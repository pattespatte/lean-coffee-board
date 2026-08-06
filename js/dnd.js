// Native HTML5 drag-and-drop for the board.
// Supports both horizontal (between columns) and vertical (reorder within a
// column) moves, using float positions with generous spacing so midpoint
// insertion always has room.

const DRAG_MIME = 'application/x-lean-coffee-card';

let dragState = null;   // { cardId, fromColumn }
let dropIndicator = null; // element currently showing a drop cue

/**
 * Wire up drag-and-drop on the board root.
 * @param {HTMLElement} root   the #board element
 * @param {(id:string, toColumn:string, toPosition:number)=>Promise} moveCard
 */
export function attachDragAndDrop(root, moveCard) {
  // Use event delegation so we don't re-bind after each re-render.
  root.addEventListener('dragstart', (e) => onDragStart(e));
  root.addEventListener('dragend',   (e) => onDragEnd(e));
  root.addEventListener('dragover',  (e) => onDragOver(e));
  root.addEventListener('dragenter', (e) => onDragEnter(e));
  root.addEventListener('dragleave', (e) => onDragLeave(e));
  root.addEventListener('drop',      (e) => onDrop(e, moveCard));
}

function onDragStart(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const cardId = card.dataset.cardId;
  const fromColumn = card.dataset.column;
  dragState = { cardId, fromColumn };
  card.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData(DRAG_MIME, cardId); } catch { /* some browsers */ }
  e.dataTransfer.setData('text/plain', cardId);
}

function onDragEnd(e) {
  const card = e.target.closest('.card');
  card?.classList.remove('is-dragging');
  clearDropIndicator();
  dragState = null;
}

function onDragEnter(e) {
  const zone = e.target.closest('[data-dropzone]');
  if (zone) zone.classList.add('is-drop-over');
}

function onDragLeave(e) {
  const zone = e.target.closest('[data-dropzone]');
  if (zone && !zone.contains(e.relatedTarget)) {
    zone.classList.remove('is-drop-over');
  }
}

function onDragOver(e) {
  if (!dragState) return;
  const card = e.target.closest('.card');
  const zone = e.target.closest('[data-dropzone]');

  // Determine drop target & orientation.
  let targetCard = null;
  let placement = null; // 'before' | 'after' | 'into-empty'

  if (card && card.dataset.cardId !== dragState.cardId) {
    targetCard = card;
    const rect = card.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    placement = e.clientY < midpoint ? 'before' : 'after';
  } else if (zone) {
    targetCard = null;
    placement = 'into-empty';
  } else {
    return; // not over a valid target
  }

  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  showDropIndicator(targetCard, placement, zone);
}

function onDrop(e, moveCard) {
  e.preventDefault();
  if (!dragState) return;

  const zone = e.target.closest('[data-dropzone]');
  const card = e.target.closest('.card');
  if (!zone) { clearDropIndicator(); return; }

  const toColumn = zone.dataset.dropzone;
  const cardId = dragState.cardId;

  // Compute target position based on indicator.
  const { targetCard, placement } = computeDropTarget(e, card, zone);
  const toPosition = computePosition(toColumn, targetCard, placement, cardId);

  clearDropIndicator();
  zone.classList.remove('is-drop-over');

  // No-op if dropping back in same spot.
  if (dragState.fromColumn === toColumn && targetCard?.dataset.cardId === cardId) {
    dragState = null;
    return;
  }

  const id = cardId;
  dragState = null;
  moveCard(id, toColumn, toPosition);
}

// ── Indicator (visual cue) ───────────────────────────────────────────
function computeDropTarget(e, card, zone) {
  if (card && card.dataset.cardId !== dragState?.cardId) {
    const rect = card.getBoundingClientRect();
    const placement = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    return { targetCard: card, placement };
  }
  // Over an empty zone, or over the dragged card itself → append.
  return { targetCard: null, placement: 'append' };
}

function showDropIndicator(targetCard, placement, zone) {
  clearDropIndicator();
  if (!zone) return;
  if (!targetCard || placement === 'into-empty' || placement === 'append') return;

  if (placement === 'before') targetCard.classList.add('is-drop-above');
  else targetCard.classList.add('is-drop-below');
  dropIndicator = targetCard;
}

function clearDropIndicator() {
  document.querySelectorAll('.is-drop-above, .is-drop-below')
    .forEach((el) => el.classList.remove('is-drop-above', 'is-drop-below'));
  document.querySelectorAll('.is-drop-over').forEach((el) => el.classList.remove('is-drop-over'));
  dropIndicator = null;
}

// ── Position math ────────────────────────────────────────────────────
// Float positions with big gaps; new position = midpoint between neighbours.
function computePosition(toColumn, targetCard, placement, draggedId) {
  const zone = document.querySelector(`[data-dropzone="${toColumn}"]`);
  if (!zone) return Date.now();

  // Gather the sibling cards in DOM order, excluding the dragged card.
  const cardEls = [...zone.querySelectorAll('.card:not(.is-dragging)')];
  const positions = cardEls.map((el) => ({
    id: el.dataset.cardId,
    pos: parseFloat(el.dataset.position ?? '0'),
  }));

  if (cardEls.length === 0) return 1000;

  if (!targetCard || placement === 'append') {
    return Math.max(...positions.map((p) => p.pos)) + 1000;
  }

  const targetId = targetCard.dataset.cardId;
  const idx = positions.findIndex((p) => p.id === targetId);
  if (idx === -1) return Math.max(...positions.map((p) => p.pos)) + 1000;

  if (placement === 'before') {
    const prevPos = idx > 0 ? positions[idx - 1].pos : 0;
    const targetPos = positions[idx].pos;
    return (prevPos + targetPos) / 2;
  }
  // after
  const targetPos = positions[idx].pos;
  const nextPos = idx < positions.length - 1 ? positions[idx + 1].pos : targetPos + 2000;
  return (targetPos + nextPos) / 2;
}
