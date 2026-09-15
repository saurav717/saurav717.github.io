// ===========================================================================
//  Pane sizing.
//  Three draggable splitters -- sidebar | workspace, prompt | editor, and
//  editor | output -- each of which writes one CSS custom property that the
//  stylesheet reads. This module owns the arithmetic (clamping, what counts
//  as "too small", what happens on a window resize) and hands the resulting
//  sizes back so the caller can persist them; it knows nothing about SQL,
//  exercises or storage.
//
//  Sizes are in pixels, not fractions: a fraction re-scales the editor every
//  time the window changes height, which is exactly what you do not want
//  while typing a query.
// ===========================================================================

/** Below this width the stylesheet stacks the panes and hides the splitters. */
const STACK_WIDTH = 1000;

/** Smallest usable size for each pane, in px. */
const MIN = { sidebar: 190, prompt: 64, editor: 132, output: 108, workspace: 420 };

const DEFAULT = { sidebar: 284, prompt: 196, editor: 300 };

/** Keyboard resize step for a focused splitter. */
const STEP = 16;

const VAR = { sidebar: '--sidebar-w', prompt: '--prompt-h', editor: '--editor-h' };

/** Ceiling for a prompt that sizes itself to its text. */
const PROMPT_FIT_MAX = 0.42;

const root = document.documentElement;
let sizes = { ...DEFAULT };
/** Until the prompt splitter is dragged, the prompt pane follows its text. */
let autoPrompt = true;
let onChange = () => {};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const px = (n) => `${Math.round(n)}px`;

/** The prompt pane (and its splitter) are hidden in Sandbox mode. */
const promptShown = () => !document.body.classList.contains('sandbox');

/** Height the three workspace panes and their splitters have to share. */
function workspaceHeight() {
  const ws = document.querySelector('.workspace');
  return ws && ws.clientHeight ? ws.clientHeight : 600;
}

/** Total thickness of the visible horizontal splitters. */
function barsHeight() {
  return [...document.querySelectorAll('.split-row')]
    .reduce((n, el) => n + el.offsetHeight, 0);
}

/**
 * Range a single pane may occupy, given what the others already take. Each
 * bound leaves every other pane at least its MIN, so no drag can squeeze a
 * pane out of existence.
 */
function limits(which) {
  if (which === 'sidebar') {
    return [MIN.sidebar, Math.max(MIN.sidebar, window.innerWidth - MIN.workspace)];
  }
  const spare = workspaceHeight() - barsHeight() - MIN.output;
  if (which === 'prompt') {
    return [MIN.prompt, Math.max(MIN.prompt, spare - MIN.editor)];
  }
  return [MIN.editor, Math.max(MIN.editor, spare - (promptShown() ? sizes.prompt : 0))];
}

/** Push the current sizes into the CSS variables the stylesheet reads. */
function apply({ persist = false } = {}) {
  // Order matters: the prompt's ceiling depends on the editor's final height.
  for (const which of ['sidebar', 'editor', 'prompt']) {
    const [lo, hi] = limits(which);
    sizes[which] = clamp(sizes[which], lo, hi);
    root.style.setProperty(VAR[which], px(sizes[which]));
  }
  if (persist) onChange({ ...sizes, autoPrompt });
}

/**
 * Size the prompt pane to the exercise text, the way it behaved before there
 * were splitters -- a two-line prompt should not reserve room for a ten-line
 * one. Dragging the prompt seam takes that over for good; double-clicking it
 * hands it back.
 */
export function fitPrompt() {
  const pane = document.querySelector('.prompt-pane');
  if (!pane || !autoPrompt || window.innerWidth <= STACK_WIDTH) return;
  // Measured unconstrained: scrollHeight against a fixed height can only grow.
  pane.style.height = 'auto';
  const content = pane.scrollHeight;
  pane.style.height = '';
  sizes.prompt = clamp(content, MIN.prompt, Math.round(window.innerHeight * PROMPT_FIT_MAX));
  apply();
}

/** Grow (or shrink) one pane by `delta` px and repaint. */
function nudge(which, delta) {
  sizes[which] += delta;
  apply({ persist: true });
}

function wire(selector, which, axis) {
  const bar = document.querySelector(selector);
  if (!bar) return;

  let from = 0, at = 0;

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || window.innerWidth <= STACK_WIDTH) return;
    e.preventDefault();
    from = axis === 'x' ? e.clientX : e.clientY;
    at = sizes[which];
    if (which === 'prompt') autoPrompt = false;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('splitter-on');
    document.body.classList.add(axis === 'x' ? 'resizing-col' : 'resizing-row');
  });

  bar.addEventListener('pointermove', (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    sizes[which] = at + ((axis === 'x' ? e.clientX : e.clientY) - from);
    apply();
  });

  const end = (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    bar.releasePointerCapture(e.pointerId);
    bar.classList.remove('splitter-on');
    document.body.classList.remove('resizing-col', 'resizing-row');
    apply({ persist: true });
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  // Double-click puts the pane back where it started -- the usual escape hatch
  // for a splitter dragged somewhere unhelpful.
  bar.addEventListener('dblclick', () => {
    sizes[which] = DEFAULT[which];
    if (which === 'prompt') { autoPrompt = true; fitPrompt(); }
    apply({ persist: true });
  });

  // A splitter is focusable, so it has to answer the arrow keys too.
  bar.addEventListener('keydown', (e) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const fwd  = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (![back, fwd, 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    if (which === 'prompt') autoPrompt = false;   // the user is sizing it now
    if (e.key === back)     nudge(which, -STEP);
    else if (e.key === fwd) nudge(which,  STEP);
    else {
      const [lo, hi] = limits(which);
      sizes[which] = e.key === 'Home' ? lo : hi;
      apply({ persist: true });
    }
  });
}

/**
 * Start up. `saved` is whatever was persisted last time (any subset of the
 * three sizes; junk values are clamped away), `onResize` is called with the
 * full set whenever the user settles on new ones.
 */
export function init({ saved = {}, onResize = () => {} } = {}) {
  onChange = onResize;
  for (const which of Object.keys(DEFAULT)) {
    const n = Number(saved?.[which]);
    if (Number.isFinite(n) && n > 0) sizes[which] = n;
  }
  autoPrompt = saved?.autoPrompt !== false;
  apply();
  wire('#split-sidebar', 'sidebar', 'x');
  wire('#split-prompt',  'prompt',  'y');
  wire('#split-editor',  'editor',  'y');
  window.addEventListener('resize', () => { apply(); fitPrompt(); });
}

/**
 * Re-clamp after something outside this module changed how much room there is
 * -- entering or leaving Sandbox mode hides the prompt pane and its splitter.
 */
export function refresh() { apply(); }

/** Current sizes, for callers that want to persist them. */
export function current() { return { ...sizes }; }
