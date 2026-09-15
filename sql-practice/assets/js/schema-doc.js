// ===========================================================================
//  Schema documentation: what a table is for, what its columns mean, and
//  which tables a given exercise expects you to touch.
//
//  WHERE THE CONTENT COMES FROM. Three sources, deliberately kept separate so
//  none of them can drift from the database:
//
//    * column names, types and row counts -> the live engine
//      (information_schema, via engine.getSchema()). Never hand-written here,
//      so a tooltip can never disagree with DESCRIBE.
//    * per-column notes and NOT NULL      -> parsed out of assets/data/schema.sql,
//      which is where those comments already live. Editing the schema edits
//      the tooltips.
//    * the one-line "what is this table for" -> PURPOSE below. Prose, so it is
//      written by hand; tools/check_schema_notes.mjs fails if a table is
//      missing one or if a note names a column that does not exist.
//
//  This module is DOM-free on purpose: the browser imports it, and so does
//  tools/check_schema_notes.mjs.
// ===========================================================================

/** One line per table: why it exists and what the trap in it is. */
export const PURPOSE = {
  dim_date:
    'The persisted calendar dimension, 2024-01-01 to 2026-12-31. Join to it instead of hand-rolling a date spine.',
  customers:
    'One row per signed-up customer. segment and city are nullable on purpose, so NOT IN and COALESCE bite here.',
  cards:
    'Payment cards. One customer can hold several, which is where join fan-out starts.',
  merchants:
    'Who was paid, with the MCC-ish category used by the fraud and category drills.',
  transactions:
    'The main event table: one row per card transaction. Contains deliberate same-timestamp ties and quiet/burst periods.',
  balance_snapshots:
    'Sparse, irregular balance readings that deliberately do NOT line up with transaction times (as-of joins).',
  logins:
    'Login attempts, several per day per customer, successful and failed (gaps and islands).',
  clickstream:
    'Funnel events whose gaps straddle the 30-minute session timeout on both sides (sessionization).',
  categories:
    'Self-referencing product category tree for recursive CTEs. parent_id is NULL at the root.',
  products:
    'The catalogue: price, cost, launch date and a discontinued flag.',
  orders:
    'One row per order. shipping_fee is order-level — summing it after joining order_items is the fan-out landmine.',
  order_items:
    'The many side of an order: one row per line item, keyed by (order_id, item_no).',
  payments:
    'Payments against an order. An order can be settled in more than one payment.',
  subscriptions:
    'Subscription intervals, half-open: active on day d when start_date <= d AND (end_date IS NULL OR d < end_date).',
  dim_customer_scd:
    'SCD Type 2 history of a customer\'s segment. Half-open [valid_from, valid_to); NULL valid_to is the current version.',
  bookings:
    'Resource reservations with deliberate overlaps on the same resource_id (interval merging).',
  daily_revenue:
    'One row per day of revenue — with missing days and zero-revenue days on purpose, so ROWS 6 PRECEDING is not a 7-day window.',
  staging_customers:
    'A raw CDC-style landing table with duplicate rows per source_customer_id. Dedup with ROW_NUMBER().',
  departments:
    'Departments. Exactly one has no employees at all, which is what the anti-join drills look for.',
  employees:
    'Employees, with a self-referencing manager_id four levels deep. department_id is NULL for contractors.',
};

/**
 * How each table joins to the others: column -> "table.column" it points at.
 *
 * These are NOT in the DDL, and that is not an oversight: Redshift, Snowflake
 * and Athena all accept foreign keys as informational metadata and never
 * enforce them, so schema.sql declares none either. The relationships are real
 * all the same, and a hover that shows you the join key saves you guessing it.
 * tools/check_schema_notes.mjs verifies both ends of every arrow exist.
 */
export const LINKS = {
  cards:             { customer_id: 'customers.customer_id' },
  transactions:      { customer_id: 'customers.customer_id', card_id: 'cards.card_id',
                       merchant_id: 'merchants.merchant_id' },
  balance_snapshots: { customer_id: 'customers.customer_id' },
  logins:            { customer_id: 'customers.customer_id' },
  clickstream:       { customer_id: 'customers.customer_id', product_id: 'products.product_id' },
  categories:        { parent_id: 'categories.category_id' },
  products:          { category_id: 'categories.category_id' },
  orders:            { customer_id: 'customers.customer_id', employee_id: 'employees.employee_id' },
  order_items:       { order_id: 'orders.order_id', product_id: 'products.product_id' },
  payments:          { order_id: 'orders.order_id' },
  subscriptions:     { customer_id: 'customers.customer_id' },
  dim_customer_scd:  { customer_id: 'customers.customer_id' },
  bookings:          { customer_id: 'customers.customer_id' },
  daily_revenue:     { day: 'dim_date.day' },
  staging_customers: { source_customer_id: 'customers.customer_id' },
  employees:         { department_id: 'departments.department_id', manager_id: 'employees.employee_id' },
};

// ---------------------------------------------------------------------------
// schema.sql parser
//
// The file is hand-written DDL in one consistent style, so a line-oriented
// parse is enough -- and it fails loudly (a table with zero columns) rather
// than silently if that style ever changes.
// ---------------------------------------------------------------------------
const NOT_A_COLUMN = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT']);

/**
 * @param {string} sql  the text of assets/data/schema.sql
 * @returns {Record<string, Record<string, {type: string, notNull: boolean, pk: boolean, note: string}>>}
 *          table -> column -> details, in declaration order.
 */
export function parseSchemaSql(sql) {
  const tables = {};
  let current = null;

  for (const raw of String(sql).split('\n')) {
    const start = raw.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i);
    if (start) { current = tables[start[1].toLowerCase()] = {}; continue; }
    if (!current) continue;
    if (/^\s*\)\s*;/.test(raw)) { current = null; continue; }

    const cut = raw.indexOf('--');
    const body = (cut === -1 ? raw : raw.slice(0, cut)).replace(/,\s*$/, '').trim();
    const note = cut === -1 ? '' : raw.slice(cut + 2).trim();
    if (!body) continue;

    // A table-level "PRIMARY KEY (a, b)" marks columns declared further up.
    const composite = body.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i);
    if (composite) {
      for (const c of composite[1].split(',')) {
        const col = current[c.trim().toLowerCase()];
        if (col) { col.pk = true; col.notNull = true; }
      }
      continue;
    }

    const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
    if (!m || NOT_A_COLUMN.has(m[1].toUpperCase())) continue;

    const rest = m[2];
    const type = rest
      .replace(/\s*\b(PRIMARY\s+KEY|NOT\s+NULL|UNIQUE|DEFAULT\s+\S+|REFERENCES\s+.*)$/i, '')
      .replace(/\s*\b(PRIMARY\s+KEY|NOT\s+NULL|UNIQUE)\b/gi, '')
      .trim();
    current[m[1].toLowerCase()] = {
      type,
      notNull: /\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(rest),
      pk: /\bPRIMARY\s+KEY\b/i.test(rest),
      note,
    };
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Which tables does an exercise use?
//
// Derived, not declared: the prompt's backticked identifiers first (they are
// the ones the text talks about, so they read in the order you meet them),
// then anything else the reference solution names. Filtering against the live
// table list is what keeps CTE names, aliases and column names out.
// ---------------------------------------------------------------------------

/**
 * @param {{prompt?: string, solution?: string, tables?: string[]}} ex
 * @param {Set<string>|string[]} known  table names that actually exist
 * @returns {string[]}
 */
export function tablesFor(ex, known) {
  const have = known instanceof Set ? known : new Set(known);
  const out = [];
  const add = (name) => {
    const n = String(name).toLowerCase();
    if (have.has(n) && !out.includes(n)) out.push(n);
  };

  for (const t of ex.tables ?? []) add(t);                       // explicit wins
  for (const m of String(ex.prompt ?? '').matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) add(m[1]);
  for (const m of String(ex.solution ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) add(m[0]);
  return out;
}
