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
      <div class="topbar__left">
        <a href="#/" class="topbar__logo">☕</a>
        <input id="board-title" class="topbar__title" type="text"
               placeholder="Untitled meeting" value="${escapeAttr(board.title || '')}">
        <span class="topbar__slug">#/${escapeHtml(board.slug)}</span>
      </div>
      <div class="topbar__right">
        <span class="identity-badge" id="identity-badge" title="Your identity (per browser)">
          <span class="identity-badge__dot" style="background:${identity.color}"></span>
          <span>${escapeHtml(identity.name)}</span>
        </span>
        <button id="export-json-btn" class="btn btn--ghost" title="Download board as JSON">⬇ JSON</button>
        <button id="export-print-btn" class="btn btn--ghost" title="Print or save as PDF">🖨 Print</button>
      </div>
    </header>
    <div id="timer-bar"></div>
    <main id="board" class="board"></main>
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
      <section class="column" data-column="${col.key}">
        <header class="column__head">
          <h2>${col.label}</h2>
          <span class="column__count">${colCards.length}</span>
          ${col.key === 'to_discuss' ? `<button class="btn btn--ghost btn--sm" data-sort-votes>Sort by votes</button>` : ''}
        </header>
        <div class="column__cards" data-dropzone="${col.key}">
          ${cardsHtml}
        </div>
        <form class="column__add" data-add-form="${col.key}">
          <textarea data-add-input="${col.key}" placeholder="Add a topic…"
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
  return `
    <article class="card${pending}" draggable="true"
             data-card-id="${card.id}" data-column="${card.column_key}"
             data-position="${card.position}">
      <div class="card__author">
        <span class="card__dot" style="background:${card.author_color || '#999'}"></span>
        <span class="card__author-name">${escapeHtml(card.author_name || 'Someone')}</span>
      </div>
      <div class="card__content" data-card-content>${escapeHtml(card.content)}</div>
      <div class="card__footer">
        ${showVote ? `
          <button class="btn btn--vote ${voted ? 'is-voted' : ''}"
                  data-vote="${card.id}"
                  title="Vote for this topic">
            ▲ <span class="card__votes">${card.votes || 0}</span>
          </button>` : `<span class="card__votes-static">${card.votes || 0} ▲</span>`}
        <div class="card__actions">
          <button class="btn btn--icon" data-edit="${card.id}" title="Edit">✎</button>
          <button class="btn btn--icon" data-delete="${card.id}" title="Delete">🗑</button>
        </div>
      </div>
    </article>
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
    el = document.createElement('div');
    el.id = 'flash-error';
    el.className = 'flash-error';
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
