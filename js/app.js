// App entry: hash-based router + view orchestration.
// Routes:
//   #/                (or empty)  → landing page
//   #/<slug>                      → a specific board
//
// Loaded as a module from index.html.

import { supabase } from './supabase.js';
import { SLUG_ALPHABET, SLUG_LENGTH } from './config.js';
import { getIdentity } from './identity.js';
import { mountBoard, unmountBoard, currentBoardSlug } from './board.js';

// ── Slug generation ─────────────────────────────────────────────────────
export function generateSlug() {
  const bytes = crypto.getRandomValues(new Uint32Array(SLUG_LENGTH));
  let out = '';
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

// ── Router ──────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash.replace(/^#\/?/, ''); // strip '#/' or '#'
  if (!hash) {
    renderLanding();
    return;
  }
  if (currentBoardSlug() !== hash) {
    mountBoard(hash).catch((err) => {
      console.error('Failed to mount board', err);
      renderError(err);
    });
  }
}

window.addEventListener('hashchange', route);

// ── Landing page ────────────────────────────────────────────────────────
async function createBoard() {
  const slug = generateSlug();
  const { error } = await supabase.from('boards').insert({
    slug,
    title: null,
    timer_duration_sec: 300,
    timer_running: false,
  });
  if (error) {
    alert('Could not create board: ' + error.message);
    return;
  }
  location.hash = `/${slug}`;
}

function renderLanding() {
  unmountBoard?.();
  const identity = getIdentity();
  document.body.innerHTML = `
    <main class="landing">
      <header class="landing__header">
        <div class="landing__logo">☕ Lean Coffee Board</div>
        <div class="identity-badge" id="identity-badge">
          <span class="identity-badge__dot" style="background:${identity.color}"></span>
          <span>${escapeHtml(identity.name)}</span>
        </div>
      </header>
      <section class="landing__hero">
        <h1>Start a Lean Coffee meeting</h1>
        <p>
          A simple, real-time board for agenda-less meetings.
          Share the link – no accounts required.
        </p>
        <button id="new-board-btn" class="btn btn--primary btn--lg">
          Start a new board
        </button>
        <p class="landing__hint">
          Or open an existing board via its URL, e.g.
          <code>#/<span class="muted">a1b2c3d4</span></code>
        </p>
      </section>
      <section class="landing__columns">
        <div class="landing__col"><h3>To Discuss</h3><p>Everyone adds topics.</p></div>
        <div class="landing__col"><h3>Discussing</h3><p>The current topic, time-boxed.</p></div>
        <div class="landing__col"><h3>Discussed</h3><p>Topics we've covered.</p></div>
        <div class="landing__col"><h3>Actions</h3><p>Decisions and next steps.</p></div>
      </section>
    </main>
  `;
  document.getElementById('new-board-btn').addEventListener('click', createBoard);
}

function renderError(err) {
  document.body.innerHTML = `
    <main class="landing">
      <div class="landing__hero">
        <h1>Could not open that board</h1>
        <p>${escapeHtml(err.message || String(err))}</p>
        <a href="#/" class="btn btn--primary">Back to start</a>
      </div>
    </main>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ── Boot ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', route);
} else {
  route();
}
