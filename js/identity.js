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
