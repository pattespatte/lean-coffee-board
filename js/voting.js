// Voting: 3 votes per person per board (Lean Coffee standard).
// Votes are tracked in localStorage (keyed per board slug) so we can't
// enforce globally without accounts, but we prevent accidental over-voting
// on the same browser.

const VOTES_PER_PERSON = 3;

function key(slug) { return `lcb:votes:${slug}`; }

export function getVotedCardIds(slug) {
  if (!slug) return new Set();
  try {
    const raw = localStorage.getItem(key(slug));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveVotedCardIds(slug, set) {
  try { localStorage.setItem(key(slug), JSON.stringify([...set])); } catch { /* ignore */ }
}

export function votesRemaining(slug) {
  return VOTES_PER_PERSON - getVotedCardIds(slug).size;
}

/**
 * Toggle vote on a card.
 * @param {string} slug
 * @param {string} cardId
 * @param {Array}  cards      current cards array (for reading prior count)
 * @param {(id:string, votes:number)=>Promise} setCardVotes
 */
export async function toggleVote(slug, cardId, cards, setCardVotes) {
  const voted = getVotedCardIds(slug);
  const card = cards.find((c) => c.id === cardId);
  if (!card) return;

  if (voted.has(cardId)) {
    voted.delete(cardId);
    saveVotedCardIds(slug, voted);
    await setCardVotes(cardId, Math.max(0, (card.votes || 0) - 1));
  } else {
    if (voted.size >= VOTES_PER_PERSON) {
      flash('You’ve used all 3 votes on this board.');
      return;
    }
    voted.add(cardId);
    saveVotedCardIds(slug, voted);
    await setCardVotes(cardId, (card.votes || 0) + 1);
  }
}

/**
 * Rewrite positions of to_discuss cards so they're ordered by vote count
 * (desc), then persist each new position.
 */
export async function sortToDiscussByVotes(supabase, board, cards, onDone) {
  const toDiscuss = cards
    .filter((c) => c.column_key === 'to_discuss')
    .sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.position - b.position);

  // Assign fresh positions: big gaps, top of column = highest votes.
  const updates = toDiscuss.map((c, i) => ({ id: c.id, position: (i + 1) * 1000 }));
  for (const u of updates) {
    const card = cards.find((c) => c.id === u.id);
    if (card) card.position = u.position;
  }
  onDone?.();

  // Persist (best-effort, in order).
  for (const u of updates) {
    const { error } = await supabase.from('cards').update({ position: u.position }).eq('id', u.id);
    if (error) console.error('Sort update failed:', error.message);
  }
}

// ── Small inline flash (timer/voting modules don't own the board's flash) ──
function flash(msg) {
  let el = document.getElementById('flash-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash-error';
    el.className = 'flash-error';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => el.classList.remove('is-visible'), 2500);
}
