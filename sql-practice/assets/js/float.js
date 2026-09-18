// ===========================================================================
//  Floating window.
//  One tile can be lifted out of the tiled layout and given a frame of its
//  own: a window that sits *over* the workspace instead of taking room from
//  it, moved by its title bar, resized from any edge or corner, and tinted
//  rather than painted -- so the query underneath stays readable while you
//  are reading the answer on top of it.
//
//  This is the terminal-window model, not the dialog model: nothing behind it
//  is blocked, nothing is dimmed, and it keeps its place across reloads. The
//  layout module still owns the tile and its slot in the tree; all this one
//  does is position the element and hand the rectangle back so the caller can
//  persist it.
//
//  Geometry is viewport pixels, because the window is `position: fixed`.
// ===========================================================================

/** Smallest usable window. Below this the compose box and the thread collide. */
const MIN = { w: 300, h: 220 };

/**
 * Margin kept between the window and the edges of the page.
 *
 * The window is contained by the page, not merely tethered to it: a desktop
 * window may hang off the side of the screen because the desktop is bigger
 * than the screen and you can always drag it back, but here there is nothing
 * out there, and a corner dragged past the edge takes its resize grip with it
 * and never gives it back.
 */
const PAD = 10;

/** Below this the stylesheet stacks the tiles, and a window makes no sense. */
const STACK_WIDTH = 1000;

/** The eight directions you can drag a corner or an edge in. */
const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * The frames the window can wear, and the tint each one is drawn for. The
 * stylesheet owns what they look like; all this needs to know is the order to
 * cycle them in and where the slider should land when you switch, because a
 * frame designed around a wide blur wants less opacity than one that is
 * mostly opacity to begin with.
 */
const STYLES = [
  { id: 'frosted',  label: 'Frosted',  tint: 0.70 },
  { id: 'clear',    label: 'Clear',    tint: 0.44 },
  { id: 'terminal', label: 'Terminal', tint: 0.85 },
  { id: 'aurora',   label: 'Aurora',   tint: 0.60 },
];
const styleAt = (id) => STYLES.find((s) => s.id === id) || STYLES[0];

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const px = (n) => `${Math.round(n)}px`;

let el = null;                 // the tile that becomes the window
let bar = null;                // its title bar: the drag handle
let on = false;
let rect = null;               // { x, y, w, h } in viewport px
let tint = 0.70;               // 0 = clear, 1 = solid
let style = STYLES[0].id;
let onChange = () => {};
let grips = [];
let drag = null;

const stacked = () => window.innerWidth <= STACK_WIDTH;

/** The strip the window must stay under: the top bar is always on top. */
function ceiling() {
  const top = document.getElementById('topbar');
  return top && !top.hidden ? Math.round(top.getBoundingClientRect().bottom) : 0;
}

/**
 * Where a window goes when it has never been placed: a tall column against
 * the right edge, over the results and the right of the editor. It reads as
 * a panel at first glance, and one drag proves it is not one.
 */
/** The largest a window may be, and the box it has to stay inside. */
function bounds() {
  const top = ceiling() + PAD;
  return {
    x: PAD, y: top,
    w: Math.max(MIN.w, window.innerWidth - 2 * PAD),
    h: Math.max(MIN.h, window.innerHeight - top - PAD),
  };
}

/**
 * Where a window goes when it has never been placed: a tall column against
 * the right edge, over the results and the right of the editor. It reads as
 * a panel at first glance, and one drag proves it is not one.
 */
export function defaultRect() {
  const b = bounds();
  const w = clamp(Math.round(window.innerWidth * 0.3), MIN.w, 460);
  // Not the full height available, deliberately: a window that exactly fills
  // its bounds has nowhere to be dragged, and the first thing anyone does
  // with a window is drag it. The gap under it is the invitation.
  const h = Math.max(MIN.h, Math.round(b.h * 0.88));
  return { x: b.x + b.w - w, y: b.y, w, h };
}

/** Keep a rectangle usable: big enough to work in, and wholly on the page. */
function fit(r) {
  const b = bounds();
  const w = clamp(r.w, MIN.w, b.w);
  const h = clamp(r.h, MIN.h, b.h);
  return {
    w, h,
    x: clamp(r.x, b.x, b.x + b.w - w),
    y: clamp(r.y, b.y, b.y + b.h - h),
  };
}

function paint() {
  if (!el || !on) return;
  el.style.left = px(rect.x);
  el.style.top = px(rect.y);
  el.style.width = px(rect.w);
  el.style.height = px(rect.h);
  el.style.setProperty('--win-tint', String(tint));
}

const save = () => onChange({ rect: { ...rect }, tint, style });

// ---------------------------------------------------------------------------
// Moving and resizing
// ---------------------------------------------------------------------------

/**
 * One pointer gesture drives both: a drag from the title bar moves the
 * window, a drag from a grip resizes it. `dir` is the compass direction of
 * the grip, or null for a move.
 */
function begin(e, dir) {
  if (e.button !== 0 || !on || stacked()) return;
  const target = e.currentTarget;
  drag = { id: e.pointerId, dir, x0: e.clientX, y0: e.clientY, start: { ...rect }, target };
  target.setPointerCapture?.(e.pointerId);
  document.body.classList.add('win-moving');
  e.preventDefault();
}

function step(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  const s = drag.start;

  if (!drag.dir) {
    rect = fit({ ...s, x: s.x + dx, y: s.y + dy });
  } else {
    // Each edge is clamped against the page here rather than left to `fit`:
    // clamping the size afterwards would slide the *opposite* edge, and the
    // edge you are not dragging is the one that has to stay where it is.
    const b = bounds();
    const r = { ...s };
    if (drag.dir.includes('e')) r.w = clamp(s.w + dx, MIN.w, b.x + b.w - s.x);
    if (drag.dir.includes('s')) r.h = clamp(s.h + dy, MIN.h, b.y + b.h - s.y);
    if (drag.dir.includes('w')) {
      r.w = clamp(s.w - dx, MIN.w, s.x + s.w - b.x);
      r.x = s.x + s.w - r.w;
    }
    if (drag.dir.includes('n')) {
      r.h = clamp(s.h - dy, MIN.h, s.y + s.h - b.y);
      r.y = s.y + s.h - r.h;
    }
    rect = fit(r);
  }
  paint();
}

function end(e) {
  if (!drag || (e?.pointerId !== undefined && e.pointerId !== drag.id)) return;
  drag.target.releasePointerCapture?.(drag.id);
  drag = null;
  document.body.classList.remove('win-moving');
  save();
}

/**
 * Double-clicking the bar sends the window back to the column it starts in,
 * the way double-clicking a title bar zooms a window -- and a second
 * double-click, from that position, fills the workspace instead.
 */
function zoom() {
  const home = defaultRect();
  const atHome = Math.abs(rect.x - home.x) < 6 && Math.abs(rect.w - home.w) < 6 &&
                 Math.abs(rect.y - home.y) < 6;
  rect = fit(atHome ? bounds() : home);
  paint();
  save();
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

function addGrips() {
  if (grips.length || !el) return;
  grips = DIRS.map((dir) => {
    const g = document.createElement('div');
    g.className = `win-grip win-grip-${dir}`;
    g.dataset.dir = dir;
    g.addEventListener('pointerdown', (e) => begin(e, dir));
    g.addEventListener('pointermove', step);
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    el.append(g);
    return g;
  });
}

function dropGrips() {
  grips.forEach((g) => g.remove());
  grips = [];
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * @param {object}   o
 * @param {string}   o.tile      the `data-tile` name of the tile to float
 * @param {object}   [o.rect]    a saved rectangle, if there is one
 * @param {number}   [o.tint]    saved opacity, 0..1
 * @param {Function} [o.onChange] called with { rect, tint } after every change
 */
export function init({ tile, rect: saved = null, tint: savedTint = null,
                       style: savedStyle = null, onChange: cb = () => {} } = {}) {
  el = document.querySelector(`[data-tile="${tile}"]`);
  if (!el) return;
  bar = el.querySelector('.tile-bar');
  onChange = cb;
  if (typeof savedTint === 'number') tint = clamp(savedTint, 0.25, 1);
  style = styleAt(savedStyle).id;
  el.dataset.winStyle = style;
  rect = fit(saved && Number.isFinite(saved.w) ? saved : defaultRect());

  bar.addEventListener('pointerdown', (e) => {
    if (!on || e.target.closest('button, a, input, select, textarea')) return;
    begin(e, null);
  });
  bar.addEventListener('pointermove', step);
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', (e) => {
    if (!on || e.target.closest('button, a, input, select, textarea')) return;
    zoom();
  });

  // A window that survives a reload has to survive a resized window too.
  window.addEventListener('resize', () => {
    if (!on) return;
    rect = fit(rect);
    paint();
  });
}

/** Float the tile, or dock it back into the layout. */
export function setOn(next) {
  on = !!next;
  if (!el) return;
  el.classList.toggle('tile-float', on);
  document.body.classList.toggle('win-float', on);
  if (on) {
    rect = fit(rect || defaultRect());
    addGrips();
    paint();
  } else {
    dropGrips();
    for (const k of ['left', 'top', 'width', 'height']) el.style.removeProperty(k);
  }
}

export const isOn = () => on;

/** 0.25 (barely there) .. 1 (opaque). */
export function setTint(next) {
  tint = clamp(Number(next) || 0, 0.25, 1);
  paint();
  save();
}
export const getTint = () => tint;

/**
 * Wear the next frame along, and move the tint to the one that frame was
 * drawn for. Returns the style now in force so the caller can label the
 * button and say what happened.
 */
export function nextStyle() {
  const i = STYLES.findIndex((s) => s.id === style);
  const next = STYLES[(i + 1) % STYLES.length];
  style = next.id;
  tint = next.tint;
  if (el) el.dataset.winStyle = style;
  paint();
  save();
  return next;
}

/** The style in force, for a label or a tooltip. */
export const currentStyle = () => styleAt(style);

/** Put the window back where it starts, at the size it starts. */
export function home() {
  rect = fit(defaultRect());
  paint();
  save();
}
