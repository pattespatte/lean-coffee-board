// App entry: hash-based router + view orchestration.
// Routes:
//   #/                (or empty)  → landing page
//   #/<slug>                      → a specific board
//
// Loaded as a module from index.html.

import { supabase } from './supabase.js';
import { SLUG_ALPHABET, SLUG_LENGTH } from './config.js';
import { getIdentity, enableNameEditing } from './identity.js';
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
        <div class="identity-badge" id="identity-badge" tabindex="0" role="img"
             aria-label="You are ${escapeHtml(identity.name)} (double-click to rename)">
          <span class="identity-badge__dot" aria-hidden="true" style="background:${identity.color}"></span>
          <span class="identity-badge__name" aria-hidden="true">${escapeHtml(identity.name)}</span>
          <span class="identity-badge__hint" aria-hidden="true">You are ${escapeHtml(identity.name)} (double-click to rename)</span>
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
      <section class="landing__how" aria-labelledby="how-it-works">
        <h2 id="how-it-works" class="landing__how-title">How it works</h2>
        <ul class="landing__columns">
          <li class="landing__col landing__col--to-discuss"><h3>To Discuss</h3><p>Everyone adds topics.</p></li>
          <li class="landing__col landing__col--discussing"><h3>Discussing</h3><p>The current topic, time-boxed.</p></li>
          <li class="landing__col landing__col--discussed"><h3>Discussed</h3><p>Topics we've covered.</p></li>
          <li class="landing__col landing__col--actions"><h3>Actions</h3><p>Decisions and next steps.</p></li>
        </ul>
      </section>
    </main>
    <footer class="site-footer">
      No ads. No login. All free. Source code at
      <a href="https://github.com/pattespatte/lean-coffee-board">GitHub</a>.
      Background artwork “Espresso Cup With A Rich Dark Coffee Shot” by Rodigart47 –
      <a href="https://pngtree.com/freepng/espresso-cup-with-a-rich-dark-coffee-shot_15473319.html">free PNG images from pngtree.com</a>.
    </footer>
  `;
  document.getElementById('new-board-btn').addEventListener('click', createBoard);
  enableNameEditing(document.getElementById('identity-badge'));
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
    <footer class="site-footer">
      No ads. No login. All free. Source code at
      <a href="https://github.com/pattespatte/lean-coffee-board">GitHub</a>.
      Background artwork “Espresso Cup With A Rich Dark Coffee Shot” by Rodigart47 –
      <a href="https://pngtree.com/freepng/espresso-cup-with-a-rich-dark-coffee-shot_15473319.html">free PNG images from pngtree.com</a>.
    </footer>
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
