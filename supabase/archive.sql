-- Lean Coffee Board – board archiving migration
-- Run once (re-runnable) in the Supabase Dashboard → SQL Editor.
--
-- Brings board archiving to any install:
--   1. boards.archived / boards.archived_at – archive state.
--   2. Card policies that reject writes while the parent board is archived
--      (replaces the fully open card policies older installs have).
--   3. trg_boards_archive_guard – archived board rows reject every update
--      except the restore itself (old-vs-new comparison needs a trigger;
--      RLS policies only ever see one row).
--   4. board_overview recreated to include the archive columns.
--
-- Fresh installs that ran the current supabase/schema.sql already have
-- 1–3; this file is then only needed for the view update (step 4).

-- ── 1. Archive state ────────────────────────────────────────────────────
alter table public.boards
  add column if not exists archived boolean not null default false;
alter table public.boards
  add column if not exists archived_at timestamptz;

-- ── 2. Cards: locked while the parent board is archived ─────────────────
-- Read stays open. ON DELETE CASCADE from boards still works – referential
-- actions bypass RLS – so deleting a board removes its archived cards too.
drop policy if exists public_insert_cards on public.cards;
drop policy if exists public_update_cards on public.cards;
drop policy if exists public_delete_cards on public.cards;

create policy public_insert_cards on public.cards for insert
  with check (not exists (select 1 from public.boards b where b.id = board_id and b.archived));
create policy public_update_cards on public.cards for update
  using (not exists (select 1 from public.boards b where b.id = board_id and b.archived))
  with check (not exists (select 1 from public.boards b where b.id = board_id and b.archived));
create policy public_delete_cards on public.cards for delete
  using (not exists (select 1 from public.boards b where b.id = board_id and b.archived));

-- ── 3. boards: archived rows are immutable except the restore ───────────
create or replace function public.boards_archive_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.archived and new.archived then
    raise exception 'board % is archived and locked for editing', old.slug;
  end if;
  return new;
end $$;

drop trigger if exists trg_boards_archive_guard on public.boards;
create trigger trg_boards_archive_guard
  before update on public.boards
  for each row execute function public.boards_archive_guard();

-- ── 4. board_overview: add the archive columns ──────────────────────────
-- Same metadata-only view as in supabase/maintenance.sql, plus archived.
-- Dropped and recreated rather than CREATE OR REPLACE: OR REPLACE may only
-- append columns at the end of the list, and inserting the archive columns
-- mid-list fails (42P16, "cannot change name of view column"). Nothing
-- depends on the view; grants are re-issued below the create.
drop view if exists public.board_overview;
create view public.board_overview as
select b.slug,
       b.title,
       b.archived,
       b.archived_at,
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

alter view public.board_overview set (security_invoker = true);

grant select on public.board_overview to anon, authenticated;
