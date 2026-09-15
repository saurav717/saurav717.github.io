// ===========================================================================
//  The table hover card.
//
//  Anything carrying data-table="<name>" -- a chip in the exercise header, a
//  `table_name` in the prompt text, a hint -- opens a card showing what that
//  table is for, its columns with types, which ones are nullable, and the
//  join keys that reach the rest of the warehouse.
//
//  One card element, one set of delegated listeners: the prompt re-renders on
//  every exercise switch, and per-element listeners would leak with it.
//
//  Hover opens it, so does keyboard focus (every trigger is focusable), and a
//  click pins it open -- which is the only way in on a touch screen, where
//  there is no hover at all.
// ===========================================================================

const SHOW_DELAY = 110;   // ms -- long enough that skimming the prompt is quiet
const HIDE_DELAY = 140;   // ms -- long enough to move the pointer into the card

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

let card = null;
let lookup = () => null;
let trigger = null;        // the element the card currently describes
let pinned = false;
let showTimer = 0, hideTimer = 0;

/**
 * @param {(name: string) => ?{name, rowCount, purpose, columns}} tableLookup
 *        Resolves a table name to its documentation, or null if unknown.
 */
export function init(tableLookup) {
  lookup = tableLookup;
  if (card) return;

  card = document.createElement('div');
  card.className = 'tbl-card';
  card.id = 'tbl-card';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  document.body.append(card);

  // Staying on the card itself keeps it open -- the column list can scroll.
  card.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  card.addEventListener('pointerleave', () => { if (!pinned) scheduleHide(); });

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;          // touch gets the click path
    const t = target(e);
    if (t) scheduleShow(t);
    else if (!pinned && trigger && !card.contains(e.target)) scheduleHide();
  });

  document.addEventListener('pointerdown', (e) => {
    const t = target(e);
    if (t) {
      if (pinned && t === trigger) { hide(); return; }
      show(t, true);
      return;                       // the focusin below must not unpin it again
    }
    if (!card.contains(e.target)) hide();
  });

  document.addEventListener('focusin', (e) => {
    const t = target(e);
    if (t) { if (t !== trigger || card.hidden) show(t, false); }
    else if (!pinned && !card.contains(e.target)) hide();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && trigger) { const t = trigger; hide(); t.focus?.(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    if (pinned && t === trigger) hide(); else show(t, true);
  });

  // A card positioned against a rect that has moved is worse than no card --
  // but scrolling the card's own column list must not close it.
  addEventListener('scroll', (e) => {
    if (!(e.target instanceof Node) || !card.contains(e.target)) hide();
  }, true);
  addEventListener('resize', () => hide());
}

const target = (e) => (e.target instanceof Element ? e.target.closest('[data-table]') : null);

function scheduleShow(el) {
  clearTimeout(hideTimer);
  if (el === trigger && !card.hidden) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => show(el, false), SHOW_DELAY);
}
function scheduleHide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_DELAY);
}

function show(el, pin) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  const doc = lookup(el.dataset.table);
  if (!doc) return;

  card.innerHTML = render(doc);
  card.hidden = false;
  pinned = pin;
  card.classList.toggle('tbl-card-pinned', pin);
  if (trigger && trigger !== el) trigger.removeAttribute('aria-describedby');
  trigger = el;
  el.setAttribute('aria-describedby', 'tbl-card');
  place(el);
}

function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (!card) return;
  card.hidden = true;
  card.classList.remove('tbl-card-pinned');
  pinned = false;
  if (trigger) trigger.removeAttribute('aria-describedby');
  trigger = null;
}

/** Below the trigger when there is room, above when there is not, always on screen. */
function place(el) {
  const M = 8;
  const r = el.getBoundingClientRect();
  card.style.left = '0px';                       // measure unclamped first
  card.style.top = '0px';
  const w = card.offsetWidth, h = card.offsetHeight;

  const left = Math.max(M, Math.min(r.left, innerWidth - w - M));
  const below = r.bottom + M;
  const above = r.top - M - h;
  const top = below + h <= innerHeight - M ? below
            : above >= M ? above
            : Math.max(M, innerHeight - h - M);

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function render(t) {
  const rows = t.columns.map(c => {
    const flags = [];
    if (c.pk) flags.push('<span class="tip-flag tip-pk">PK</span>');
    if (!c.notNull && !c.pk) flags.push('<span class="tip-flag tip-null">null</span>');
    const meta = [
      c.link ? `<span class="tip-link">&rarr; ${esc(c.link)}</span>` : '',
      c.note ? `<span class="tip-note">${esc(c.note)}</span>` : '',
    ].filter(Boolean).join(' ');
    return `<tr>
      <th scope="row">${esc(c.name)}</th>
      <td class="tip-type">${esc(c.type)}</td>
      <td class="tip-meta">${flags.join('')}${meta}</td>
    </tr>`;
  }).join('');

  return `
    <div class="tip-head">
      <span class="tip-name">${esc(t.name)}</span>
      <span class="tip-rows">${t.rowCount === null || t.rowCount === undefined
        ? '' : `${t.rowCount.toLocaleString()} rows`}</span>
    </div>
    ${t.purpose ? `<p class="tip-purpose">${esc(t.purpose)}</p>` : ''}
    <div class="tip-scroll"><table class="tip-cols"><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Markup helpers
// ---------------------------------------------------------------------------

/** The "Tables" strip under an exercise title. */
export function chips(names) {
  if (!names.length) return '';
  return `<span class="tables-label">Tables</span>` + names.map(n =>
    `<span class="tbl-ref tbl-chip" data-table="${esc(n)}" tabindex="0" role="button"
           aria-label="${esc(n)} — show columns">${esc(n)}</span>`).join('');
}

/**
 * Turn every inline `table_name` inside `root` into a hover trigger.
 * Code blocks are left alone: a whole SQL snippet lit up would be noise.
 */
export function annotate(root, isTable) {
  if (!root) return;
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre')) continue;
    const name = code.textContent.trim();
    if (!isTable(name)) continue;
    code.classList.add('tbl-ref');
    code.dataset.table = name;
    code.tabIndex = 0;
    code.setAttribute('role', 'button');
    code.setAttribute('aria-label', `${name} — show columns`);
  }
}
