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

  if (got.columns.length !== want.columns.length) {
    return {
      pass: false, reason: 'shape', got, want,
      detail: `Expected ${want.columns.length} columns (${want.columns.join(', ')}), got ${got.columns.length} (${got.columns.join(', ')}).`,
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

  const gotKeys = got.rows.map(rowKey);
  const wantKeys = want.rows.map(rowKey);

  if (exercise.ordered) {
    for (let i = 0; i < wantKeys.length; i++) {
      if (gotKeys[i] === wantKeys[i]) continue;
      const sameMultiset =
        [...gotKeys].sort().join('') === [...wantKeys].sort().join('');
      const fmt = (r) => r.map(v => v === null ? 'NULL' : v).join(' | ');
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
