// ===========================================================================
//  UI layer.
//  Keeps no SQL knowledge of its own -- everything about correctness and
//  portability lives in engine.js, everything about content in curriculum.js.
// ===========================================================================
import * as engine from './engine.js';
import { EXERCISES, TRACKS, ENGINES, ENGINE_LABELS } from './curriculum.js';

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const STORE_KEY = 'sqlpractice.v1';
const DIFF_LABEL = { 1: 'warm-up', 2: 'core', 3: 'hard', 4: 'interview-grade' };

const state = loadState();
let schemaCache = null;
let sandbox = false;

function loadState() {
  const base = {
    solved: {}, attempted: {}, revealed: {}, drafts: {},
    hintsShown: {}, engine: 'redshift', theme: 'dark',
    current: EXERCISES[0].id,
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

function paintEditor() {
  // trailing newline keeps the last line's height in the <pre>
  highlightLayer.innerHTML = highlightSQL(editor.value + '\n');
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
}

editor.addEventListener('input', () => {
  paintEditor();
  if (!sandbox) { state.drafts[state.current] = editor.value; saveState(); }
  scheduleLint();
});
editor.addEventListener('scroll', () => {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
});
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = editor;
    editor.value = value.slice(0, a) + '  ' + value.slice(b);
    editor.selectionStart = editor.selectionEnd = a + 2;
    editor.dispatchEvent(new Event('input'));
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

function renderHints() {
  const ex = currentExercise();
  const shown = state.hintsShown[ex.id] || 0;
  const box = $('#hints');
  if (!shown) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = ex.hints.slice(0, shown)
    .map((h, i) => `<div class="hint"><span class="hint-n">${i + 1}</span><span>${markdown(h).replace(/^<p>|<\/p>$/g, '')}</span></div>`)
    .join('');
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
async function doRun() {
  const sql = editor.value.trim();
  if (!sql) return;
  showTab('results');
  setStatus('Running…', '');
  try {
    if (sandbox && !engine.isReadOnlyQuery(sql)) {
      const { ms } = await engine.exec(sql);
      $('#tab-results').innerHTML = '<p class="placeholder">Statement executed. It returned no result set.</p>';
      schemaCache = null;
      setStatus(`Executed in ${ms.toFixed(0)} ms`, 'sandbox');
      return;
    }
    const res = await engine.run(sql);
    renderGrid(res);
    setStatus(`${res.rowCount.toLocaleString()} rows in ${res.ms.toFixed(0)} ms`,
              `${res.columns.length} columns`);
  } catch (e) {
    $('#tab-results').innerHTML =
      `<div class="verdict verdict-bad"><h3>Query error</h3><pre>${esc(e.message ?? e)}</pre></div>`;
    setStatus('Query failed', '', true);
  }
}

async function doCheck() {
  const ex = currentExercise();
  const sql = editor.value.trim();
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

  const dot = $('#feedback-dot');
  dot.hidden = false;
  dot.className = 'dot' + (verdict.pass ? ' dot-good' : '');

  if (verdict.pass) {
    if (!state.solved[ex.id]) state.solved[ex.id] = new Date().toISOString();
    saveState();
    const next = nextUnsolved();
    $('#tab-feedback').innerHTML =
      `<div class="verdict verdict-good"><h3>Correct</h3><div>${esc(verdict.detail)}</div></div>` +
      (next ? `<p class="placeholder">Next unsolved: <strong>${esc(next.title)}</strong> — press <code>Alt+→</code>.</p>` : '<p class="placeholder">That was the last one. All exercises solved.</p>');
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

// --- schema browser ---------------------------------------------------------
async function renderSchema() {
  const panel = $('#tab-schema');
  if (!schemaCache) {
    panel.innerHTML = '<p class="placeholder">Reading schema…</p>';
    try { schemaCache = await engine.getSchema(); }
    catch (e) { panel.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  }
  panel.innerHTML =
    '<p class="placeholder">Click a table or column name to insert it into the editor.</p>' +
    schemaCache.map(t => `
      <div class="schema-table">
        <div class="schema-name" data-insert="${esc(t.name)}">
          <span>${esc(t.name)}</span>
          <span class="schema-rows">${t.rowCount === null ? '' : t.rowCount.toLocaleString() + ' rows'}</span>
        </div>
        <div class="schema-cols">
          ${t.columns.map(c => `<span class="schema-col" data-insert="${esc(c.name)}">${esc(c.name)}<span class="ct"> ${esc(c.type)}</span></span>`).join('')}
        </div>
      </div>`).join('');

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

// --- tabs -------------------------------------------------------------------
function showTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('tab-on', t.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.toggle('tab-panel-on', p.id === `tab-${name}`));
  if (name === 'schema') renderSchema();
  if (name === 'portability') renderLint();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  $('#btn-run').addEventListener('click', doRun);
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

  $('#btn-clear').addEventListener('click', () => { setEditor(''); editor.focus(); });

  $('#btn-sandbox').addEventListener('click', () => {
    sandbox = !sandbox;
    document.body.classList.toggle('sandbox', sandbox);
    $('#btn-sandbox').classList.toggle('btn-primary', sandbox);
    if (sandbox) {
      setEditor(state.drafts.__sandbox ?? '-- Sandbox: any SQL, including DDL and DML.\n-- "Reset data" restores the dataset.\n\nSELECT table_name, estimated_size\nFROM duckdb_tables()\nORDER BY table_name;');
    } else {
      renderExercise();
    }
    renderSidebar();
  });

  $('#btn-reset-db').addEventListener('click', async () => {
    if (!confirm('Reload the dataset from scratch? Any data you changed in the Sandbox is discarded.')) return;
    setStatus('Reloading dataset…', '');
    await engine.resetDatabase(msg => setStatus(msg, ''));
    schemaCache = null;
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
      if (e.shiftKey && !sandbox) doCheck(); else doRun();
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      const n = nextUnsolved();
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

  $('#boot').remove();
  $('#topbar').hidden = false;
  $('#layout').hidden = false;
  $('#engine-version').textContent =
    `DuckDB ${engine.engineVersion} - time zones ${engine.hasTimezoneSupport ? 'on' : 'off (UTC only)'}`;
  $('#engine-version').title = engine.hasTimezoneSupport
    ? 'ICU extension loaded: CONVERT_TIMEZONE and AT TIME ZONE work with IANA zone names.'
    : 'ICU extension unavailable, so this session knows UTC only. Every exercise still works; exercises ts-4 and ts-8 use fixed offsets deliberately.';

  wire();
  renderExercise();
  renderSidebar();
  renderLint();
  editor.focus();
})();
