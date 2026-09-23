#!/usr/bin/env node
// Lean Coffee Board – maintenance CLI (monitoring + cleanup).
//
// Content-blind by design: `list` and `prune` work on the board_overview
// view (title, timestamps, counts) and never fetch card text or authors.
// The only content-touching feature is `--archive`, which is opt-in.
//
// Requirements: Bun or Node ≥ 18. No dependencies.
//
// Usage:
//   maintenance.mjs list [--json]
//   maintenance.mjs prune --older-than <age> [--empty-age <age>]
//                         [--archive DIR] [--apply]
//   maintenance.mjs archive <slug> [--apply]
//   maintenance.mjs unarchive <slug> [--apply]
//   maintenance.mjs delete <slug> [--archive DIR] [--apply]
//   maintenance.mjs help
//
// Configuration: SUPABASE_URL / SUPABASE_ANON_KEY env vars, falling back to
// the values committed in js/config.js. Requires supabase/maintenance.sql
// to have been applied to the project (it creates the board_overview view).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// ── Small helpers ────────────────────────────────────────────────────────
function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(`Lean Coffee Board maintenance – monitor, archive and clean up boards in Supabase.

Usage:
  maintenance.mjs list      [--json]
  maintenance.mjs prune     --older-than <age> [--empty-age <age>] [--archive DIR] [--apply]
  maintenance.mjs archive   <slug> [--apply]
  maintenance.mjs unarchive <slug> [--apply]
  maintenance.mjs delete    <slug> [--archive DIR] [--apply]
  maintenance.mjs help

Commands:
  list        Show all boards: slug, title, activity, card and vote counts.
  prune       Delete stale boards (dry run unless --apply). Skips archived boards.
  archive     Lock one board: read-only for everyone, running timer stopped
              (dry run unless --apply).
  unarchive   Restore one archived board to editable (dry run unless --apply).
  delete      Permanently remove one board – cards cascade with it
              (dry run unless --apply).
  help        Show this text.

Options:
  --older-than <age>  Activity cutoff for prune: e.g. 48h, 90d, 2w (1h minimum).
  --empty-age <age>   Delete never-used (0-card) boards after this age instead.
                      Default 1d; 0 disables.
  --archive DIR       With --apply: save the deleted board(s) as JSON in the
                      app's own export format first (re-importable later).
                      Reads card content, so it is opt-in; DIR is created if
                      needed.
  --apply             Actually change anything. Without it commands only report.
  --json              list: print raw JSON instead of a table.

Ages use h/d/w units; a bare number means days. Prune deletes whole boards –
cards cascade with them. Archived boards are never pruned; use
"delete <slug>" to remove one explicitly.`);
}

// ── Config: env vars, falling back to js/config.js ───────────────────────
function loadConfig() {
  let { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const src = readFileSync(join(REPO_ROOT, 'js', 'config.js'), 'utf8');
    const pick = (name) =>
      src.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`))?.[1];
    SUPABASE_URL ||= pick('SUPABASE_URL');
    SUPABASE_ANON_KEY ||= pick('SUPABASE_ANON_KEY');
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    die('Missing SUPABASE_URL / SUPABASE_ANON_KEY (env vars or js/config.js).');
  }
  return { url: SUPABASE_URL.replace(/\/+$/, ''), key: SUPABASE_ANON_KEY };
}

// ── Supabase REST (PostgREST) ────────────────────────────────────────────
async function api(cfg, path, init = {}) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 && path.startsWith('board_overview')) {
      die('board_overview is missing – apply supabase/maintenance.sql in the Supabase '
        + 'SQL Editor (if you just did, PostgREST may need a few seconds to reload '
        + `its schema cache). (HTTP 404: ${body.slice(0, 200)})`);
    }
    die(`Supabase request failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return res;
}

async function fetchOverview(cfg) {
  const res = await api(cfg, 'board_overview?select=*&order='
    + encodeURIComponent('last_activity_at.desc'));
  return res.json();
}

// Single-board commands: the boards row (metadata incl. timer state) and the
// board_overview row (card/vote counts). Both die with a readable message
// when the slug doesn't exist.
async function fetchBoard(cfg, slug) {
  const [row] = await (await api(cfg,
    'boards?select=*&slug=' + encodeURIComponent(`eq.${slug}`))).json();
  if (!row) die(`No board found for slug "${slug}" – run "maintenance.mjs list" to see slugs.`);
  return row;
}

async function fetchOverviewRow(cfg, slug) {
  const [row] = await (await api(cfg,
    'board_overview?select=*&slug=' + encodeURIComponent(`eq.${slug}`))).json();
  if (!row) die(`No board found for slug "${slug}" – run "maintenance.mjs list" to see slugs.`);
  return row;
}

// Boards row from a project where supabase/archive.sql hasn't been applied.
function requireArchiveSupport(row) {
  if (row.archived === undefined) {
    die('boards.archived is missing – apply supabase/archive.sql in the Supabase '
      + 'SQL Editor first (PostgREST may need a few seconds to reload its schema cache).');
  }
}

// Mirror of the app's timer math (js/timer.js): seconds elapsed at "now".
function elapsedSecAtNow(b) {
  const prior = b.timer_paused_elapsed_sec || 0;
  if (!b.timer_running || !b.timer_started_at) return prior;
  return Math.round(prior + (Date.now() - Date.parse(b.timer_started_at)) / 1000);
}

async function patchBoard(cfg, slug, patch) {
  await api(cfg, 'boards?slug=' + encodeURIComponent(`eq.${slug}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// ── Time helpers ─────────────────────────────────────────────────────────
function parseDuration(text, flag) {
  const m = /^(\d+)\s*(h|d|w)?$/.exec(String(text ?? ''));
  if (!m) die(`Invalid --${flag} value "${text}" – expected e.g. 48h, 90d, 2w.`);
  return Number(m[1]) * MS[m[2] || 'd'];
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < MS.h) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < MS.d) return `${Math.floor(ms / MS.h)} h ago`;
  if (ms < MS.w) return `${Math.floor(ms / MS.d)} d ago`;
  if (ms < 30 * MS.d) return `${Math.floor(ms / MS.w)} w ago`;
  return `${Math.floor(ms / (30 * MS.d))} mo ago`;
}

// ── Output ───────────────────────────────────────────────────────────────
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderTable(rows) {
  const head = ['slug', 'title', 'arch', 'created', 'last activity', 'cards', 'votes'];
  const data = rows.map((r) => [
    r.slug,
    truncate(r.title || '–', 32),
    r.archived ? 'yes' : '–',
    ago(r.created_at),
    ago(r.last_activity_at),
    String(r.cards_total),
    String(r.votes_total),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const d of data) console.log(line(d));
}

// ── Archive (the one content-reading feature) ────────────────────────────
async function archiveBoard(cfg, slug, dir) {
  const [board] = await (await api(cfg,
    'boards?select=*&slug=' + encodeURIComponent(`eq.${slug}`))).json();
  if (!board) die(`Board ${slug} disappeared before archiving.`);

  const cards = await (await api(cfg,
    'cards?select=column_key,content,author_name,author_color,votes,created_at'
    + '&board_id=' + encodeURIComponent(`eq.${board.id}`)
    + '&order=' + encodeURIComponent('column_key.asc,position.asc'))).json();

  // Same shape as the in-app JSON export (js/export.js), so the file can be
  // re-imported via the Import button.
  const payload = {
    exported_at: new Date().toISOString(),
    board: {
      slug: board.slug,
      title: board.title || null,
      timer_duration_sec: board.timer_duration_sec,
    },
    cards: cards.map(({ column_key, content, author_name, author_color, votes, created_at }) => ({
      column_key, content, author_name, author_color, votes: votes || 0, created_at,
    })),
  };
  const date = new Date().toISOString().slice(0, 10);
  const file = join(dir, `lean-coffee-${slug}-${date}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

// ── Commands ─────────────────────────────────────────────────────────────
function noPositional(command, positional) {
  if (positional.length > 0) die(`"${command}" takes no arguments.`);
}

function requireSlug(command, positional) {
  const slug = positional[0];
  if (!slug) die(`${command} requires a board slug, e.g. maintenance.mjs ${command} a1b2c3d4`);
  return slug;
}

async function cmdList(flags, positional) {
  noPositional('list', positional);
  const cfg = loadConfig();
  const rows = await fetchOverview(cfg);
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No boards yet.');
    return;
  }
  renderTable(rows);
  console.log(`\n${rows.length} board(s). Metadata only – card content is never fetched.`);
}

async function cmdPrune(flags, positional) {
  noPositional('prune', positional);
  if (!flags['older-than']) die('prune requires --older-than (e.g. 90d, 2w, 48h).');
  if (flags.archive !== undefined && !flags.apply) {
    die('--archive only makes sense together with --apply.');
  }

  const olderMs = parseDuration(flags['older-than'], 'older-than');
  if (olderMs < MS.h) die('--older-than must be at least 1h – current meetings are not stale.');

  const emptyRaw = flags['empty-age'] ?? '1d';
  const emptyMs = emptyRaw === '0' ? 0 : parseDuration(emptyRaw, 'empty-age');
  if (emptyMs !== 0 && emptyMs < MS.h) die('--empty-age must be at least 1h (or 0 to disable).');

  const cfg = loadConfig();
  const rows = await fetchOverview(cfg);
  const now = Date.now();
  // Archived boards are kept on purpose; remove them explicitly via delete.
  const candidates = rows.filter((r) => !r.archived);
  const archivedSkipped = rows.length - candidates.length;
  const stale = candidates.filter((r) => {
    if (now - new Date(r.last_activity_at).getTime() >= olderMs) return true;
    return emptyMs > 0
      && r.cards_total === 0
      && now - new Date(r.created_at).getTime() >= emptyMs;
  });

  if (archivedSkipped > 0) {
    console.log(`${archivedSkipped} archived board(s) skipped – kept until "delete <slug>" removes them explicitly.`);
  }
  if (stale.length === 0) {
    console.log('Nothing to delete – no boards match.');
    return;
  }

  renderTable(stale);
  if (!flags.apply) {
    console.log(`\n${stale.length} board(s) would be deleted (dry run – no changes made).`);
    console.log('Re-run with --apply to delete. Cards are deleted with their board.');
    return;
  }

  if (flags.archive !== undefined) {
    const dir = resolve(REPO_ROOT, flags.archive);
    mkdirSync(dir, { recursive: true });
    for (const r of stale) {
      console.log(`Archived ${r.slug} → ${await archiveBoard(cfg, r.slug, dir)}`);
    }
  }

  const deleted = await (await api(cfg,
    'boards?select=id&slug='
    + encodeURIComponent(`in.(${stale.map((r) => `"${r.slug}"`).join(',')})`),
    { method: 'DELETE', headers: { Prefer: 'return=representation' } })).json();
  console.log(`\nDeleted ${deleted.length} board(s).`);
}

async function cmdArchive(flags, positional) {
  const slug = requireSlug('archive', positional);
  const cfg = loadConfig();
  const board = await fetchBoard(cfg, slug);
  requireArchiveSupport(board);
  const overview = await fetchOverviewRow(cfg, slug);

  renderTable([overview]);
  if (board.archived) {
    console.log(`\n${slug} is already archived – nothing to do.`);
    return;
  }

  // Archiving stops a running timer but keeps its elapsed time, so a later
  // restore resumes where the meeting left off (same as the in-app button).
  const patch = {
    archived: true,
    archived_at: new Date().toISOString(),
    timer_running: false,
    timer_started_at: null,
  };
  if (board.timer_running) patch.timer_paused_elapsed_sec = elapsedSecAtNow(board);

  if (!flags.apply) {
    console.log(`\n${slug} would be archived (dry run – no changes made).`);
    console.log('The board becomes read-only for everyone; restore it with "unarchive".');
    if (board.timer_running) console.log('The running timer is stopped; its elapsed time is kept.');
    console.log('Re-run with --apply to archive.');
    return;
  }

  await patchBoard(cfg, slug, patch);
  console.log(`\nArchived ${slug} – read-only now. Restore it with "unarchive ${slug}".`);
}

async function cmdUnarchive(flags, positional) {
  const slug = requireSlug('unarchive', positional);
  const cfg = loadConfig();
  const board = await fetchBoard(cfg, slug);
  requireArchiveSupport(board);
  const overview = await fetchOverviewRow(cfg, slug);

  renderTable([overview]);
  if (!board.archived) {
    console.log(`\n${slug} is not archived – nothing to do.`);
    return;
  }

  if (!flags.apply) {
    console.log(`\n${slug} would be restored from the archive (dry run – no changes made).`);
    console.log('Re-run with --apply to unarchive.');
    return;
  }

  await patchBoard(cfg, slug, { archived: false, archived_at: null });
  console.log(`\nRestored ${slug} from the archive – it can be edited again.`);
}

async function cmdDelete(flags, positional) {
  const slug = requireSlug('delete', positional);
  if (flags.archive !== undefined && !flags.apply) {
    die('--archive only makes sense together with --apply.');
  }
  const cfg = loadConfig();
  const overview = await fetchOverviewRow(cfg, slug);

  renderTable([overview]);
  if (!flags.apply) {
    console.log(`\n${slug} would be permanently deleted (dry run – no changes made).`);
    console.log('Cards are deleted with the board. This cannot be undone.');
    console.log('Re-run with --apply to delete.');
    return;
  }

  if (flags.archive !== undefined) {
    const dir = resolve(REPO_ROOT, flags.archive);
    mkdirSync(dir, { recursive: true });
    console.log(`Saved backup → ${await archiveBoard(cfg, slug, dir)}`);
  }

  await api(cfg, 'boards?slug=' + encodeURIComponent(`eq.${slug}`), { method: 'DELETE' });
  console.log(`\nDeleted ${slug}.`);
}

// ── Arg parsing + dispatch ───────────────────────────────────────────────
function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positional = [];
  const errors = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json' || a === '--apply') {
      flags[a.slice(2)] = true;
    } else if (a === '--older-than' || a === '--empty-age' || a === '--archive') {
      const v = rest[++i];
      if (v === undefined) errors.push(`${a} needs a value`);
      else flags[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      errors.push(`unknown argument "${a}"`);
    } else {
      positional.push(a);
    }
  }
  return { command, flags, positional, errors };
}

const { command, flags, positional, errors } = parseArgs(process.argv.slice(2));
if (errors.length) die(errors.join('; '));

switch (command) {
  case 'list': await cmdList(flags, positional); break;
  case 'prune': await cmdPrune(flags, positional); break;
  case 'archive': await cmdArchive(flags, positional); break;
  case 'unarchive': await cmdUnarchive(flags, positional); break;
  case 'delete': await cmdDelete(flags, positional); break;
  case 'help': case '--help': case '-h': noPositional('help', positional); usage(); break;
  default:
    console.error(`Unknown command "${command}".`);
    usage();
    process.exit(1);
}
