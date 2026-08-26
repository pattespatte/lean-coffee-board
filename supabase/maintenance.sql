-- Lean Coffee Board – maintenance migration
-- Run once (re-runnable) in the Supabase Dashboard → SQL Editor, after
-- supabase/schema.sql. Adds:
--   1. boards.last_activity_at – trigger-maintained "last write" timestamp,
--      used to decide what counts as an old meeting.
--   2. Integrity check constraints (slug format, timer bounds, text lengths,
--      non-negative votes).
--   3. board_overview – a metadata-only view for monitoring and cleanup.
--      It deliberately excludes card content and author names; the title is
--      included on purpose so the owner can tell meetings apart.

-- ── boards.last_activity_at ──────────────────────────────────────────────
-- Added as NULL first (no default) so pre-existing boards can be backfilled
-- from their card history; the default and NOT NULL are set afterwards.
-- If a board row is written mid-migration (no triggers exist yet) it stays
-- NULL and the final SET NOT NULL fails – just re-run the migration.
alter table public.boards
  add column if not exists last_activity_at timestamptz;

alter table public.boards
  alter column last_activity_at set default now();

create index if not exists idx_boards_last_activity on public.boards (last_activity_at);

-- Backfill for boards created before this migration: last activity is
-- approximated as the newest card creation (creation itself counts). Only
-- NULL rows are touched, so re-running never disturbs trigger-maintained
-- values.
update public.boards b
set    last_activity_at = greatest(
         b.created_at,
         coalesce((select max(c.created_at) from public.cards c where c.board_id = b.id), b.created_at))
where  b.last_activity_at is null;

alter table public.boards
  alter column last_activity_at set not null;

-- ── Triggers: any write counts as activity ───────────────────────────────
-- Writes to the board row itself (timer, title, card selection).
create or replace function public.boards_touch_last_activity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- A statement that sets last_activity_at explicitly (card trigger,
  -- backfill) wins; everything else is stamped with now().
  if new.last_activity_at is distinct from old.last_activity_at then
    return new;
  end if;
  new.last_activity_at := now();
  return new;
end $$;

drop trigger if exists trg_boards_touch on public.boards;
create trigger trg_boards_touch
  before update on public.boards
  for each row execute function public.boards_touch_last_activity();

-- Writes to any card touch the parent board. (When a board is deleted, its
-- cards cascade; the per-card DELETE triggers then update a row that is
-- already gone – a no-op, not an error.)
create or replace function public.cards_touch_board_last_activity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    update public.boards set last_activity_at = now() where id = old.board_id;
  else
    update public.boards set last_activity_at = now() where id = new.board_id;
  end if;
  return null;  -- AFTER row trigger: return value is ignored
end $$;

drop trigger if exists trg_cards_touch on public.cards;
create trigger trg_cards_touch
  after insert or update or delete on public.cards
  for each row execute function public.cards_touch_board_last_activity();

-- ── Integrity constraints ────────────────────────────────────────────────
-- Guards against junk written through the public REST API (no accounts).
-- If an ADD CONSTRAINT fails, some existing row violates it – the error
-- names the constraint; fix the data (or relax the rule) and re-run.
do $$
begin
  -- 8 chars from the app's SLUG_ALPHABET (js/config.js)
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.boards'::regclass and conname = 'boards_slug_format') then
    alter table public.boards add constraint boards_slug_format
      check (slug ~ '^[abcdefghijkmnpqrstuvwxyz23456789]{8}$');
  end if;
  -- The app offers 2–15 minutes; allow headroom either way.
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.boards'::regclass and conname = 'boards_timer_duration_range') then
    alter table public.boards add constraint boards_timer_duration_range
      check (timer_duration_sec between 30 and 3600);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.boards'::regclass and conname = 'boards_title_max_len') then
    alter table public.boards add constraint boards_title_max_len
      check (title is null or char_length(title) <= 200);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.cards'::regclass and conname = 'cards_votes_nonnegative') then
    alter table public.cards add constraint cards_votes_nonnegative
      check (votes >= 0);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.cards'::regclass and conname = 'cards_content_max_len') then
    alter table public.cards add constraint cards_content_max_len
      check (char_length(content) <= 5000);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.cards'::regclass and conname = 'cards_author_name_max_len') then
    alter table public.cards add constraint cards_author_name_max_len
      check (author_name is null or char_length(author_name) <= 100);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.cards'::regclass and conname = 'cards_author_color_max_len') then
    alter table public.cards add constraint cards_author_color_max_len
      check (author_color is null or char_length(author_color) <= 32);
  end if;
end $$;

-- ── board_overview view ──────────────────────────────────────────────────
-- Metadata-only monitoring view used by scripts/maintenance.mjs and handy
-- in the SQL Editor:
--   select * from public.board_overview order by last_activity_at desc;
--
-- Exposes slug, title, timestamps and counts – never card content or author
-- names. (The tables themselves are already publicly readable under the
-- open-RLS model, so this view adds no new exposure.)
create or replace view public.board_overview as
select b.slug,
       b.title,
       b.created_at,
       b.last_activity_at,
       count(c.id) filter (where c.column_key = 'to_discuss') as cards_to_discuss,
       count(c.id) filter (where c.column_key = 'discussing')  as cards_discussing,
       count(c.id) filter (where c.column_key = 'discussed')   as cards_discussed,
       count(c.id) filter (where c.column_key = 'actions')     as cards_actions,
       count(c.id)                                              as cards_total,
       coalesce(sum(c.votes), 0)                                as votes_total
from public.boards b
left join public.cards c on c.board_id = b.id
group by b.id;

-- Run with the querying user's permissions instead of the view owner's, so
-- the table RLS policies apply (silences Supabase's "Security Definer View"
-- advisor finding and keeps the view honest if RLS is ever tightened).
-- Under the current open-RLS model this changes nothing in practice.
alter view public.board_overview set (security_invoker = true);

grant select on public.board_overview to anon, authenticated;
