// ===========================================================================
//  Engine layer: DuckDB-Wasm boot, query execution, answer grading, and the
//  cross-engine portability linter.
//
//  WHY DUCKDB: nothing can run real Redshift, Athena or Snowflake in a
//  browser -- they are cloud services. DuckDB is the closest embeddable
//  dialect: Postgres-family (as Redshift and Snowflake are), with QUALIFY,
//  IGNORE NULLS, ASOF JOIN, real IANA time zones, RANGE+INTERVAL frames and
//  windowed STDDEV_SAMP. assets/data/compat.sql adds the Snowflake/Redshift
//  spellings (DATEADD, CONVERT_TIMEZONE, NVL, IFF, TO_CHAR) on top.
//
//  The linter below is what keeps you honest about the difference.
//
//  NOTE ON THE DIRECTORY NAME: the DuckDB files live in engine/, not vendor/.
//  Jekyll's default exclude list contains "vendor", and the hosted copy of this
//  site is served from a Jekyll site, so a directory called vendor/ risks being
//  silently dropped at build time. Keeping one name for both means the local
//  clone and the deployed copy resolve identical paths.
//
//  ENGINE SOURCE. The DuckDB wasm binary is ~36 MB on disk. Served from a CDN
//  it arrives compressed at roughly 8 MB, which is what you want for a hosted
//  copy; served from the vendored files it works with no network at all, which
//  is what you want locally. So the source is chosen per environment:
//
//    localhost / 127.0.0.1 / file://  ->  vendored  (offline-capable)
//    anything else (a real host)      ->  jsDelivr  (smaller first load)
//
//  Override either way with ?engine=vendor or ?engine=cdn, or by putting
//  data-engine-source="cdn" on the module <script> tag (the deployed copy on
//  GitHub Pages does exactly that, so it never looks for files it does not
//  ship).
// ===========================================================================

const LOCAL_BASE = 'engine/duckdb/';
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/';

/** 'vendor' | 'cdn' -- where the worker and wasm binary come from. */
export function resolveEngineSource() {
  const param = new URLSearchParams(location.search).get('engine');
  if (param === 'cdn' || param === 'vendor') return param;

  const tagged = document.querySelector('script[data-engine-source]');
  if (tagged) {
    const v = tagged.dataset.engineSource;
    if (v === 'cdn' || v === 'vendor') return v;
  }

  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  return isLocal ? 'vendor' : 'cdn';
}

export let engineSource = 'vendor';

let db = null, conn = null, duckdb = null;
export let engineVersion = 'unknown';
/** True when DuckDB's ICU extension loaded, giving real IANA time zones. */
export let hasTimezoneSupport = false;

const strip = (sql) => sql.trim().replace(/;+\s*$/, '');

// --- boot -------------------------------------------------------------------
export async function boot(onProgress = () => {}) {
  onProgress('Loading DuckDB engine');
  duckdb = await import(`../../${LOCAL_BASE}duckdb-browser.bundle.mjs`);

  engineSource = resolveEngineSource();
  const base = engineSource === 'cdn'
    ? CDN_BASE
    // Absolute URL: the worker resolves the wasm path against ITS OWN location,
    // not the document's, so a relative path would look for
    // engine/duckdb/engine/duckdb/duckdb-eh.wasm and 404.
    : new URL(LOCAL_BASE, document.baseURI).href;

  const workerSrc = `${base}duckdb-browser-eh.worker.js`;
  const wasmUrl   = `${base}duckdb-eh.wasm`;

  // A classic Worker cannot be constructed from a cross-origin URL, so for the
  // CDN path we wrap it in a same-origin blob that importScripts() the real
  // one. This is DuckDB's own documented pattern for CDN loading.
  let worker, blobUrl = null;
  if (engineSource === 'cdn') {
    blobUrl = URL.createObjectURL(
      new Blob([`importScripts(${JSON.stringify(workerSrc)});`], { type: 'text/javascript' }));
    worker = new Worker(blobUrl);
  } else {
    worker = new Worker(workerSrc);
  }

  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(wasmUrl);
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  conn = await db.connect();

  try {
    const v = await conn.query('SELECT version() AS v');
    engineVersion = v.toArray()[0].v;
  } catch { /* non-fatal */ }

  await tryTimezoneSupport(onProgress);
  await loadDataset(onProgress);
  return engineVersion;
}

/**
 * DuckDB keeps the IANA time-zone database in its ICU extension, which the
 * wasm build fetches from extensions.duckdb.org on first use. That is a
 * runtime network dependency, so we treat it as OPTIONAL: try once with a
 * short timeout, and if it is not reachable, turn extension auto-loading OFF
 * so that a later timezone query fails immediately with a clear message
 * instead of hanging on a blocked request.
 *
 * Every exercise is solvable without it. Only CONVERT_TIMEZONE / AT TIME ZONE
 * need it, and exercises ts-4 and ts-8 deliberately teach the fixed-offset
 * approach (and its DST bug) instead.
 */
async function tryTimezoneSupport(onProgress) {
  onProgress('Checking time-zone support (optional)');
  try {
    await Promise.race([
      conn.query('INSTALL icu; LOAD icu;'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    hasTimezoneSupport = true;
  } catch {
    hasTimezoneSupport = false;
    try {
      await conn.query(
        'SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;');
    } catch { /* older builds may not expose these */ }
  }
}

async function fetchSql(name) {
  const res = await fetch(`assets/data/${name}.sql`);
  if (!res.ok) throw new Error(`could not load assets/data/${name}.sql (${res.status})`);
  return res.text();
}

/**
 * The raw DDL text, for the documentation layer: assets/data/schema.sql carries
 * a comment on most columns, and those comments are the hover-card notes.
 */
export function schemaSource() {
  return fetchSql('schema');
}

export async function loadDataset(onProgress = () => {}) {
  onProgress('Creating tables');
  await conn.query(await fetchSql('schema'));
  onProgress('Installing dialect compatibility macros');
  await conn.query(await fetchSql('compat'));
  if (hasTimezoneSupport) {
    // CONVERT_TIMEZONE / from_utc_timestamp / to_utc_timestamp -- these need ICU.
    await conn.query(await fetchSql('compat-tz'));
  }
  onProgress('Loading seed data (2 MB)');
  await conn.query(await fetchSql('seed'));
  onProgress('Ready');
}

export async function resetDatabase(onProgress = () => {}) {
  await loadDataset(onProgress);
}

// --- execution --------------------------------------------------------------
// Everything is canonicalised to VARCHAR before it leaves the engine. This
// sidesteps Arrow's DECIMAL / DATE / TIMESTAMP JS representations entirely, and
// it means grading compares exactly what you see in the results grid.
//
// Floating types are rounded to 6 decimals first so that 0.1 + 0.2 style noise
// never fails an otherwise-correct answer.
const FLOATY = /^(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/i;

async function describe(sql) {
  const r = await conn.query(`DESCRIBE ${strip(sql)}`);
  return r.toArray().map(row => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
}

function canonicalise(sql, cols) {
  const proj = cols.map(c => {
    const id = `"${c.name.replace(/"/g, '""')}"`;
    return FLOATY.test(c.type)
      ? `CAST(ROUND(CAST(${id} AS DOUBLE), 6) AS VARCHAR) AS ${id}`
      : `CAST(${id} AS VARCHAR) AS ${id}`;
  }).join(', ');
  // A pure projection over a subquery. DuckDB honours the inner ORDER BY;
  // this is verified for every ordered exercise by tools/check_order.mjs.
  return `SELECT ${proj} FROM (${strip(sql)}) AS _practice_q`;
}

/** Run a query and return { columns, types, rows, rowCount, ms }. */
export async function run(sql, { limit = 2000 } = {}) {
  const t0 = performance.now();
  const cols = await describe(sql);
  const result = await conn.query(canonicalise(sql, cols));
  const ms = performance.now() - t0;

  const rows = [];
  for (const rec of result.toArray()) {
    rows.push(cols.map(c => {
      const v = rec[c.name];
      return v === null || v === undefined ? null : String(v);
    }));
  }
  return {
    columns: cols.map(c => c.name),
    types: cols.map(c => c.type),
    rows: rows.slice(0, limit),
    rowCount: rows.length,
    truncated: rows.length > limit,
    ms,
  };
}

/** Run statements that return nothing useful (DDL/DML) -- sandbox only. */
export async function exec(sql) {
  const t0 = performance.now();
  await conn.query(sql);
  return { ms: performance.now() - t0 };
}

export function isReadOnlyQuery(sql) {
  const head = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  return /^(SELECT|WITH|DESCRIBE|EXPLAIN|SHOW|PIVOT|UNPIVOT|FROM|VALUES|TABLE)\b/.test(head);
}

// --- statement boundaries ---------------------------------------------------
//  A worksheet holds a script, not a query: scratch work above, the real
//  query below, each ended by a ';'. Finding those boundaries is lexing, not
//  splitting on ';' -- the character is ordinary text inside a string, a
//  quoted identifier, a comment or a dollar-quoted body.

/** Walk past the quoted run starting at `i`. A doubled quote is an escape. */
function skipQuoted(text, i) {
  const q = text[i];
  for (let k = i + 1; k < text.length; k++) {
    if (text[k] !== q) continue;
    if (text[k + 1] === q) { k++; continue; }   // '' / "" -- a literal quote
    return k + 1;
  }
  return text.length;                          // unterminated: rest is quoted
}

/** True when a chunk of text holds nothing executable -- blanks and comments. */
const isAllCommentary = (sql) =>
  !sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

/**
 * Split a script into the statements it actually runs, in text order:
 *
 *   [{ sql, start, end }, ...]
 *
 * `start`/`end` are offsets into the original text, trimmed to the first and
 * last non-blank character, with the terminating ';' left out -- so a caller
 * can both execute the slice and mark it in an editor. Segments holding only
 * whitespace and comments are dropped; they are not statements.
 */
export function splitStatements(script) {
  const text = String(script ?? '');
  const out = [];
  let from = 0, i = 0;

  const push = (a, b) => {
    while (a < b && /\s/.test(text[a]))     a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a >= b) return;
    const sql = text.slice(a, b);
    if (isAllCommentary(sql)) return;
    out.push({ sql, start: a, end: b });
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
    } else if (c === "'" || c === '"') {
      i = skipQuoted(text, i);
    } else if (c === '$') {
      // DuckDB/Postgres dollar quoting: $$ ... $$ or $tag$ ... $tag$
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (!tag) { i++; continue; }
      const close = text.indexOf(tag[0], i + tag[0].length);
      i = close === -1 ? text.length : close + tag[0].length;
    } else if (c === ';') {
      push(from, i);
      from = i + 1;
      i++;
    } else i++;
  }
  push(from, text.length);
  return out;
}

/**
 * The statement a cursor sits in -- what a Snowflake worksheet runs on
 * Cmd+Enter. A cursor in the blank space after a ';' belongs to the statement
 * before it, so pressing Run at the end of a script runs the last statement
 * rather than nothing.
 *
 * Returns { sql, start, end, index, total }, or null for an empty script.
 */
export function statementAt(script, cursor = 0) {
  const stmts = splitStatements(script);
  if (!stmts.length) return null;
  let pick = 0;
  for (let i = 0; i < stmts.length && stmts[i].start <= cursor; i++) pick = i;
  return { ...stmts[pick], index: pick, total: stmts.length };
}

// --- grading ----------------------------------------------------------------
const rowKey = (r) => JSON.stringify(r);

/** Reorder one row so that perm[j] -- a candidate column -- lands in slot j. */
const permuteRow = (row, perm) => perm.map(i => row[i]);

/**
 * Do the candidate's rows equal the expected ones once `perm` is applied?
 * Row order only matters when the exercise pins it.
 */
function rowsAgree(gotRows, wantRows, perm, ordered) {
  const a = gotRows.map(r => rowKey(permuteRow(r, perm)));
  const b = wantRows.map(rowKey);
  if (!ordered) { a.sort(); b.sort(); }
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A ten-column answer has 3.6M orderings, so the search is both pruned (a
// candidate column can only fill a slot whose values it actually holds) and
// budgeted. Both numbers are far above anything the curriculum asks for.
const PERM_MAX_COLUMNS = 10;
const PERM_MAX_TRIES = 512;

/**
 * Is the candidate the right answer with its SELECT list in a different order?
 *
 * Grading compares rows position by position, so swapping two columns turns a
 * correct query into "wrong values" -- which is true but useless as feedback.
 * This looks for a reordering of the candidate's columns that reproduces the
 * expected result exactly, and returns it (perm[j] = the candidate column that
 * belongs in expected slot j), or null when no reordering works.
 *
 * The identity permutation is never returned: that case has already passed.
 */
export function findColumnPermutation(got, want, ordered = false) {
  const n = want.columns.length;
  if (n < 2 || n !== got.columns.length || n > PERM_MAX_COLUMNS) return null;
  if (got.rows.length !== want.rows.length) return null;

  // Per-column signature: the values that column holds, as a sequence when the
  // row order is fixed and as a multiset otherwise. A column can only fill a
  // slot with the same signature, which collapses the search in practice.
  const sig = (rows, i) => {
    const vals = rows.map(r => JSON.stringify(r[i]));
    if (!ordered) vals.sort();
    return vals.join('\u0000');
  };
  const gotSig = got.columns.map((_, i) => sig(got.rows, i));
  const wantSig = want.columns.map((_, j) => sig(want.rows, j));

  const perm = new Array(n).fill(-1);
  const used = new Array(n).fill(false);
  let tries = 0;

  const solve = (j) => {
    if (j === n) return ++tries <= PERM_MAX_TRIES
      && rowsAgree(got.rows, want.rows, perm, ordered);
    for (let i = 0; i < n; i++) {
      if (used[i] || gotSig[i] !== wantSig[j]) continue;
      used[i] = true; perm[j] = i;
      if (solve(j + 1)) return true;
      used[i] = false; perm[j] = -1;
    }
    return false;
  };

  if (!solve(0)) return null;
  return perm.every((i, j) => i === j) ? null : perm;
}

/**
 * The advisory a column-order match carries: right answer, wrong SELECT list
 * order. Graded as a pass, because the rows are the rows.
 *
 * `namesNote` is appended when the columns are in the wrong order AND carry
 * names the brief did not ask for -- two separate remarks about one answer.
 */
function columnOrderVerdict(got, want, perm, namesNote = '') {
  const mapped = perm.map(i => got.columns[i]);
  return {
    pass: true,
    reason: 'column-order',
    got, want,
    columnOrder: { expected: want.columns, got: got.columns, permutation: perm },
    detail:
      'Your rows are right -- your columns just come back in a different order, '
      + 'so this counts as solved.\n\n'
      + `  the brief asks for:  ${want.columns.join(', ')}\n`
      + `  your query returns:  ${got.columns.join(', ')}\n\n`
      + `Reordering your SELECT list to ${mapped.join(', ')} matches the brief exactly. `
      + 'Worth doing anyway: the column order is part of the output contract, '
      + 'and any grader that compares column by column -- an interview '
      + 'rubric, a dbt test, a downstream INSERT -- reads a reordered SELECT '
      + 'list as a wrong answer.'
      + (namesNote ? `\n\n${namesNote}` : ''),
  };
}

// --- checking by column name ------------------------------------------------
//
//  Comparing whole rows position by position answers "is this the right
//  result?" and nothing else: every failure reads as a wall of row text, and a
//  query that put the right labels on the wrong values passed outright.
//
//  So when your column names ARE the brief's names -- same set, each once, in
//  any order -- the pairing between your columns and the expected ones is
//  unambiguous, and the answer is checked NAME BY NAME: the values under
//  `revenue` are compared with the values the brief wants under `revenue`,
//  whichever position either sits in. Then order is a separate remark rather
//  than the thing that decides right from wrong.
//
//  Names stay advisory. Rename a column and the pairing is gone, so the answer
//  falls back to the positional comparison below and still passes with a note.
//  Nothing that passed before this fails now.

const normName = (c) => String(c).trim().toLowerCase();
const hasDuplicates = (names) => new Set(names).size !== names.length;

/**
 * Pair the candidate's columns to the brief's by name.
 *
 * @returns { pinned, perm, missing, extra }
 *   pinned  -- the names are the brief's names, each exactly once on both
 *              sides, so values can be checked under each name
 *   perm    -- perm[j] = the candidate column carrying want.columns[j]
 *   missing -- expected names your result does not have
 *   extra   -- names in your result the brief did not ask for
 */
export function pairColumnsByName(gotCols, wantCols) {
  const g = gotCols.map(normName);
  const w = wantCols.map(normName);
  const missing = wantCols.filter((_, j) => !g.includes(w[j]));
  const extra = gotCols.filter((_, i) => !w.includes(g[i]));
  const pinned = g.length === w.length && !missing.length && !extra.length
    && !hasDuplicates(g) && !hasDuplicates(w);
  return { pinned, perm: pinned ? w.map((n) => g.indexOf(n)) : null, missing, extra };
}

/** Do two columns hold the same values -- in order, or as a bag? */
function columnAgrees(gotRows, gi, wantRows, wi, ordered) {
  const a = gotRows.map((r) => JSON.stringify(r[gi]));
  const b = wantRows.map((r) => JSON.stringify(r[wi]));
  if (!ordered) { a.sort(); b.sort(); }
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One concrete difference inside a single column, for the message. */
function columnDiff(gotRows, gi, wantRows, wi, ordered) {
  const show = (v) => v === null ? 'NULL' : String(v);
  const a = gotRows.map((r) => r[gi]);
  const b = wantRows.map((r) => r[wi]);
  if (ordered) {
    for (let i = 0; i < b.length; i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        return `row ${i + 1}: expected ${show(b[i])}, got ${show(a[i])}`;
      }
    }
    return '';
  }
  // Unordered: name a value the brief expects that your column never produces
  // the right number of, which survives the rows being in any order.
  const tally = (vals) => {
    const m = new Map();
    for (const v of vals) { const k = JSON.stringify(v); m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  };
  const ta = tally(a), tb = tally(b);
  for (const [k, n] of tb) {
    const mine = ta.get(k) ?? 0;
    if (mine !== n) {
      const v = show(JSON.parse(k));
      return mine === 0
        ? `never produces ${v}, which the brief expects ${n}\u00d7`
        : `produces ${v} ${mine}\u00d7, the brief expects it ${n}\u00d7`;
    }
  }
  return '';
}

/**
 * Grade an answer whose column names are the brief's, checking the values
 * under each name and treating position as a remark rather than a verdict.
 */
function gradeByName(got, want, ordered, perm) {
  if (rowsAgree(got.rows, want.rows, perm, ordered)) {
    return perm.every((i, j) => i === j)
      ? { pass: true, got, want, detail: 'Correct.' }
      : columnOrderVerdict(got, want, perm);
  }

  // A missing or wrong ORDER BY comes first, because it is the common mistake
  // and it decomposes badly: shifting the rows makes EVERY column look wrong,
  // so the per-column diagnosis below would bury the one thing to fix.
  if (ordered) {
    const mine = got.rows.map(r => rowKey(permuteRow(r, perm)));
    const theirs = want.rows.map(rowKey);
    if ([...mine].sort().join('') === [...theirs].sort().join('')) {
      const i = mine.findIndex((k, n) => k !== theirs[n]);
      const alsoReordered = !perm.every((g, j) => g === j);
      return {
        pass: false, reason: 'order', got, want, firstBadRow: i,
        detail: `Right rows, wrong order. First difference at row ${i + 1}. `
          + 'This exercise specifies an ordering, so add or fix the ORDER BY.'
          + (alsoReordered
            ? `\n\nYour columns are in a different order too (the brief asks for `
              + `${want.columns.join(', ')}); they were matched up by name to check the rows.`
            : ''),
      };
    }
  }

  // Something under at least one name is wrong. Say which name.
  const bad = [];
  for (let j = 0; j < want.columns.length; j++) {
    if (!columnAgrees(got.rows, perm[j], want.rows, j, ordered)) bad.push(j);
  }

  if (!bad.length) {
    // Every column holds exactly the right values on its own, yet the rows do
    // not match -- so the values are paired into rows differently. That is a
    // join or grouping key, not a column.
    return {
      pass: false, reason: 'row-pairing', got, want,
      detail:
        'Every column on its own holds exactly the values the brief expects -- '
        + 'but they are not paired into the same rows.\n\n'
        + '  Each of your columns is right; which value sits beside which is not.\n\n'
        + 'That is a join or grouping problem rather than a column problem: '
        + 'check what you are joining on, and what you are grouping by.',
    };
  }

  // Right data, wrong labels: the values the brief wants are all present, just
  // not under the names carrying them. Position-only grading passed this.
  const byValue = findColumnPermutation(got, want, ordered);
  if (byValue) {
    const lines = byValue
      .map((i, j) => [got.columns[i], want.columns[j]])
      .filter(([mine, asked]) => normName(mine) !== normName(asked))
      .map(([mine, asked]) => `  your ${mine} holds the values the brief wants under ${asked}`);
    return {
      pass: false, reason: 'column-labels', got, want,
      detail:
        'The right values are all there, but they are under the wrong names -- '
        + 'your labels and your expressions do not line up.\n\n'
        + lines.join('\n') + '\n\n'
        + 'Check the aliases in your SELECT list: something is named for a value '
        + 'it does not hold.',
    };
  }

  const names = bad.map((j) => want.columns[j]);
  const lines = bad.map((j) => {
    const d = columnDiff(got.rows, perm[j], want.rows, j, ordered);
    return `  ${want.columns[j]} -- ${d || 'differs'}`;
  });
  const rightOnes = want.columns.filter((_, j) => !bad.includes(j));
  return {
    pass: false, reason: 'column-values', got, want, badColumns: names,
    detail:
      `${names.length === 1 ? 'One column holds' : `${names.length} columns hold`} `
      + `the wrong values: ${names.join(', ')}.\n\n`
      + lines.join('\n')
      + (rightOnes.length ? `\n\n  correct: ${rightOnes.join(', ')}` : '')
      + '\n\nYour column names and row count are right, so the shape of the query '
      + 'is fine -- it is the expression behind '
      + `${names.length === 1 ? 'that column' : 'those columns'} to look at.`,
  };
}

/**
 * Compare a candidate query's result against the reference solution.
 * Returns { pass, reason, detail, got, want }.
 */
export async function grade(userSql, exercise) {
  if (!strip(userSql)) {
    return { pass: false, reason: 'empty', detail: 'Nothing to check yet.' };
  }
  if (!isReadOnlyQuery(userSql)) {
    return {
      pass: false, reason: 'not-a-query',
      detail: 'Answers must be a single SELECT / WITH query. Use the Sandbox if you want to modify data.',
    };
  }

  let got;
  try {
    got = await run(userSql, { limit: 1e9 });
  } catch (e) {
    return { pass: false, reason: 'error', detail: String(e.message ?? e) };
  }

  const want = await run(exercise.solution, { limit: 1e9 });

  const ordered = !!exercise.ordered;
  const byName = pairColumnsByName(got.columns, want.columns);

  if (got.columns.length !== want.columns.length) {
    // Name the columns rather than only counting them: "got 3, expected 2" does
    // not tell you which one to drop.
    const bits = [];
    if (byName.missing.length) bits.push(`missing: ${byName.missing.join(', ')}`);
    if (byName.extra.length) bits.push(`not asked for: ${byName.extra.join(', ')}`);
    return {
      pass: false, reason: 'shape', got, want,
      detail: `Expected ${want.columns.length} columns (${want.columns.join(', ')}), got ${got.columns.length} (${got.columns.join(', ')}).`
        + (bits.length ? `\n\n  ${bits.join('\n  ')}` : ''),
    };
  }

  if (got.rowCount !== want.rowCount) {
    const hint = got.rowCount > want.rowCount
      ? ' Too many rows usually means a join fanned out, or a filter is missing.'
      : ' Too few rows usually means an INNER JOIN dropped the unmatched side, or a filter is too strict.';
    return {
      pass: false, reason: 'rowcount', got, want,
      detail: `Expected ${want.rowCount.toLocaleString()} rows, got ${got.rowCount.toLocaleString()}.${hint}`,
    };
  }

  // Your column names are the brief's names, so the pairing between your
  // columns and the expected ones is unambiguous: check the values under each
  // name, and treat position as a remark rather than the verdict.
  if (byName.pinned) return gradeByName(got, want, ordered, byName.perm);

  // Otherwise the names give nothing to pin to -- you renamed something, or an
  // expression came back unnamed -- so fall back to comparing by position.
  // Names are advisory, so this path still passes a correct answer.
  const gotKeys = got.rows.map(rowKey);
  const wantKeys = want.rows.map(rowKey);

  // Rows are compared position by position, so a correct answer whose SELECT
  // list is in a different order looks like wrong values. Before calling
  // anything wrong, check for that -- it grades as a pass with a note.
  const orderedCmp = ordered;
  const asColumnOrder = () => {
    const perm = findColumnPermutation(got, want, orderedCmp);
    if (!perm) return null;
    // Reordered AND renamed: two separate things to say about one answer.
    // Duplicate names also land here, and those can still be the brief's, so
    // only say the names differ when they actually do.
    const sameNames = got.columns.map(normName).sort().join(',')
                   === want.columns.map(normName).sort().join(',');
    const note = sameNames ? '' :
      `Your column names differ from the brief too (expected: ${want.columns.join(', ')}). `
      + 'Names are advisory here, but they are part of the contract in production.';
    return columnOrderVerdict(got, want, perm, note);
  };

  if (orderedCmp) {
    for (let i = 0; i < wantKeys.length; i++) {
      if (gotKeys[i] === wantKeys[i]) continue;
      const sameMultiset =
        [...gotKeys].sort().join('') === [...wantKeys].sort().join('');
      const fmt = (r) => r.map(v => v === null ? 'NULL' : v).join(' | ');
      if (!sameMultiset) {
        const swapped = asColumnOrder();
        if (swapped) return swapped;
      }
      return {
        pass: false, reason: sameMultiset ? 'order' : 'values', got, want, firstBadRow: i,
        detail: sameMultiset
          ? `Right rows, wrong order. First difference at row ${i + 1}. This exercise specifies an ordering, so add or fix the ORDER BY.`
          : `Row ${i + 1} differs.\n  expected:  ${fmt(want.rows[i])}\n  got:       ${fmt(got.rows[i])}`,
      };
    }
  } else {
    const a = [...gotKeys].sort();
    const b = [...wantKeys].sort();
    for (let i = 0; i < b.length; i++) {
      if (a[i] === b[i]) continue;
      const swapped = asColumnOrder();
      if (swapped) return swapped;
      const missing = JSON.parse(b[i]).map(v => v === null ? 'NULL' : v).join(' | ');
      return {
        pass: false, reason: 'values', got, want,
        detail: `Row sets differ. An expected row that is not in your result:\n  ${missing}`,
      };
    }
  }

  // Values match. Column naming is advisory, not a failure.
  const namesMatch = got.columns.map(c => c.toLowerCase()).join(',')
                  === want.columns.map(c => c.toLowerCase()).join(',');
  return {
    pass: true, got, want,
    detail: namesMatch
      ? 'Correct.'
      : `Correct, though your column names differ from the brief (expected: ${want.columns.join(', ')}). In production, column names are part of the contract.`,
  };
}

// ===========================================================================
//  Portability linter
//
//  DuckDB accepts things your warehouse will not. Each rule names the engines
//  that reject the construct and says what to write instead. Sourced from
//  Part 6 of the rolling-windows reference plus each vendor's documentation.
//
//  These are WARNINGS, never errors. Your answer still grades normally.
// ===========================================================================
const LINT_RULES = [
  {
    id: 'qualify', re: /\bQUALIFY\b/i,
    bad: ['redshift', 'trino', 'spark'],
    msg: 'QUALIFY is Snowflake-only among your targets.',
    fix: 'Wrap the window function in a CTE and filter it in an outer WHERE.',
  },
  {
    id: 'filter-clause', re: /\bFILTER\s*\(\s*WHERE\b/i,
    bad: ['snowflake', 'redshift', 'spark'],
    msg: 'FILTER (WHERE ...) is not supported there.',
    fix: 'Use SUM(CASE WHEN cond THEN 1 ELSE 0 END) -- the portable form.',
  },
  {
    id: 'named-window', re: /\bWINDOW\s+\w+\s+AS\s*\(/i,
    bad: ['snowflake', 'redshift', 'spark'],
    msg: 'The named WINDOW clause is not supported there.',
    fix: 'Repeat the full OVER (...) specification on each function. Keep them identical so the engine still shares one sort.',
  },
  {
    id: 'exclude-frame', re: /\bEXCLUDE\s+(CURRENT\s+ROW|TIES|GROUP|NO\s+OTHERS)\b/i,
    bad: ['snowflake', 'redshift', 'trino', 'spark'],
    msg: 'Frame EXCLUDE is Postgres / DuckDB only.',
    fix: 'Rewrite as (SUM(x) OVER w - x) / NULLIF(COUNT(*) OVER w - 1, 0).',
  },
  {
    id: 'range-interval', re: /\bRANGE\s+BETWEEN[\s\S]{0,80}?\bINTERVAL\b/i,
    bad: ['redshift'],
    msg: 'Redshift does NOT accept offsets with RANGE -- only UNBOUNDED PRECEDING, CURRENT ROW and UNBOUNDED FOLLOWING.',
    fix: 'ORDER BY EXTRACT(EPOCH FROM ts) with a numeric RANGE (604800 = 7 days), or build a gap-free date spine.',
  },
  {
    id: 'range-numeric', re: /\bRANGE\s+BETWEEN\s+\d+\s+PRECEDING\b/i,
    bad: ['redshift'],
    msg: 'Redshift rejects numeric offsets with RANGE too.',
    fix: 'Use a date spine plus a ROWS frame.',
  },
  {
    id: 'groups-frame', re: /\bGROUPS\s+BETWEEN\b/i,
    bad: ['snowflake', 'redshift', 'trino', 'spark'],
    msg: 'GROUPS frames have little support outside Postgres / DuckDB.',
    fix: 'Rank the peer groups with DENSE_RANK and frame on ROWS, or restructure the aggregate.',
  },
  {
    id: 'asof', re: /\bASOF\s+(LEFT\s+|INNER\s+)?JOIN\b/i,
    bad: ['redshift', 'trino', 'spark'],
    msg: 'ASOF JOIN exists on Snowflake and DuckDB, but not there.',
    fix: 'Use a correlated subquery picking MAX(ts) <= event_ts, or LAST_VALUE(x) IGNORE NULLS over a UNION ALL of both tables.',
  },
  {
    id: 'generate-series', re: /\bgenerate_series\s*\(/i,
    bad: ['redshift', 'trino', 'spark'],
    msg: 'generate_series is unavailable (Trino / Spark) or leader-node-only and unjoinable (Redshift).',
    fix: 'Redshift: use dim_date, or ROW_NUMBER() off a large table. Trino: sequence() + UNNEST. Spark: sequence() + explode.',
  },
  {
    id: 'unnest-series', re: /\bUNNEST\s*\(\s*generate_series/i,
    bad: ['snowflake'],
    msg: 'Snowflake has no generate_series.',
    fix: 'TABLE(GENERATOR(ROWCOUNT => n)) with DATEADD(day, SEQ4(), start_date).',
  },
  {
    id: 'cast-shorthand', re: /::\s*[A-Za-z]/,
    bad: ['trino', 'spark'],
    msg: 'The :: cast shorthand is Postgres-family; Trino and Spark want CAST(x AS type).',
    fix: 'Write CAST(expr AS TYPE) -- valid everywhere.',
  },
  {
    id: 'date-trunc-week', re: /date_trunc\s*\(\s*'week'/i,
    bad: ['snowflake'],
    msg: 'Week start is not standardised. Snowflake follows the WEEK_START session parameter; Redshift / Trino / Spark use Monday.',
    fix: "For an unambiguous Sunday week: DATE_TRUNC('week', d + INTERVAL 1 DAY) - INTERVAL 1 DAY.",
  },
  {
    id: 'median', re: /\bMEDIAN\s*\(/i,
    bad: ['trino', 'spark'],
    msg: 'MEDIAN is not a plain aggregate there.',
    fix: 'Trino: approx_percentile(x, 0.5). Spark: percentile(x, 0.5). Redshift: MEDIAN is window-only, use PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x).',
  },
  {
    id: 'epoch-fn', re: /\bepoch\s*\(/i,
    bad: ['snowflake', 'redshift', 'trino', 'spark'],
    msg: 'epoch() is a DuckDB spelling.',
    fix: 'EXTRACT(EPOCH FROM ts) on Redshift / Snowflake, to_unixtime(ts) on Trino, unix_timestamp(ts) on Spark.',
  },
  {
    id: 'compat-dateadd', re: /\bDATEADD\s*\(/i,
    bad: ['trino', 'spark'],
    msg: 'DATEADD is the Snowflake / Redshift spelling.',
    fix: "Trino: date_add('day', 7, ts). Spark: ts + INTERVAL 7 DAY.",
  },
  {
    id: 'compat-convert-tz', re: /\bCONVERT_TIMEZONE\s*\(/i,
    bad: ['trino', 'spark'],
    msg: 'CONVERT_TIMEZONE is the Snowflake / Redshift spelling.',
    fix: "Trino: ts AT TIME ZONE 'zone'. Spark: from_utc_timestamp(ts, 'zone').",
  },
  {
    id: 'compat-nvl-iff', re: /\b(NVL2|IFF|ZEROIFNULL|NULLIFZERO)\s*\(/i,
    bad: ['trino', 'spark'],
    msg: 'That is a Snowflake / Redshift convenience function.',
    fix: 'Use COALESCE and CASE WHEN, which work on every engine.',
  },
  {
    id: 'to-char', re: /\bTO_CHAR\s*\(/i,
    bad: ['trino', 'spark'],
    msg: 'TO_CHAR is Postgres / Redshift / Snowflake.',
    fix: "Trino: format_datetime(ts,'yyyy-MM-dd'). Spark: date_format(ts,'yyyy-MM-dd').",
  },
  {
    id: 'ignore-nulls', re: /\bIGNORE\s+NULLS\b/i,
    bad: [],
    msg: 'Supported on all four of your targets -- but NOT on Postgres, if you ever prototype there.',
    fix: 'Postgres workaround: MAX(x) OVER a grouping key built from a running COUNT of non-nulls.',
  },
  {
    id: 'select-star', re: /\bSELECT\s+\*/i,
    bad: ['redshift', 'trino', 'spark'],
    msg: 'SELECT * on a columnar store reads every column.',
    fix: 'Name the columns you need. On Athena you are billed per byte scanned; on Redshift it defeats column pruning.',
  },
];

/**
 * Lint a query for constructs unsupported on the chosen target engine.
 * @returns array of { id, msg, fix, severity }
 */
export function lint(sql, targetEngine) {
  if (!sql || !targetEngine) return [];
  // Strip comments and string literals so we never match inside them.
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");

  const out = [];
  for (const rule of LINT_RULES) {
    if (!rule.re.test(cleaned)) continue;
    if (rule.bad.includes(targetEngine)) {
      out.push({ id: rule.id, msg: rule.msg, fix: rule.fix, severity: 'warn' });
    } else if (rule.bad.length === 0) {
      out.push({ id: rule.id, msg: rule.msg, fix: rule.fix, severity: 'info' });
    }
  }
  return out;
}

// --- schema introspection ---------------------------------------------------
export async function getSchema() {
  const r = await conn.query(`
    SELECT table_name, column_name, data_type, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'main'
    ORDER BY table_name, ordinal_position
  `);
  const tables = new Map();
  for (const row of r.toArray()) {
    const t = String(row.table_name);
    if (!tables.has(t)) tables.set(t, []);
    tables.get(t).push({ name: String(row.column_name), type: String(row.data_type) });
  }
  const counts = new Map();
  for (const t of tables.keys()) {
    try {
      const c = await conn.query(`SELECT count(*) AS n FROM "${t}"`);
      counts.set(t, Number(c.toArray()[0].n));
    } catch { counts.set(t, null); }
  }
  return [...tables.entries()].map(([name, columns]) => ({
    name, columns, rowCount: counts.get(name),
  }));
}
