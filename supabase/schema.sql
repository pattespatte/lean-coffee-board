-- Lean Coffee Board – Supabase schema
-- Run once in the Supabase Dashboard → SQL Editor.
-- Re-runnable (uses IF NOT EXISTS / guarded publication adds).

create extension if not exists "pgcrypto";

-- ── boards ──────────────────────────────────────────────────────────────
create table if not exists public.boards (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text unique not null,
  title                    text,
  timer_duration_sec       integer not null default 300,
  timer_started_at         timestamptz,            -- null when stopped
  timer_paused_elapsed_sec integer,                -- null when running
  timer_running            boolean not null default false,
  created_at               timestamptz not null default now()
);

create index if not exists idx_boards_slug on public.boards (slug);

-- Card currently in focus for the room (click a card to select it).
-- Nullable: null = no selection. Cleared automatically if the card is deleted.
alter table public.boards
  add column if not exists selected_card_id uuid references public.cards(id) on delete set null;

-- ── cards ───────────────────────────────────────────────────────────────
create table if not exists public.cards (
  id           uuid primary key default gen_random_uuid(),
  board_id     uuid not null references public.boards (id) on delete cascade,
  column_key   text not null default 'to_discuss'
                 check (column_key in ('to_discuss', 'discussing', 'discussed', 'actions')),
  content      text not null default '',
  author_name  text,
  author_color text,
  position     double precision not null default 0,
  votes        integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists idx_cards_board_id        on public.cards (board_id);
create index if not exists idx_cards_board_col_pos    on public.cards (board_id, column_key, position);

-- ── Row Level Security ──────────────────────────────────────────────────
-- No-account model: the 8-char board slug is the capability secret.
-- Anyone who has the URL can read and edit the board.
alter table public.boards enable row level security;
alter table public.cards  enable row level security;

do $$
begin
  -- boards
  if not exists (select 1 from pg_policies where tablename = 'boards' and policyname = 'public_read_boards') then
    create policy public_read_boards   on public.boards for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'boards' and policyname = 'public_insert_boards') then
    create policy public_insert_boards on public.boards for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'boards' and policyname = 'public_update_boards') then
    create policy public_update_boards on public.boards for update using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'boards' and policyname = 'public_delete_boards') then
    create policy public_delete_boards on public.boards for delete using (true);
  end if;

  -- cards
  if not exists (select 1 from pg_policies where tablename = 'cards' and policyname = 'public_read_cards') then
    create policy public_read_cards   on public.cards for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cards' and policyname = 'public_insert_cards') then
    create policy public_insert_cards on public.cards for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cards' and policyname = 'public_update_cards') then
    create policy public_update_cards on public.cards for update using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'cards' and policyname = 'public_delete_cards') then
    create policy public_delete_cards on public.cards for delete using (true);
  end if;
end $$;

-- ── Realtime ────────────────────────────────────────────────────────────
-- Broadcast inserts/updates/deletes to all connected clients.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'boards'
  ) then
    alter publication supabase_realtime add table public.boards;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cards'
  ) then
    alter publication supabase_realtime add table public.cards;
  end if;
end $$;
