// ===========================================================================
//  Tiled layout.
//  The four tiles -- the exercise list, the exercise prompt, the editor and
//  the results panel -- are the leaves of a tree of splits. A split is a row
//  or a column; the seam between two children is a draggable splitter, and a
//  tile can be picked up by its bar and dropped against the left, right, top
//  or bottom edge of any other tile (or of the window) to rebuild the tree.
//  This module owns the arithmetic (clamping, what counts as "too small",
//  what happens on a window resize) and the tree surgery, and hands the
//  result back so the caller can persist it; it knows nothing about SQL,
//  exercises or storage.
//
//  Sizes are in pixels, not fractions: a fraction re-scales the editor every
//  time the window changes height, which is exactly what you do not want
//  while typing a query. Exactly one child of every split is elastic -- the
//  one that holds the results panel, or failing that the last one -- and it
//  absorbs whatever the window gains or loses, so every other tile keeps the
//  size you gave it.
// ===========================================================================

/** Below this width the stylesheet stacks the tiles and hides the splitters. */
const STACK_WIDTH = 1000;

/** Splitter thickness. Must match `.split-col` / `.split-row` in the CSS. */
const BAR = 5;

/** Keyboard resize step for a focused splitter. */
const STEP = 16;

/** Ceiling for a prompt that sizes itself to its text. */
const PROMPT_FIT_MAX = 0.42;

/** The tiles, in the order they appear in the markup. */
const PANES = ['sidebar', 'prompt', 'editor', 'assistant', 'output'];

/** Smallest usable size for each tile, per axis, in px. */
const MIN = {
  sidebar:   { x: 190, y: 120 },
  prompt:    { x: 240, y:  88 },
  editor:    { x: 300, y: 160 },
  assistant: { x: 280, y: 180 },
  output:    { x: 280, y: 120 },
};

/** Size a tile gets when it lands in a slot that has no measurement yet. */
const DEFAULT = {
  sidebar:   { x: 284, y: 220 },
  prompt:    { x: 360, y: 196 },
  editor:    { x: 480, y: 300 },
  assistant: { x: 380, y: 320 },
  output:    { x: 520, y: 300 },
};

/** side -> which way the split runs, and which side of it the tile lands on. */
const SIDES = {
  left:   { dir: 'row', before: true  },
  right:  { dir: 'row', before: false },
  top:    { dir: 'col', before: true  },
  bottom: { dir: 'col', before: false },
};

/** How close to an edge the pointer has to be for that edge to win a drop. */
const EDGE_FRACTION = 0.3;
const ROOT_EDGE = 26;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const px = (n) => `${Math.round(n)}px`;
const axisOf = (dir) => (dir === 'row' ? 'x' : 'y');
const isLeaf = (n) => typeof n?.pane === 'string';

/** The live tile elements, looked up once: a re-render moves them around. */
const tiles = new Map();
const tileEl = (pane) => tiles.get(pane) || null;
const host = () => document.getElementById('layout');
const stacked = () => window.innerWidth <= STACK_WIDTH;

/**
 * Tiles that are currently taking up no room. The prompt goes when Sandbox
 * mode is on; the Claude panel is closed until someone asks for it, and is
 * the only tile that starts that way -- so a visitor who never opens it sees
 * exactly the layout this site has always had.
 */
const hidden = new Set(['assistant']);
const tileHidden = (pane) =>
  hidden.has(pane) || (pane === 'prompt' && document.body.classList.contains('sandbox'));

/** Show or hide a tile without disturbing where it sits in the tree. */
export function setHidden(pane, off) {
  if (!PANES.includes(pane)) return;
  if (off) hidden.add(pane); else hidden.delete(pane);
  apply();
}
export const isHidden = (pane) => hidden.has(pane);
const visible = (n) => (isLeaf(n) ? !tileHidden(n.pane) : n.children.some(visible));
const holds = (n, pane) => (isLeaf(n) ? n.pane === pane : n.children.some((c) => holds(c, pane)));
const leadPane = (n) => (isLeaf(n) ? n.pane : leadPane(n.children[0]));
const nameOf = (pane) =>
  tileEl(pane)?.querySelector('.tile-name')?.textContent?.trim() || pane;

let tree = null;
let onChange = () => {};

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

const leaf = (pane, size = null, sizeAxis = null, auto = false) =>
  ({ pane, size, sizeAxis, auto });

function defaultTree() {
  return {
    dir: 'row', size: null, sizeAxis: null,
    children: [
      leaf('sidebar', DEFAULT.sidebar.x, 'x'),
      {
        dir: 'col', size: null, sizeAxis: null,
        children: [
          leaf('prompt', DEFAULT.prompt.y, 'y', true),
          // The editor and the Claude panel share a row, so the panel is
          // beside the query rather than under it -- that is the whole point
          // of it. It is hidden until asked for, and a hidden tile costs the
          // editor nothing.
          {
            dir: 'row', size: DEFAULT.editor.y, sizeAxis: 'y',
            children: [
              leaf('editor', DEFAULT.editor.x, 'x'),
              leaf('assistant', DEFAULT.assistant.x, 'x'),
            ],
          },
          leaf('output', DEFAULT.output.y, 'y'),
        ],
      },
    ],
  };
}

/** Smallest this node can be along `axis`, with its own structure accounted for. */
function minOf(node, axis) {
  if (isLeaf(node)) return MIN[node.pane][axis];
  const vis = node.children.filter(visible);
  if (!vis.length) return 0;
  const mins = vis.map((c) => minOf(c, axis));
  return axisOf(node.dir) === axis
    ? mins.reduce((a, b) => a + b, 0) + (vis.length - 1) * BAR
    : Math.max(...mins);
}

/** What this node would like to be along `axis`, for a slot never measured. */
function hint(node, axis) {
  if (isLeaf(node)) return DEFAULT[node.pane][axis];
  const vis = node.children.filter(visible);
  if (!vis.length) return 0;
  const want = vis.map((c) => hint(c, axis));
  return axisOf(node.dir) === axis
    ? want.reduce((a, b) => a + b, 0) + (vis.length - 1) * BAR
    : Math.max(...want);
}

/**
 * A size measured across a row means nothing once the slot becomes a column,
 * so it is thrown away and the tile asks for its preferred size instead. A
 * size that is merely out of range is left alone: sizeNode clamps it, which
 * is what makes a drag past a floor stop at the floor instead of snapping
 * back to the default.
 */
function normalize(node, axis) {
  if (node.sizeAxis !== axis || !Number.isFinite(node.size)) {
    node.size = hint(node, axis);
    node.sizeAxis = axis;
  }
}

function findLeaf(pane, from = tree) {
  if (!from) return null;
  if (isLeaf(from)) return from.pane === pane ? from : null;
  for (const c of from.children) {
    const found = findLeaf(pane, c);
    if (found) return found;
  }
  return null;
}

function parentOf(node, from = tree) {
  if (!from || isLeaf(from)) return null;
  if (from.children.includes(node)) return from;
  for (const c of from.children) {
    const p = parentOf(node, c);
    if (p) return p;
  }
  return null;
}

/**
 * The elastic child of a split: whichever one holds the results panel, else
 * the last visible one that is not the Claude panel. Everything else in the
 * split is a fixed pixel size, so a resize anywhere is absorbed here.
 *
 * The Claude panel is excluded because it is a side panel: it sits at the end
 * of the row it shares with the editor, so the plain "last one" rule would
 * hand it every pixel a wider window brings and leave the editor -- where the
 * work happens -- exactly as narrow as it was.
 */
function growChild(node) {
  const vis = node.children.filter(visible);
  const body = vis.filter((c) => !holds(c, 'assistant'));
  return vis.find((c) => holds(c, 'output'))
      ?? body[body.length - 1]
      ?? vis[vis.length - 1] ?? null;
}

/**
 * Tidy the tree after surgery: drop empty splits, replace a split that has a
 * single child with that child, and merge a split into a parent that runs the
 * same way. Keeping it shallow keeps seam ids and drags predictable.
 */
function collapseNode(node) {
  if (isLeaf(node)) return node;
  const kids = node.children.map(collapseNode).filter(Boolean);
  const flat = [];
  for (const c of kids) {
    if (!isLeaf(c) && c.dir === node.dir) flat.push(...c.children);
    else flat.push(c);
  }
  if (!flat.length) return null;
  if (flat.length === 1) {
    const only = flat[0];
    only.size = node.size;            // it inherits the slot it now fills
    only.sizeAxis = node.sizeAxis;
    return only;
  }
  node.children = flat;
  return node;
}
const collapse = () => { tree = collapseNode(tree) || defaultTree(); };

function detach(node) {
  const p = parentOf(node);
  if (!p) return false;
  p.children.splice(p.children.indexOf(node), 1);
  collapse();
  return true;
}

/** Put `pane` against one side of `targetPane`. */
function placeBeside(pane, targetPane, side) {
  const spec = SIDES[side];
  const node = findLeaf(pane);
  const target = findLeaf(targetPane);
  if (!spec || !node || !target || node === target) return false;

  detach(node);
  node.sizeAxis = null;                     // it is about to change slots
  const pair = (a, b) => (spec.before ? [a, b] : [b, a]);
  const parent = parentOf(target);

  if (parent && parent.dir === spec.dir) {
    const i = parent.children.indexOf(target);
    parent.children.splice(spec.before ? i : i + 1, 0, node);
  } else if (!parent) {
    tree = { dir: spec.dir, size: null, sizeAxis: null, children: pair(node, tree) };
  } else {
    const i = parent.children.indexOf(target);
    parent.children[i] = {
      dir: spec.dir, size: target.size, sizeAxis: target.sizeAxis,
      children: pair(node, target),
    };
    target.sizeAxis = null;                 // the two now share the old slot
  }
  collapse();
  return true;
}

/** Put `pane` against one edge of the whole window. */
function attachAtEdge(pane, side) {
  const spec = SIDES[side];
  const node = findLeaf(pane);
  if (!spec || !node) return false;
  detach(node);
  node.sizeAxis = null;
  if (isLeaf(tree) || tree.dir !== spec.dir) {
    tree = {
      dir: spec.dir, size: null, sizeAxis: null,
      children: spec.before ? [node, tree] : [tree, node],
    };
  } else if (spec.before) {
    tree.children.unshift(node);
  } else {
    tree.children.push(node);
  }
  collapse();
  return true;
}

/** Trade two tiles' slots, leaving the shape of the layout alone. */
function swapPanes(a, b) {
  const A = findLeaf(a);
  const B = findLeaf(b);
  if (!A || !B || A === B) return false;
  [A.pane, B.pane] = [B.pane, A.pane];
  [A.auto, B.auto] = [B.auto, A.auto];
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Seam ids handed out in the current render, so no two can collide. */
const seamIds = new Set();

/**
 * A seam. Its id names the tile the seam actually resizes -- `#split-sidebar`,
 * `#split-prompt`, `#split-editor` in the default layout -- which is the same
 * tile its label names. That is usually the tile in front of it, but not when
 * the tile in front is the elastic one: there the seam resizes what is behind
 * it instead, and the id follows.
 *
 * Tree surgery can still put two seams in front of the same tile (drop the
 * results panel beside the exercise list and both seams answer to the
 * sidebar), so the second one to be built takes a suffix. Duplicate ids break
 * every query in this module and every test that names a seam, and a layout
 * anyone can rearrange by hand cannot promise they never happen.
 */
function splitter(node, i, axis) {
  const bar = document.createElement('div');
  const target = seamTarget(node, i);
  const lead = leadPane(target.node ?? node.children[i - 1]);
  let id = `split-${lead}`;
  for (let n = 2; seamIds.has(id); n++) id = `split-${lead}-${n}`;
  seamIds.add(id);
  bar.id = id;
  bar.className = `splitter ${axis === 'x' ? 'split-col' : 'split-row'}`;
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  bar.setAttribute('aria-label', `Resize ${nameOf(lead)}`);
  bar.title = 'Drag to resize · double-click to reset';
  bar.tabIndex = 0;
  wireSplitter(bar, node, i, axis);
  return bar;
}

function build(node) {
  if (isLeaf(node)) {
    node._el = tileEl(node.pane);
    return node._el;
  }
  const el = document.createElement('div');
  el.className = `dock-split dock-${node.dir}`;
  const axis = axisOf(node.dir);
  node.children.forEach((c, i) => {
    c._bar = i > 0 ? splitter(node, i, axis) : null;
    if (c._bar) el.append(c._bar);
    const childEl = build(c);
    if (childEl) el.append(childEl);
  });
  node._el = el;
  return el;
}

/** Re-parenting a textarea keeps its value, but not the caret. */
function saveFocus() {
  const el = document.activeElement;
  if (!el || !host()?.contains(el)) return null;
  const sel = typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null;
  return { el, sel };
}
function restoreFocus(keep) {
  if (!keep?.el?.isConnected) return;
  keep.el.focus({ preventScroll: true });
  if (keep.sel) { try { keep.el.setSelectionRange(keep.sel[0], keep.sel[1]); } catch { /* not a text field */ } }
}

function render() {
  const root = host();
  if (!root) return;
  const keep = saveFocus();
  seamIds.clear();
  root.replaceChildren(build(tree));
  restoreFocus(keep);
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function clearInline(node) {
  if (node._el) {
    node._el.style.flex = '';
    node._el.style.display = isLeaf(node) && tileHidden(node.pane) ? 'none' : '';
  }
  if (node._bar) node._bar.style.display = '';
  if (!isLeaf(node)) node.children.forEach(clearInline);
}

function sizeNode(node) {
  if (isLeaf(node) || !node._el) return;
  const axis = axisOf(node.dir);
  const box = axis === 'x' ? node._el.clientWidth : node._el.clientHeight;

  // A seam only earns its 5px when there is a visible tile on both sides.
  let seen = 0;
  for (const c of node.children) {
    const show = visible(c);
    if (c._bar) c._bar.style.display = show && seen ? '' : 'none';
    if (c._el) c._el.style.display = show ? '' : 'none';
    if (show) seen++;
  }

  const vis = node.children.filter(visible);
  const grow = growChild(node);
  if (!grow) return;
  const fixed = vis.filter((c) => c !== grow);

  // Each fixed child in turn takes what it asks for, but never so much that a
  // later one -- or the elastic one -- would drop below its floor.
  let room = Math.max(0, box - Math.max(0, seen - 1) * BAR - minOf(grow, axis));
  fixed.forEach((c, i) => {
    normalize(c, axis);
    const later = fixed.slice(i + 1).reduce((sum, o) => sum + minOf(o, axis), 0);
    const lo = minOf(c, axis);
    c.size = clamp(c.size, lo, Math.max(lo, room - later));
    room -= c.size;
    if (c._el) c._el.style.flex = `0 0 ${px(c.size)}`;
  });
  if (grow._el) grow._el.style.flex = '1 1 0';

  // A child can only be measured once its parent's flex is resolved.
  for (const c of vis) sizeNode(c);
}

function apply({ persist = false } = {}) {
  const root = host();
  if (!root || !tree) return;
  if (stacked()) {
    root.classList.add('dock-stacked');
    clearInline(tree);
  } else {
    root.classList.remove('dock-stacked');
    if (tree._el) tree._el.style.flex = '1 1 auto';
    sizeNode(tree);
  }
  if (persist) onChange(current());
}

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------

/**
 * Which node a seam resizes: the child in front of it, unless that child is
 * the elastic one -- there is nothing to set on an elastic child, so the seam
 * resizes the child behind it instead and the drag direction flips.
 */
function seamTarget(node, i) {
  const grow = growChild(node);
  const prev = node.children[i - 1];
  const next = node.children[i];
  return prev === grow ? { node: next, sign: -1 } : { node: prev, sign: 1 };
}

function wireSplitter(bar, node, i, axis) {
  let target = null, from = 0, start = 0;

  const grab = (e) => {
    if (e.button !== 0 || stacked()) return;
    e.preventDefault();
    target = seamTarget(node, i);
    if (!target.node) { target = null; return; }
    normalize(target.node, axis);
    // Dragging the prompt's own seam takes its auto-height over for good.
    if (isLeaf(target.node) && target.node.pane === 'prompt') target.node.auto = false;
    from = axis === 'x' ? e.clientX : e.clientY;
    start = target.node.size;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('splitter-on');
    document.body.classList.add(axis === 'x' ? 'resizing-col' : 'resizing-row');
  };

  bar.addEventListener('pointerdown', grab);

  bar.addEventListener('pointermove', (e) => {
    if (!target || !bar.hasPointerCapture(e.pointerId)) return;
    const now = axis === 'x' ? e.clientX : e.clientY;
    target.node.size = start + (now - from) * target.sign;
    apply();
  });

  const end = (e) => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    bar.releasePointerCapture(e.pointerId);
    bar.classList.remove('splitter-on');
    document.body.classList.remove('resizing-col', 'resizing-row');
    target = null;
    apply({ persist: true });
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  // Double-click puts this split back to its preferred sizes -- the usual
  // escape hatch for a seam dragged somewhere unhelpful.
  bar.addEventListener('dblclick', () => {
    for (const c of node.children) {
      c.size = hint(c, axis);
      c.sizeAxis = axis;
      if (isLeaf(c) && c.pane === 'prompt') c.auto = true;
    }
    apply({ persist: true });
    fitPrompt();
  });

  // A seam is focusable, so it has to answer the arrow keys too.
  bar.addEventListener('keydown', (e) => {
    const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const fwd  = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (![back, fwd, 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const t = seamTarget(node, i);
    if (!t.node) return;
    normalize(t.node, axis);
    if (isLeaf(t.node) && t.node.pane === 'prompt') t.node.auto = false;
    if (e.key === back) t.node.size -= STEP * t.sign;
    else if (e.key === fwd) t.node.size += STEP * t.sign;
    else t.node.size = e.key === 'Home' ? 0 : 1e6;   // apply() clamps to the real extremes
    apply({ persist: true });
  });
}

// ---------------------------------------------------------------------------
// Moving tiles
// ---------------------------------------------------------------------------

let live = null;                        // the polite announcement region

function announce(msg) {
  if (!live) {
    live = document.createElement('div');
    live.id = 'dock-live';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = msg;
}

/** Everything a structural change has to do, in one place. */
function commit(msg) {
  render();
  apply({ persist: true });
  fitPrompt();
  if (msg) announce(msg);
}

/** Move a tile to one edge of the window. `side` is left/right/top/bottom. */
export function move(pane, side) {
  if (stacked() || !SIDES[side]) return;
  if (attachAtEdge(pane, side)) commit(`${nameOf(pane)} moved to the ${side} edge`);
}

/** Put a tile against one side of another one, or swap the two. */
export function dropOn(pane, targetPane, side) {
  if (side === 'swap') {
    if (swapPanes(pane, targetPane)) commit(`${nameOf(pane)} swapped with ${nameOf(targetPane)}`);
    return;
  }
  if (placeBeside(pane, targetPane, side)) {
    commit(`${nameOf(pane)} moved to the ${side} of ${nameOf(targetPane)}`);
  }
}

/** Back to the arrangement the site ships with. */
export function reset() {
  tree = defaultTree();
  commit('Layout reset');
}

// --- drag and drop ---------------------------------------------------------

let drag = null;
let dropBox = null, ghostEl = null;

function chrome() {
  if (!dropBox) {
    dropBox = document.createElement('div');
    dropBox.id = 'dock-drop';
    dropBox.hidden = true;
    dropBox.innerHTML = '<span class="dock-drop-label"></span>';
    ghostEl = document.createElement('div');
    ghostEl.id = 'dock-ghost';
    ghostEl.hidden = true;
    document.body.append(dropBox, ghostEl);
  }
  return { dropBox, ghostEl };
}

/**
 * Where a drop at (x, y) would put the tile: against an edge of the window,
 * against an edge of the tile under the pointer, or swapped with it.
 */
function hitTest(x, y, dragged) {
  const root = host()?.getBoundingClientRect();
  if (!root) return null;
  if (x < root.left || x > root.right || y < root.top || y > root.bottom) return null;

  if (x - root.left < ROOT_EDGE)   return { kind: 'root', side: 'left' };
  if (root.right - x < ROOT_EDGE)  return { kind: 'root', side: 'right' };
  if (y - root.top < ROOT_EDGE)    return { kind: 'root', side: 'top' };
  if (root.bottom - y < ROOT_EDGE) return { kind: 'root', side: 'bottom' };

  const el = document.elementFromPoint(x, y)?.closest('[data-tile]');
  const pane = el?.dataset.tile;
  if (!el || !pane || pane === dragged) return null;
  const r = el.getBoundingClientRect();
  const near = {
    left: (x - r.left) / r.width,  right: (r.right - x) / r.width,
    top:  (y - r.top) / r.height,  bottom: (r.bottom - y) / r.height,
  };
  const side = Object.keys(near).reduce((a, b) => (near[b] < near[a] ? b : a));
  if (near[side] > EDGE_FRACTION) return { kind: 'tile', pane, side: 'swap' };
  return { kind: 'tile', pane, side };
}

function paintDrop(drop) {
  const { dropBox: box } = chrome();
  if (!drop) { box.hidden = true; return; }
  const label = box.querySelector('.dock-drop-label');
  let r;
  if (drop.kind === 'root') {
    const root = host().getBoundingClientRect();
    const band = (n) => Math.max(120, Math.round(n * 0.25));
    const w = band(root.width), h = band(root.height);
    r = {
      left:  drop.side === 'right' ? root.right - w : root.left,
      top:   drop.side === 'bottom' ? root.bottom - h : root.top,
      width:  drop.side === 'left' || drop.side === 'right' ? w : root.width,
      height: drop.side === 'top' || drop.side === 'bottom' ? h : root.height,
    };
    label.textContent = `${drop.side} edge of the window`;
  } else {
    const t = tileEl(drop.pane).getBoundingClientRect();
    const half = { width: Math.round(t.width / 2), height: Math.round(t.height / 2) };
    if (drop.side === 'swap') {
      r = { left: t.left, top: t.top, width: t.width, height: t.height };
      label.textContent = `swap with ${nameOf(drop.pane)}`;
    } else if (drop.side === 'left' || drop.side === 'right') {
      r = { left: drop.side === 'right' ? t.left + half.width : t.left, top: t.top,
            width: half.width, height: t.height };
      label.textContent = `${drop.side} of ${nameOf(drop.pane)}`;
    } else {
      r = { left: t.left, top: drop.side === 'bottom' ? t.top + half.height : t.top,
            width: t.width, height: half.height };
      label.textContent = `${drop.side} of ${nameOf(drop.pane)}`;
    }
  }
  box.style.left = px(r.left);
  box.style.top = px(r.top);
  box.style.width = px(r.width);
  box.style.height = px(r.height);
  box.hidden = false;
}

function onTileDown(e) {
  const bar = e.target.closest?.('.tile-bar');
  if (!bar || e.button !== 0 || stacked()) return;
  if (e.target.closest('button, a, input, select, textarea')) return;
  const pane = bar.closest('[data-tile]')?.dataset.tile;
  if (!pane) return;
  drag = { pane, id: e.pointerId, x0: e.clientX, y0: e.clientY, bar, on: false, drop: null };
  bar.setPointerCapture(e.pointerId);
}

function onTileMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.on) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
    drag.on = true;
    document.body.classList.add('dock-dragging');
    tileEl(drag.pane)?.classList.add('tile-dragging');
    const { ghostEl: ghost } = chrome();
    ghost.textContent = nameOf(drag.pane);
    ghost.hidden = false;
  }
  const { ghostEl: ghost } = chrome();
  ghost.style.left = px(e.clientX + 12);
  ghost.style.top = px(e.clientY + 14);
  drag.drop = hitTest(e.clientX, e.clientY, drag.pane);
  paintDrop(drag.drop);
}

function endTileDrag(e, cancel = false) {
  if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.id)) return;
  const { pane, drop, on, bar, id } = drag;
  drag = null;
  if (bar.hasPointerCapture?.(id)) bar.releasePointerCapture(id);
  document.body.classList.remove('dock-dragging');
  tileEl(pane)?.classList.remove('tile-dragging');
  if (ghostEl) ghostEl.hidden = true;
  paintDrop(null);
  if (!on || cancel || !drop) return;
  if (drop.kind === 'root') move(pane, drop.side);
  else dropOn(pane, drop.pane, drop.side);
}

function wireTiles() {
  const root = host();
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.tile-move');
    if (!btn) return;
    const pane = btn.closest('[data-tile]')?.dataset.tile;
    if (pane) move(pane, btn.dataset.move);
  });
  root.addEventListener('pointerdown', onTileDown);
  root.addEventListener('pointermove', onTileMove);
  root.addEventListener('pointerup', (e) => endTileDrag(e));
  root.addEventListener('pointercancel', (e) => endTileDrag(e, true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag) { e.preventDefault(); endTileDrag(null, true); }
  });
}

// ---------------------------------------------------------------------------
// The prompt's auto height
// ---------------------------------------------------------------------------

/**
 * Size the prompt tile to the exercise text, the way it behaved before there
 * were seams -- a two-line prompt should not reserve room for a ten-line one.
 * Dragging the prompt seam takes that over for good; double-clicking it hands
 * it back. Only a tile stacked above or below something can fit its height;
 * side by side there is nothing to fit.
 */
export function fitPrompt() {
  const node = findLeaf('prompt');
  if (!node || !node.auto || stacked()) return;
  const parent = parentOf(node);
  if (!parent || axisOf(parent.dir) !== 'y' || node === growChild(parent)) return;
  const pane = node._el;
  if (!pane) return;
  // Measured unconstrained: scrollHeight against a fixed height can only grow.
  const flex = pane.style.flex;
  pane.style.flex = '0 0 auto';
  pane.style.height = 'auto';
  const content = pane.scrollHeight;
  pane.style.height = '';
  pane.style.flex = flex;
  node.size = clamp(content, MIN.prompt.y, Math.round(window.innerHeight * PROMPT_FIT_MAX));
  node.sizeAxis = 'y';
  apply();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Whatever was stored last time, minus anything that stopped making sense. */
function sanitize(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const size = Number(raw.size);
  const keptSize = Number.isFinite(size) && size > 0 ? size : null;
  const keptAxis = raw.sizeAxis === 'x' || raw.sizeAxis === 'y' ? raw.sizeAxis : null;
  if (typeof raw.pane === 'string') {
    if (!PANES.includes(raw.pane) || seen.has(raw.pane)) return null;
    seen.add(raw.pane);
    return leaf(raw.pane, keptSize, keptAxis, !!raw.auto);
  }
  const kids = (Array.isArray(raw.children) ? raw.children : [])
    .map((c) => sanitize(c, seen)).filter(Boolean);
  if (!kids.length) return null;
  return { dir: raw.dir === 'col' ? 'col' : 'row', size: keptSize, sizeAxis: keptAxis, children: kids };
}

/** Pre-tree storage: three pixel sizes against the layout this site shipped with. */
function fromLegacy(saved) {
  const t = defaultTree();
  const [side, col] = t.children;
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  if (n(saved?.sidebar)) side.size = n(saved.sidebar);
  if (n(saved?.prompt))  col.children[0].size = n(saved.prompt);
  if (n(saved?.editor))  col.children[1].size = n(saved.editor);
  col.children[0].auto = saved?.autoPrompt !== false;
  return t;
}

function adopt(saved) {
  if (!saved?.tree) return fromLegacy(saved);
  const seen = new Set();
  const stored = sanitize(saved.tree, seen);
  if (!stored) return defaultTree();
  tree = stored;
  collapse();
  // A tile the stored tree lost comes back at the bottom rather than
  // vanishing -- except the Claude panel, which belongs beside the editor and
  // would be useless stretched across the foot of the window.
  for (const pane of PANES) {
    if (seen.has(pane)) continue;
    if (pane === 'assistant' && findLeaf('editor')) {
      tree = {
        dir: 'col', size: null, sizeAxis: null,
        children: [tree, leaf(pane, DEFAULT[pane].x, 'x')],
      };
      collapse();
      placeBeside('assistant', 'editor', 'right');
      continue;
    }
    tree = {
      dir: 'col', size: null, sizeAxis: null,
      children: [tree, leaf(pane, DEFAULT[pane].y, 'y', pane === 'prompt')],
    };
  }
  collapse();
  return tree;
}

/** The current arrangement, ready to be stored. */
export function current() {
  const out = (n) => {
    const slot = {};
    if (Number.isFinite(n.size)) slot.size = Math.round(n.size);
    if (n.sizeAxis) slot.sizeAxis = n.sizeAxis;
    return isLeaf(n)
      ? { pane: n.pane, ...slot, auto: !!n.auto }
      : { dir: n.dir, ...slot, children: n.children.map(out) };
  };
  return { tree: out(tree) };
}

// ---------------------------------------------------------------------------
// The tab strip
// ---------------------------------------------------------------------------

const tabOrder = (strip) => [...strip.querySelectorAll('.tab')].map((t) => t.dataset.tab);

let tabStrip = null;
let tabMarkup = [];        // the order the markup ships with
let onTabs = () => {};

/**
 * Let the output tabs be dragged into the order you want them in -- drag one
 * sideways, or focus it and use shift + the arrow keys. `saved` is the order
 * stored last time; tabs it does not mention keep their place in the markup.
 */
export function initTabs({ strip = '#tabs', saved = [], onReorder = () => {} } = {}) {
  const el = document.querySelector(strip);
  if (!el) return;
  tabStrip = el;
  onTabs = onReorder;
  tabMarkup = tabOrder(el);
  orderTabs(saved);

  let held = null;

  el.addEventListener('pointerdown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.button !== 0) return;
    held = { tab, x0: e.clientX, id: e.pointerId, moved: false };
    tab.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!held || e.pointerId !== held.id) return;
    if (!held.moved) {
      if (Math.abs(e.clientX - held.x0) < 5) return;
      held.moved = true;
      held.tab.classList.add('tab-dragging');
    }
    const over = [...el.querySelectorAll('.tab')].find((t) => {
      if (t === held.tab) return false;
      const r = t.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right;
    });
    if (!over) return;
    const r = over.getBoundingClientRect();
    over.insertAdjacentElement(e.clientX > r.left + r.width / 2 ? 'afterend' : 'beforebegin', held.tab);
  });

  const drop = (e, cancel = false) => {
    if (!held || (e && e.pointerId !== held.id)) return;
    const { tab, moved, id } = held;
    held = null;
    if (tab.hasPointerCapture?.(id)) tab.releasePointerCapture(id);
    tab.classList.remove('tab-dragging');
    if (!moved || cancel) return;
    // A tab that was dragged must not also be selected by the click that ends
    // the drag -- you were rearranging, not switching.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    el.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 250);
    onReorder(tabOrder(el));
  };
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', (e) => drop(e, true));

  el.addEventListener('keydown', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const sib = e.key === 'ArrowLeft' ? tab.previousElementSibling : tab.nextElementSibling;
    if (!sib?.classList.contains('tab')) return;
    e.preventDefault();
    sib.insertAdjacentElement(e.key === 'ArrowLeft' ? 'beforebegin' : 'afterend', tab);
    tab.focus();
    onReorder(tabOrder(el));
  });
}

/** Put the strip in `order`; tabs it does not name keep their place after it. */
function orderTabs(order) {
  if (!tabStrip) return;
  const tabs = [...tabStrip.querySelectorAll('.tab')];
  const wanted = (Array.isArray(order) ? order : [])
    .map((name) => tabs.find((t) => t.dataset.tab === name))
    .filter(Boolean);
  for (const t of [...wanted, ...tabs.filter((t) => !wanted.includes(t))]) tabStrip.append(t);
}

/** Back to the tab order the markup ships with. */
export function resetTabs() {
  if (!tabStrip) return;
  orderTabs(tabMarkup);
  onTabs([]);
  announce('Tab order reset');
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------

/**
 * `saved` is whatever was persisted last time (a tree, or the three pixel
 * sizes this module used to store; junk is clamped or dropped), `onLayout` is
 * called with the full arrangement whenever the user settles on a new one.
 */
export function init({ saved = {}, onLayout = () => {} } = {}) {
  onChange = onLayout;
  tiles.clear();
  for (const pane of PANES) {
    const el = document.querySelector(`[data-tile="${pane}"]`);
    if (el) tiles.set(pane, el);
  }
  tree = adopt(saved);
  render();
  apply();
  fitPrompt();
  wireTiles();
  window.addEventListener('resize', () => { apply(); fitPrompt(); });
}

/**
 * Re-clamp after something outside this module changed how much room there is
 * -- entering or leaving Sandbox mode hides the prompt tile and its seam.
 */
export function refresh() { apply(); }
