// Board export: JSON download + printable summary.

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
        <span class="print-votes">${c.votes ? `▲${c.votes}` : ''}</span>
        <span class="print-text">${escapeHtml(c.content)}</span>
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
      .print-votes { color: #8a5a2b; font-weight: 600; min-width: 2.5rem; font-size: .85rem; }
      .print-text { flex: 1; }
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
