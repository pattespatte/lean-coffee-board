// Board state, initial load, realtime handling, and rendering.
// Owns the cards array + board metadata for the currently mounted board.

import { supabase, subscribeBoard } from './supabase.js';
import { getIdentity } from './identity.js';
import { attachDragAndDrop } from './dnd.js';
import { startTimerUI, stopTimerUI, setBoardRef } from './timer.js';
import { toggleVote, getVotedCardIds, sortToDiscussByVotes, votesRemaining } from './voting.js';
import { exportJson, printBoard } from './export.js';

// ── Module state ────────────────────────────────────────────────────────
let currentSlug = null;
let board = null;             // { id, slug, title, timer_* }
let cards = [];               // [{ id, board_id, column, content, author_name, author_color, position, votes }]
let unsubscribe = null;
let titleInputTimer = null;
let srInsertBuffer = [];      // pending card inserts awaiting SR announcement
let srInsertTimer = null;     // throttle timer for SR announcements

const COLUMNS = [
  { key: 'to_discuss',  label: 'To Discuss' },
  { key: 'discussing',  label: 'Discussing' },
  { key: 'discussed',   label: 'Discussed'  },
  { key: 'actions',     label: 'Actions'    },
];

export function currentBoardSlug() { return currentSlug; }

// ── Mount / unmount ─────────────────────────────────────────────────────
export async function mountBoard(slug) {
  unmountBoard();
  currentSlug = slug;

  // Fetch the board row + its cards.
  const { data: boardRow, error: bErr } = await supabase
    .from('boards').select('*').eq('slug', slug).maybeSingle();
  if (bErr) throw bErr;
  if (!boardRow) throw new Error(`No board found for "${slug}".`);
  board = boardRow;

  const { data: cardRows, error: cErr } = await supabase
    .from('cards').select('*').eq('board_id', board.id).order('position');
  if (cErr) throw cErr;
  cards = cardRows || [];

  // Subscribe to realtime changes.
  unsubscribe = subscribeBoard(board.id, handleRealtime);

  renderShell();
  renderBoard();
}

export function unmountBoard() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  stopTimerUI();
  currentSlug = null;
  board = null;
  cards = [];
}

// ── Realtime ────────────────────────────────────────────────────────────
function handleRealtime(payload) {
  const table = payload._table;
  const row = payload.new || payload.old;

  if (table === 'boards' && row?.id === board?.id) {
    board = { ...board, ...(payload.new || {}) };
    setBoardRef(board);   // keep timer module's ref in sync with remote changes
    onBoardChanged();
    return;
  }
  if (table !== 'cards') return;

  if (payload.eventType === 'INSERT') {
    if (!cards.some((c) => c.id === row.id)) {
      cards.push(row);
      insertSorted();
      queueSrInsertAnnouncement(row);
    }
  } else if (payload.eventType === 'UPDATE') {
    const i = cards.findIndex((c) => c.id === row.id);
    if (i >= 0) cards[i] = { ...cards[i], ...row };
  } else if (payload.eventType === 'DELETE') {
    cards = cards.filter((c) => c.id !== (payload.old?.id ?? row.id));
  }
  renderBoard();
}

function insertSorted() {
  cards.sort((a, b) =>
    a.column_key.localeCompare(b.column_key) || a.position - b.position);
}

// Throttled screen-reader announcement of new cards (WCAG 4.1.3).
// Buffers inserts for 800ms, then announces a single consolidated message
// so a board restore with many cards doesn't flood the live region.
function queueSrInsertAnnouncement(card) {
  srInsertBuffer.push(card);
  if (srInsertTimer) return; // already pending; will batch
  srInsertTimer = setTimeout(() => {
    srInsertTimer = null;
    const count = srInsertBuffer.length;
    srInsertBuffer = [];
    if (count === 0) return;
    const el = document.getElementById('sr-status');
    if (!el) return;
    el.textContent = count === 1
      ? 'A new topic was added'
      : `${count} new topics were added`;
  }, 800);
}

// Position math for keyboard-driven moves (mirrors js/dnd.js float-position scheme).
// Returns the new position for `cardId` if moved one slot up/down within its column,
// or null if the card is already at the top/bottom (no move possible).
function positionForMoveUp(cardId) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  const sorted = cards
    .filter((c) => c.column_key === card.column_key)
    .sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex((c) => c.id === cardId);
  if (idx <= 0) return null; // already first
  const prevPos = idx > 1 ? sorted[idx - 2].position : 0;
  const targetPos = sorted[idx - 1].position;
  return (prevPos + targetPos) / 2;
}
function positionForMoveDown(cardId) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  const sorted = cards
    .filter((c) => c.column_key === card.column_key)
    .sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex((c) => c.id === cardId);
  if (idx === -1 || idx >= sorted.length - 1) return null; // already last
  const targetPos = sorted[idx + 1].position;
  const nextPos = idx < sorted.length - 2 ? sorted[idx + 2].position : targetPos + 2000;
  return (targetPos + nextPos) / 2;
}

// Where in the order is this card (1-based), within its column?
function cardRankInColumn(cardId) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return { rank: 0, total: 0 };
  const sorted = cards
    .filter((c) => c.column_key === card.column_key)
    .sort((a, b) => a.position - b.position);
  return { rank: sorted.findIndex((c) => c.id === cardId) + 1, total: sorted.length };
}

// ── Mutations ───────────────────────────────────────────────────────────
export async function addCard(columnKey) {
  const input = document.querySelector(`[data-add-input="${columnKey}"]`);
  if (!input) return;
  const content = input.value.trim();
  if (!content || !board) return;
  input.value = '';

  const identity = getIdentity();
  const position = nextPosition(columnKey);

  // Optimistic insert.
  const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const optimistic = {
    id: tempId, board_id: board.id, column_key: columnKey, content,
    author_name: identity.name, author_color: identity.color,
    position, votes: 0, created_at: new Date().toISOString(), _pending: true,
  };
  cards.push(optimistic);
  insertSorted();
  renderBoard();

  const { data, error } = await supabase.from('cards').insert({
    board_id: board.id, column_key: columnKey, content,
    author_name: identity.name, author_color: identity.color, position,
  }).select().single();
  if (error) {
    cards = cards.filter((c) => c.id !== tempId);
    renderBoard();
    flashError(error.message);
    return;
  }
  // Replace the temp card with the real one.
  // Guard against a race where realtime already inserted the real card:
  // in that case just drop the temp placeholder.
  const i = cards.findIndex((c) => c.id === tempId);
  if (i >= 0) {
    if (cards.some((c) => c.id === data.id)) cards.splice(i, 1);
    else cards[i] = data;
  }
  insertSorted();
  renderBoard();
}

export async function updateCardContent(id, content) {
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  const prev = cards[i].content;
  cards[i].content = content;
  renderBoard();
  const { error } = await supabase.from('cards').update({ content }).eq('id', id);
  if (error) { cards[i].content = prev; renderBoard(); flashError(error.message); }
}

export async function moveCard(id, toColumn, toPosition) {
  if (!board) return;
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  const card = cards[i];
  const prev = { column_key: card.column_key, position: card.position };

  // Optimistic move.
  card.column_key = toColumn;
  card.position = toPosition;
  insertSorted();
  renderBoard();

  const { error } = await supabase.from('cards')
    .update({ column_key: toColumn, position: toPosition }).eq('id', id);
  if (error) {
    card.column_key = prev.column_key;
    card.position = prev.position;
    insertSorted();
    renderBoard();
    flashError(error.message);
  }
}

export async function deleteCard(id) {
  const prevCards = cards.slice();
  cards = cards.filter((c) => c.id !== id);
  renderBoard();
  const { error } = await supabase.from('cards').delete().eq('id', id);
  if (error) { cards = prevCards; renderBoard(); flashError(error.message); }
}

export async function setCardVotes(id, votes) {
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  cards[i].votes = votes;
  renderBoard();
  const { error } = await supabase.from('cards').update({ votes }).eq('id', id);
  if (error) { flashError(error.message); }
}

export function nextPosition(columnKey) {
  const inCol = cards.filter((c) => c.column_key === columnKey);
  if (inCol.length === 0) return 1000;
  return Math.max(...inCol.map((c) => c.position)) + 1000;
}

export function getBoard() { return board; }
export function getCards() { return cards; }
export function setCards(next) { cards = next.slice(); }

// ── Rendering ───────────────────────────────────────────────────────────
function renderShell() {
  const identity = getIdentity();
  document.body.innerHTML = `
    <header class="topbar">
      <h1 class="visually-hidden">${escapeHtml(board.title || 'Untitled meeting')}</h1>
      <div class="topbar__left">
        <a href="#/" class="topbar__logo" aria-label="Lean Coffee Board home">☕</a>
        <input id="board-title" class="topbar__title" type="text"
               placeholder="Untitled meeting" value="${escapeAttr(board.title || '')}"
               aria-label="Board title">
        <span class="topbar__slug">#/${escapeHtml(board.slug)}</span>
      </div>
      <div class="topbar__right">
        <span class="identity-badge" id="identity-badge" title="Your identity (per browser)" role="img" aria-label="Your identity: ${escapeAttr(identity.name)}">
          <span class="identity-badge__dot" aria-hidden="true" style="background:${identity.color}"></span>
          <span aria-hidden="true">${escapeHtml(identity.name)}</span>
        </span>
        <button id="export-json-btn" class="btn btn--ghost" aria-label="Download board as JSON"><span aria-hidden="true">⬇</span> JSON</button>
        <button id="export-print-btn" class="btn btn--ghost" aria-label="Print or save as PDF"><span aria-hidden="true">🖨</span> Print</button>
      </div>
    </header>
    <div id="timer-bar"></div>
    <main id="board" class="board" aria-label="Board"></main>
    <footer class="site-footer">
      No ads. No login. All free. Source code at
      <a href="https://github.com/pattespatte/lean-coffee-board">GitHub</a>.
    </footer>
    <!-- Live regions for screen-reader status announcements (WCAG 4.1.3). -->
    <div id="flash-error" class="flash-error" role="alert" aria-live="assertive" aria-atomic="true"></div>
    <div id="sr-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>
  `;

  document.getElementById('board-title').addEventListener('input', (e) => {
    clearTimeout(titleInputTimer);
    const value = e.target.value;
    titleInputTimer = setTimeout(async () => {
      const { error } = await supabase.from('boards').update({ title: value }).eq('id', board.id);
      if (error) flashError(error.message);
    }, 400);
  });

  document.getElementById('export-json-btn').addEventListener('click', () => exportJson(board, cards));
  document.getElementById('export-print-btn').addEventListener('click', () => printBoard(board, cards));

  startTimerUI(board, document.getElementById('timer-bar'), (next) => { board = { ...board, ...next }; });
}

function renderBoard() {
  const root = document.getElementById('board');
  if (!root) return;

  const html = COLUMNS.map((col) => {
    const colCards = cards.filter((c) => c.column_key === col.key);
    const cardsHtml = colCards.map((card) => renderCard(card, col.key)).join('');
    return `
      <section class="column" data-column="${col.key}" aria-label="${col.label}">
        <header class="column__head">
          <h2>${col.label}</h2>
          <span class="column__count">${colCards.length}<span class="visually-hidden"> topic${colCards.length === 1 ? '' : 's'}</span></span>
          ${col.key === 'to_discuss' ? `<button class="btn btn--ghost btn--sm" data-sort-votes aria-label="Sort To Discuss by votes">Sort by votes</button>` : ''}
        </header>
        <div class="column__cards" data-dropzone="${col.key}">
          ${cardsHtml}
        </div>
        <form class="column__add" data-add-form="${col.key}">
          <label class="visually-hidden" for="add-input-${col.key}">Add a topic to ${col.label}</label>
          <textarea id="add-input-${col.key}" data-add-input="${col.key}" placeholder="Add a topic…"
                    rows="1"></textarea>
          <button type="submit" class="btn btn--ghost btn--sm">Add</button>
        </form>
      </section>
    `;
  }).join('');

  root.innerHTML = html;

  // Wire up controls after render.
  wireAddForms();
  wireCardControls();
  wireSortButton();
  attachDragAndDrop(root, moveCard);
  updateVoteRemainingIndicator();
}

function renderCard(card, columnKey) {
  const voted = getVotedCardIds(currentSlug).has(card.id);
  const showVote = columnKey === 'to_discuss';
  const pending = card._pending ? ' card--pending' : '';
  const votes = card.votes || 0;
  const author = card.author_name || 'Someone';
  const preview = truncate(card.content, 60);
  const voteLabel = voted
    ? `Remove vote, ${votes} vote${votes === 1 ? '' : 's'}`
    : `Vote for this topic, ${votes} vote${votes === 1 ? '' : 's'}`;
  const thumbIcon = '<svg class="icon icon--thumb" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8.73984815c0-.47742254.17078432-.93909653.4814868-1.30158274l4.7909063-5.58939072c.4276196-.49888947 1.1399001-.64272811 1.7276069-.34887469.5737957.28689785.849314.95205792.6464466 1.56066017l-1.6464466 4.93933983h4.6035746c.1199832 0 .239723.01079693.3577708.03226018 1.0867527.1975914 1.8075604 1.238758 1.609969 2.32551072l-1.2727273 7c-.1729057.9509814-1.0011675 1.6422291-1.9677398 1.6422291h-7.3308473c-1.1045695 0-2-.8954305-2-2z"></path><path d="m4 18v-9"></path></svg>';
  // Keyboard-move controls (SC 2.5.7): hidden on pending cards (not yet persisted).
  const moveControls = card._pending ? '' : renderCardMoveControls(card);
  return `
    <article class="card${pending}" draggable="true"
             data-card-id="${card.id}" data-column="${card.column_key}"
             data-position="${card.position}"
             aria-label="Topic by ${escapeAttr(author)}: ${escapeAttr(preview)}">
      <div class="card__author">
        <span class="card__dot" aria-hidden="true" style="background:${card.author_color || '#999'}"></span>
        <span class="card__author-name">${escapeHtml(author)}</span>
      </div>
      <div class="card__content" data-card-content>${escapeHtml(card.content)}</div>
      ${moveControls}
      <div class="card__footer">
        ${showVote ? `
          <button class="btn btn--vote ${voted ? 'is-voted' : ''}"
                  data-vote="${card.id}"
                  aria-label="${voteLabel}"
                  aria-pressed="${voted ? 'true' : 'false'}">
            ${thumbIcon}
            <span class="card__votes" aria-hidden="true">${votes}</span>
          </button>` : `<span class="card__votes-static">${votes} ${thumbIcon}<span class="visually-hidden"> vote${votes === 1 ? '' : 's'}</span></span>`}
        <div class="card__actions">
          <button class="btn btn--icon" data-edit="${card.id}" aria-label="Edit topic">
            <span aria-hidden="true">✎</span>
          </button>
          <button class="btn btn--icon" data-delete="${card.id}" aria-label="Delete topic">
            <span aria-hidden="true">🗑</span>
          </button>
        </div>
      </div>
    </article>
  `;
}

// Keyboard-operable move controls (WCAG 2.2 SC 2.5.7 Dragging Movements).
// A "Move to column" select + Move up/down buttons, so cards can be rearranged
// without a pointer. Drag-and-drop (dnd.js) remains the pointer path.
function renderCardMoveControls(card) {
  const { rank, total } = cardRankInColumn(card.id);
  const atTop = rank <= 1;
  const atBottom = rank >= total || total <= 1;
  const options = COLUMNS.map((c) =>
    `<option value="${c.key}"${c.key === card.column_key ? ' selected' : ''}>${c.label}</option>`
  ).join('');
  return `
    <div class="card__move">
      <label class="visually-hidden" for="move-to-${card.id}">Move topic to column</label>
      <select id="move-to-${card.id}" class="card__move-select" data-move-col="${card.id}">
        ${options}
      </select>
      <button class="btn btn--icon" data-move-up="${card.id}"
              aria-label="Move topic up"${atTop ? ' disabled aria-disabled="true"' : ''}>
        <span aria-hidden="true">↑</span>
      </button>
      <button class="btn btn--icon" data-move-down="${card.id}"
              aria-label="Move topic down"${atBottom ? ' disabled aria-disabled="true"' : ''}>
        <span aria-hidden="true">↓</span>
      </button>
    </div>
  `;
}

// ── Wiring ──────────────────────────────────────────────────────────────
function wireAddForms() {
  document.querySelectorAll('[data-add-form]').forEach((form) => {
    const colKey = form.dataset.addForm;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      addCard(colKey);
    });
    const textarea = form.querySelector('textarea');
    if (textarea) {
      textarea.addEventListener('input', () => autoGrow(textarea));
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          addCard(colKey);
        }
      });
    }
  });
}

function wireCardControls() {
  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCard(btn.dataset.delete));
  });
  document.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => startEdit(btn.dataset.edit));
  });
  document.querySelectorAll('[data-vote]').forEach((btn) => {
    btn.addEventListener('click', () => toggleVote(currentSlug, btn.dataset.vote, cards, setCardVotes));
  });
  // Keyboard move controls (SC 2.5.7).
  document.querySelectorAll('[data-move-col]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const cardId = sel.dataset.moveCol;
      const targetCol = sel.value;
      const card = cards.find((c) => c.id === cardId);
      if (card && card.column_key !== targetCol) {
        moveCard(cardId, targetCol, nextPosition(targetCol));
      }
    });
  });
  document.querySelectorAll('[data-move-up]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const cardId = btn.dataset.moveUp;
      const card = cards.find((c) => c.id === cardId);
      const newPos = positionForMoveUp(cardId);
      if (card && newPos !== null) moveCard(cardId, card.column_key, newPos);
    });
  });
  document.querySelectorAll('[data-move-down]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const cardId = btn.dataset.moveDown;
      const card = cards.find((c) => c.id === cardId);
      const newPos = positionForMoveDown(cardId);
      if (card && newPos !== null) moveCard(cardId, card.column_key, newPos);
    });
  });
}

function wireSortButton() {
  const btn = document.querySelector('[data-sort-votes]');
  if (btn) btn.addEventListener('click', () => sortToDiscussByVotes(supabase, board, cards, () => {
    insertSorted();
    renderBoard();
  }));
}

function onBoardChanged() {
  // Title input retains focus; just keep data in sync.
  const input = document.getElementById('board-title');
  if (input && document.activeElement !== input) {
    input.value = board.title || '';
  }
  // Keep the visually-hidden h1 in sync for screen-reader users.
  const h1 = document.querySelector('.topbar h1');
  if (h1) h1.textContent = board.title || 'Untitled meeting';
  // Timer UI reads board state each tick; nothing extra needed here.
}

function startEdit(id) {
  const cardEl = document.querySelector(`[data-card-id="${id}"]`);
  if (!cardEl) return;
  const contentEl = cardEl.querySelector('[data-card-content]');
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  const original = card.content;
  contentEl.outerHTML = `
    <textarea class="card__edit" data-edit-area>${escapeHtml(original)}</textarea>
  `;
  const area = cardEl.querySelector('[data-edit-area]');
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  autoGrow(area);

  const commit = async () => {
    const val = area.value.trim();
    cardEl.removeEventListener('blur', onBlur, true);
    if (val === original || val === '') { renderBoard(); return; }
    await updateCardContent(id, val);
  };
  const onBlur = () => commit();
  area.addEventListener('blur', onBlur, { once: true });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { renderBoard(); }
  });
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function updateVoteRemainingIndicator() {
  // Subtle: reflect votes remaining in the identity badge tooltip.
  const badge = document.getElementById('identity-badge');
  if (badge) {
    const remaining = 3 - votesRemaining(currentSlug);
    badge.title = `You are ${getIdentity().name} · ${remaining} vote${remaining === 1 ? '' : 's'} left`;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────
function flashError(msg) {
  let el = document.getElementById('flash-error');
  if (!el) {
    // Fallback for views without renderShell (e.g. landing). The board view
    // pre-renders this as a live region in renderShell.
    el = document.createElement('div');
    el.id = 'flash-error';
    el.className = 'flash-error';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(flashError._t);
  flashError._t = setTimeout(() => el.classList.remove('is-visible'), 3000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
