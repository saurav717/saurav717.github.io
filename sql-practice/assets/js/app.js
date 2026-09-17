// ===========================================================================
//  UI layer.
//  Keeps no SQL knowledge of its own -- everything about correctness and
//  portability lives in engine.js, everything about content in curriculum.js.
// ===========================================================================
import * as engine from './engine.js';
import { EXERCISES, TRACKS, ENGINES, ENGINE_LABELS } from './curriculum.js';
import * as activity from './activity.js';
import * as beacon from './beacon.js';
import * as layout from './layout.js';
import * as tabletip from './tabletip.js';
import { PURPOSE, LINKS, parseSchemaSql, tablesFor } from './schema-doc.js';

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const STORE_KEY = 'sqlpractice.v1';
const DIFF_LABEL = { 1: 'warm-up', 2: 'core', 3: 'hard', 4: 'interview-grade' };

const state = loadState();
let schemaCache = null;
let tableDocs = new Map();     // table name -> what the hover card shows
let ddlNotes = null;           // parsed assets/data/schema.sql, fetched once
let sandbox = false;

function loadState() {
  const base = {
    solved: {}, attempted: {}, revealed: {}, drafts: {},
    hintsShown: {}, engine: 'redshift', theme: 'dark', lineNumbers: false,
    current: EXERCISES[0].id, layout: {},
  };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch { return base; }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

const exerciseById = (id) => EXERCISES.find(e => e.id === id);
const currentExercise = () => exerciseById(state.current) || EXERCISES[0];

// ---------------------------------------------------------------------------
// Minimal markdown -> HTML. Supports exactly what the prompts use:
// fenced code, inline code, bold, blockquote, ordered/unordered lists.
// ---------------------------------------------------------------------------
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function markdown(src) {
  const blocks = [];
  // pull fenced code out first so nothing else touches it
  let text = String(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code class="lang-${lang}">${highlightSQL(code.replace(/\n$/, ''))}</code></pre>`);
    return `@@CODEBLOCK${blocks.length - 1}@@`;
  });

  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out = [];
  let list = null;           // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }

    const ph = line.match(/^@@CODEBLOCK(\d+)@@$/);
    if (ph) { closeList(); out.push(blocks[+ph[1]]); continue; }

    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote><p>${inline(line.replace(/^>\s?/, ''))}</p></blockquote>`);
      continue;
    }
    const ol = line.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// SQL syntax highlighting (single pass, token-by-token so nothing nests wrong)
// ---------------------------------------------------------------------------
const SQL_KEYWORDS = new Set(`SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET AS ON JOIN INNER
LEFT RIGHT FULL OUTER CROSS NATURAL USING UNION ALL EXCEPT INTERSECT WITH RECURSIVE CASE WHEN THEN
ELSE END AND OR NOT IN EXISTS BETWEEN LIKE ILIKE IS NULL TRUE FALSE DISTINCT OVER PARTITION ROWS
RANGE GROUPS UNBOUNDED PRECEDING FOLLOWING CURRENT ROW EXCLUDE TIES NO OTHERS WINDOW FILTER QUALIFY
ASOF LATERAL CAST INTERVAL DATE TIMESTAMP TIME VARCHAR INTEGER BIGINT DOUBLE DECIMAL BOOLEAN
CREATE TABLE VIEW INSERT UPDATE DELETE DROP ALTER SET VALUES INTO RETURNING EXPLAIN DESCRIBE PIVOT
UNPIVOT UNNEST GENERATE_SERIES ASC DESC NULLS FIRST LAST IGNORE RESPECT PRIMARY KEY REFERENCES
DEFAULT CONSTRAINT MACRO OR REPLACE IF EXISTS TEMP TEMPORARY`.split(/\s+/));

function highlightSQL(code) {
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
  let out = '', m;
  while ((m = re.exec(code)) !== null) {
    const [, comment, str, num, word, other] = m;
    if (comment) out += `<span class="t-cmt">${esc(comment)}</span>`;
    else if (str) out += `<span class="t-str">${esc(str)}</span>`;
    else if (num) out += `<span class="t-num">${esc(num)}</span>`;
    else if (word) {
      const upper = word.toUpperCase();
      if (SQL_KEYWORDS.has(upper)) out += `<span class="t-kw">${esc(word)}</span>`;
      else if (code[re.lastIndex] === '(') out += `<span class="t-fn">${esc(word)}</span>`;
      else out += esc(word);
    } else out += esc(other);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Editor (transparent textarea over a highlighted <pre>)
// ---------------------------------------------------------------------------
const editor = $('#editor');
const highlightLayer = $('#editor-highlight');
const editorWrap = $('.editor-wrap');
const gutter = $('#editor-gutter');
const gutterLines = $('#editor-gutter-lines');

/** One indent level. The stylesheet's tab-size matches it. */
const INDENT = '  ';
/** One level of leading whitespace: a tab, or up to INDENT.length spaces. */
const ONE_LEVEL = new RegExp(`^(?:\\t| {1,${INDENT.length}})`);

/**
 * Replace [from, to) with `text`, then leave the selection at [selA, selB).
 *
 * Every edit this module makes to the editor goes through here, because it
 * routes through execCommand('insertText') -- the only way to change a
 * textarea that leaves the browser's own undo stack intact. Assigning to
 * `editor.value` wipes that stack, which is how pressing Tab over a selected
 * query used to eat it with no way back.
 */
function replaceRange(from, to, text, selA, selB) {
  editor.focus();
  editor.setSelectionRange(from, to);
  let ok = false;
  try {
    ok = text === ''
      ? document.execCommand('delete')
      : document.execCommand('insertText', false, text);
  } catch { ok = false; }
  if (!ok) {
    // Very old or locked-down browsers only: the edit still lands, but this
    // one will not be undoable.
    const v = editor.value;
    editor.value = v.slice(0, from) + text + v.slice(to);
    editor.dispatchEvent(new Event('input'));
  }
  editor.setSelectionRange(selA, selB);
  paintEditor();
}

/** Offset of the start of the line `pos` sits on. */
const lineStart = (value, pos) => value.lastIndexOf('\n', pos - 1) + 1;

/**
 * The whole lines the current selection touches. A selection that ends exactly
 * on a line break stops at the end of the previous line, so selecting three
 * lines by dragging down does not quietly drag in a fourth.
 */
function selectedLines() {
  const { value, selectionStart: a, selectionEnd: b } = editor;
  const from = lineStart(value, a);
  const tail = b > a && value[b - 1] === '\n' ? b - 1 : b;
  let to = value.indexOf('\n', tail);
  if (to === -1) to = value.length;
  return { from, to };
}

/**
 * Tab and Shift+Tab. A selection spanning more than one line is indented or
 * dedented as a block -- never replaced, which is what used to delete the
 * whole query after ⌘A. Inside a single line, Tab pads to the next tab stop
 * and Shift+Tab takes one indent level off that line.
 */
function indentSelection(dedent) {
  const { value, selectionStart: a, selectionEnd: b } = editor;
  const { from, to } = selectedLines();
  const multiLine = value.slice(a, b).includes('\n');

  if (!multiLine && !dedent) {
    // Pad to the tab stop rather than always two, so Tab lines columns up.
    const pad = INDENT.length - ((a - from) % INDENT.length);
    replaceRange(a, b, ' '.repeat(pad), a + pad, a + pad);
    return;
  }

  const lines = value.slice(from, to).split('\n');
  let firstShift = 0, shiftAll = 0;
  const out = lines.map((line, i) => {
    let next = line;
    if (dedent) {
      const lead = ONE_LEVEL.exec(line);
      if (lead) next = line.slice(lead[0].length);
    } else if (line !== '') {
      next = INDENT + line;               // no trailing space on blank lines
    }
    const d = next.length - line.length;
    if (i === 0) firstShift = d;
    shiftAll += d;
    return next;
  });
  if (shiftAll === 0) return;             // nothing left to dedent

  const selA = multiLine ? from : Math.max(from, a + firstShift);
  const selB = multiLine ? to + shiftAll : Math.max(selA, b + firstShift);
  replaceRange(from, to, out.join('\n'), selA, selB);
}

/**
 * What Run acts on, Snowflake-worksheet style: the selection if there is one,
 * otherwise the single statement the cursor sits in. Returns null for an
 * editor with nothing runnable in it.
 *   { sql, start, end, label, total }
 */
function runTarget() {
  const { selectionStart: a, selectionEnd: b, value } = editor;
  if (b > a && value.slice(a, b).trim()) {
    return { sql: value.slice(a, b), start: a, end: b, label: 'the selection', total: 0 };
  }
  const st = engine.statementAt(value, a);
  if (!st) return null;
  return {
    ...st,
    label: st.total > 1 ? `statement ${st.index + 1} of ${st.total}` : '',
  };
}

function syncScroll() {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
  // The gutter scrolls vertically with the text but never horizontally, so
  // the numbers stay put while a long line slides underneath them.
  gutterLines.style.transform = `translateY(${-editor.scrollTop}px)`;
}

/**
 * Redraw the line-number gutter. Widths are in `ch`, so the column grows by
 * exactly one digit when the query passes 100 lines instead of jumping.
 */
function paintGutter() {
  if (!state.lineNumbers) return;
  const n = editor.value.split('\n').length;
  let out = '';
  for (let i = 1; i <= n; i++) out += `${i}\n`;
  gutterLines.textContent = out;
  // On the wrap, because the text layers pad themselves clear of it too.
  editorWrap.style.setProperty('--gutter-digits', String(n).length);
}

/** Show or hide the gutter, and put the toolbar toggle in the matching state. */
function applyLineNumbers() {
  editorWrap.classList.toggle('with-gutter', state.lineNumbers);
  gutter.hidden = !state.lineNumbers;
  const btn = $('#btn-lines');
  btn.classList.toggle('btn-on', state.lineNumbers);
  btn.setAttribute('aria-pressed', String(state.lineNumbers));
  if (state.lineNumbers) { paintGutter(); syncScroll(); }
}

/** Signature of the marked range, so we only repaint when it actually moves. */
let paintedTarget = null;

function paintEditor() {
  const text = editor.value + '\n';   // keeps the last line's height in the <pre>
  const t = runTarget();
  // One statement needs no marking -- banding the whole editor says nothing.
  const mark = t && t.total > 1;
  highlightLayer.innerHTML = mark
    ? highlightSQL(text.slice(0, t.start))
      + `<span class="stmt-active">${highlightSQL(text.slice(t.start, t.end))}</span>`
      + highlightSQL(text.slice(t.end))
    : highlightSQL(text);
  paintedTarget = t ? `${t.start}:${t.end}:${t.total}` : '';
  paintGutter();
  syncScroll();
  renderRunTargetLabel(t);
}

/** Repaint only if moving the caret changed which statement Run would take. */
function repaintIfTargetMoved() {
  const t = runTarget();
  if ((t ? `${t.start}:${t.end}:${t.total}` : '') === paintedTarget) return;
  paintEditor();
}

function renderRunTargetLabel(t) {
  const el = $('#stmt-indicator');
  el.hidden = !(t && t.label);
  el.textContent = t && t.label ? `⌘↵ runs ${t.label}` : '';
}

/**
 * Toggle `--` line comments over the selected lines, the way ⌘/ does in every
 * other editor: comment the block unless every line in it is already
 * commented, in which case uncomment. The comment marker goes at the shallowest
 * indent in the block, so the code keeps its shape.
 */
function toggleLineComment() {
  const { value } = editor;
  const a = editor.selectionStart, b = editor.selectionEnd;
  const { from, to } = selectedLines();

  const lines = value.slice(from, to).split('\n');
  const code = lines.filter(l => l.trim());
  const commented = code.length > 0 && code.every(l => /^\s*--/.test(l));

  let out;
  if (commented) {
    out = lines.map(l => l.replace(/^(\s*)--[ \t]?/, '$1'));
  } else {
    const indent = code.length ? Math.min(...code.map(l => /^\s*/.exec(l)[0].length)) : 0;
    // With nothing but blank lines selected, comment them anyway: the user
    // asked for a comment marker and that is where the cursor is.
    out = lines.map(l => (l.trim() || !code.length)
      ? l.slice(0, indent) + '-- ' + l.slice(indent)
      : l);
  }

  const replaced = out.join('\n');
  const shiftFirst = out[0].length - lines[0].length;
  const shiftAll   = replaced.length - (to - from);
  const selA = Math.max(from, a + shiftFirst);
  const selB = a === b ? selA : Math.max(selA, b + shiftAll);
  replaceRange(from, to, replaced, selA, selB);
}

editor.addEventListener('input', () => {
  paintEditor();
  if (!sandbox) { state.drafts[state.current] = editor.value; saveState(); }
  scheduleLint();
});
editor.addEventListener('scroll', syncScroll);

// Moving the caret changes what ⌘↵ would run, so the marked band follows it.
['keyup', 'mouseup', 'focus', 'select'].forEach(ev =>
  editor.addEventListener(ev, repaintIfTargetMoved));
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editor) repaintIfTargetMoved();
});

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    indentSelection(e.shiftKey);
    return;
  }
  // ⌘/ (Ctrl+/ elsewhere). e.code, because on some layouts the modifier
  // changes what e.key reports for this physical key.
  if ((e.metaKey || e.ctrlKey) && (e.key === '/' || e.code === 'Slash')) {
    e.preventDefault();
    toggleLineComment();
  }
});

function setEditor(text) {
  editor.value = text;
  paintEditor();
  scheduleLint();
}

// ---------------------------------------------------------------------------
// Rendering: sidebar
// ---------------------------------------------------------------------------
function exerciseStatus(id) {
  if (state.solved[id])   return 'done';
  if (state.revealed[id]) return 'seen';
  if (state.attempted[id]) return 'try';
  return 'todo';
}
const STATE_GLYPH = { done: '●', try: '◐', seen: '○', todo: '○' };

function renderSidebar() {
  const q = $('#search').value.trim().toLowerCase();
  const filter = $('#status-filter .chip-on').dataset.filter;
  const list = $('#exercise-list');
  list.innerHTML = '';

  for (const track of TRACKS) {
    const items = EXERCISES.filter(e => {
      if (e.track !== track.id) return false;
      if (q && !(`${e.title} ${e.id} ${e.prompt}`.toLowerCase().includes(q))) return false;
      const st = exerciseStatus(e.id);
      if (filter === 'todo' && st === 'done') return false;
      if (filter === 'done' && st !== 'done') return false;
      return true;
    });
    if (!items.length) continue;

    const solvedCount = EXERCISES.filter(e => e.track === track.id && state.solved[e.id]).length;
    const total = EXERCISES.filter(e => e.track === track.id).length;

    const head = document.createElement('div');
    head.className = 'track-head';
    head.innerHTML = `<span>${esc(track.name)}</span><span class="track-count">${solvedCount}/${total}</span>`;
    list.append(head);

    const src = document.createElement('div');
    src.className = 'track-source';
    src.textContent = track.source;
    list.append(src);

    for (const ex of items) {
      const st = exerciseStatus(ex.id);
      const btn = document.createElement('button');
      btn.className = 'ex-item' + (ex.id === state.current && !sandbox ? ' ex-item-on' : '');
      btn.innerHTML =
        `<span class="ex-state ex-state-${st}">${STATE_GLYPH[st]}</span>` +
        `<span class="ex-name">${esc(ex.title)}</span>` +
        `<span class="ex-diff">L${ex.diff}</span>`;
      btn.addEventListener('click', () => selectExercise(ex.id));
      list.append(btn);
    }
  }

  const solved = Object.keys(state.solved).length;
  $('#progress-label').textContent = `${solved} / ${EXERCISES.length}`;
  $('#progress-fill').style.width = `${(solved / EXERCISES.length) * 100}%`;
}

// ---------------------------------------------------------------------------
// Rendering: exercise
// ---------------------------------------------------------------------------
function selectExercise(id) {
  sandbox = false;
  document.body.classList.remove('sandbox');
  state.current = id;
  saveState();
  renderExercise();
  renderSidebar();
  editor.focus();
}

function renderExercise() {
  const ex = currentExercise();
  const track = TRACKS.find(t => t.id === ex.track);

  $('#ex-track').textContent = track ? track.name : ex.track;
  $('#ex-ref').textContent = ex.ref || '';
  $('#ex-title').textContent = ex.title;
  $('#ex-prompt').innerHTML = markdown(ex.prompt);
  renderTables();              // must run before fitPrompt: it adds a row
  layout.fitPrompt();          // a short prompt should not reserve a tall pane
  $('#ex-diff').textContent = `L${ex.diff} ${DIFF_LABEL[ex.diff]}`;

  const st = exerciseStatus(ex.id);
  const statusEl = $('#ex-status');
  statusEl.className = 'badge' + (st === 'done' ? ' badge-done' : st === 'seen' ? ' badge-seen' : '');
  statusEl.textContent = { done: 'solved', try: 'attempted', seen: 'solution seen', todo: 'not started' }[st];

  setEditor(state.drafts[ex.id] ?? '');
  renderHints();
  renderDialect();
  $('#tab-feedback').innerHTML = '<p class="placeholder">Run Check answer to compare your result against the reference.</p>';
  $('#feedback-dot').hidden = true;
  $('#tab-results').innerHTML = '<p class="placeholder">No results yet.</p>';
  setStatus('', '');
  showTab('results');
}

/**
 * The "Tables" strip under the exercise title, plus the hover triggers on the
 * table names inside the prompt itself. Which tables an exercise uses is
 * derived from its text and its reference solution -- see schema-doc.js.
 */
function renderTables() {
  const row = $('#ex-tables');
  const names = tablesFor(currentExercise(), new Set(tableDocs.keys()));
  row.innerHTML = tabletip.chips(names);
  row.hidden = names.length === 0;
  tabletip.annotate($('#ex-prompt'), (n) => tableDocs.has(n));
}

function renderHints() {
  const ex = currentExercise();
  const shown = state.hintsShown[ex.id] || 0;
  const box = $('#hints');
  if (!shown) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = ex.hints.slice(0, shown)
    .map((h, i) => `<div class="hint"><span class="hint-n">${i + 1}</span><span>${markdown(h).replace(/^<p>|<\/p>$/g, '')}</span></div>`)
    .join('');
  tabletip.annotate(box, (n) => tableDocs.has(n));
  $('#btn-hint').textContent = shown >= ex.hints.length ? 'No more hints' : `Hint (${shown}/${ex.hints.length})`;
  $('#btn-hint').disabled = shown >= ex.hints.length;
}

function renderDialect() {
  const ex = currentExercise();
  const panel = $('#tab-dialect');
  if (!ex.dialect) { panel.innerHTML = '<p class="placeholder">No dialect notes for this exercise.</p>'; return; }
  panel.innerHTML =
    `<p class="placeholder">How this answer changes on each engine. Your current target is <strong>${ENGINE_LABELS[state.engine]}</strong>.</p>` +
    ENGINES.map(engName => {
      const note = ex.dialect[engName];
      if (!note) return '';
      const cur = engName === state.engine ? ' dialect-item-current' : '';
      return `<div class="dialect-item${cur}">
        <div class="dialect-engine">${esc(ENGINE_LABELS[engName])}</div>
        <div class="dialect-body">${markdown(note).replace(/^<p>|<\/p>$/g, '')}</div>
      </div>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Results grid
// ---------------------------------------------------------------------------
const NUMERIC = /^(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|.*INT|HUGEINT)/i;

function renderGrid(result, target = '#tab-results') {
  const { columns, types, rows, rowCount, truncated } = result;
  if (!rows.length) {
    $(target).innerHTML = '<p class="placeholder">Query ran and returned 0 rows.</p>';
    return;
  }
  const head = columns.map((c, i) =>
    `<th>${esc(c)}<span class="col-type">${esc(types[i] || '')}</span></th>`).join('');
  const body = rows.map(r => '<tr>' + r.map((v, i) => {
    if (v === null) return '<td class="is-null">NULL</td>';
    const cls = NUMERIC.test(types[i] || '') ? ' class="is-num"' : '';
    return `<td${cls}>${esc(v)}</td>`;
  }).join('') + '</tr>').join('');

  $(target).innerHTML =
    `<div class="grid-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    (truncated ? `<p class="placeholder">Showing the first ${rows.length.toLocaleString()} of ${rowCount.toLocaleString()} rows.</p>` : '');
}

function setStatus(left, right, isError = false) {
  const l = $('#status-left');
  l.textContent = left;
  l.className = isError ? 'err' : 'muted';
  $('#status-right').textContent = right;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
/** Execute one piece of SQL and show it on the Results tab. */
async function runSql(sql, note = '') {
  showTab('results');
  setStatus(note ? `Running ${note}…` : 'Running…', '');
  const right = (extra) => [extra, note].filter(Boolean).join(' · ');
  try {
    if (sandbox && !engine.isReadOnlyQuery(sql)) {
      const { ms } = await engine.exec(sql);
      $('#tab-results').innerHTML = '<p class="placeholder">Statement executed. It returned no result set.</p>';
      schemaCache = null;
      setStatus(`Executed in ${ms.toFixed(0)} ms`, right('sandbox'));
      logActivity({ sql, action: 'run', rowCount: null, ms });
      return { ok: true, ms };
    }
    const res = await engine.run(sql);
    renderGrid(res);
    setStatus(`${res.rowCount.toLocaleString()} rows in ${res.ms.toFixed(0)} ms`,
              right(`${res.columns.length} columns`));
    logActivity({ sql, action: 'run', rowCount: res.rowCount, ms: res.ms });
    return { ok: true, ms: res.ms };
  } catch (e) {
    $('#tab-results').innerHTML =
      `<div class="verdict verdict-bad"><h3>Query error${note ? ` in ${esc(note)}` : ''}</h3>`
      + `<pre>${esc(e.message ?? e)}</pre></div>`;
    setStatus('Query failed', note, true);
    return { ok: false, ms: 0 };
  }
}

/** ⌘↵ -- the selection, or the statement the cursor is in. */
async function doRun() {
  const t = runTarget();
  if (!t || !t.sql.trim()) return;
  await runSql(t.sql, t.label);
}

/** ⌘⌥↵ -- every statement in the editor, in order, stopping at the first error. */
async function doRunAll() {
  const stmts = engine.splitStatements(editor.value);
  if (!stmts.length) return;
  if (stmts.length === 1) { await runSql(stmts[0].sql); return; }

  let ms = 0, done = 0;
  for (const [i, st] of stmts.entries()) {
    const res = await runSql(st.sql, `statement ${i + 1} of ${stmts.length}`);
    if (!res.ok) break;
    ms += res.ms;
    done++;
  }
  if (done === stmts.length) {
    // The grid is showing the last statement's result, which is what a
    // worksheet does; the status line accounts for the whole script.
    setStatus(`Ran ${stmts.length} statements in ${ms.toFixed(0)} ms`,
              `result of statement ${stmts.length}`);
  }
}

async function doCheck() {
  const ex = currentExercise();
  // Grade what Run would run, so scratch work parked above the answer does not
  // get submitted along with it.
  const t = runTarget();
  const sql = t ? t.sql.trim() : '';
  if (!sql) return;

  state.attempted[ex.id] = true;
  saveState();
  showTab('feedback');
  $('#tab-feedback').innerHTML = '<p class="placeholder">Checking…</p>';

  let verdict;
  try {
    verdict = await engine.grade(sql, ex);
  } catch (e) {
    verdict = { pass: false, reason: 'error', detail: String(e.message ?? e) };
  }

  // verdict.got is only set when the user's query executed. A query that
  // errored never ran successfully, so it is not a submission worth logging.
  if (verdict.got) {
    logActivity({
      sql, action: 'check', rowCount: verdict.got.rowCount,
      ms: verdict.got.ms, passed: verdict.pass,
    });
  }

  const dot = $('#feedback-dot');
  dot.hidden = false;
  dot.className = 'dot' + (verdict.pass ? ' dot-good' : '');

  if (verdict.pass) {
    if (!state.solved[ex.id]) state.solved[ex.id] = new Date().toISOString();
    saveState();
    const next = nextUnsolved();
    $('#tab-feedback').innerHTML =
      `<div class="verdict verdict-good"><h3>Correct</h3><div>${esc(verdict.detail)}</div></div>` +
      (next
        ? `<p class="placeholder">Next unsolved: <button type="button" id="btn-next-unsolved" class="btn btn-ghost">${esc(next.title)}</button></p>`
        : '<p class="placeholder">That was the last one. All exercises solved.</p>');
    if (next) $('#btn-next-unsolved').addEventListener('click', () => selectExercise(next.id));
    if (verdict.got) { renderGrid(verdict.got); }
    setStatus('Correct', `${verdict.got.rowCount.toLocaleString()} rows`);
  } else {
    const title = {
      error: 'Query error', shape: 'Wrong number of columns', rowcount: 'Wrong number of rows',
      order: 'Wrong order', values: 'Wrong values', empty: 'Nothing to check',
      'not-a-query': 'Not a query',
    }[verdict.reason] || 'Not correct yet';
    $('#tab-feedback').innerHTML =
      `<div class="verdict verdict-bad"><h3>${esc(title)}</h3><pre>${esc(verdict.detail)}</pre></div>` +
      `<p class="placeholder">Reveal a hint if you are stuck. Your result (if any) is on the Results tab.</p>`;
    if (verdict.got) renderGrid(verdict.got);
    setStatus(title, '', true);
  }
  renderExerciseBadge();
  renderSidebar();
}

function renderExerciseBadge() {
  const ex = currentExercise();
  const st = exerciseStatus(ex.id);
  const statusEl = $('#ex-status');
  statusEl.className = 'badge' + (st === 'done' ? ' badge-done' : st === 'seen' ? ' badge-seen' : '');
  statusEl.textContent = { done: 'solved', try: 'attempted', seen: 'solution seen', todo: 'not started' }[st];
}

/**
 * The exercise one step before or after the current one in list order, or null
 * at either end. From the sandbox it lands back on the exercise you left.
 */
function neighborExercise(dir) {
  const i = EXERCISES.findIndex(e => e.id === state.current);
  if (i < 0) return EXERCISES[0] || null;
  if (sandbox) return EXERCISES[i];
  return EXERCISES[i + dir] || null;
}

function nextUnsolved() {
  const i = EXERCISES.findIndex(e => e.id === state.current);
  for (let k = 1; k <= EXERCISES.length; k++) {
    const cand = EXERCISES[(i + k) % EXERCISES.length];
    if (!state.solved[cand.id]) return cand;
  }
  return null;
}

// --- portability lint (debounced) ------------------------------------------
let lintTimer = null;
function scheduleLint() {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(renderLint, 220);
}
function renderLint() {
  const findings = engine.lint(editor.value, state.engine);
  const warnings = findings.filter(f => f.severity === 'warn');
  const pill = $('#lint-count');
  pill.hidden = warnings.length === 0;
  pill.textContent = String(warnings.length);

  const panel = $('#tab-portability');
  if (!findings.length) {
    panel.innerHTML = `<p class="placeholder">Nothing in this query looks unsupported on <strong>${ENGINE_LABELS[state.engine]}</strong>.</p>`
      + `<p class="placeholder">The practice engine is DuckDB, which accepts more than most warehouses. This tab flags anything that would break when you paste the query into your real cluster.</p>`;
    return;
  }
  panel.innerHTML = findings.map(f => `
    <div class="lint-item lint-${f.severity}">
      <div class="lint-head">${esc(f.msg)}</div>
      <div class="lint-fix">${markdown(f.fix).replace(/^<p>|<\/p>$/g, '')}</div>
    </div>`).join('');
}

// --- schema, and the documentation built on top of it -----------------------
//
// Column names and types come from the live engine; the prose comes from
// schema.sql and schema-doc.js. See assets/js/schema-doc.js for why they are
// kept in three places rather than one.
async function ensureSchema() {
  if (schemaCache) return schemaCache;
  schemaCache = await engine.getSchema();
  if (!ddlNotes) {
    try { ddlNotes = parseSchemaSql(await engine.schemaSource()); }
    catch { ddlNotes = {}; }       // no notes is a worse card, not a broken one
  }
  tableDocs = new Map(schemaCache.map(t => {
    const notes = ddlNotes[t.name] ?? {};
    const links = LINKS[t.name] ?? {};
    return [t.name, {
      name: t.name,
      rowCount: t.rowCount,
      purpose: PURPOSE[t.name] ?? '',
      columns: t.columns.map(c => ({
        name: c.name,
        type: c.type,
        note: notes[c.name]?.note ?? '',
        notNull: notes[c.name]?.notNull ?? false,
        pk: notes[c.name]?.pk ?? false,
        link: links[c.name] ?? '',
      })),
    }];
  }));
  return schemaCache;
}

/** What the hover card knows about a table, or null for one it has never seen. */
const tableDoc = (name) => tableDocs.get(String(name).toLowerCase()) ?? null;

async function renderSchema() {
  const panel = $('#tab-schema');
  if (!schemaCache) {
    panel.innerHTML = '<p class="placeholder">Reading schema…</p>';
    try { await ensureSchema(); }
    catch (e) { panel.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  }
  panel.innerHTML =
    '<p class="placeholder">Click a table or column name to insert it into the editor. Hover either one for what it means.</p>' +
    schemaCache.map(t => {
      const doc = tableDoc(t.name);
      const noteOf = (col) => doc?.columns.find(c => c.name === col)?.note ?? '';
      return `
      <div class="schema-table">
        <div class="schema-name" data-insert="${esc(t.name)}"${doc?.purpose ? ` title="${esc(doc.purpose)}"` : ''}>
          <span>${esc(t.name)}</span>
          <span class="schema-rows">${t.rowCount === null ? '' : t.rowCount.toLocaleString() + ' rows'}</span>
        </div>
        <div class="schema-cols">
          ${t.columns.map(c => `<span class="schema-col" data-insert="${esc(c.name)}"${
            noteOf(c.name) ? ` title="${esc(noteOf(c.name))}"` : ''
          }>${esc(c.name)}<span class="ct"> ${esc(c.type)}</span></span>`).join('')}
        </div>
      </div>`;
    }).join('');

  panel.querySelectorAll('[data-insert]').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.dataset.insert;
      const { selectionStart: a, selectionEnd: b } = editor;
      editor.value = editor.value.slice(0, a) + t + editor.value.slice(b);
      editor.selectionStart = editor.selectionEnd = a + t.length;
      editor.focus();
      editor.dispatchEvent(new Event('input'));
    });
  });
}

// --- activity log -----------------------------------------------------------
// Everything recorded here stays in this browser. See assets/js/activity.js
// for why the device id is a UUID and not a MAC address.

/** Record one successful submission, then keep the tab badge in step. */
function logActivity({ sql, action, rowCount, ms, passed = null }) {
  const ex = sandbox ? null : currentExercise();
  activity.record({
    sql, action, rowCount, ms, passed,
    exerciseId: sandbox ? null : ex.id,
    exerciseTitle: sandbox ? 'Sandbox' : ex.title,
    target: state.engine,
  });
  updateActivityCount();
  if ($('#tab-activity').classList.contains('tab-panel-on')) renderActivity();
}

function updateActivityCount() {
  const pill = $('#activity-count');
  const n = activity.entryCount();
  pill.hidden = n === 0;
  pill.textContent = String(n);
}

const fmtWhen = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleString();
};

function locationLine() {
  if (!activity.locationSupported()) {
    return '<span class="act-off">This browser has no Geolocation API.</span>';
  }
  if (!activity.locationConsent()) {
    return '<span class="act-off">Off — entries are recorded without a position.</span>';
  }
  const loc = activity.lastLocation();
  if (!loc) return '<span class="act-off">On, but no fix yet.</span>';
  return `<code>${loc.lat}, ${loc.lon}</code> ±${loc.accuracyM ?? '?'} m` +
         `<span class="act-sub"> · ${esc(fmtWhen(loc.capturedAt))}</span>`;
}

function renderActivity() {
  const on = activity.isLogging();
  const rows = [...activity.entries()].reverse();

  const head = `
    <div class="act-head">
      <label class="act-toggle">
        <input type="checkbox" id="act-logging"${on ? ' checked' : ''}>
        <span>Record queries that run successfully</span>
      </label>
      <label class="act-toggle">
        <input type="checkbox" id="act-location"${activity.locationConsent() ? ' checked' : ''}
               ${activity.locationSupported() ? '' : 'disabled'}>
        <span>Attach my location</span>
      </label>
    </div>

    <div class="act-ident">
      <div class="act-field">
        <span class="act-key">Device ID</span>
        <span class="act-val"><code>${esc(activity.deviceId())}</code>
          <button class="act-link" id="act-reset-id">reset</button></span>
      </div>
      <div class="act-field">
        <span class="act-key">Location</span>
        <span class="act-val">${locationLine()}</span>
      </div>
      <div class="act-field">
        <span class="act-key">MAC address</span>
        <span class="act-val act-off">Unavailable. No browser exposes the network
          adapter's hardware address to a web page, so the device ID above — a random
          UUID kept in this browser's storage — stands in for it.</span>
      </div>
    </div>

    <div class="act-actions">
      <button class="btn btn-ghost" id="act-export-json" ${rows.length ? '' : 'disabled'}>Export JSON</button>
      <button class="btn btn-ghost" id="act-export-csv"  ${rows.length ? '' : 'disabled'}>Export CSV</button>
      <span class="toolbar-gap"></span>
      <button class="btn btn-ghost" id="act-clear" ${rows.length ? '' : 'disabled'}>Clear log</button>
    </div>`;

  const note = activity.storageFailed()
    ? '<p class="err">This browser refused to save the log (private mode, or storage is full). Entries will be lost on reload.</p>'
    : '';

  const body = !rows.length
    ? `<p class="placeholder">${on
        ? 'No queries recorded yet. Run or check a query and it lands here.'
        : 'Recording is off.'} Nothing is sent anywhere — the log lives in this browser until you export or clear it.</p>`
    : `<div class="grid-wrap"><table class="grid act-table">
        <thead><tr>
          <th>When</th><th>What</th><th>Exercise</th><th>Result</th><th>Location</th><th>Query</th>
        </tr></thead>
        <tbody>${rows.map(e => `
          <tr>
            <td class="act-when">${esc(fmtWhen(e.at))}</td>
            <td>${esc(e.action)}${e.passed === null ? ''
                 : e.passed ? ' <span class="act-pass">pass</span>' : ' <span class="act-fail">fail</span>'}</td>
            <td>${esc(e.exerciseTitle ?? e.exerciseId ?? '—')}</td>
            <td class="is-num">${e.rowCount === null ? '—' : e.rowCount.toLocaleString() + ' rows'}${
                 e.ms === null ? '' : ` / ${e.ms} ms`}</td>
            <td>${e.location ? `${e.location.lat}, ${e.location.lon}` : '—'}</td>
            <td><pre class="act-sql">${esc(e.sql)}${e.sqlTruncated ? '\n…truncated' : ''}</pre></td>
          </tr>`).join('')}
        </tbody></table></div>
       <p class="placeholder">Newest first. The log keeps the most recent 500 entries.</p>`;

  $('#tab-activity').innerHTML = head + note + body;
  wireActivityPanel();
}

function wireActivityPanel() {
  const panel = $('#tab-activity');

  panel.querySelector('#act-logging').addEventListener('change', (e) => {
    activity.setLogging(e.target.checked);
    renderActivity();
  });

  panel.querySelector('#act-location').addEventListener('change', async (e) => {
    const box = e.target;
    box.disabled = true;
    const res = await activity.setLocationConsent(box.checked);
    box.disabled = false;
    renderActivity();
    if (!res.ok) {
      setStatus(`Location not enabled: ${res.error}`, '', true);
    }
  });

  panel.querySelector('#act-reset-id').addEventListener('click', () => {
    if (!confirm('Generate a new device ID?\n\nEntries already recorded keep the ID they were written with.')) return;
    activity.resetDeviceId();
    renderActivity();
  });

  const json = panel.querySelector('#act-export-json');
  const csv  = panel.querySelector('#act-export-csv');
  const clr  = panel.querySelector('#act-clear');
  if (!json.disabled) json.addEventListener('click', () => activity.download('json'));
  if (!csv.disabled)  csv.addEventListener('click',  () => activity.download('csv'));
  if (!clr.disabled)  clr.addEventListener('click', () => {
    if (!confirm(`Delete all ${activity.entryCount()} recorded entries? This cannot be undone.`)) return;
    activity.clearEntries();
    updateActivityCount();
    renderActivity();
  });
}

// --- tabs -------------------------------------------------------------------
function showTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('tab-on', t.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('tab-panel-on', p.id === `tab-${name}`));
  if (name === 'schema') renderSchema();
  if (name === 'portability') renderLint();
  if (name === 'activity') renderActivity();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  tabletip.init(tableDoc);

  $('#btn-run').addEventListener('click', doRun);
  $('#btn-run-all').addEventListener('click', doRunAll);
  $('#btn-check').addEventListener('click', doCheck);

  $('#btn-hint').addEventListener('click', () => {
    const ex = currentExercise();
    const shown = state.hintsShown[ex.id] || 0;
    if (shown >= ex.hints.length) return;
    state.hintsShown[ex.id] = shown + 1;
    saveState();
    renderHints();
  });

  $('#btn-solution').addEventListener('click', () => {
    const ex = currentExercise();
    if (!state.solved[ex.id] && !state.revealed[ex.id]) {
      const ok = confirm('Show the reference solution?\n\nThis marks the exercise as "solution seen" so you know to come back to it.');
      if (!ok) return;
      state.revealed[ex.id] = true;
    }
    setEditor(ex.solution);
    state.drafts[ex.id] = ex.solution;
    saveState();
    renderExerciseBadge();
    renderSidebar();
  });

  // Through replaceRange, not setEditor: emptying the editor by accident and
  // having ⌘Z do nothing is the same trap Tab used to be.
  $('#btn-clear').addEventListener('click', () => {
    if (editor.value) replaceRange(0, editor.value.length, '', 0, 0);
    editor.focus();
  });

  $('#btn-lines').addEventListener('click', () => {
    state.lineNumbers = !state.lineNumbers;
    saveState();
    applyLineNumbers();
  });
  applyLineNumbers();

  $('#btn-sandbox').addEventListener('click', () => {
    sandbox = !sandbox;
    document.body.classList.toggle('sandbox', sandbox);
    $('#btn-sandbox').classList.toggle('btn-primary', sandbox);
    if (sandbox) {
      setEditor(state.drafts.__sandbox ?? '-- Sandbox: any SQL, including DDL and DML.\n-- "Reset data" restores the dataset.\n\nSELECT table_name, estimated_size\nFROM duckdb_tables()\nORDER BY table_name;');
    } else {
      renderExercise();
    }
    layout.refresh();
    renderSidebar();
  });

  $('#btn-reset-db').addEventListener('click', async () => {
    if (!confirm('Reload the dataset from scratch? Any data you changed in the Sandbox is discarded.')) return;
    setStatus('Reloading dataset…', '');
    await engine.resetDatabase(msg => setStatus(msg, ''));
    schemaCache = null;
    await ensureSchema().catch(() => {});   // row counts on the cards again
    setStatus('Dataset reloaded', '');
  });

  $('#btn-theme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    saveState();
  });

  const sel = $('#engine-select');
  sel.innerHTML = ENGINES.map(e =>
    `<option value="${e}"${e === state.engine ? ' selected' : ''}>${esc(ENGINE_LABELS[e])}</option>`).join('');
  sel.addEventListener('change', () => {
    state.engine = sel.value;
    saveState();
    renderLint();
    renderDialect();
  });

  $('#search').addEventListener('input', renderSidebar);
  $$('#status-filter .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('#status-filter .chip').forEach(c => c.classList.remove('chip-on'));
      chip.classList.add('chip-on');
      renderSidebar();
    });
  });

  $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey && !sandbox) doCheck();
      else if (e.altKey) doRunAll();
      else doRun();
    }
    // Walk the exercise list. Deliberately not ⌥←/⌥→: on macOS those are
    // word-wise caret movement, and claiming them here broke typing in the
    // editor. ⌘⌥↑/↓ is free (⌘⌥←/→ switches browser tabs) and matches the
    // sidebar, which runs vertically.
    if (mod && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = neighborExercise(e.key === 'ArrowDown' ? 1 : -1);
      if (n) selectExercise(n.id);
    }
  });

  // sandbox drafts are kept separately from exercise drafts
  editor.addEventListener('input', () => {
    if (sandbox) { state.drafts.__sandbox = editor.value; saveState(); }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function main() {
  document.documentElement.dataset.theme = state.theme;

  // Before the engine, not after: the first load pulls ~8 MB and a visitor who
  // gives up halfway is still a visit. No await -- the collector is never
  // allowed to delay the page.
  beacon.ping();

  const steps = ['Loading DuckDB engine', 'Checking time-zone support (optional)', 'Creating tables',
                 'Installing dialect compatibility macros', 'Loading seed data (2 MB)', 'Ready'];

  try {
    await engine.boot((msg) => {
      $('#boot-status').textContent = msg;
      const i = steps.indexOf(msg);
      $('#boot-bar-fill').style.width = `${((i < 0 ? 0 : i + 1) / steps.length) * 100}%`;
    });
  } catch (e) {
    $('#boot-status').textContent = 'Could not start the engine.';
    const box = document.createElement('div');
    box.className = 'boot-error';
    box.textContent = String(e.message ?? e)
      + '\n\nThis page must be served over http:// — opening index.html directly from the filesystem will not work, because the browser blocks WebAssembly and fetch on file:// URLs.'
      + '\n\nRun:  python3 -m http.server 8000     then open http://localhost:8000';
    $('.boot-card').append(box);
    return;
  }

  // The hover cards need the live column list, so read it before the first
  // exercise renders. A failure here costs the cards, not the app.
  $('#boot-status').textContent = 'Reading the schema';
  try { await ensureSchema(); } catch { /* cards degrade to nothing */ }

  $('#boot').remove();
  $('#topbar').hidden = false;
  $('#layout').hidden = false;
  $('#engine-version').textContent =
    `DuckDB ${engine.engineVersion} - time zones ${engine.hasTimezoneSupport ? 'on' : 'off (UTC only)'}`;
  $('#engine-version').title = engine.hasTimezoneSupport
    ? 'ICU extension loaded: CONVERT_TIMEZONE and AT TIME ZONE work with IANA zone names.'
    : 'ICU extension unavailable, so this session knows UTC only. Every exercise still works; exercises ts-4 and ts-8 use fixed offsets deliberately.';

  layout.init({
    saved: state.layout,
    onResize: (sizes) => { state.layout = sizes; saveState(); },
  });

  wire();
  renderExercise();
  renderSidebar();
  renderLint();
  updateActivityCount();
  editor.focus();
})();
