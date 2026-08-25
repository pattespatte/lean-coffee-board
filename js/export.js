// Board export: JSON download + printable summary.

import { renderMarkdown } from './markdown.js';

const COLUMN_LABELS = {
  to_discuss: 'To Discuss',
  discussing: 'Discussing',
  discussed:  'Discussed',
  actions:    'Actions',
};

export function exportJson(board, cards) {
  const payload = {
    exported_at: new Date().toISOString(),
    board: {
      slug: board.slug,
      title: board.title || null,
      timer_duration_sec: board.timer_duration_sec,
    },
    cards: cards
      .filter((c) => !c._pending)
      .map((c) => ({
        column_key: c.column_key,
        content: c.content,
        author_name: c.author_name,
        author_color: c.author_color,
        votes: c.votes || 0,
        created_at: c.created_at,
      })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `lean-coffee-${board.slug}-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function printBoard(board, cards) {
  const byColumn = (col) => cards
    .filter((c) => c.column_key === col && !c._pending)
    .sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.position - b.position);

  const title = escapeHtml(board.title || 'Lean Coffee meeting');
  const dateStr = new Date().toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const renderList = (col) => {
    const items = byColumn(col);
    if (items.length === 0) return '<p class="print-empty">(none)</p>';
    return `<ul>${items.map((c) => `
      <li>
        <span class="print-votes">${c.votes ? `<svg class="print-thumb" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><path d="m8 8.73984815c0-.47742254.17078432-.93909653.4814868-1.30158274l4.7909063-5.58939072c.4276196-.49888947 1.1399001-.64272811 1.7276069-.34887469.5737957.28689785.849314.95205792.6464466 1.56066017l-1.6464466 4.93933983h4.6035746c.1199832 0 .239723.01079693.3577708.03226018 1.0867527.1975914 1.8075604 1.238758 1.609969 2.32551072l-1.2727273 7c-.1729057.9509814-1.0011675 1.6422291-1.9677398 1.6422291h-7.3308473c-1.1045695 0-2-.8954305-2-2z"/><path d="m4 18v-9"/></svg>${c.votes}` : ''}</span>
        <span class="print-text">${renderMarkdown(c.content)}</span>
      </li>`).join('')}</ul>`;
  };

  const win = window.open('', '_blank');
  if (!win) { alert('Please allow pop-ups to print the board.'); return; }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>${title} – ${dateStr}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; color: #2b2620; max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; }
      h1 { margin-bottom: 0; font-size: 1.5rem; }
      .meta { color: #6b6357; margin: .25rem 0 2rem; font-size: .9rem; }
      section { margin-bottom: 1.75rem; break-inside: avoid; }
      h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .06em; color: #6b6357; border-bottom: 1px solid #e6ddcf; padding-bottom: .3rem; }
      ul { list-style: none; padding-left: 0; }
      li { padding: .35rem 0; border-bottom: 1px dashed #eee; display: flex; gap: .6rem; }
      .print-votes { color: #8a5a2b; font-weight: 600; min-width: 2.5rem; font-size: .85rem; display: inline-flex; align-items: center; gap: .25rem; }
      .print-thumb { width: 1.7rem; height: 1.7rem; }
      .print-text { flex: 1; }
      .print-text code { font-family: ui-monospace, Menlo, monospace; font-size: .82em; background: #f3ece0; border-radius: 3px; padding: .05em .25em; }
      .print-text pre { margin: .2rem 0; padding: .3rem .4rem; background: #f3ece0; border: 1px solid #e6ddcf; border-radius: 4px; white-space: pre-wrap; }
      .print-text pre code { background: none; padding: 0; }
      .print-empty { color: #a89f90; font-style: italic; }
      section.actions h2 { color: #4a7c4a; }
      section.actions { background: #f4f7f4; padding: .75rem 1rem; border-radius: 8px; }
    </style>
  </head><body>
    <h1>${title}</h1>
    <p class="meta">Lean Coffee board · ${dateStr} · #/${escapeHtml(board.slug)}</p>
    <section><h2>To Discuss</h2>${renderList('to_discuss')}</section>
    <section><h2>Discussed</h2>${renderList('discussed')}</section>
    <section class="actions"><h2>Actions &amp; Decisions</h2>${renderList('actions')}</section>
  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
