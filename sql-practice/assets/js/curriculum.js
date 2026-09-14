// ===========================================================================
//  Curriculum.
//
//  Tracks 1-2 come from the prep guide's Tier 1 "SQL core mechanics".
//  Tracks 3-6 follow the rolling-windows reference part by part.
//  Track 7 is the "patterns you will write constantly" list.
//  Track 8 is Part 5 (performance) + Part 6 (dialect portability).
//  Track 9 is Part 7 -- the ten practice problems, verbatim.
//
//  Every exercise carries `dialect` notes: how the same answer is spelled on
//  Snowflake, Redshift, Athena/Trino and Spark. The practice engine is DuckDB,
//  which is Postgres-family like Redshift and Snowflake -- but you are going to
//  type this into a real warehouse, so the differences are part of the lesson.
// ===========================================================================

export const ENGINES = ['snowflake', 'redshift', 'trino', 'spark'];
export const ENGINE_LABELS = {
  snowflake: 'Snowflake', redshift: 'Redshift',
  trino: 'Athena / Trino', spark: 'Spark SQL',
};

export const TRACKS = [
  { id: 'joins',      name: 'Joins & the fan-out problem', source: 'Prep guide, Tier 1' },
  { id: 'nulls',      name: 'NULL semantics',              source: 'Prep guide, Tier 1' },
  { id: 'frames',     name: 'Window frame mechanics',      source: 'Windows ref, Part 1' },
  { id: 'rolling',    name: 'Rolling aggregation',         source: 'Windows ref, Part 2' },
  { id: 'timestamps', name: 'Timestamp operations',        source: 'Windows ref, Part 3' },
  { id: 'patterns',   name: 'Timestamp analysis patterns', source: 'Windows ref, Part 4' },
  { id: 'analytics',  name: 'Analytics patterns',          source: 'Prep guide, Tier 1' },
  { id: 'perf',       name: 'Performance & portability',   source: 'Windows ref, Parts 5-6' },
  { id: 'capstone',   name: 'Capstone: the ten problems',  source: 'Windows ref, Part 7' },
];

export const EXERCISES = [

// ---------------------------------------------------------------------------
// TRACK 1 -- JOINS & FAN-OUT
// ---------------------------------------------------------------------------
{
  id: 'joins-1', track: 'joins', diff: 1,
  title: 'LEFT JOIN that keeps the empty group',
  ref: 'Prep guide: "know exactly when a left join silently drops or duplicates rows"',
  prompt: `Return every department with its headcount, **including departments that have no employees at all**.

Columns: \`dept_name\`, \`employee_count\` — ordered by \`dept_name\`.

One department genuinely has zero employees. If your answer has 6 rows instead of 7, you used the wrong join. If it has 7 rows but the empty one shows \`1\`, you counted the wrong thing.`,
  hints: [
    'An INNER JOIN cannot produce a row for a department with no matching employees. Which join preserves the left side?',
    'After a LEFT JOIN, the unmatched row has NULL in every right-hand column. What does COUNT(*) do with that row? What does COUNT(some_right_column) do instead?',
    'COUNT(*) counts rows — and there IS one row for Legal, containing NULLs. COUNT(e.employee_id) skips NULLs and gives 0.',
  ],
  ordered: true,
  solution: `SELECT d.dept_name,
       COUNT(e.employee_id) AS employee_count
FROM departments d
LEFT JOIN employees e ON e.department_id = d.department_id
GROUP BY d.dept_name
ORDER BY d.dept_name;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'joins-2', track: 'joins', diff: 2,
  title: 'Anti-join: find the orphans',
  ref: 'Prep guide, Tier 1',
  prompt: `Return the departments that have **no employees**.

Columns: \`department_id\`, \`dept_name\`.

Write it as an anti-join. Then, in the sandbox, try the \`NOT IN\` version and see what happens — that is the next exercise.`,
  hints: [
    'Two idiomatic forms: LEFT JOIN ... WHERE right_key IS NULL, or NOT EXISTS (correlated subquery).',
    'NOT EXISTS is usually the one to reach for: it states the intent directly and it is NULL-safe.',
  ],
  ordered: false,
  solution: `SELECT d.department_id, d.dept_name
FROM departments d
WHERE NOT EXISTS (
    SELECT 1 FROM employees e
    WHERE e.department_id = d.department_id
);`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'joins-3', track: 'joins', diff: 3,
  title: 'The fan-out problem',
  ref: 'Prep guide: "joining a 1:many relationship and inflating your metrics"',
  prompt: `\`orders\` has an order-level \`shipping_fee\`. \`order_items\` has many rows per order.

Return, per channel: \`channel\`, \`order_count\`, \`item_count\`, \`total_shipping_fee\` — ordered by \`channel\`.

The naive query — join \`orders\` to \`order_items\`, then \`SUM(o.shipping_fee)\` — **multiplies each order's shipping fee by its number of items**. Your \`total_shipping_fee\` must be the true order-level total.

Detection habit: row count before the join vs after. 700 orders in, 2099 rows out.`,
  hints: [
    'Pre-aggregate the many-side down to one row per order BEFORE joining it to the one-side.',
    'A CTE that does SELECT order_id, COUNT(*) FROM order_items GROUP BY order_id gives you exactly one row per order.',
    'Alternative: SUM(DISTINCT ...) does NOT work here (two orders can share a fee value). Pre-aggregation is the real fix.',
  ],
  ordered: true,
  solution: `WITH items AS (
    SELECT order_id, COUNT(*) AS n_items
    FROM order_items
    GROUP BY order_id
)
SELECT o.channel,
       COUNT(*)                        AS order_count,
       SUM(i.n_items)                  AS item_count,
       ROUND(SUM(o.shipping_fee), 2)   AS total_shipping_fee
FROM orders o
JOIN items i ON i.order_id = o.order_id
GROUP BY o.channel
ORDER BY o.channel;`,
  dialect: {
    snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.',
    spark: 'Identical. On Spark, watch the physical plan — pre-aggregating also shrinks the shuffle.',
  },
},
{
  id: 'joins-4', track: 'joins', diff: 3,
  title: 'WHERE vs ON in an outer join',
  ref: 'Prep guide: "filtering in WHERE vs HAVING vs the ON clause of a left join"',
  prompt: `Return every customer with how many orders they placed **in 2026**. Customers with none must still appear, showing \`0\`.

Columns: \`customer_id\`, \`full_name\`, \`orders_2026\` — ordered by \`customer_id\`.

Put the date filter in \`WHERE\` and your LEFT JOIN silently collapses into an INNER JOIN, because the NULL-extended rows fail the predicate. The filter belongs in the \`ON\`.`,
  hints: [
    'Predicates on the RIGHT table of a LEFT JOIN belong in ON. Predicates on the LEFT table belong in WHERE.',
    'ON decides which rows match; WHERE runs after the join and discards rows — including the NULL-extended ones you wanted to keep.',
  ],
  ordered: true,
  solution: `SELECT c.customer_id,
       c.full_name,
       COUNT(o.order_id) AS orders_2026
FROM customers c
LEFT JOIN orders o
       ON o.customer_id = c.customer_id
      AND o.order_ts >= DATE '2026-01-01'
      AND o.order_ts <  DATE '2027-01-01'
GROUP BY c.customer_id, c.full_name
ORDER BY c.customer_id;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'joins-5', track: 'joins', diff: 2,
  title: 'Self-join: employee to manager',
  ref: 'Prep guide, Tier 1: self-joins',
  prompt: `List each employee alongside their manager's name. The CEO has no manager and must still appear, with \`NULL\` for the manager.

Columns: \`employee_id\`, \`employee_name\`, \`manager_name\` — ordered by \`employee_id\`.`,
  hints: ['Join employees to itself with two different aliases.', 'LEFT JOIN, or the CEO disappears.'],
  ordered: true,
  solution: `SELECT e.employee_id,
       e.full_name AS employee_name,
       m.full_name AS manager_name
FROM employees e
LEFT JOIN employees m ON m.employee_id = e.manager_id
ORDER BY e.employee_id;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'joins-6', track: 'joins', diff: 3,
  title: 'Recursive CTE: walk the category tree',
  ref: 'Prep guide, Tier 1: CTEs',
  prompt: `\`categories\` is self-referencing, four levels deep. Produce every category with its depth and its full path from the root.

Columns: \`category_id\`, \`category_name\`, \`depth\` (root = 1), \`path\` (names joined by \`' > '\`, e.g. \`All Products > Electronics > Computers\`) — ordered by \`path\`.`,
  hints: [
    'Anchor member: the rows WHERE parent_id IS NULL. Recursive member: join categories back to the CTE.',
    'Carry depth+1 and path || \' > \' || category_name through the recursive step.',
  ],
  ordered: true,
  solution: `WITH RECURSIVE tree AS (
    SELECT category_id, category_name, parent_id,
           1 AS depth,
           category_name AS path
    FROM categories
    WHERE parent_id IS NULL

    UNION ALL

    SELECT c.category_id, c.category_name, c.parent_id,
           t.depth + 1,
           t.path || ' > ' || c.category_name
    FROM categories c
    JOIN tree t ON c.parent_id = t.category_id
)
SELECT category_id, category_name, depth, path
FROM tree
ORDER BY path;`,
  dialect: {
    snowflake: 'Snowflake requires the RECURSIVE keyword too, and supports CONNECT BY as an alternative.',
    redshift: 'Supported (WITH RECURSIVE). Older clusters needed a session flag — verify on yours.',
    trino: 'Supported, but Trino caps recursion depth; set max_recursion_depth if you hit it.',
    spark: 'Spark SQL did NOT support recursive CTEs before 3.5/4.0. Check your version — you may have to iterate in code instead.',
  },
},

// ---------------------------------------------------------------------------
// TRACK 2 -- NULL SEMANTICS
// ---------------------------------------------------------------------------
{
  id: 'nulls-1', track: 'nulls', diff: 2,
  title: 'NOT IN with a NULL in the subquery',
  ref: 'Prep guide: "NOT IN with NULLs returning empty sets"',
  prompt: `Four employees are contractors with \`department_id IS NULL\`.

Run this first in the sandbox and see that it returns **zero rows**:

\`\`\`sql
SELECT department_id FROM departments
WHERE department_id NOT IN (SELECT department_id FROM employees);
\`\`\`

\`x NOT IN (1, 2, NULL)\` is \`x<>1 AND x<>2 AND x<>NULL\`, and \`x<>NULL\` is \`UNKNOWN\` — never TRUE. So nothing qualifies, ever.

Now return the correct answer: \`department_id\`, \`dept_name\` for departments with no employees.`,
  hints: [
    'Three fixes: NOT EXISTS, a LEFT JOIN ... IS NULL, or adding WHERE department_id IS NOT NULL inside the subquery.',
    'NOT EXISTS is the habit worth building — it is immune to this by construction.',
  ],
  ordered: false,
  solution: `SELECT d.department_id, d.dept_name
FROM departments d
WHERE NOT EXISTS (
    SELECT 1 FROM employees e
    WHERE e.department_id = d.department_id
);`,
  dialect: { snowflake: 'Same trap.', redshift: 'Same trap.', trino: 'Same trap.', spark: 'Same trap. This is ANSI behaviour, not a dialect quirk.' },
},
{
  id: 'nulls-2', track: 'nulls', diff: 1,
  title: 'COALESCE in a GROUP BY',
  ref: 'Prep guide: COALESCE, NULLIF',
  prompt: `Some customers have a NULL \`segment\`. Count customers per segment, bucketing the NULLs under the literal \`'Unknown'\`.

Columns: \`segment\`, \`customer_count\` — ordered by \`segment\`.`,
  hints: ['GROUP BY the same expression you SELECT.', 'COALESCE(segment, \'Unknown\').'],
  ordered: true,
  solution: `SELECT COALESCE(segment, 'Unknown') AS segment,
       COUNT(*) AS customer_count
FROM customers
GROUP BY COALESCE(segment, 'Unknown')
ORDER BY segment;`,
  dialect: {
    snowflake: 'COALESCE, or the Snowflake-flavoured NVL / IFNULL. All three work here.',
    redshift: 'COALESCE or NVL.', trino: 'COALESCE.', spark: 'COALESCE or nvl.',
  },
},
{
  id: 'nulls-3', track: 'nulls', diff: 2,
  title: 'NULLIF on the denominator',
  ref: 'Windows ref 2.4: "NULLIF(x, 0) on the denominator is not optional"',
  prompt: `\`daily_revenue\` contains a handful of **zero-revenue days**. Compute day-over-day percentage change without dividing by zero.

Columns: \`day\`, \`revenue\`, \`prev_revenue\`, \`dod_pct\` — ordered by \`day\`.

\`dod_pct\` = (revenue − prev_revenue) / prev_revenue × 100, rounded to 2 decimals, and \`NULL\` where the previous day's revenue was 0 or missing.

Note this table has gaps, so "previous row" is not always "yesterday". That is the next track's problem — here just use LAG.`,
  hints: [
    'LAG(revenue) OVER (ORDER BY day) gives the previous ROW, not yesterday.',
    'Wrap the denominator: NULLIF(prev, 0). Division by NULL yields NULL, which is what you want.',
    'Compute the LAG once in a CTE rather than repeating it three times.',
  ],
  ordered: true,
  solution: `WITH d AS (
    SELECT day,
           revenue,
           LAG(revenue) OVER (ORDER BY day) AS prev_revenue
    FROM daily_revenue
)
SELECT day,
       revenue,
       prev_revenue,
       ROUND((revenue - prev_revenue) / NULLIF(prev_revenue, 0) * 100, 2) AS dod_pct
FROM d
ORDER BY day;`,
  dialect: { snowflake: 'Identical. NULLIFZERO(x) is the Snowflake shorthand.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical — Spark returns NULL on divide-by-zero by default, but do not rely on the session config; be explicit.' },
},
{
  id: 'nulls-4', track: 'nulls', diff: 3,
  title: 'AVG skips NULLs — and that is the bug',
  ref: 'Windows ref 2.2: "a day with no sales has revenue 0, not NULL"',
  prompt: `Build a gap-free daily series for **January 2026** from \`daily_revenue\`, then report the monthly average two ways:

Columns (one row): \`avg_treating_missing_as_zero\`, \`avg_skipping_missing\`, \`n_days\`, \`n_days_with_data\`.

Round both averages to 2 decimals. \`n_days\` is every calendar day in January; \`n_days_with_data\` is how many had a row.

The two averages differ. The second one is the classic silent error: it answers "average of the days we happened to record", not "average daily revenue".`,
  hints: [
    'generate_series(DATE \'2026-01-01\', DATE \'2026-01-31\', INTERVAL 1 DAY) builds the spine.',
    'LEFT JOIN the spine to daily_revenue. Unmatched days give NULL revenue.',
    'AVG(COALESCE(revenue,0)) vs AVG(revenue) — the second ignores the NULL rows entirely.',
  ],
  ordered: false,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2026-01-01', DATE '2026-01-31', INTERVAL 1 DAY))::DATE AS day
),
filled AS (
    SELECT s.day, r.revenue
    FROM spine s
    LEFT JOIN daily_revenue r ON r.day = s.day
)
SELECT ROUND(AVG(COALESCE(revenue, 0)), 2) AS avg_treating_missing_as_zero,
       ROUND(AVG(revenue), 2)              AS avg_skipping_missing,
       COUNT(*)                            AS n_days,
       COUNT(revenue)                      AS n_days_with_data
FROM filled;`,
  dialect: {
    snowflake: "Spine: SELECT DATEADD('day', SEQ4(), DATE '2026-01-01') FROM TABLE(GENERATOR(ROWCOUNT => 31)).",
    redshift: 'generate_series is leader-node only and cannot be joined to user tables. Use ROW_NUMBER() off a large table, or a persisted calendar table.',
    trino: "SELECT d FROM UNNEST(sequence(DATE '2026-01-01', DATE '2026-01-31', INTERVAL '1' DAY)) AS t(d).",
    spark: "SELECT explode(sequence(DATE '2026-01-01', DATE '2026-01-31', INTERVAL 1 DAY)) AS day.",
  },
},

// ---------------------------------------------------------------------------
// TRACK 3 -- WINDOW FRAME MECHANICS  (Windows ref, Part 1)
// ---------------------------------------------------------------------------
{
  id: 'frames-1', track: 'frames', diff: 3,
  title: 'The default frame is RANGE, not ROWS',
  ref: 'Windows ref 1.3: "always write the frame explicitly"',
  prompt: `Customer 8 has several batches of transactions sharing an **identical** \`txn_ts\`.

For \`customer_id = 8\`, compute a running total of \`amount\` two ways:

- \`rt_default\` — \`SUM(amount) OVER (ORDER BY txn_ts)\`, frame left implicit
- \`rt_rows\` — the same, but with \`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\`

Return **only the rows where the two disagree**.

Columns: \`txn_id\`, \`txn_ts\`, \`amount\`, \`rt_default\`, \`rt_rows\` — ordered by \`txn_ts\`, \`txn_id\`.

The implicit frame is \`RANGE UNBOUNDED PRECEDING\`, and RANGE includes **every peer row sharing the current ORDER BY value**. So all three rows of a same-timestamp batch jump straight to the batch total. With unique timestamps the two are identical and the bug stays hidden.`,
  hints: [
    'Compute both windows in a CTE, then filter WHERE rt_default <> rt_rows in an outer query — you cannot filter on a window result in the same SELECT.',
    'Do not add a tiebreaker to the ORDER BY of the default window; the ties are the whole point.',
  ],
  ordered: true,
  solution: `WITH w AS (
    SELECT txn_id,
           txn_ts,
           amount,
           SUM(amount) OVER (ORDER BY txn_ts) AS rt_default,
           SUM(amount) OVER (ORDER BY txn_ts
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS rt_rows
    FROM transactions
    WHERE customer_id = 8
)
SELECT txn_id, txn_ts, amount, rt_default, rt_rows
FROM w
WHERE rt_default <> rt_rows
ORDER BY txn_ts, txn_id;`,
  dialect: {
    snowflake: 'Same default. Snowflake also defaults to RANGE UNBOUNDED PRECEDING when you supply ORDER BY without a frame.',
    redshift: 'Same default, and the same trap.',
    trino: 'Same default.',
    spark: 'Same default. This is the ANSI rule, so the habit transfers everywhere.',
  },
},
{
  id: 'frames-2', track: 'frames', diff: 3,
  title: 'ROWS counts records, RANGE counts time',
  ref: 'Windows ref 1.2 / 2.2: "ROWS 6 PRECEDING is only a 7-day window if every day has a row"',
  prompt: `\`daily_revenue\` has **missing days** — roughly 7% of dates simply have no row.

For every day in \`daily_revenue\` from \`2026-01-01\` to \`2026-03-31\`, compute:

- \`sum_7rows\` — \`ROWS BETWEEN 6 PRECEDING AND CURRENT ROW\`
- \`sum_7days\` — \`RANGE BETWEEN INTERVAL 6 DAY PRECEDING AND CURRENT ROW\`

Return only the rows where they **differ**.

Columns: \`day\`, \`revenue\`, \`sum_7rows\`, \`sum_7days\` — ordered by \`day\`.

Every differing row is a day where the "7-day" ROWS window silently reached back further than seven calendar days, because it was counting records across a gap.`,
  hints: [
    'Both windows share ORDER BY day. Only the frame differs.',
    'RANGE compares VALUES of the ORDER BY column, so it needs an interval offset against a DATE.',
    'Filter the date range in a CTE first, then compare in the outer query.',
  ],
  ordered: true,
  solution: `WITH w AS (
    SELECT day,
           revenue,
           SUM(revenue) OVER (ORDER BY day
                              ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS sum_7rows,
           SUM(revenue) OVER (ORDER BY day
                              RANGE BETWEEN INTERVAL 6 DAY PRECEDING AND CURRENT ROW) AS sum_7days
    FROM daily_revenue
    WHERE day BETWEEN DATE '2026-01-01' AND DATE '2026-03-31'
)
SELECT day, revenue, sum_7rows, sum_7days
FROM w
WHERE sum_7rows <> sum_7days
ORDER BY day;`,
  dialect: {
    snowflake: "Snowflake supports RANGE BETWEEN with interval offsets on date/time ORDER BY. Verify on your account's version.",
    redshift: 'NOT SUPPORTED. Redshift accepts only UNBOUNDED PRECEDING / CURRENT ROW / UNBOUNDED FOLLOWING with RANGE. Workaround: ORDER BY EXTRACT(EPOCH FROM ts) with a numeric RANGE (604800 = 7 days), or build a gap-free spine.',
    trino: "Supported: RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW.",
    spark: 'Supported via numeric offsets on a cast ordering column; interval offsets depend on version.',
  },
},
{
  id: 'frames-3', track: 'frames', diff: 2,
  title: 'ROW_NUMBER vs RANK vs DENSE_RANK',
  ref: 'Prep guide: "ROW_NUMBER(), RANK(), DENSE_RANK() and when each matters"',
  prompt: `Rank customers **within their country** by number of orders placed, highest first.

Columns: \`country\`, \`customer_id\`, \`order_count\`, \`rn\`, \`rnk\`, \`dense_rnk\`.

Return only rows where \`rnk <> dense_rnk\` — ordered by \`country\`, \`rnk\`, \`customer_id\`.

Order counts tie constantly, which is exactly when the three diverge:
\`ROW_NUMBER\` invents an arbitrary winner among equals, \`RANK\` leaves gaps after a tie, \`DENSE_RANK\` does not. Picking the wrong one is how "top 3" silently becomes "top 5".`,
  hints: [
    'Aggregate to one row per customer first, then rank in a second step.',
    'All three ranking functions share the same OVER clause — PARTITION BY country ORDER BY order_count DESC.',
    'Only customers with at least one order can be ranked here; an INNER JOIN to orders is fine.',
  ],
  ordered: true,
  solution: `WITH per_customer AS (
    SELECT c.country,
           c.customer_id,
           COUNT(o.order_id) AS order_count
    FROM customers c
    JOIN orders o ON o.customer_id = c.customer_id
    GROUP BY c.country, c.customer_id
),
ranked AS (
    SELECT country, customer_id, order_count,
           ROW_NUMBER() OVER (PARTITION BY country ORDER BY order_count DESC) AS rn,
           RANK()       OVER (PARTITION BY country ORDER BY order_count DESC) AS rnk,
           DENSE_RANK() OVER (PARTITION BY country ORDER BY order_count DESC) AS dense_rnk
    FROM per_customer
)
SELECT country, customer_id, order_count, rn, rnk, dense_rnk
FROM ranked
WHERE rnk <> dense_rnk
ORDER BY country, rnk, customer_id;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'frames-4', track: 'frames', diff: 3,
  title: 'The LAST_VALUE trap',
  ref: 'Prep guide: FIRST_VALUE / LAST_VALUE / NTH_VALUE',
  prompt: `For each customer who has transacted, return their first and last transaction amount **by time**, using window functions rather than MIN/MAX tricks.

Columns: \`customer_id\`, \`first_amount\`, \`last_amount\` — one row per customer, ordered by \`customer_id\`.

\`LAST_VALUE(x) OVER (ORDER BY ts)\` does **not** give the last row of the partition. The default frame ends at \`CURRENT ROW\`, so it returns the current row's own value. You must open the frame to \`UNBOUNDED FOLLOWING\`.`,
  hints: [
    'FIRST_VALUE is safe under the default frame; LAST_VALUE is not.',
    'Use ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING on the LAST_VALUE window.',
    'To collapse to one row per customer, use QUALIFY ROW_NUMBER() ... = 1, or wrap in a CTE and filter.',
  ],
  ordered: true,
  solution: `WITH w AS (
    SELECT customer_id,
           FIRST_VALUE(amount) OVER (PARTITION BY customer_id ORDER BY txn_ts, txn_id
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS first_amount,
           LAST_VALUE(amount)  OVER (PARTITION BY customer_id ORDER BY txn_ts, txn_id
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_amount,
           ROW_NUMBER()        OVER (PARTITION BY customer_id ORDER BY txn_ts, txn_id) AS rn
    FROM transactions
)
SELECT customer_id, first_amount, last_amount
FROM w
WHERE rn = 1
ORDER BY customer_id;`,
  dialect: {
    snowflake: 'Same trap. Snowflake QUALIFY lets you drop the CTE entirely.',
    redshift: 'Same trap. No QUALIFY on most versions — keep the CTE.',
    trino: 'Same trap. No QUALIFY.',
    spark: 'Same trap. No QUALIFY.',
  },
},
{
  id: 'frames-5', track: 'frames', diff: 2,
  title: 'NTILE for RFM monetary quintiles',
  ref: 'Prep guide: "RFM ... know how to build it in SQL with NTILE"',
  prompt: `Bucket customers into **monetary quintiles** by their total settled transaction value.

Columns: \`customer_id\`, \`total_amount\`, \`monetary_quintile\` where quintile **5 is the highest spend** — ordered by \`monetary_quintile\` DESC, \`total_amount\` DESC.

Only \`status = 'settled'\` transactions count. Customers who never transacted are excluded.`,
  hints: [
    'NTILE(5) OVER (ORDER BY total_amount) assigns 1 to the LOWEST bucket. To make 5 the highest, order ascending.',
    'Aggregate first in a CTE, then apply NTILE to the aggregated rows — never to the raw transactions.',
  ],
  ordered: true,
  solution: `WITH per_customer AS (
    SELECT customer_id, SUM(amount) AS total_amount
    FROM transactions
    WHERE status = 'settled'
    GROUP BY customer_id
)
SELECT customer_id,
       total_amount,
       NTILE(5) OVER (ORDER BY total_amount) AS monetary_quintile
FROM per_customer
ORDER BY monetary_quintile DESC, total_amount DESC;`,
  dialect: {
    snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.',
    spark: 'Identical. NTILE needs a full sort — on very large tables consider approx_percentile instead.',
  },
},
{
  id: 'frames-6', track: 'frames', diff: 4,
  title: 'EXCLUDE CURRENT ROW, and the portable rewrite',
  ref: 'Windows ref 1.4: "EXCLUDE ... exist in Postgres 11+ but are not portable"',
  prompt: `For each day in \`daily_revenue\` during Q1 2026, compute the average of the **six surrounding days, excluding the day itself** (3 before, 3 after).

Columns: \`day\`, \`revenue\`, \`neighbour_avg\` (rounded to 2dp) — ordered by \`day\`.

Do it with \`ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING EXCLUDE CURRENT ROW\`.

Then read the dialect note: on engines without \`EXCLUDE\` you rebuild this as \`(SUM(window) - current) / (COUNT(window) - 1)\`, which is worth being able to derive on the spot.`,
  hints: [
    'EXCLUDE CURRENT ROW attaches to the end of the frame clause.',
    'Careful at the series edges: the window is smaller there, and that is correct.',
  ],
  ordered: true,
  solution: `SELECT day,
       revenue,
       ROUND(AVG(revenue) OVER (ORDER BY day
                                ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
                                EXCLUDE CURRENT ROW), 2) AS neighbour_avg
FROM daily_revenue
WHERE day BETWEEN DATE '2026-01-01' AND DATE '2026-03-31'
ORDER BY day;`,
  dialect: {
    snowflake: 'No EXCLUDE. Use (SUM(...) OVER w - revenue) / NULLIF(COUNT(*) OVER w - 1, 0).',
    redshift: 'No EXCLUDE. Same rewrite.',
    trino: 'No EXCLUDE. Same rewrite.',
    spark: 'No EXCLUDE. Same rewrite.',
  },
},

// ---------------------------------------------------------------------------
// TRACK 4 -- ROLLING AGGREGATION  (Windows ref, Part 2)
// ---------------------------------------------------------------------------
{
  id: 'rolling-1', track: 'rolling', diff: 2,
  title: 'Trailing moving average, partial windows nulled',
  ref: 'Windows ref 2.1: "decide deliberately whether to null them out"',
  prompt: `For every row of \`daily_revenue\` in Q1 2026, compute a trailing 7-**row** moving average, but emit it **only when the window is actually full**.

Columns: \`day\`, \`revenue\`, \`ma_7\` (rounded 2dp, NULL until 7 rows are available) — ordered by \`day\`.

The first six rows of any series average an incomplete window. Left visible on a dashboard, they look like a January collapse and someone will ask you about it.`,
  hints: [
    'COUNT(*) OVER (same frame) tells you how many rows the frame actually contains.',
    'CASE WHEN COUNT(*) OVER w = 7 THEN AVG(revenue) OVER w END',
    'A named WINDOW clause lets you write the frame once instead of three times.',
  ],
  ordered: true,
  solution: `SELECT day,
       revenue,
       CASE WHEN COUNT(*) OVER w = 7
            THEN ROUND(AVG(revenue) OVER w, 2)
       END AS ma_7
FROM daily_revenue
WHERE day BETWEEN DATE '2026-01-01' AND DATE '2026-03-31'
WINDOW w AS (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
ORDER BY day;`,
  dialect: {
    snowflake: 'No named WINDOW clause — repeat the OVER spec, or wrap in a CTE.',
    redshift: 'No named WINDOW clause. Repeat the frame.',
    trino: 'Named WINDOW clause supported.',
    spark: 'No named WINDOW clause. Repeat the frame.',
  },
},
{
  id: 'rolling-2', track: 'rolling', diff: 3,
  title: 'Date spine: make the gaps explicit',
  ref: 'Windows ref 2.2, Fix B',
  prompt: `Build a **gap-free** daily series for Q1 2026 and compute a true 7-day moving average on it.

Columns: \`day\`, \`revenue\` (0 on days with no row, not NULL), \`ma_7\` (rounded 2dp) — ordered by \`day\`, every calendar day in Q1 present.

Two things to get right: the spine must be LEFT JOINed so missing days survive, and the missing days must become \`0\` **before** the window runs. Leave them NULL and \`AVG\` skips them, quietly giving you the average of the days that happened to exist.`,
  hints: [
    'generate_series(DATE \'2026-01-01\', DATE \'2026-03-31\', INTERVAL 1 DAY) then UNNEST it.',
    'COALESCE(r.revenue, 0) in the filled CTE — not in the window.',
    'Now ROWS BETWEEN 6 PRECEDING really is seven days, because every day has exactly one row.',
  ],
  ordered: true,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL 1 DAY))::DATE AS day
),
filled AS (
    SELECT s.day,
           COALESCE(r.revenue, 0) AS revenue
    FROM spine s
    LEFT JOIN daily_revenue r ON r.day = s.day
)
SELECT day,
       revenue,
       ROUND(AVG(revenue) OVER (ORDER BY day
                                ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2) AS ma_7
FROM filled
ORDER BY day;`,
  dialect: {
    snowflake: "TABLE(GENERATOR(ROWCOUNT => 90)) with DATEADD('day', SEQ4(), start_date).",
    redshift: 'generate_series cannot be joined to user tables. Use ROW_NUMBER() OVER () off any large table, or the persisted dim_date.',
    trino: "UNNEST(sequence(DATE '2026-01-01', DATE '2026-03-31', INTERVAL '1' DAY)).",
    spark: 'explode(sequence(...)).',
  },
},
{
  id: 'rolling-3', track: 'rolling', diff: 3,
  title: 'Same answer without a spine: RANGE + INTERVAL',
  ref: 'Windows ref 2.2, Fix A / 2.3',
  prompt: `Redo the trailing 7-day **sum** over Q1 2026 without building a spine, using a time-based RANGE frame.

Columns: \`day\`, \`revenue\`, \`sum_7d\` — ordered by \`day\`. Only days present in \`daily_revenue\` appear.

\`RANGE BETWEEN INTERVAL 6 DAY PRECEDING AND CURRENT ROW\` is measured in **calendar time**, so gaps cost you nothing — the window is always the right width.

This is the cleaner answer where it is supported. Read the dialect note before you rely on it: **Redshift does not support offset values with RANGE at all.**`,
  hints: [
    'No CTE needed. One SELECT.',
    'The frame offset is an INTERVAL because the ORDER BY column is a DATE.',
  ],
  ordered: true,
  solution: `SELECT day,
       revenue,
       SUM(revenue) OVER (ORDER BY day
                          RANGE BETWEEN INTERVAL 6 DAY PRECEDING AND CURRENT ROW) AS sum_7d
FROM daily_revenue
WHERE day BETWEEN DATE '2026-01-01' AND DATE '2026-03-31'
ORDER BY day;`,
  dialect: {
    snowflake: 'Supported on date/time ordering columns.',
    redshift: 'NOT SUPPORTED — RANGE takes only UNBOUNDED/CURRENT ROW. Cast to epoch seconds and use a numeric RANGE (604800 PRECEDING), or use a spine.',
    trino: "RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW.",
    spark: 'Order by a numeric (unix_timestamp) column and use numeric offsets.',
  },
},
{
  id: 'rolling-4', track: 'rolling', diff: 3,
  title: 'Per-customer rolling 30-day spend',
  ref: 'Windows ref 2.3 — and a warm-up for capstone problem 1',
  prompt: `For every transaction, compute that customer's **trailing 30-day** transaction total, inclusive of the current transaction.

Restrict to \`customer_id = 66\` (the heaviest transactor) so the output is readable.

Columns: \`txn_id\`, \`txn_ts\`, \`amount\`, \`trailing_30d_amount\` — ordered by \`txn_ts\`, \`txn_id\`.

Note the frame must PARTITION BY customer even though you filtered to one customer — write it as you would in production.`,
  hints: [
    'PARTITION BY customer_id ORDER BY txn_ts, with a RANGE INTERVAL 30 DAY frame.',
    'The ORDER BY column is a TIMESTAMP, so INTERVAL 30 DAY compares against the timestamp value directly.',
  ],
  ordered: true,
  solution: `SELECT txn_id,
       txn_ts,
       amount,
       SUM(amount) OVER (PARTITION BY customer_id
                         ORDER BY txn_ts
                         RANGE BETWEEN INTERVAL 30 DAY PRECEDING AND CURRENT ROW) AS trailing_30d_amount
FROM transactions
WHERE customer_id = 66
ORDER BY txn_ts, txn_id;`,
  dialect: {
    snowflake: 'Supported.',
    redshift: "Not supported with RANGE offsets. Use ORDER BY EXTRACT(EPOCH FROM txn_ts) RANGE BETWEEN 2592000 PRECEDING AND CURRENT ROW (30 days in seconds).",
    trino: "RANGE BETWEEN INTERVAL '30' DAY PRECEDING AND CURRENT ROW.",
    spark: 'ORDER BY unix_timestamp(txn_ts) RANGE BETWEEN 2592000 PRECEDING AND CURRENT ROW.',
  },
},
{
  id: 'rolling-5', track: 'rolling', diff: 3,
  title: 'Rolling z-score, current row excluded',
  ref: 'Windows ref 2.5: "a genuine outlier inflates its own mean and standard deviation"',
  prompt: `Find anomalous transaction days. For each customer-day, compare that day's transaction **count** against the customer's own trailing 30-day baseline, **excluding the day itself** from the baseline.

Columns: \`customer_id\`, \`day\`, \`n_txns\`, \`baseline_avg\` (2dp), \`baseline_sd\` (2dp), \`z\` (2dp) — return only rows with \`z > 3\`, ordered by \`z\` DESC, \`customer_id\`, \`day\`.

The frame must end at \`1 PRECEDING\`, not \`CURRENT ROW\`. Include today in its own baseline and a real spike drags the mean and SD up with it, shrinking its own z-score — you blunt the exact signal you are hunting.

Guard the division: a flat baseline has SD 0.`,
  hints: [
    'Aggregate to one row per customer-day first.',
    'Frame: PARTITION BY customer_id ORDER BY day ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING.',
    'z = (n - avg) / NULLIF(sd, 0). Rows where sd is 0 or NULL drop out of a > 3 filter automatically.',
  ],
  ordered: true,
  solution: `WITH daily AS (
    SELECT customer_id,
           txn_ts::DATE AS day,
           COUNT(*)     AS n_txns
    FROM transactions
    GROUP BY customer_id, txn_ts::DATE
),
scored AS (
    SELECT customer_id, day, n_txns,
           AVG(n_txns)         OVER w AS baseline_avg,
           STDDEV_SAMP(n_txns) OVER w AS baseline_sd
    FROM daily
    WINDOW w AS (PARTITION BY customer_id ORDER BY day
                 ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING)
)
SELECT customer_id,
       day,
       n_txns,
       ROUND(baseline_avg, 2) AS baseline_avg,
       ROUND(baseline_sd, 2)  AS baseline_sd,
       ROUND((n_txns - baseline_avg) / NULLIF(baseline_sd, 0), 2) AS z
FROM scored
WHERE (n_txns - baseline_avg) / NULLIF(baseline_sd, 0) > 3
ORDER BY z DESC, customer_id, day;`,
  dialect: {
    snowflake: 'STDDEV_SAMP works as a window function. No named WINDOW clause — repeat the frame.',
    redshift: 'STDDEV_SAMP works as a window function. No named WINDOW clause.',
    trino: 'stddev_samp works as a window function. Named WINDOW supported.',
    spark: 'stddev_samp works as a window function. No named WINDOW clause.',
  },
},
{
  id: 'rolling-6', track: 'rolling', diff: 4,
  title: 'Rolling standard deviation without STDDEV',
  ref: 'Portability drill — derive it from SUM(x) and SUM(x*x)',
  prompt: `Recompute the trailing 30-day standard deviation of daily transaction counts for \`customer_id = 121\` **without using STDDEV_SAMP** — derive it from the sums.

Columns: \`day\`, \`n_txns\`, \`sd_manual\` (4dp), \`sd_builtin\` (4dp) — ordered by \`day\`. Frame: \`ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING\`.

The sample variance identity:

\`\`\`
var = ( SUM(x²) − SUM(x)² / n ) / (n − 1)
\`\`\`

Every engine can do this, which makes it the fallback when a windowed STDDEV is unavailable or when you are pushing the maths into a tool that lacks it. The two columns should agree to 4 decimals.`,
  hints: [
    'You need three windowed aggregates over the same frame: SUM(n), SUM(n*n), COUNT(*).',
    'Guard n - 1 = 0 with NULLIF, then SQRT the variance.',
    'Rounding both to 4dp hides floating-point noise in the last bits.',
  ],
  ordered: true,
  solution: `WITH daily AS (
    SELECT txn_ts::DATE AS day, COUNT(*) AS n_txns
    FROM transactions
    WHERE customer_id = 121
    GROUP BY txn_ts::DATE
),
agg AS (
    SELECT day, n_txns,
           SUM(n_txns)          OVER w AS s1,
           SUM(n_txns * n_txns) OVER w AS s2,
           COUNT(*)             OVER w AS n,
           STDDEV_SAMP(n_txns)  OVER w AS sd_builtin
    FROM daily
    WINDOW w AS (ORDER BY day ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING)
)
SELECT day,
       n_txns,
       ROUND(SQRT((s2 - (s1 * s1) / n) / NULLIF(n - 1, 0)), 4) AS sd_manual,
       ROUND(sd_builtin, 4)                                    AS sd_builtin
FROM agg
ORDER BY day;`,
  dialect: {
    snowflake: 'Identical arithmetic; SQRT and POWER exist everywhere.',
    redshift: 'Identical. Cast to DOUBLE PRECISION if your inputs are integers, or integer division will bite.',
    trino: 'Identical.',
    spark: 'Identical.',
  },
},
{
  id: 'rolling-7', track: 'rolling', diff: 2,
  title: 'Conditional aggregation inside a window',
  ref: 'Windows ref 2.6: "default to the CASE WHEN form, it always works"',
  prompt: `For \`customer_id = 23\`, count how many of the **last 10 transactions** (current one included) were not settled.

Columns: \`txn_id\`, \`txn_ts\`, \`status\`, \`non_settled_last_10\` — ordered by \`txn_ts\`, \`txn_id\`.

Use the portable \`SUM(CASE WHEN ... THEN 1 ELSE 0 END) OVER (...)\` form rather than \`COUNT(*) FILTER (WHERE ...)\`. The FILTER form is cleaner and works here, but it is not available on Redshift or Spark — and this is a habit you want to be automatic.`,
  hints: [
    'Frame: ROWS BETWEEN 9 PRECEDING AND CURRENT ROW gives ten rows.',
    "CASE WHEN status <> 'settled' THEN 1 ELSE 0 END, summed over the frame.",
  ],
  ordered: true,
  solution: `SELECT txn_id,
       txn_ts,
       status,
       SUM(CASE WHEN status <> 'settled' THEN 1 ELSE 0 END) OVER (
           ORDER BY txn_ts, txn_id
           ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
       ) AS non_settled_last_10
FROM transactions
WHERE customer_id = 23
ORDER BY txn_ts, txn_id;`,
  dialect: {
    snowflake: 'CASE form works. FILTER is not supported.',
    redshift: 'CASE form works. FILTER is not supported.',
    trino: 'Both work. FILTER is available.',
    spark: 'CASE form works. FILTER is not supported in window context.',
  },
},
{
  id: 'rolling-8', track: 'rolling', diff: 4,
  title: 'Rolling distinct count — the one that does not work',
  ref: 'Windows ref 2.7: "COUNT(DISTINCT x) OVER (...) is not supported in essentially any major engine"',
  prompt: `Compute **28-day rolling active customers** for each day in Q1 2026: the number of distinct customers with at least one transaction in the trailing 28 days.

Columns: \`day\`, \`active_28d\` — ordered by \`day\`, one row per calendar day in Q1.

\`COUNT(DISTINCT customer_id) OVER (...)\` will be rejected. There is no window-function answer. Use the self-join / range-join form: build a spine, then join transactions to every day whose 28-day window contains them.

This metric is one of the most requested and most expensive in analytics. At scale, teams reach for HyperLogLog sketches instead — see the dialect note.`,
  hints: [
    'Spine of days, then JOIN transactions ON t.txn_ts >= day - 27 days AND t.txn_ts < day + 1 day.',
    'Mind the boundaries: a 28-day window ending on `day` inclusive spans day-27 .. day.',
    'Because txn_ts is a TIMESTAMP, compare against day + INTERVAL 1 DAY rather than <= day.',
  ],
  ordered: true,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL 1 DAY))::DATE AS day
)
SELECT s.day,
       COUNT(DISTINCT t.customer_id) AS active_28d
FROM spine s
LEFT JOIN transactions t
       ON t.txn_ts >= s.day - INTERVAL 27 DAY
      AND t.txn_ts <  s.day + INTERVAL 1 DAY
GROUP BY s.day
ORDER BY s.day;`,
  dialect: {
    snowflake: 'Same approach. Snowflake has APPROX_COUNT_DISTINCT and HLL sketch functions (HLL_ACCUMULATE / HLL_COMBINE) for the cheap version.',
    redshift: 'Same approach. Redshift has APPROXIMATE COUNT(DISTINCT ...) and HLL types.',
    trino: 'Same approach, or approx_set / merge / cardinality for HLL sketches — the pattern in the reference doc.',
    spark: 'Same approach, or approx_count_distinct.',
  },
},

// ---------------------------------------------------------------------------
// TRACK 5 -- TIMESTAMP OPERATIONS  (Windows ref, Part 3)
// ---------------------------------------------------------------------------
{
  id: 'ts-1', track: 'timestamps', diff: 3,
  title: 'Week start is not standardised',
  ref: 'Windows ref 3.1: "if weekly figures are off, this is the first thing to check"',
  prompt: `Take the week containing **2026-02-11** and total \`daily_revenue\` over it under both week conventions.

Columns: \`week_definition\` (\`'monday_start'\` or \`'sunday_start'\`), \`week_start\`, \`revenue_total\` (2dp), \`n_days\` — two rows, ordered by \`week_definition\`.

\`DATE_TRUNC('week', ...)\` gives **Monday** on Postgres, Redshift, Trino and DuckDB; BigQuery defaults to Sunday; Snowflake follows a session parameter. Two teams can compute "weekly revenue" from the same table and disagree, and neither query is wrong.

Force a Sunday start explicitly with \`DATE_TRUNC('week', d + INTERVAL 1 DAY) - INTERVAL 1 DAY\`.`,
  hints: [
    'Compute each week_start from the anchor date, then join daily_revenue on [week_start, week_start + 7 days).',
    'Use a half-open range, not BETWEEN — BETWEEN would include day 8.',
    'UNION ALL the two branches.',
  ],
  ordered: true,
  solution: `WITH anchor AS (SELECT DATE '2026-02-11' AS d),
mon AS (SELECT DATE_TRUNC('week', d)::DATE AS ws FROM anchor),
sun AS (SELECT (DATE_TRUNC('week', d + INTERVAL 1 DAY) - INTERVAL 1 DAY)::DATE AS ws FROM anchor)
SELECT 'monday_start' AS week_definition,
       m.ws           AS week_start,
       ROUND(SUM(r.revenue), 2) AS revenue_total,
       COUNT(*)       AS n_days
FROM mon m
JOIN daily_revenue r ON r.day >= m.ws AND r.day < m.ws + INTERVAL 7 DAY
GROUP BY m.ws

UNION ALL

SELECT 'sunday_start',
       s.ws,
       ROUND(SUM(r.revenue), 2),
       COUNT(*)
FROM sun s
JOIN daily_revenue r ON r.day >= s.ws AND r.day < s.ws + INTERVAL 7 DAY
GROUP BY s.ws
ORDER BY week_definition;`,
  dialect: {
    snowflake: 'DATE_TRUNC respects the WEEK_START session parameter (default 0 = legacy Sunday-ish behaviour). Set it explicitly or use the +1/-1 day trick. This is the single most portable-looking function that is not portable.',
    redshift: "DATE_TRUNC('week', ...) is Monday. Also has DATE_PART('week', ...) for ISO week numbers.",
    trino: "date_trunc('week', ...) is Monday.",
    spark: "date_trunc('week', ...) is Monday; weekofyear() is ISO.",
  },
},
{
  id: 'ts-2', track: 'timestamps', diff: 1,
  title: 'ISO day-of-week vs Postgres day-of-week',
  ref: 'Windows ref 3.2: "another cross-engine mismatch that produces subtly wrong weekend flags"',
  prompt: `Count transactions by day of week using the persisted calendar dimension.

Columns: \`iso_dow\` (1=Monday … 7=Sunday), \`day_name\`, \`n_txns\`, \`is_weekend\` (1/0) — ordered by \`iso_dow\`.

\`dim_date\` carries both numbering schemes on purpose: \`iso_dow\` (1=Mon) and \`dow_sun0\` (0=Sun, the Postgres/Redshift \`EXTRACT(DOW)\` convention). Mixing them up shifts your weekend flag by a day and nobody notices until someone asks why Saturday revenue looks like a weekday.`,
  hints: [
    'Join transactions to dim_date on the DATE-cast of txn_ts.',
    'is_weekend is the inverse of dim_date.is_weekday.',
  ],
  ordered: true,
  solution: `SELECT d.iso_dow,
       d.day_name,
       COUNT(*) AS n_txns,
       CASE WHEN d.is_weekday = 1 THEN 0 ELSE 1 END AS is_weekend
FROM transactions t
JOIN dim_date d ON d.day = t.txn_ts::DATE
GROUP BY d.iso_dow, d.day_name, d.is_weekday
ORDER BY d.iso_dow;`,
  dialect: {
    snowflake: 'DAYOFWEEKISO() is 1=Mon..7=Sun; DAYOFWEEK() follows the WEEK_START parameter.',
    redshift: "EXTRACT(DOW) is 0=Sunday. Use EXTRACT(ISODOW) for 1=Monday.",
    trino: 'day_of_week() is 1=Monday..7=Sunday — NOT the same as Postgres DOW.',
    spark: 'dayofweek() is 1=Sunday..7=Saturday. Different again. Always check.',
  },
},
{
  id: 'ts-3', track: 'timestamps', diff: 3,
  title: 'The DATEDIFF boundary-crossing trap',
  ref: 'Windows ref 3.3: "that is one day apart, but it crosses one year boundary"',
  prompt: `Compute each customer's tenure in whole years as of **2026-09-14**, two ways:

- \`tenure_datediff\` — \`DATEDIFF('year', signup_date, DATE '2026-09-14')\`
- \`tenure_true\` — \`FLOOR(days_elapsed / 365.25)\`

Return only customers where the two **disagree**.

Columns: \`customer_id\`, \`signup_date\`, \`tenure_datediff\`, \`tenure_true\` — ordered by \`customer_id\`.

\`DATEDIFF\` on Redshift, Snowflake and SQL Server counts **boundary crossings**, not elapsed time. Someone who signed up on 31 Dec 2025 has a "tenure" of 1 year on 1 Jan 2026. Use it for customer age or tenure and you will systematically overstate it.`,
  hints: [
    'signup_ts is a TIMESTAMP — cast it to DATE first so both calculations start from the same place.',
    "DATEDIFF('day', a, b) is safe; it is the year/month/quarter parts that cross boundaries.",
    'FLOOR needs a real division: days / 365.25, not integer division.',
  ],
  ordered: true,
  solution: `WITH t AS (
    SELECT customer_id,
           signup_ts::DATE AS signup_date,
           DATEDIFF('year', signup_ts::DATE, DATE '2026-09-14') AS tenure_datediff,
           FLOOR(DATEDIFF('day', signup_ts::DATE, DATE '2026-09-14') / 365.25) AS tenure_true
    FROM customers
)
SELECT customer_id, signup_date, tenure_datediff, tenure_true
FROM t
WHERE tenure_datediff <> tenure_true
ORDER BY customer_id;`,
  dialect: {
    snowflake: 'DATEDIFF(year, a, b) counts boundary crossings — same trap. Use DATEDIFF(day,...)/365.25, or MONTHS_BETWEEN/12.',
    redshift: 'Same trap. Postgres has AGE() for true elapsed time; Redshift does not.',
    trino: "date_diff('year', a, b) truncates the actual elapsed duration — the more intuitive behaviour, and DIFFERENT from Redshift. Know which engine you are on.",
    spark: 'months_between(b, a)/12 gives true elapsed; datediff(b, a) is days only.',
  },
},
{
  id: 'ts-4', track: 'timestamps', diff: 3,
  title: 'UTC in, local time out - and the fixed-offset trap',
  ref: 'Windows ref 3.4: "always use IANA zone names, never abbreviations"',
  prompt: `\`txn_ts\` is naive UTC. \`customers\` carries both \`tz_name\` (an IANA zone such as \`America/New_York\`) and \`utc_offset_minutes\` (a **fixed** offset, DST ignored).

Using the fixed offset, produce the distribution of transactions by local hour of day for customers in \`America/New_York\`.

Columns: \`local_hour\` (0-23), \`n_txns\` - ordered by \`local_hour\`.

Shift the timestamp by \`utc_offset_minutes * INTERVAL 1 MINUTE\`, then extract the hour.

**And now the point.** This answer is *wrong for roughly two-thirds of the year*. \`America/New_York\` is UTC-5 in winter but UTC-4 under daylight saving, so a fixed -300 offset misplaces every summer transaction by one hour. This is exactly what writing \`'EST'\` instead of \`'America/New_York'\` does to you, and it is why the reference doc says never to use the abbreviation. The next exercise measures the damage.

Doing it *correctly* needs the engine's IANA database: \`CONVERT_TIMEZONE('UTC', 'America/New_York', txn_ts)\` on Snowflake/Redshift. Here that needs DuckDB's optional ICU extension - see the Portability tab.`,
  hints: [
    'Join transactions to customers to reach tz_name and utc_offset_minutes.',
    'txn_ts + (utc_offset_minutes * INTERVAL 1 MINUTE) shifts the naive timestamp.',
    'EXTRACT(HOUR FROM <shifted timestamp>), then GROUP BY it.',
  ],
  ordered: true,
  solution: `SELECT EXTRACT(HOUR FROM t.txn_ts + (c.utc_offset_minutes * INTERVAL 1 MINUTE)) AS local_hour,
       COUNT(*) AS n_txns
FROM transactions t
JOIN customers c ON c.customer_id = t.customer_id
WHERE c.tz_name = 'America/New_York'
GROUP BY 1
ORDER BY local_hour;`,
  dialect: {
    snowflake: "Do it properly: CONVERT_TIMEZONE('UTC', c.tz_name, t.txn_ts). Snowflake ships the IANA database, so DST is handled for you and the fixed-offset workaround above is never needed.",
    redshift: "CONVERT_TIMEZONE('UTC', c.tz_name, t.txn_ts) - native, DST-correct. Note Redshift TIMESTAMP is naive and TIMESTAMPTZ is aware, the same split as here.",
    trino: "t.txn_ts AT TIME ZONE 'America/New_York' (on a zoned value). Trino's AT TIME ZONE converts; applied to a naive timestamp it interprets instead - the double meaning the reference doc warns about.",
    spark: "from_utc_timestamp(t.txn_ts, c.tz_name) - DST-correct. to_utc_timestamp() goes the other way.",
  },
},
{
  id: 'ts-8', track: 'timestamps', diff: 3,
  title: 'Measure what the fixed offset costs you',
  ref: 'Windows ref 3.4: DST edge cases that break reports',
  prompt: `Quantify the error from the previous exercise.

US daylight saving ran **2025-03-09 07:00 UTC to 2025-11-02 06:00 UTC**, and **2026-03-08 07:00 UTC to 2026-11-01 06:00 UTC**. During those windows \`America/New_York\` is UTC-4, not UTC-5, so a fixed -300 offset places the transaction in the wrong hour.

For customers in \`America/New_York\`, return one row:

Columns: \`n_total\`, \`n_misplaced\`, \`pct_misplaced\` (2dp).

A fixed offset is not a rounding error. It is a systematic one-hour shift applied to most of your data, and it will not show up until someone compares your hourly dashboard against another team's.`,
  hints: [
    'Filter to the New York customers first in a CTE.',
    'SUM(CASE WHEN txn_ts falls inside either DST window THEN 1 ELSE 0 END).',
    'Use half-open comparisons (>= start AND < end) so the boundary instant is counted once.',
  ],
  ordered: false,
  solution: `WITH ny AS (
    SELECT t.txn_ts
    FROM transactions t
    JOIN customers c ON c.customer_id = t.customer_id
    WHERE c.tz_name = 'America/New_York'
),
flagged AS (
    SELECT CASE
             WHEN (txn_ts >= TIMESTAMP '2025-03-09 07:00:00' AND txn_ts < TIMESTAMP '2025-11-02 06:00:00')
               OR (txn_ts >= TIMESTAMP '2026-03-08 07:00:00' AND txn_ts < TIMESTAMP '2026-11-01 06:00:00')
             THEN 1 ELSE 0
           END AS is_dst
    FROM ny
)
SELECT COUNT(*)                                        AS n_total,
       SUM(is_dst)                                     AS n_misplaced,
       ROUND(SUM(is_dst) * 100.0 / COUNT(*), 2)        AS pct_misplaced
FROM flagged;`,
  dialect: {
    snowflake: 'You would never write this in production - CONVERT_TIMEZONE handles DST. The exercise exists to show the size of the bug you avoid by using it.',
    redshift: 'Same: CONVERT_TIMEZONE with an IANA name is DST-correct.',
    trino: 'Same: AT TIME ZONE with an IANA name is DST-correct.',
    spark: 'Same: from_utc_timestamp with an IANA name is DST-correct.',
  },
},
{
  id: 'ts-5', track: 'timestamps', diff: 3,
  title: 'Bucketing into arbitrary intervals',
  ref: 'Windows ref 3.5: "the epoch floor-divide is the pattern to remember"',
  prompt: `Bucket clickstream events from **2026-03-01 to 2026-03-07 inclusive** into **15-minute** buckets.

Columns: \`bucket_start\` (a TIMESTAMP at the bucket boundary), \`n_events\` — ordered by \`bucket_start\`. Only non-empty buckets appear.

Two equivalent routes: truncate to the hour and add \`FLOOR(minute/15)*15\` minutes, or floor-divide the epoch by 900 seconds and convert back. The epoch route generalises to any bucket size and works on every engine — that is the one worth memorising.`,
  hints: [
    "DATE_TRUNC('hour', event_ts) gets you the hour boundary.",
    'EXTRACT(MINUTE FROM event_ts) / 15, floored, times 15 gives the minute offset.',
    'DuckDB needs the offset multiplied by an interval literal: (expr) * INTERVAL 1 MINUTE.',
  ],
  ordered: true,
  solution: `SELECT DATE_TRUNC('hour', event_ts)
         + (FLOOR(EXTRACT(MINUTE FROM event_ts) / 15) * 15) * INTERVAL 1 MINUTE AS bucket_start,
       COUNT(*) AS n_events
FROM clickstream
WHERE event_ts >= DATE '2026-03-01'
  AND event_ts <  DATE '2026-03-08'
GROUP BY 1
ORDER BY bucket_start;`,
  dialect: {
    snowflake: "TIME_SLICE(ts, 15, 'MINUTE') does this natively — the nicest version anywhere.",
    redshift: "DATE_TRUNC('hour', ts) + FLOOR(EXTRACT(MINUTE FROM ts)/15) * INTERVAL '15 minutes'.",
    trino: 'from_unixtime(floor(to_unixtime(ts)/900)*900) — the epoch floor-divide.',
    spark: 'window(ts, "15 minutes") gives a struct of start/end, or use the epoch floor-divide.',
  },
},
{
  id: 'ts-6', track: 'timestamps', diff: 2,
  title: 'Epoch conversions, seconds vs milliseconds',
  ref: 'Windows ref 3.6: "if your dates land in 1970, you forgot the /1000"',
  prompt: `For the 10 earliest transactions, show the timestamp alongside its epoch representations and a round-trip back.

Columns: \`txn_id\`, \`txn_ts\`, \`epoch_s\` (BIGINT seconds), \`epoch_ms\` (BIGINT milliseconds), \`roundtrip_ts\` — ordered by \`txn_ts\`, \`txn_id\`, limited to 10 rows.

\`roundtrip_ts\` must equal \`txn_ts\` exactly. Event streams routinely carry milliseconds; feeding those to a seconds-based converter lands you in the year 56000, and dividing when you should not lands you in 1970.`,
  hints: [
    'EXTRACT(EPOCH FROM ts) gives seconds; cast to BIGINT to drop fractional noise.',
    'Milliseconds are just seconds * 1000 here.',
    'make_timestamp(micros) rebuilds a naive TIMESTAMP with no time-zone machinery involved.',
  ],
  ordered: true,
  solution: `SELECT txn_id,
       txn_ts,
       CAST(EXTRACT(EPOCH FROM txn_ts) AS BIGINT)        AS epoch_s,
       CAST(EXTRACT(EPOCH FROM txn_ts) * 1000 AS BIGINT) AS epoch_ms,
       make_timestamp(CAST(EXTRACT(EPOCH FROM txn_ts) AS BIGINT) * 1000000) AS roundtrip_ts
FROM transactions
ORDER BY txn_ts, txn_id
LIMIT 10;`,
  dialect: {
    snowflake: 'TO_TIMESTAMP_NTZ(epoch_s) / DATE_PART(EPOCH_SECOND, ts). Snowflake guesses the unit from magnitude — explicit TO_TIMESTAMP_NTZ(x, 3) for millis is safer.',
    redshift: "EXTRACT(EPOCH FROM ts); back via TIMESTAMP 'epoch' + n * INTERVAL '1 second'.",
    trino: 'to_unixtime(ts) / from_unixtime(n).',
    spark: 'unix_timestamp(ts) / from_unixtime(n).',
  },
},
{
  id: 'ts-7', track: 'timestamps', diff: 3,
  title: 'Business days from the calendar dimension',
  ref: 'Windows ref 3.7: "do not hand-code holiday logic"',
  prompt: `For every **ended** subscription, count the business days it was active — weekdays only, excluding holidays.

Columns: \`subscription_id\`, \`start_date\`, \`end_date\`, \`business_days\` — ordered by \`subscription_id\`.

Count days in the half-open range \`(start_date, end_date]\`. Use \`dim_date\` — it already carries \`is_weekday\` and \`is_holiday\`. Hand-rolling weekend logic works until someone asks for a second country, and holidays are never derivable from arithmetic.`,
  hints: [
    'A correlated scalar subquery counting dim_date rows is the clearest form.',
    'Or join dim_date on the range and GROUP BY the subscription.',
    'is_weekday = 1 AND is_holiday = 0.',
  ],
  ordered: true,
  solution: `SELECT s.subscription_id,
       s.start_date,
       s.end_date,
       (SELECT COUNT(*)
          FROM dim_date d
         WHERE d.day >  s.start_date
           AND d.day <= s.end_date
           AND d.is_weekday = 1
           AND d.is_holiday = 0) AS business_days
FROM subscriptions s
WHERE s.end_date IS NOT NULL
ORDER BY s.subscription_id;`,
  dialect: {
    snowflake: 'Correlated scalar subqueries are supported. Snowflake also has DATEDIFF(week,...)*5 style approximations — avoid them, holidays break the approximation.',
    redshift: 'Supported. Redshift is happier with the JOIN + GROUP BY form than with correlated subqueries at scale.',
    trino: 'Supported.',
    spark: 'Correlated scalar subqueries are supported in Spark 3.x but can be slow; prefer the JOIN + GROUP BY form.',
  },
},

// ---------------------------------------------------------------------------
// TRACK 6 -- TIMESTAMP ANALYSIS PATTERNS  (Windows ref, Part 4)
// ---------------------------------------------------------------------------
{
  id: 'pat-1', track: 'patterns', diff: 4,
  title: 'Sessionization: LAG, flag, cumulative sum',
  ref: 'Windows ref 4.1: "the pattern to memorize"',
  prompt: `Sessionize \`clickstream\` with a **30-minute inactivity timeout**, per customer.

Columns: \`customer_id\`, \`session_seq\` (1-based within the customer), \`session_start\`, \`session_end\`, \`event_count\`, \`duration_sec\` — ordered by \`customer_id\`, \`session_seq\`.

The shape, which is worth having in muscle memory:

\`\`\`
LAG(ts)  ->  boolean "is this a new session?"  ->  cumulative SUM of that flag  ->  group key
\`\`\`

A new session starts when the previous event is NULL (first event) or more than 30 minutes earlier. The cumulative sum of that 0/1 flag is a stable session number.`,
  hints: [
    'Three CTEs: with_gap (LAG), flagged (CASE -> 1/0), sessionized (SUM OVER ... UNBOUNDED PRECEDING).',
    'The cumulative SUM must use ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW — under the default RANGE frame, tied timestamps would land in the same total.',
    "duration_sec = date_diff('second', MIN(ts), MAX(ts)) within the group.",
  ],
  ordered: true,
  solution: `WITH with_gap AS (
    SELECT customer_id,
           event_ts,
           LAG(event_ts) OVER (PARTITION BY customer_id ORDER BY event_ts) AS prev_ts
    FROM clickstream
),
flagged AS (
    SELECT customer_id, event_ts,
           CASE WHEN prev_ts IS NULL THEN 1
                WHEN event_ts > prev_ts + INTERVAL 30 MINUTE THEN 1
                ELSE 0 END AS is_new_session
    FROM with_gap
),
sessionized AS (
    SELECT customer_id, event_ts,
           SUM(is_new_session) OVER (PARTITION BY customer_id ORDER BY event_ts
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_seq
    FROM flagged
)
SELECT customer_id,
       session_seq,
       MIN(event_ts) AS session_start,
       MAX(event_ts) AS session_end,
       COUNT(*)      AS event_count,
       DATE_DIFF('second', MIN(event_ts), MAX(event_ts)) AS duration_sec
FROM sessionized
GROUP BY customer_id, session_seq
ORDER BY customer_id, session_seq;`,
  dialect: {
    snowflake: "Identical. DATEDIFF('second', a, b) for the duration.",
    redshift: "Identical. DATEDIFF('second', a, b).",
    trino: "Identical. date_diff('second', a, b).",
    spark: 'Identical, or use Spark\'s session_window() built-in which does this natively.',
  },
},
{
  id: 'pat-2', track: 'patterns', diff: 4,
  title: 'Gaps and islands: longest login streak',
  ref: 'Windows ref 4.2 — and capstone problem 3',
  prompt: `For each customer, find their **longest run of consecutive calendar days** containing at least one successful login.

Columns: \`customer_id\`, \`streak_length\`, \`streak_start\`, \`streak_end\` — one row per customer, ordered by \`streak_length\` DESC, \`customer_id\`.

On ties within a customer, keep the **earliest** streak.

The trick: within a consecutive run, the date advances by 1 and so does \`ROW_NUMBER()\`, so \`date − row_number\` is **constant** across the run and changes the moment there is a gap. That difference is your island key.

Watch out: there are multiple logins per day, and failed ones.`,
  hints: [
    'DISTINCT the (customer, day) pairs first — and filter success = 1 before that.',
    'island_key = day - ROW_NUMBER() OVER (PARTITION BY customer ORDER BY day) * INTERVAL 1 DAY.',
    'Group by (customer, island_key) to get each run, then pick the longest per customer with ROW_NUMBER or QUALIFY.',
  ],
  ordered: true,
  solution: `WITH daily AS (
    SELECT DISTINCT customer_id, login_ts::DATE AS active_day
    FROM logins
    WHERE success = 1
),
grouped AS (
    SELECT customer_id,
           active_day,
           active_day - (ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY active_day)) * INTERVAL 1 DAY AS island_key
    FROM daily
),
runs AS (
    SELECT customer_id,
           COUNT(*)        AS streak_length,
           MIN(active_day) AS streak_start,
           MAX(active_day) AS streak_end
    FROM grouped
    GROUP BY customer_id, island_key
),
ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_id
                                 ORDER BY streak_length DESC, streak_start) AS rn
    FROM runs
)
SELECT customer_id, streak_length, streak_start, streak_end
FROM ranked
WHERE rn = 1
ORDER BY streak_length DESC, customer_id;`,
  dialect: {
    snowflake: 'Identical; QUALIFY ROW_NUMBER() ... = 1 removes the last CTE.',
    redshift: "Identical. Use DATEADD('day', -ROW_NUMBER() OVER (...), active_day) for the island key.",
    trino: 'Identical.',
    spark: 'Identical; date_sub(active_day, row_number() OVER (...)).',
  },
},
{
  id: 'pat-3', track: 'patterns', diff: 4,
  title: 'Point-in-time correct join (as-of)',
  ref: 'Windows ref 4.3: "the most common cause of training/serving skew and target leakage"',
  prompt: `For every transaction of \`customer_id = 66\`, attach the account balance from the **most recent snapshot at or before** the transaction time.

Columns: \`txn_id\`, \`txn_ts\`, \`amount\`, \`balance_asof\` — ordered by \`txn_ts\`, \`txn_id\`.

Transactions that precede the customer's first snapshot must still appear, with \`NULL\`.

This is the single most important join in ML feature engineering. Attach the *current* balance instead of the *as-of* balance and you have leaked the future into your training set — the model looks brilliant offline and fails in production.`,
  hints: [
    'The portable form is a correlated scalar subquery: the snapshot with MAX(snapshot_ts) <= txn_ts.',
    'ORDER BY snapshot_ts DESC LIMIT 1 inside the subquery.',
    'DuckDB and Snowflake also have a native ASOF JOIN — try rewriting it that way once the subquery version works.',
  ],
  ordered: true,
  solution: `SELECT t.txn_id,
       t.txn_ts,
       t.amount,
       (SELECT b.balance
          FROM balance_snapshots b
         WHERE b.customer_id = t.customer_id
           AND b.snapshot_ts <= t.txn_ts
         ORDER BY b.snapshot_ts DESC
         LIMIT 1) AS balance_asof
FROM transactions t
WHERE t.customer_id = 66
ORDER BY t.txn_ts, t.txn_id;`,
  dialect: {
    snowflake: 'Native ASOF JOIN: ... ASOF JOIN balance_snapshots b MATCH_CONDITION(t.txn_ts >= b.snapshot_ts) ON t.customer_id = b.customer_id.',
    redshift: 'No ASOF JOIN. Correlated subquery, or the LAST_VALUE(...) IGNORE NULLS carry-forward over a UNION ALL of both tables.',
    trino: 'No ASOF JOIN. Same two options as Redshift.',
    spark: 'No ASOF JOIN. Same. (pandas users: this is merge_asof.)',
  },
},
{
  id: 'pat-4', track: 'patterns', diff: 4,
  title: 'SCD Type 2 lookup with half-open intervals',
  ref: 'Windows ref 4.4: "use <= on both ends and you double-count"',
  prompt: `Attach to every order the customer segment **that was in force when the order was placed**, from \`dim_customer_scd\`.

Columns: \`order_id\`, \`order_ts\`, \`customer_id\`, \`segment_name\` — ordered by \`order_id\`. Orders placed before the customer's first version get \`NULL\`.

The versions are contiguous: version N's \`valid_to\` is **exactly** version N+1's \`valid_from\`. So the match must be half-open — \`>= valid_from AND < valid_to\` — with \`valid_to IS NULL\` meaning "current".

Use \`<=\` on both ends and orders landing exactly on a boundary match two versions, your row count grows, and every downstream metric is silently inflated. Check your row count: it must be 700.`,
  hints: [
    'LEFT JOIN so pre-history orders survive.',
    'COALESCE(valid_to, TIMESTAMP \'9999-12-31\') handles the open-ended current version.',
    'After writing it, change < to <= and watch the row count grow past 700. That is the bug.',
  ],
  ordered: true,
  solution: `SELECT o.order_id,
       o.order_ts,
       o.customer_id,
       d.segment_name
FROM orders o
LEFT JOIN dim_customer_scd d
       ON d.customer_id = o.customer_id
      AND o.order_ts >= d.valid_from
      AND o.order_ts <  COALESCE(d.valid_to, TIMESTAMP '9999-12-31')
ORDER BY o.order_id;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'pat-5', track: 'patterns', diff: 3,
  title: 'Overlapping intervals',
  ref: 'Windows ref 4.5: "two intervals overlap when each starts before the other ends"',
  prompt: `Find every pair of \`bookings\` on the **same resource** whose times overlap, with the overlap duration.

Columns: \`resource_id\`, \`booking_a\`, \`booking_b\`, \`overlap_seconds\` — ordered by \`resource_id\`, \`booking_a\`, \`booking_b\`.

Each pair must appear **once**, not twice, and a booking must not match itself.

Overlap test: \`a.start < b.end AND b.start < a.end\`. Overlap duration: from \`GREATEST(starts)\` to \`LEAST(ends)\`.`,
  hints: [
    'a.booking_id < b.booking_id both deduplicates the pair and excludes the self-match, in one predicate.',
    'Strict < on both sides means back-to-back bookings (one ends exactly as the next begins) do not count as overlapping.',
    "date_diff('second', GREATEST(a.start_ts, b.start_ts), LEAST(a.end_ts, b.end_ts)).",
  ],
  ordered: true,
  solution: `SELECT a.resource_id,
       a.booking_id AS booking_a,
       b.booking_id AS booking_b,
       DATE_DIFF('second',
                 GREATEST(a.start_ts, b.start_ts),
                 LEAST(a.end_ts, b.end_ts)) AS overlap_seconds
FROM bookings a
JOIN bookings b
  ON a.resource_id = b.resource_id
 AND a.booking_id  < b.booking_id
 AND a.start_ts    < b.end_ts
 AND b.start_ts    < a.end_ts
ORDER BY a.resource_id, booking_a, booking_b;`,
  dialect: {
    snowflake: 'Identical.', redshift: 'Identical.',
    trino: 'Identical.', spark: 'Identical — but a non-equi join like this becomes a nested loop; keep the equi-predicate on resource_id so it can still hash-partition.',
  },
},
{
  id: 'pat-6', track: 'patterns', diff: 4,
  title: 'Merging overlapping intervals into blocks',
  ref: 'Windows ref 4.5: "same LAG-flag-cumsum shape, using a running max instead of a lag"',
  prompt: `Collapse overlapping \`bookings\` per resource into **maximal non-overlapping blocks** of occupied time.

Columns: \`resource_id\`, \`block_start\`, \`block_end\`, \`n_bookings\` — ordered by \`resource_id\`, \`block_start\`.

A new block starts when a booking begins **after** the running maximum end time of everything before it. Note it is the running MAX of previous ends, not the previous row's end — a long booking can swallow several short ones that follow it.`,
  hints: [
    'MAX(end_ts) OVER (PARTITION BY resource_id ORDER BY start_ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) is the running max of prior ends.',
    'is_new_block = 1 when that running max IS NULL or start_ts > it.',
    'Cumulative SUM of the flag gives block_id; then group by (resource_id, block_id).',
  ],
  ordered: true,
  solution: `WITH ordered AS (
    SELECT resource_id, booking_id, start_ts, end_ts,
           MAX(end_ts) OVER (PARTITION BY resource_id ORDER BY start_ts
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end
    FROM bookings
),
flagged AS (
    SELECT *,
           CASE WHEN prev_max_end IS NULL OR start_ts > prev_max_end THEN 1 ELSE 0 END AS is_new_block
    FROM ordered
),
blocked AS (
    SELECT *,
           SUM(is_new_block) OVER (PARTITION BY resource_id ORDER BY start_ts
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS block_id
    FROM flagged
)
SELECT resource_id,
       MIN(start_ts) AS block_start,
       MAX(end_ts)   AS block_end,
       COUNT(*)      AS n_bookings
FROM blocked
GROUP BY resource_id, block_id
ORDER BY resource_id, block_start;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'pat-7', track: 'patterns', diff: 4,
  title: 'Monthly cohort retention',
  ref: 'Windows ref 4.6: "compute the month offset arithmetically, not with DATEDIFF"',
  prompt: `Build a monthly cohort retention table. Cohort = the month of the customer's **first transaction**; activity = any transaction.

Columns: \`cohort_month\`, \`month_offset\`, \`active_users\`, \`cohort_size\`, \`retention_pct\` (2dp) — ordered by \`cohort_month\`, \`month_offset\`.

Compute the offset **arithmetically**:

\`\`\`
(year(activity) - year(cohort)) * 12 + (month(activity) - month(cohort))
\`\`\`

\`DATEDIFF('month', ...)\` counts boundary crossings and will hand you off-by-one errors on some engines. \`cohort_size\` is the offset-0 count, which \`FIRST_VALUE\` over the cohort gives you for free.`,
  hints: [
    'Three steps: cohorts (first txn month per customer), activity (DISTINCT customer + activity month), retention (counts per cohort/offset).',
    'DATE_TRUNC(\'month\', ts) for both the cohort month and the activity month.',
    'cohort_size = FIRST_VALUE(active_users) OVER (PARTITION BY cohort_month ORDER BY month_offset).',
  ],
  ordered: true,
  solution: `WITH cohorts AS (
    SELECT customer_id,
           DATE_TRUNC('month', MIN(txn_ts)) AS cohort_month
    FROM transactions
    GROUP BY customer_id
),
activity AS (
    SELECT DISTINCT
           t.customer_id,
           c.cohort_month,
           DATE_TRUNC('month', t.txn_ts) AS activity_month
    FROM transactions t
    JOIN cohorts c ON c.customer_id = t.customer_id
),
retention AS (
    SELECT cohort_month,
           (EXTRACT(YEAR FROM activity_month) - EXTRACT(YEAR FROM cohort_month)) * 12
             + (EXTRACT(MONTH FROM activity_month) - EXTRACT(MONTH FROM cohort_month)) AS month_offset,
           COUNT(DISTINCT customer_id) AS active_users
    FROM activity
    GROUP BY 1, 2
)
SELECT cohort_month,
       month_offset,
       active_users,
       FIRST_VALUE(active_users) OVER (PARTITION BY cohort_month ORDER BY month_offset) AS cohort_size,
       ROUND(active_users * 100.0
             / FIRST_VALUE(active_users) OVER (PARTITION BY cohort_month ORDER BY month_offset), 2) AS retention_pct
FROM retention
ORDER BY cohort_month, month_offset;`,
  dialect: {
    snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.',
    spark: 'Identical.',
  },
},
{
  id: 'pat-8', track: 'patterns', diff: 3,
  title: 'Time-to-event with censoring',
  ref: 'Windows ref 4.7: "they are right-censored observations, and treating them as negatives biases your model"',
  prompt: `For every customer, measure the time from signup to their **first purchase event** in \`clickstream\`.

Columns: \`customer_id\`, \`signup_ts\`, \`first_purchase_ts\`, \`hours_to_first_purchase\`, \`is_censored\` (1/0) — ordered by \`customer_id\`.

Every customer appears. Customers with no purchase get \`NULL\` timestamps, \`NULL\` hours, and \`is_censored = 1\`.

That flag is what feeds survival analysis. A customer who has not purchased *yet* is not a non-purchaser — they are still at risk, and scoring them as a negative biases every churn model you build on top.`,
  hints: [
    "LEFT JOIN clickstream filtered to event_type = 'purchase' AND event_ts > signup_ts.",
    'Put the event_type filter in the ON clause, or the LEFT JOIN collapses.',
    "date_diff('hour', signup_ts, MIN(event_ts)) after grouping.",
  ],
  ordered: true,
  solution: `SELECT c.customer_id,
       c.signup_ts,
       MIN(p.event_ts) AS first_purchase_ts,
       DATE_DIFF('hour', c.signup_ts, MIN(p.event_ts)) AS hours_to_first_purchase,
       CASE WHEN MIN(p.event_ts) IS NULL THEN 1 ELSE 0 END AS is_censored
FROM customers c
LEFT JOIN clickstream p
       ON p.customer_id = c.customer_id
      AND p.event_type  = 'purchase'
      AND p.event_ts    > c.signup_ts
GROUP BY c.customer_id, c.signup_ts
ORDER BY c.customer_id;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},

// ---------------------------------------------------------------------------
// TRACK 7 -- ANALYTICS PATTERNS  ("patterns you will write constantly")
// ---------------------------------------------------------------------------
{
  id: 'an-1', track: 'analytics', diff: 3,
  title: 'Funnel with conditional aggregation',
  ref: 'Prep guide: "funnel analysis with conditional aggregation"',
  prompt: `Build the conversion funnel over \`clickstream\`, counting **distinct customers** who reached each stage.

Stages in order: \`view_home\`, \`view_product\`, \`add_to_cart\`, \`begin_checkout\`, \`purchase\`.

Columns: \`stage\`, \`stage_order\` (1–5), \`customers\`, \`pct_of_top\` (2dp), \`pct_of_previous\` (2dp, NULL for stage 1) — ordered by \`stage_order\`.

The idiom is one pass over the table with \`COUNT(DISTINCT CASE WHEN ... END)\` per stage, then unpivot. Five separate queries UNIONed together scans the table five times.`,
  hints: [
    'One row of conditional aggregates, then UNION ALL / unpivot into five rows — or build the five rows directly with a VALUES list joined to the counts.',
    'pct_of_previous needs LAG over stage_order.',
    'COUNT(DISTINCT CASE WHEN event_type = \'x\' THEN customer_id END) counts only the matching rows.',
  ],
  ordered: true,
  solution: `WITH stages(stage, stage_order) AS (
    VALUES ('view_home', 1), ('view_product', 2), ('add_to_cart', 3),
           ('begin_checkout', 4), ('purchase', 5)
),
counts AS (
    SELECT s.stage, s.stage_order,
           COUNT(DISTINCT c.customer_id) AS customers
    FROM stages s
    LEFT JOIN clickstream c ON c.event_type = s.stage
    GROUP BY s.stage, s.stage_order
)
SELECT stage,
       stage_order,
       customers,
       ROUND(customers * 100.0
             / FIRST_VALUE(customers) OVER (ORDER BY stage_order), 2) AS pct_of_top,
       ROUND(customers * 100.0
             / NULLIF(LAG(customers) OVER (ORDER BY stage_order), 0), 2) AS pct_of_previous
FROM counts
ORDER BY stage_order;`,
  dialect: {
    snowflake: 'Identical. Snowflake COUNT(DISTINCT ...) is exact; APPROX_COUNT_DISTINCT is the cheap version.',
    redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.',
  },
},
{
  id: 'an-2', track: 'analytics', diff: 2,
  title: 'Deduplication with ROW_NUMBER',
  ref: 'Prep guide: "ROW_NUMBER() OVER (PARTITION BY id ORDER BY updated_at DESC)"',
  prompt: `\`staging_customers\` is a raw landing table: the same \`source_customer_id\` can appear several times, and the freshest row wins.

Return exactly one row per \`source_customer_id\` — the one with the latest \`updated_at\`.

Columns: \`source_customer_id\`, \`email\`, \`full_name\`, \`country\`, \`updated_at\` — ordered by \`source_customer_id\`.

This is the single most-typed window function in a warehouse. Note that \`GROUP BY id\` with \`MAX(updated_at)\` does **not** solve it — you would then have to join back to recover the other columns, and a tie would resurrect the duplicate.`,
  hints: [
    'ROW_NUMBER() OVER (PARTITION BY source_customer_id ORDER BY updated_at DESC) then keep rn = 1.',
    'Add a deterministic tiebreaker (row_id) to the ORDER BY so the result is stable.',
    'QUALIFY collapses this to a single SELECT on Snowflake and DuckDB.',
  ],
  ordered: true,
  solution: `WITH ranked AS (
    SELECT source_customer_id, email, full_name, country, updated_at,
           ROW_NUMBER() OVER (PARTITION BY source_customer_id
                              ORDER BY updated_at DESC, row_id DESC) AS rn
    FROM staging_customers
)
SELECT source_customer_id, email, full_name, country, updated_at
FROM ranked
WHERE rn = 1
ORDER BY source_customer_id;`,
  dialect: {
    snowflake: 'QUALIFY ROW_NUMBER() OVER (...) = 1 — no CTE needed.',
    redshift: 'No QUALIFY. Keep the CTE.',
    trino: 'No QUALIFY. Keep the CTE.',
    spark: 'No QUALIFY. Keep the CTE.',
  },
},
{
  id: 'an-3', track: 'analytics', diff: 2,
  title: 'Pivoting with CASE inside an aggregate',
  ref: 'Prep guide: "pivoting with CASE WHEN inside aggregates"',
  prompt: `Turn order counts by channel into **columns**, one row per month.

Columns: \`order_month\` (DATE, first of month), \`web_orders\`, \`mobile_orders\`, \`phone_orders\`, \`partner_orders\`, \`total_orders\` — ordered by \`order_month\`.

\`SUM(CASE WHEN channel = 'web' THEN 1 ELSE 0 END)\` is the portable pivot. Dedicated \`PIVOT\` syntax exists on several engines but the column list usually has to be static anyway, so the CASE form stays the workhorse.`,
  hints: [
    "DATE_TRUNC('month', order_ts) cast to DATE for a clean month key.",
    'One SUM(CASE ...) per channel, plus COUNT(*) for the total.',
  ],
  ordered: true,
  solution: `SELECT DATE_TRUNC('month', order_ts)::DATE AS order_month,
       SUM(CASE WHEN channel = 'web'     THEN 1 ELSE 0 END) AS web_orders,
       SUM(CASE WHEN channel = 'mobile'  THEN 1 ELSE 0 END) AS mobile_orders,
       SUM(CASE WHEN channel = 'phone'   THEN 1 ELSE 0 END) AS phone_orders,
       SUM(CASE WHEN channel = 'partner' THEN 1 ELSE 0 END) AS partner_orders,
       COUNT(*) AS total_orders
FROM orders
GROUP BY 1
ORDER BY order_month;`,
  dialect: {
    snowflake: 'Has PIVOT(...) syntax, and the CASE form. Both fine.',
    redshift: 'Has a limited PIVOT. CASE form is safer.',
    trino: 'No PIVOT. CASE form, or map_agg for a dynamic shape.',
    spark: 'Has PIVOT and it can infer values dynamically — the one engine where PIVOT is genuinely nicer.',
  },
},
{
  id: 'an-4', track: 'analytics', diff: 3,
  title: 'Top-N per group',
  ref: 'Prep guide, Tier 1',
  prompt: `Find the **top 3 products by net revenue within each category**.

Net revenue = \`SUM(quantity * unit_price * (1 - discount))\` over \`order_items\`, counting only orders whose status is \`'completed'\`.

Columns: \`category_name\`, \`product_id\`, \`product_name\`, \`net_revenue\` (2dp), \`rn\` (1–3) — ordered by \`category_name\`, \`rn\`.

Use \`ROW_NUMBER\`, not \`RANK\` — you want exactly three rows per category even when revenues tie.`,
  hints: [
    'Aggregate to one row per (category, product) first, then rank inside the category.',
    'Join order_items -> orders to apply the status filter, and products -> categories for the name.',
    'Filter rn <= 3 in an outer query; you cannot filter a window function in the same SELECT.',
  ],
  ordered: true,
  solution: `WITH rev AS (
    SELECT cat.category_name,
           p.product_id,
           p.product_name,
           SUM(oi.quantity * oi.unit_price * (1 - oi.discount)) AS net_revenue
    FROM order_items oi
    JOIN orders o     ON o.order_id = oi.order_id
    JOIN products p   ON p.product_id = oi.product_id
    JOIN categories cat ON cat.category_id = p.category_id
    WHERE o.status = 'completed'
    GROUP BY cat.category_name, p.product_id, p.product_name
),
ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY category_name
                                 ORDER BY net_revenue DESC, product_id) AS rn
    FROM rev
)
SELECT category_name, product_id, product_name,
       ROUND(net_revenue, 2) AS net_revenue, rn
FROM ranked
WHERE rn <= 3
ORDER BY category_name, rn;`,
  dialect: {
    snowflake: 'QUALIFY ROW_NUMBER() OVER (...) <= 3 removes the outer query.',
    redshift: 'No QUALIFY.', trino: 'No QUALIFY.', spark: 'No QUALIFY.',
  },
},
{
  id: 'an-5', track: 'analytics', diff: 4,
  title: 'RFM segmentation',
  ref: 'Prep guide: "RFM ... the workhorse. Know how to build it in SQL with NTILE"',
  prompt: `Build an RFM table as of **2026-09-14** over settled transactions.

- **Recency** — days since the customer's most recent transaction (smaller is better)
- **Frequency** — number of transactions
- **Monetary** — total amount

Columns: \`customer_id\`, \`recency_days\`, \`frequency\`, \`monetary\` (2dp), \`r_score\`, \`f_score\`, \`m_score\`, \`rfm\` — ordered by \`customer_id\`.

All three scores are \`NTILE(5)\`, where **5 is always the best**: most recent, most frequent, highest spend. \`rfm\` is the three digits concatenated, e.g. \`'545'\`.

Getting \`r_score\` backwards is the classic slip — low recency_days is *good*, so order it descending.`,
  hints: [
    'Aggregate per customer first: MAX(txn_ts), COUNT(*), SUM(amount).',
    'r_score = NTILE(5) OVER (ORDER BY recency_days DESC) — descending, so the smallest gap lands in bucket 5.',
    'Concatenate with || after casting the scores to VARCHAR.',
  ],
  ordered: true,
  solution: `WITH base AS (
    SELECT customer_id,
           DATE_DIFF('day', MAX(txn_ts)::DATE, DATE '2026-09-14') AS recency_days,
           COUNT(*)    AS frequency,
           SUM(amount) AS monetary
    FROM transactions
    WHERE status = 'settled'
    GROUP BY customer_id
),
scored AS (
    SELECT *,
           NTILE(5) OVER (ORDER BY recency_days DESC) AS r_score,
           NTILE(5) OVER (ORDER BY frequency)         AS f_score,
           NTILE(5) OVER (ORDER BY monetary)          AS m_score
    FROM base
)
SELECT customer_id,
       recency_days,
       frequency,
       ROUND(monetary, 2) AS monetary,
       r_score, f_score, m_score,
       CAST(r_score AS VARCHAR) || CAST(f_score AS VARCHAR) || CAST(m_score AS VARCHAR) AS rfm
FROM scored
ORDER BY customer_id;`,
  dialect: {
    snowflake: 'Identical. Use || or CONCAT.',
    redshift: 'Identical.', trino: 'Identical — CAST then ||, or concat().',
    spark: 'Identical — concat() or ||.',
  },
},
{
  id: 'an-6', track: 'analytics', diff: 3,
  title: 'Share of total and the Pareto curve',
  ref: 'Prep guide, Tier 3: business & metrics literacy',
  prompt: `Rank categories by net revenue and show what share of the total each one represents, plus the running cumulative share.

Net revenue as in the previous exercise, restricted to \`'completed'\` orders.

Columns: \`category_name\`, \`net_revenue\` (2dp), \`pct_of_total\` (2dp), \`cumulative_pct\` (2dp) — ordered by \`net_revenue\` DESC.

\`pct_of_total\` uses a window with **no ORDER BY** — an unordered window sees the whole partition, which is exactly what a grand total needs. \`cumulative_pct\` uses an ordered running sum. The distinction between those two windows is the whole exercise.`,
  hints: [
    'SUM(x) OVER () with an empty OVER gives the grand total on every row.',
    'SUM(x) OVER (ORDER BY x DESC ROWS UNBOUNDED PRECEDING) gives the running total.',
    'Write the running frame explicitly — ties under the default RANGE frame would flatten the curve.',
  ],
  ordered: true,
  solution: `WITH rev AS (
    SELECT cat.category_name,
           SUM(oi.quantity * oi.unit_price * (1 - oi.discount)) AS net_revenue
    FROM order_items oi
    JOIN orders o       ON o.order_id = oi.order_id
    JOIN products p     ON p.product_id = oi.product_id
    JOIN categories cat ON cat.category_id = p.category_id
    WHERE o.status = 'completed'
    GROUP BY cat.category_name
)
SELECT category_name,
       ROUND(net_revenue, 2) AS net_revenue,
       ROUND(net_revenue * 100.0 / SUM(net_revenue) OVER (), 2) AS pct_of_total,
       ROUND(SUM(net_revenue) OVER (ORDER BY net_revenue DESC
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
             * 100.0 / SUM(net_revenue) OVER (), 2) AS cumulative_pct
FROM rev
ORDER BY net_revenue DESC;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'an-7', track: 'analytics', diff: 3,
  title: 'Month-over-month growth on a gap-free spine',
  ref: 'Windows ref 2.4 + 2.2 combined',
  prompt: `Monthly transaction revenue for 2026, with month-over-month absolute and percentage change — and **no missing months**, even if a month had no transactions.

Columns: \`month\` (DATE), \`revenue\` (2dp), \`mom_abs\` (2dp), \`mom_pct\` (2dp) — ordered by \`month\`, covering every month from 2026-01 to 2026-09.

Build the month spine first. \`LAG\` over rows that skip a month silently compares January to March and labels it "month over month".`,
  hints: [
    "generate_series(DATE '2026-01-01', DATE '2026-09-01', INTERVAL 1 MONTH) gives the spine.",
    'LEFT JOIN the aggregated revenue onto it and COALESCE to 0.',
    'Guard the percentage denominator with NULLIF.',
  ],
  ordered: true,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2026-01-01', DATE '2026-09-01', INTERVAL 1 MONTH))::DATE AS month
),
monthly AS (
    SELECT DATE_TRUNC('month', txn_ts)::DATE AS month,
           SUM(amount) AS revenue
    FROM transactions
    WHERE status = 'settled'
    GROUP BY 1
),
filled AS (
    SELECT s.month, COALESCE(m.revenue, 0) AS revenue
    FROM spine s
    LEFT JOIN monthly m ON m.month = s.month
),
lagged AS (
    SELECT month, revenue,
           LAG(revenue) OVER (ORDER BY month) AS prev_revenue
    FROM filled
)
SELECT month,
       ROUND(revenue, 2) AS revenue,
       ROUND(revenue - prev_revenue, 2) AS mom_abs,
       ROUND((revenue - prev_revenue) / NULLIF(prev_revenue, 0) * 100, 2) AS mom_pct
FROM lagged
ORDER BY month;`,
  dialect: {
    snowflake: 'Spine via TABLE(GENERATOR(...)) + DATEADD(month, SEQ4(), ...).',
    redshift: 'Use dim_date (SELECT DISTINCT month_start) as the spine — generate_series cannot be joined.',
    trino: "sequence(DATE '2026-01-01', DATE '2026-09-01', INTERVAL '1' MONTH).",
    spark: 'sequence(...) + explode.',
  },
},

// ---------------------------------------------------------------------------
// TRACK 8 -- PERFORMANCE & PORTABILITY  (Windows ref, Parts 5-6)
// ---------------------------------------------------------------------------
{
  id: 'perf-1', track: 'perf', diff: 4,
  title: 'Lookback buffer, then trim',
  ref: 'Windows ref 5.2: "pull in a lookback buffer and discard it at the end"',
  prompt: `Report the trailing 7-day moving average of \`daily_revenue\` for **February 2026 only** — with every value computed from a **complete** window.

Columns: \`day\`, \`revenue\`, \`ma_7\` (2dp) — ordered by \`day\`, February rows only.

Filter to February first and the first six days average an incomplete window, because January's rows were thrown away before the window ran. Pull an extra 7 days of lookback into the inner query, compute the window, then trim the buffer off in the outer query.

Cross-check: none of your February values should match what you would get from a naive February-only filter.`,
  hints: [
    'Inner CTE: WHERE day >= DATE \'2026-02-01\' - INTERVAL 7 DAY AND day <= DATE \'2026-02-28\'.',
    'Compute the window over that buffered set.',
    'Outer query: WHERE day >= DATE \'2026-02-01\'.',
  ],
  ordered: true,
  solution: `WITH buffered AS (
    SELECT day, revenue
    FROM daily_revenue
    WHERE day >= DATE '2026-02-01' - INTERVAL 7 DAY
      AND day <= DATE '2026-02-28'
),
windowed AS (
    SELECT day, revenue,
           AVG(revenue) OVER (ORDER BY day
                              ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS ma_7
    FROM buffered
)
SELECT day, revenue, ROUND(ma_7, 2) AS ma_7
FROM windowed
WHERE day >= DATE '2026-02-01'
ORDER BY day;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'perf-2', track: 'perf', diff: 2,
  title: 'Reuse the frame, share the sort',
  ref: 'Windows ref 5.1: "each distinct OVER specification typically requires its own sort"',
  prompt: `For \`customer_id = 66\`, return a running total, a running average and a sequence number over the same ordering.

Columns: \`txn_id\`, \`txn_ts\`, \`running_total\` (2dp), \`running_avg\` (2dp), \`txn_seq\` — ordered by \`txn_ts\`, \`txn_id\`.

All three must share **one identical** \`PARTITION BY\`/\`ORDER BY\`, so the engine sorts once. Vary the partition or ordering between them and you buy an extra sort per variation — the most common reason a window-heavy query is inexplicably slow.

Run \`EXPLAIN\` on your answer and count the sort operators.`,
  hints: [
    'PARTITION BY customer_id ORDER BY txn_ts, txn_id for all three.',
    'ROW_NUMBER() needs no frame; give SUM and AVG an explicit ROWS frame.',
    'A named WINDOW clause makes the sharing visible at a glance.',
  ],
  ordered: true,
  solution: `SELECT txn_id,
       txn_ts,
       ROUND(SUM(amount) OVER w, 2) AS running_total,
       ROUND(AVG(amount) OVER w, 2) AS running_avg,
       ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY txn_ts, txn_id) AS txn_seq
FROM transactions
WHERE customer_id = 66
WINDOW w AS (PARTITION BY customer_id ORDER BY txn_ts, txn_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
ORDER BY txn_ts, txn_id;`,
  dialect: {
    snowflake: 'No named WINDOW clause — repeat the spec identically and the optimiser still shares the sort.',
    redshift: 'No named WINDOW clause.',
    trino: 'Named WINDOW supported.',
    spark: 'No named WINDOW clause.',
  },
},
{
  id: 'perf-3', track: 'perf', diff: 2,
  title: 'Keep the partition column bare',
  ref: 'Windows ref 5.3: "wrapping a partition column in a function usually defeats pruning"',
  prompt: `Count \`daily_revenue\` rows in February 2026 two ways and prove they agree:

Columns (one row): \`prunable_rows\`, \`wrapped_rows\`, \`results_match\` (boolean).

- \`prunable_rows\` — a half-open range on the bare column: \`day >= DATE '2026-02-01' AND day < DATE '2026-03-01'\`
- \`wrapped_rows\` — the same filter expressed as \`DATE_TRUNC('month', day) = DATE '2026-02-01'\`

Identical answers, very different cost on a partitioned S3-backed table. The bare-column form lets Athena or Spectrum skip whole partitions; wrapping the column in a function forces a full scan because the engine cannot map the expression back to partition values.

The habit: keep the partition column alone on one side of the comparison, and move the arithmetic to the literal side.`,
  hints: [
    'Two scalar subqueries in one SELECT.',
    'Compare them with = to produce the boolean.',
  ],
  ordered: false,
  solution: `SELECT (SELECT COUNT(*) FROM daily_revenue
         WHERE day >= DATE '2026-02-01' AND day < DATE '2026-03-01') AS prunable_rows,
       (SELECT COUNT(*) FROM daily_revenue
         WHERE DATE_TRUNC('month', day) = DATE '2026-02-01')         AS wrapped_rows,
       (SELECT COUNT(*) FROM daily_revenue
         WHERE day >= DATE '2026-02-01' AND day < DATE '2026-03-01')
       = (SELECT COUNT(*) FROM daily_revenue
         WHERE DATE_TRUNC('month', day) = DATE '2026-02-01')         AS results_match;`,
  dialect: {
    snowflake: 'Micro-partition pruning follows the same rule — bare column, literal on the other side.',
    redshift: 'Sort-key range-restricted scans follow the same rule.',
    trino: 'Hive partition pruning; this is where it matters most, since Athena bills per TB scanned.',
    spark: 'Partition pruning plus predicate pushdown into Parquet row groups.',
  },
},
{
  id: 'perf-4', track: 'perf', diff: 3,
  title: 'Replace a correlated subquery with a window',
  ref: 'Windows ref 5.1 / 2.3: "use this only on small partitions, it is O(n squared)"',
  prompt: `This correlated subquery ranks each of customer 23's transactions by amount, and re-scans the table once per row:

\`\`\`sql
SELECT t.txn_id, t.amount,
       (SELECT COUNT(*) FROM transactions x
         WHERE x.customer_id = t.customer_id
           AND (x.amount > t.amount
             OR (x.amount = t.amount AND x.txn_id <= t.txn_id))) AS amount_rank
FROM transactions t
WHERE t.customer_id = 23;
\`\`\`

Return **identical results** using a window function instead.

Columns: \`txn_id\`, \`amount\`, \`amount_rank\` — ordered by \`amount_rank\`.

The correlated form is O(n²) within each partition; the window form sorts once. On a partition of a few hundred rows nobody notices. On a few million, the correlated version simply never finishes.`,
  hints: [
    'The subquery counts rows ranked at or above the current one — that is ROW_NUMBER over amount DESC.',
    'Match the tiebreaker exactly: amount DESC, then txn_id ASC.',
  ],
  ordered: true,
  solution: `SELECT txn_id,
       amount,
       ROW_NUMBER() OVER (PARTITION BY customer_id
                          ORDER BY amount DESC, txn_id) AS amount_rank
FROM transactions
WHERE customer_id = 23
ORDER BY amount_rank;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},

// ---------------------------------------------------------------------------
// TRACK 9 -- CAPSTONE: the ten problems from Part 7 of the reference.
// The doc says: "pick problems 1, 3, 4 and 6 -- those four cover roughly 80%
// of the patterns -- and write them until you can do them without reference."
// Those four are marked *core* in the title.
// ---------------------------------------------------------------------------
{
  id: 'cap-1', track: 'capstone', diff: 4,
  title: 'P1 *core*: rolling 30-day sum, gap-safe',
  ref: 'Part 7, problem 1',
  prompt: `> *"For each customer, compute the rolling 30-day sum of transaction amounts, correctly handling days with no transactions."*

Report **Q1 2026** (2026-01-01 … 2026-03-31) for every customer who has ever transacted.

Columns: \`customer_id\`, \`day\`, \`amount\` (0 on days with no transactions), \`rolling_30d\` (2dp) — ordered by \`customer_id\`, \`day\`.

Two traps stacked on top of each other:

1. **Gaps.** A customer-day with no transactions has no row, so \`ROWS BETWEEN 29 PRECEDING\` reaches back arbitrarily far. Build a per-customer date spine.
2. **Edges.** The window for 1 January needs December's data. Extend the spine 29 days earlier, compute, then trim back to Q1.`,
  hints: [
    'CROSS JOIN the distinct customers against a date spine covering 2025-12-03 .. 2026-03-31.',
    'LEFT JOIN the per-customer daily totals onto that grid and COALESCE to 0 BEFORE windowing.',
    'PARTITION BY customer_id ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW, then trim WHERE day >= DATE \'2026-01-01\'.',
  ],
  ordered: true,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2025-12-03', DATE '2026-03-31', INTERVAL 1 DAY))::DATE AS day
),
cust AS (
    SELECT DISTINCT customer_id FROM transactions
),
daily AS (
    SELECT customer_id, txn_ts::DATE AS day, SUM(amount) AS amt
    FROM transactions
    GROUP BY 1, 2
),
grid AS (
    SELECT c.customer_id, s.day
    FROM cust c
    CROSS JOIN spine s
),
filled AS (
    SELECT g.customer_id, g.day, COALESCE(d.amt, 0) AS amount
    FROM grid g
    LEFT JOIN daily d ON d.customer_id = g.customer_id AND d.day = g.day
),
rolled AS (
    SELECT customer_id, day, amount,
           SUM(amount) OVER (PARTITION BY customer_id ORDER BY day
                             ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rolling_30d
    FROM filled
)
SELECT customer_id, day, amount, ROUND(rolling_30d, 2) AS rolling_30d
FROM rolled
WHERE day >= DATE '2026-01-01'
ORDER BY customer_id, day;`,
  dialect: {
    snowflake: "RANGE BETWEEN INTERVAL '30 days' PRECEDING avoids the spine entirely if supported on your account.",
    redshift: 'No RANGE offsets — the spine is mandatory. Build it from dim_date, not generate_series.',
    trino: "RANGE BETWEEN INTERVAL '30' DAY PRECEDING removes the need for a spine.",
    spark: 'ORDER BY unix_timestamp(day) RANGE BETWEEN 2592000 PRECEDING AND CURRENT ROW.',
  },
},
{
  id: 'cap-2', track: 'capstone', diff: 4,
  title: 'P2: anomalous trailing-7d volume vs a 90-day baseline',
  ref: 'Part 7, problem 2',
  prompt: `> *"Find all customers whose trailing-7-day transaction count is more than 3 standard deviations above their own trailing-90-day baseline, excluding the current day from that baseline."*

Report anomalies occurring in **Q1 2026**.

Columns: \`customer_id\`, \`day\`, \`cnt_7d\`, \`baseline_avg\` (3dp), \`baseline_sd\` (3dp), \`z\` (2dp) — ordered by \`z\` DESC, \`customer_id\`, \`day\`.

Layered correctly this is: per-customer daily counts on a gap-free spine → trailing 7-day count → mean and SD of *that* series over the previous 90 days, ending at \`1 PRECEDING\` → z-score.

The baseline must exclude today. Include it and a genuine spike inflates the very mean and SD it is being measured against, shrinking its own z-score.`,
  hints: [
    'Spine must start 90+7 days before 2026-01-01 so the first reported day has a full baseline.',
    'cnt_7d uses ROWS BETWEEN 6 PRECEDING AND CURRENT ROW on the daily counts.',
    'baseline uses ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING on cnt_7d — note the 1 PRECEDING.',
  ],
  ordered: true,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2025-09-25', DATE '2026-03-31', INTERVAL 1 DAY))::DATE AS day
),
cust AS (SELECT DISTINCT customer_id FROM transactions),
daily AS (
    SELECT customer_id, txn_ts::DATE AS day, COUNT(*) AS n
    FROM transactions GROUP BY 1, 2
),
filled AS (
    SELECT c.customer_id, s.day, COALESCE(d.n, 0) AS n
    FROM cust c
    CROSS JOIN spine s
    LEFT JOIN daily d ON d.customer_id = c.customer_id AND d.day = s.day
),
seven AS (
    SELECT customer_id, day,
           SUM(n) OVER (PARTITION BY customer_id ORDER BY day
                        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS cnt_7d
    FROM filled
),
scored AS (
    SELECT customer_id, day, cnt_7d,
           AVG(cnt_7d)         OVER w AS baseline_avg,
           STDDEV_SAMP(cnt_7d) OVER w AS baseline_sd
    FROM seven
    WINDOW w AS (PARTITION BY customer_id ORDER BY day
                 ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING)
)
SELECT customer_id,
       day,
       cnt_7d,
       ROUND(baseline_avg, 3) AS baseline_avg,
       ROUND(baseline_sd, 3)  AS baseline_sd,
       ROUND((cnt_7d - baseline_avg) / NULLIF(baseline_sd, 0), 2) AS z
FROM scored
WHERE day >= DATE '2026-01-01'
  AND (cnt_7d - baseline_avg) / NULLIF(baseline_sd, 0) > 3
ORDER BY z DESC, customer_id, day;`,
  dialect: {
    snowflake: 'Repeat the frame instead of the named WINDOW clause.',
    redshift: 'Repeat the frame. STDDEV_SAMP is available as a window function.',
    trino: 'Named WINDOW supported.',
    spark: 'Repeat the frame.',
  },
},
{
  id: 'cap-3', track: 'capstone', diff: 4,
  title: 'P3 *core*: longest consecutive-day login streak',
  ref: 'Part 7, problem 3',
  prompt: `> *"Given a login events table, identify each user's longest streak of consecutive days with at least one login."*

Columns: \`customer_id\`, \`longest_streak\`, \`streak_start\`, \`streak_end\` — one row per customer that has ever logged in, ordered by \`longest_streak\` DESC, \`customer_id\`.

On a tie within a customer, keep the **earliest** streak.

Note this counts *any* login, successful or not — read the problem statement literally. (Exercise \`pat-2\` filtered to successful logins; the answers differ, and noticing that difference is the point.)

Gaps and islands: \`day − ROW_NUMBER()\` is constant within a consecutive run.`,
  hints: [
    'DISTINCT (customer_id, date) first — there are multiple logins per day.',
    'island_key = active_day - ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY active_day) * INTERVAL 1 DAY.',
    'GROUP BY (customer_id, island_key), then take the longest run per customer.',
  ],
  ordered: true,
  solution: `WITH daily AS (
    SELECT DISTINCT customer_id, login_ts::DATE AS active_day
    FROM logins
),
grouped AS (
    SELECT customer_id, active_day,
           active_day - (ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY active_day)) * INTERVAL 1 DAY AS island_key
    FROM daily
),
runs AS (
    SELECT customer_id,
           COUNT(*)        AS longest_streak,
           MIN(active_day) AS streak_start,
           MAX(active_day) AS streak_end
    FROM grouped
    GROUP BY customer_id, island_key
),
ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_id
                                 ORDER BY longest_streak DESC, streak_start) AS rn
    FROM runs
)
SELECT customer_id, longest_streak, streak_start, streak_end
FROM ranked
WHERE rn = 1
ORDER BY longest_streak DESC, customer_id;`,
  dialect: {
    snowflake: 'QUALIFY removes the last CTE.',
    redshift: "DATEADD('day', -ROW_NUMBER() OVER (...), active_day) for the island key.",
    trino: 'Identical.', spark: 'date_sub(active_day, row_number() OVER (...)).',
  },
},
{
  id: 'cap-4', track: 'capstone', diff: 4,
  title: 'P4 *core*: as-of balance for every transaction',
  ref: 'Part 7, problem 4',
  prompt: `> *"For each transaction, attach the customer's account balance as of the most recent balance snapshot at or before the transaction time."*

Every transaction in the table. Transactions preceding the customer's first snapshot get \`NULL\`.

Columns: \`txn_id\`, \`customer_id\`, \`txn_ts\`, \`amount\`, \`balance_asof\` — ordered by \`txn_id\`.

This is the point-in-time-correct join that ML feature pipelines live or die on. Attach the *current* balance instead and you have leaked the future into training data.

At 13k transactions the correlated-subquery form is fine. At 13 million it is not — which is why engines that have \`ASOF JOIN\` are worth knowing about.`,
  hints: [
    'Portable: correlated scalar subquery taking the snapshot with the greatest snapshot_ts <= txn_ts.',
    'DuckDB and Snowflake: ASOF LEFT JOIN ... ON customer matches AND txn_ts >= snapshot_ts.',
    'LEFT semantics matter — do not drop the pre-history transactions.',
  ],
  ordered: true,
  solution: `SELECT t.txn_id,
       t.customer_id,
       t.txn_ts,
       t.amount,
       b.balance AS balance_asof
FROM transactions t
ASOF LEFT JOIN balance_snapshots b
       ON b.customer_id = t.customer_id
      AND t.txn_ts >= b.snapshot_ts
ORDER BY t.txn_id;`,
  dialect: {
    snowflake: 'ASOF JOIN ... MATCH_CONDITION(t.txn_ts >= b.snapshot_ts) ON t.customer_id = b.customer_id.',
    redshift: 'No ASOF JOIN. Correlated subquery, or LAST_VALUE(...) IGNORE NULLS carried forward over a UNION ALL of both tables.',
    trino: 'No ASOF JOIN. Same fallbacks.',
    spark: 'No ASOF JOIN. Same fallbacks.',
  },
},
{
  id: 'cap-5', track: 'capstone', diff: 4,
  title: 'P5: cohort retention, incomplete months excluded',
  ref: 'Part 7, problem 5',
  prompt: `> *"Build a monthly cohort retention table showing percentage retained by month offset, excluding cohort-month pairs where the full month hasn't elapsed yet."*

Cohort = month of first transaction. Activity = any transaction. Today is **2026-09-14**, so the last **complete** month is **2026-08**.

Columns: \`cohort_month\`, \`month_offset\`, \`active_users\`, \`cohort_size\`, \`retention_pct\` (2dp) — ordered by \`cohort_month\`, \`month_offset\`.

Drop every (cohort, offset) pair whose activity month is 2026-09 or later. Leave them in and the newest cohorts appear to fall off a cliff — not because they churned, but because the month has not finished happening.

Compute the offset arithmetically, not with \`DATEDIFF('month', ...)\`.`,
  hints: [
    'Filter activity_month <= DATE \'2026-08-01\' before counting.',
    'month_offset = (year diff) * 12 + (month diff).',
    'cohort_size = FIRST_VALUE(active_users) OVER (PARTITION BY cohort_month ORDER BY month_offset).',
  ],
  ordered: true,
  solution: `WITH cohorts AS (
    SELECT customer_id, DATE_TRUNC('month', MIN(txn_ts)) AS cohort_month
    FROM transactions
    GROUP BY customer_id
),
activity AS (
    SELECT DISTINCT
           t.customer_id,
           c.cohort_month,
           DATE_TRUNC('month', t.txn_ts) AS activity_month
    FROM transactions t
    JOIN cohorts c ON c.customer_id = t.customer_id
    WHERE DATE_TRUNC('month', t.txn_ts) <= DATE '2026-08-01'
),
retention AS (
    SELECT cohort_month,
           (EXTRACT(YEAR FROM activity_month) - EXTRACT(YEAR FROM cohort_month)) * 12
             + (EXTRACT(MONTH FROM activity_month) - EXTRACT(MONTH FROM cohort_month)) AS month_offset,
           COUNT(DISTINCT customer_id) AS active_users
    FROM activity
    GROUP BY 1, 2
)
SELECT cohort_month,
       month_offset,
       active_users,
       FIRST_VALUE(active_users) OVER (PARTITION BY cohort_month ORDER BY month_offset) AS cohort_size,
       ROUND(active_users * 100.0
             / FIRST_VALUE(active_users) OVER (PARTITION BY cohort_month ORDER BY month_offset), 2) AS retention_pct
FROM retention
ORDER BY cohort_month, month_offset;`,
  dialect: { snowflake: 'Identical.', redshift: 'Identical.', trino: 'Identical.', spark: 'Identical.' },
},
{
  id: 'cap-6', track: 'capstone', diff: 4,
  title: 'P6 *core*: sessionize, then median session duration per day',
  ref: 'Part 7, problem 6',
  prompt: `> *"Sessionize a clickstream with a 30-minute inactivity timeout, then compute median session duration per day."*

A session belongs to the day its **first** event occurred.

Columns: \`day\`, \`n_sessions\`, \`median_duration_sec\` (2dp) — ordered by \`day\`.

Two stages: the LAG → flag → cumulative-sum sessionization, then an aggregation over the resulting sessions.

Median, not mean — session durations are heavily right-skewed by a handful of tabs left open for hours, and the mean reports those rather than typical behaviour.`,
  hints: [
    'Reuse the sessionization from pat-1, then aggregate its output a second time.',
    'Session duration = seconds between the first and last event of the session. Single-event sessions have duration 0 — decide deliberately whether to keep them (here: keep).',
    'DuckDB: median(x), or quantile_cont(x, 0.5).',
  ],
  ordered: true,
  solution: `WITH with_gap AS (
    SELECT customer_id, event_ts,
           LAG(event_ts) OVER (PARTITION BY customer_id ORDER BY event_ts) AS prev_ts
    FROM clickstream
),
flagged AS (
    SELECT customer_id, event_ts,
           CASE WHEN prev_ts IS NULL THEN 1
                WHEN event_ts > prev_ts + INTERVAL 30 MINUTE THEN 1
                ELSE 0 END AS is_new_session
    FROM with_gap
),
sessionized AS (
    SELECT customer_id, event_ts,
           SUM(is_new_session) OVER (PARTITION BY customer_id ORDER BY event_ts
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_seq
    FROM flagged
),
sessions AS (
    SELECT customer_id, session_seq,
           MIN(event_ts)::DATE AS day,
           DATE_DIFF('second', MIN(event_ts), MAX(event_ts)) AS duration_sec
    FROM sessionized
    GROUP BY customer_id, session_seq
)
SELECT day,
       COUNT(*) AS n_sessions,
       ROUND(MEDIAN(duration_sec), 2) AS median_duration_sec
FROM sessions
GROUP BY day
ORDER BY day;`,
  dialect: {
    snowflake: 'MEDIAN() is native.',
    redshift: 'MEDIAN() is native, but it is a window function there — wrap it, or use PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x).',
    trino: 'approx_percentile(x, 0.5), or exact via PERCENTILE_CONT.',
    spark: 'percentile(x, 0.5) exact, or approx_percentile.',
  },
},
{
  id: 'cap-7', track: 'capstone', diff: 3,
  title: 'P7: daily count of active subscriptions',
  ref: 'Part 7, problem 7',
  prompt: `> *"Given a table of subscription periods with start_date and end_date, produce a daily count of active subscriptions across a date range."*

Range: **2026-01-01 … 2026-03-31**, every day present.

Columns: \`day\`, \`active_subscriptions\` — ordered by \`day\`.

A subscription is active on day *d* when \`start_date <= d\` and it has not yet ended: \`end_date IS NULL OR d < end_date\`. Half-open again — a subscription ending on the 5th is not active on the 5th.

Some customers hold two subscriptions in sequence (win-backs), so counting distinct customers would undercount. Count subscriptions.`,
  hints: [
    'Spine of days CROSS/INNER JOINed to subscriptions on the active-range predicate.',
    'A plain JOIN drops days with zero actives — use LEFT JOIN if you want those days to show 0.',
    'COUNT(s.subscription_id), not COUNT(*), so empty days report 0.',
  ],
  ordered: true,
  solution: `WITH spine AS (
    SELECT UNNEST(generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL 1 DAY))::DATE AS day
)
SELECT s.day,
       COUNT(sub.subscription_id) AS active_subscriptions
FROM spine s
LEFT JOIN subscriptions sub
       ON sub.start_date <= s.day
      AND (sub.end_date IS NULL OR s.day < sub.end_date)
GROUP BY s.day
ORDER BY s.day;`,
  dialect: {
    snowflake: 'Identical with a GENERATOR spine.',
    redshift: 'Use dim_date as the spine.',
    trino: 'sequence() + UNNEST.',
    spark: 'sequence() + explode. This range join can be expensive — Spark may broadcast the small side.',
  },
},
{
  id: 'cap-8', track: 'capstone', diff: 4,
  title: 'P8: velocity-based fraud signal',
  ref: 'Part 7, problem 8',
  prompt: `> *"Identify transactions occurring within 60 seconds of the previous transaction on the same card from a different merchant category — a velocity-based fraud signal."*

Columns: \`txn_id\`, \`card_id\`, \`txn_ts\`, \`seconds_since_prev\`, \`category\`, \`prev_category\`, \`prev_txn_id\` — ordered by \`txn_ts\`, \`txn_id\`.

"The previous transaction on the same card" means the immediately preceding one — that is \`LAG\`, partitioned by card. Both conditions must hold: strictly under 60 seconds apart, **and** a different merchant category.

Physically plausible? A card cannot be at a petrol station and a hotel forty seconds apart. That is the signal.`,
  hints: [
    'LAG over (PARTITION BY card_id ORDER BY txn_ts, txn_id) for the previous timestamp, category and id.',
    'Join to merchants first so the category travels with the row before you LAG it.',
    "date_diff('second', prev_ts, txn_ts) < 60 and categories differ.",
  ],
  ordered: true,
  solution: `WITH enriched AS (
    SELECT t.txn_id, t.card_id, t.txn_ts, m.category
    FROM transactions t
    JOIN merchants m ON m.merchant_id = t.merchant_id
),
lagged AS (
    SELECT txn_id, card_id, txn_ts, category,
           LAG(txn_ts)   OVER w AS prev_ts,
           LAG(category) OVER w AS prev_category,
           LAG(txn_id)   OVER w AS prev_txn_id
    FROM enriched
    WINDOW w AS (PARTITION BY card_id ORDER BY txn_ts, txn_id)
)
SELECT txn_id,
       card_id,
       txn_ts,
       DATE_DIFF('second', prev_ts, txn_ts) AS seconds_since_prev,
       category,
       prev_category,
       prev_txn_id
FROM lagged
WHERE prev_ts IS NOT NULL
  AND DATE_DIFF('second', prev_ts, txn_ts) < 60
  AND category <> prev_category
ORDER BY txn_ts, txn_id;`,
  dialect: {
    snowflake: 'Repeat the window spec; no named WINDOW clause.',
    redshift: 'Repeat the window spec.',
    trino: 'Named WINDOW supported.',
    spark: 'Repeat the window spec.',
  },
},
{
  id: 'cap-9', track: 'capstone', diff: 4,
  title: 'P9: week-over-week growth per product, Sunday weeks, zero-filled',
  ref: 'Part 7, problem 9',
  prompt: `> *"Compute week-over-week growth for each product, where weeks start on Sunday and products with no sales in a week should show as 0 rather than being absent."*

Range: weeks starting **2026-01-04** through **2026-03-29** (Sundays). Units come from \`order_items\` joined to \`'completed'\` orders.

Columns: \`product_id\`, \`week_start\`, \`units\` (0 when no sales), \`prev_units\`, \`wow_pct\` (2dp, NULL when the previous week was 0) — ordered by \`product_id\`, \`week_start\`.

Three things at once:

1. **Sunday weeks** — \`DATE_TRUNC('week', ...)\` gives Monday here. Force Sunday: \`DATE_TRUNC('week', d + INTERVAL 1 DAY) - INTERVAL 1 DAY\`.
2. **Zero-fill** — every product must appear in every week, so cross join products against the week spine.
3. **Safe division** — \`NULLIF\` the denominator.`,
  hints: [
    "Week spine: generate_series(DATE '2026-01-04', DATE '2026-03-29', INTERVAL 7 DAY) — already Sundays.",
    'Bucket each order into its Sunday week with the +1/-1 day trick, then aggregate units per (product, week).',
    'CROSS JOIN products x weeks, LEFT JOIN the aggregate, COALESCE to 0, then LAG within product.',
  ],
  ordered: true,
  solution: `WITH weeks AS (
    SELECT UNNEST(generate_series(DATE '2026-01-04', DATE '2026-03-29', INTERVAL 7 DAY))::DATE AS week_start
),
sold AS (
    SELECT oi.product_id,
           (DATE_TRUNC('week', o.order_ts + INTERVAL 1 DAY) - INTERVAL 1 DAY)::DATE AS week_start,
           SUM(oi.quantity) AS units
    FROM order_items oi
    JOIN orders o ON o.order_id = oi.order_id
    WHERE o.status = 'completed'
    GROUP BY 1, 2
),
grid AS (
    SELECT p.product_id, w.week_start
    FROM products p
    CROSS JOIN weeks w
),
filled AS (
    SELECT g.product_id, g.week_start, COALESCE(s.units, 0) AS units
    FROM grid g
    LEFT JOIN sold s ON s.product_id = g.product_id AND s.week_start = g.week_start
)
SELECT product_id,
       week_start,
       units,
       LAG(units) OVER (PARTITION BY product_id ORDER BY week_start) AS prev_units,
       ROUND((units - LAG(units) OVER (PARTITION BY product_id ORDER BY week_start)) * 100.0
             / NULLIF(LAG(units) OVER (PARTITION BY product_id ORDER BY week_start), 0), 2) AS wow_pct
FROM filled
ORDER BY product_id, week_start;`,
  dialect: {
    snowflake: 'Set WEEK_START=7 for Sunday weeks, or keep the explicit +1/-1 trick (safer — it does not depend on session state).',
    redshift: "DATE_TRUNC('week', ...) is Monday; use the +1/-1 trick. Spine from dim_date.week_start_sun.",
    trino: 'Same +1/-1 trick.',
    spark: 'Same +1/-1 trick.',
  },
},
{
  id: 'cap-10', track: 'capstone', diff: 4,
  title: 'P10: time from signup to the Nth purchase, censored',
  ref: 'Part 7, problem 10',
  prompt: `> *"For each user, find the time from signup to their Nth purchase, correctly marking users who never reached N as censored."*

Use **N = 3** and \`clickstream\` events with \`event_type = 'purchase'\` occurring after signup.

Columns: \`customer_id\`, \`signup_ts\`, \`nth_purchase_ts\`, \`hours_to_nth\`, \`is_censored\` (1/0) — every customer appears, ordered by \`customer_id\`.

Customers who never reached three purchases get \`NULL\` for the timestamp and hours, and \`is_censored = 1\`.

Censoring is the whole point. A customer with two purchases has not "failed to reach three" — they have not reached three *yet*. Scoring them as a negative biases every survival or churn model built on this.`,
  hints: [
    "Number each customer's purchases with ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY event_ts).",
    'Keep rn = 3, then LEFT JOIN that back onto the full customer list.',
    'The LEFT JOIN is what produces the censored rows — do not filter them away afterwards.',
  ],
  ordered: true,
  solution: `WITH purchases AS (
    SELECT c.customer_id, e.event_ts,
           ROW_NUMBER() OVER (PARTITION BY c.customer_id ORDER BY e.event_ts, e.event_id) AS rn
    FROM customers c
    JOIN clickstream e
      ON e.customer_id = c.customer_id
     AND e.event_type  = 'purchase'
     AND e.event_ts    > c.signup_ts
),
nth AS (
    SELECT customer_id, event_ts AS nth_purchase_ts
    FROM purchases
    WHERE rn = 3
)
SELECT c.customer_id,
       c.signup_ts,
       n.nth_purchase_ts,
       DATE_DIFF('hour', c.signup_ts, n.nth_purchase_ts) AS hours_to_nth,
       CASE WHEN n.nth_purchase_ts IS NULL THEN 1 ELSE 0 END AS is_censored
FROM customers c
LEFT JOIN nth n ON n.customer_id = c.customer_id
ORDER BY c.customer_id;`,
  dialect: {
    snowflake: 'QUALIFY rn = 3 collapses the purchases/nth CTEs into one.',
    redshift: 'No QUALIFY.', trino: 'No QUALIFY.', spark: 'No QUALIFY.',
  },
},

];
