// Synced discussion timer.
// State lives in the boards row; every client computes remaining time from
// the server timestamps so all participants stay in sync without a tick server.

import { supabase } from './supabase.js';

const DEFAULT_DURATION_SEC = 300; // 5 minutes

let rafBoard = null;       // latest board snapshot (mutable ref)
let container = null;
let intervalId = null;
let onChangeCallback = null;
// Signature of the last full rebuild. The 500ms tick only needs to update the
// time text and progress width; rebuilding innerHTML every tick blows away the
// open <select> (and any focus) mid-interaction.
let lastSignature = null;

export function startTimerUI(board, el, onChange) {
  rafBoard = board;
  container = el;
  onChangeCallback = onChange;
  render();
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(render, 500);
}

export function stopTimerUI() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  container = null;
  rafBoard = null;
  lastSignature = null;
}

export function setBoardRef(board) {
  rafBoard = board;
  render();
}

function render() {
  if (!container || !rafBoard) return;
  const duration = rafBoard.timer_duration_sec ?? DEFAULT_DURATION_SEC;
  const remaining = computeRemainingSec(rafBoard);

  const running = !!rafBoard.timer_running;
  const low = remaining !== null && remaining <= 30 && remaining > 0;

  const pct = remaining === null
    ? 0
    : Math.max(0, Math.min(100, (remaining / duration) * 100));

  const mmss = remaining === null ? formatTime(duration) : formatTime(Math.max(0, remaining));

  // Only the time text + progress bar + low-time class change each tick.
  // The buttons/select markup depends solely on `running` and `duration`,
  // so we rebuild innerHTML only when one of those actually changes.
  const signature = `${running}|${duration}`;
  if (signature !== lastSignature) {
    container.innerHTML = `
      <section class="timer ${running ? '' : 'is-paused'}" aria-label="Discussion timer">
        <span class="timer__label">Discussion</span>
        <span class="timer__time" data-timer-time>${mmss}<span class="visually-hidden" data-timer-aria> ${ariaTimeLabel(remaining, duration)}</span></span>
        <div class="timer__progress" role="progressbar" aria-valuemin="0" aria-valuemax="${duration}" aria-valuenow="${remaining === null ? duration : Math.max(0, Math.round(remaining))}" aria-label="Time remaining"><span data-timer-bar style="width:${pct}%"></span></div>
        <div class="timer__buttons">
          ${running
            ? `<button class="btn btn--ghost btn--sm" data-timer="pause" aria-label="Pause timer"><span aria-hidden="true">⏸</span> Pause</button>`
            : `<button class="btn btn--primary btn--sm" data-timer="start" aria-label="Start timer"><span aria-hidden="true">▶</span> Start</button>`}
          <button class="btn btn--ghost btn--sm" data-timer="reset" aria-label="Reset timer"><span aria-hidden="true">↺</span> Reset</button>
          <label class="timer__duration" for="timer-duration-select">
            Discussion length
            <select id="timer-duration-select" data-timer-duration aria-label="Discussion length">
              ${[120, 180, 300, 480, 600, 900].map((s) =>
                `<option value="${s}" ${s === duration ? 'selected' : ''}>${formatTime(s)}</option>`
              ).join('')}
            </select>
          </label>
        </div>
      </section>
    `;
    wireButtons();
    lastSignature = signature;
  } else {
    // Patch only what actually changed this tick.
    const timeEl = container.querySelector('[data-timer-time]');
    const barEl = container.querySelector('[data-timer-bar]');
    const ariaEl = container.querySelector('[data-timer-aria]');
    const progressEl = container.querySelector('.timer__progress');
    const sectionEl = container.querySelector('.timer');
    if (timeEl) {
      // Preserve the visually-hidden aria sibling.
      const ariaText = ariaEl ? ariaEl.textContent : '';
      timeEl.childNodes[0].nodeValue = mmss;
      timeEl.classList.toggle('is-low', low);
    }
    if (ariaEl) ariaEl.textContent = ' ' + ariaTimeLabel(remaining, duration);
    if (barEl) barEl.style.width = `${pct}%`;
    if (progressEl) progressEl.setAttribute('aria-valuenow', String(remaining === null ? duration : Math.max(0, Math.round(remaining))));
    if (sectionEl) sectionEl.classList.toggle('is-paused', !running);
  }
}

function wireButtons() {
  container.querySelectorAll('[data-timer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.timer;
      if (action === 'start') startTimer();
      else if (action === 'pause') pauseTimer();
      else if (action === 'reset') resetTimer();
    });
  });
  container.querySelector('[data-timer-duration]')?.addEventListener('change', (e) => {
    setDuration(parseInt(e.target.value, 10));
  });
}

// ── Compute remaining seconds from server state ─────────────────────
function computeRemainingSec(b) {
  const duration = b.timer_duration_sec ?? DEFAULT_DURATION_SEC;
  if (!b.timer_running) {
    // Paused/stopped: remaining = duration - elapsed-at-pause.
    if (b.timer_paused_elapsed_sec != null) return Math.max(0, duration - b.timer_paused_elapsed_sec);
    return duration;
  }
  // Running: elapsed = now - started_at + (any prior accumulated paused elapsed).
  const startedAt = b.timer_started_at ? Date.parse(b.timer_started_at) : Date.now();
  const prior = b.timer_paused_elapsed_sec || 0;
  const elapsedSec = prior + (Date.now() - startedAt) / 1000;
  return Math.max(0, duration - elapsedSec);
}

// ── Mutations (write to boards row; realtime fans out) ──────────────
async function startTimer() {
  if (!rafBoard) return;
  // Resume: keep prior elapsed; set fresh started_at.
  const elapsed = rafBoard.timer_paused_elapsed_sec || 0;
  const patch = {
    timer_running: true,
    timer_started_at: new Date().toISOString(),
    timer_paused_elapsed_sec: elapsed,
  };
  applyLocal(patch);
  await persist(patch);
}

async function pauseTimer() {
  if (!rafBoard) return;
  const elapsed = computeElapsedAtNow(rafBoard);
  const patch = {
    timer_running: false,
    timer_started_at: null,
    timer_paused_elapsed_sec: elapsed,
  };
  applyLocal(patch);
  await persist(patch);
}

async function resetTimer() {
  if (!rafBoard) return;
  const patch = {
    timer_running: false,
    timer_started_at: null,
    timer_paused_elapsed_sec: 0,
  };
  applyLocal(patch);
  await persist(patch);
}

async function setDuration(seconds) {
  if (!rafBoard) return;
  const patch = { timer_duration_sec: seconds };
  applyLocal(patch);
  await persist(patch);
}

function computeElapsedAtNow(b) {
  const prior = b.timer_paused_elapsed_sec || 0;
  if (!b.timer_running || !b.timer_started_at) return prior;
  return prior + (Date.now() - Date.parse(b.timer_started_at)) / 1000;
}

function applyLocal(patch) {
  rafBoard = { ...rafBoard, ...patch };
  onChangeCallback?.(patch);
  render();
}

async function persist(patch) {
  const { error } = await supabase.from('boards').update(patch).eq('id', rafBoard.id);
  if (error) console.error('Timer update failed:', error.message);
}

function formatTime(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function ariaTimeLabel(remaining, duration) {
  const s = Math.max(0, Math.round(remaining === null ? duration : remaining));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts = [];
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (r > 0 || m === 0) parts.push(`${r} second${r === 1 ? '' : 's'}`);
  return `${parts.join(' ')} remaining`;
}
