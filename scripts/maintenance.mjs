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
  console.log(`Lean Coffee Board maintenance – monitor and clean up boards in Supabase.

Usage:
  maintenance.mjs list  [--json]
  maintenance.mjs prune --older-than <age> [--empty-age <age>] [--archive DIR] [--apply]
  maintenance.mjs help

Commands:
  list    Show all boards: slug, title, activity, card and vote counts.
  prune   Delete stale boards (dry run unless --apply).
  help    Show this text.

Options:
  --older-than <age>  Activity cutoff for prune: e.g. 48h, 90d, 2w (1h minimum).
  --empty-age <age>   Delete never-used (0-card) boards after this age instead.
                      Default 1d; 0 disables.
  --archive DIR       With --apply: save each deleted board as JSON in the app's
                      own export format first (re-importable later). Reads card
                      content, so it is opt-in; DIR is created if needed.
  --apply             Actually delete. Without it prune only reports.
  --json              list: print raw JSON instead of a table.

Ages use h/d/w units; a bare number means days. Prune deletes whole boards –
cards cascade with them.`);
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
  const head = ['slug', 'title', 'created', 'last activity', 'cards', 'votes'];
  const data = rows.map((r) => [
    r.slug,
    truncate(r.title || '–', 32),
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
async function cmdList(flags) {
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

async function cmdPrune(flags) {
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
  const stale = rows.filter((r) => {
    if (now - new Date(r.last_activity_at).getTime() >= olderMs) return true;
    return emptyMs > 0
      && r.cards_total === 0
      && now - new Date(r.created_at).getTime() >= emptyMs;
  });

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

// ── Arg parsing + dispatch ───────────────────────────────────────────────
function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const errors = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json' || a === '--apply') {
      flags[a.slice(2)] = true;
    } else if (a === '--older-than' || a === '--empty-age' || a === '--archive') {
      const v = rest[++i];
      if (v === undefined) errors.push(`${a} needs a value`);
      else flags[a.slice(2)] = v;
    } else {
      errors.push(`unknown argument "${a}"`);
    }
  }
  return { command, flags, errors };
}

const { command, flags, errors } = parseArgs(process.argv.slice(2));
if (errors.length) die(errors.join('; '));

switch (command) {
  case 'list': await cmdList(flags); break;
  case 'prune': await cmdPrune(flags); break;
  case 'help': case '--help': case '-h': usage(); break;
  default:
    console.error(`Unknown command "${command}".`);
    usage();
    process.exit(1);
}
