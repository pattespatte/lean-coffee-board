// Per-browser identity for the no-account model.
// First visit → random friendly name + colour, stored in localStorage.

const STORAGE_KEY = 'lcb:identity';

const ADJECTIVES = [
  'Curious', 'Thoughtful', 'Energetic', 'Calm', 'Playful', 'Steady',
  'Bright', 'Cozy', 'Swift', 'Gentle', 'Clever', 'Bold', 'Warm',
  'Mellow', 'Sparkly', 'Honest', 'Zippy', 'Quiet', 'Lucky', 'Friendly',
];

const ANIMALS = [
  'Otter', 'Fox', 'Heron', 'Lynx', 'Panda', 'Falcon', 'Bear', 'Owl',
  'Hare', 'Seal', 'Wolf', 'Deer', 'Puffin', 'Hedgehog', 'Raven', 'Elk',
  'Marten', 'Stork', 'Bee', 'Moth',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomColor() {
  // pleasant, fairly-saturated, consistent lightness
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h}, 65%, 55%)`;
}

function makeIdentity() {
  return {
    name: `${randomFrom(ADJECTIVES)} ${randomFrom(ANIMALS)}`,
    color: randomColor(),
  };
}

export function getIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.name && parsed.color) return parsed;
    }
  } catch { /* fall through */ }
  const fresh = makeIdentity();
  saveIdentity(fresh);
  return fresh;
}

export function saveIdentity(identity) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch { /* storage may be unavailable */ }
}

// ── Inline renaming via the identity badge ──────────────────────────────
// Double-click (or focus + Enter) turns the badge name into an input;
// Enter/blur saves, Escape cancels. Empty names keep the previous one.

const MAX_NAME_LENGTH = 40;

export function enableNameEditing(badge) {
  if (!badge) return;

  badge.addEventListener('dblclick', (e) => {
    if (e.target === badge || e.target.closest('.identity-badge__name')) beginEdit(badge);
  });
  badge.addEventListener('keydown', (e) => {
    if (e.target === badge && e.key === 'Enter') {
      e.preventDefault();
      beginEdit(badge);
    }
  });
}

function beginEdit(badge) {
  if (badge.classList.contains('is-editing')) return;
  const identity = getIdentity();
  const span = badge.querySelector('.identity-badge__name');
  if (!span) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'identity-badge__input';
  input.value = identity.name;
  input.maxLength = MAX_NAME_LENGTH;
  input.setAttribute('aria-label', 'Your name');

  badge.classList.add('is-editing');
  badge.removeAttribute('role');
  badge.removeAttribute('aria-label');
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next && next !== identity.name) {
      saveIdentity({ ...identity, name: next });
      announce(`Name changed to ${next}`);
    }
    badge.classList.remove('is-editing');
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', `Your identity: ${getIdentity().name}`);
    input.replaceWith(span);
    span.textContent = getIdentity().name;
    badge.focus();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function announce(msg) {
  const live = document.getElementById('sr-status');
  if (live) live.textContent = msg;
}
