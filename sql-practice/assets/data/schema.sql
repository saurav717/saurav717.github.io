-- ============================================================================
--  NimbusPay / NimbusCart practice warehouse   [engine: DuckDB v1.5.5]
--  A toy dataset shaped to the "SQL: Rolling Windows & Timestamp Operations"
--  reference and the Tier-1 SQL section of the pre-onboarding prep guide.
--
--  Every table exists to serve specific patterns. Notes below say which.
--
--  CONVENTIONS (deliberate, they mirror a real warehouse):
--    * Timestamps are real TIMESTAMP columns holding UTC, with no zone
--      attached -- exactly like Redshift's TIMESTAMP and Snowflake's
--      TIMESTAMP_NTZ. Converting them is an explicit act (ref 3.4).
--    * NO FOREIGN KEYS ARE ENFORCED. This is not laziness -- Redshift,
--      Snowflake and Athena all accept FK declarations as *informational
--      metadata only* and never enforce them. The planner may use them; the
--      loader will not stop you violating them. Orphan rows are a real class
--      of warehouse bug, and a LEFT JOIN that finds NULL on the right is how
--      you discover them. The relationships are documented per column below.
--    * Money is DECIMAL, not FLOAT. Warehouses use fixed-point for money and
--      so should you; FLOAT sums are not associative and will not reconcile.
--    * Half-open validity intervals: [valid_from, valid_to)  -- see dim_customer_scd
--    * NULL is used meaningfully, not accidentally. Some columns are nullable
--      precisely so NOT IN / COALESCE / left-join traps are reproducible.
-- ============================================================================

DROP TABLE IF EXISTS dim_date;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS merchants;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS balance_snapshots;
DROP TABLE IF EXISTS logins;
DROP TABLE IF EXISTS clickstream;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS dim_customer_scd;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS daily_revenue;
DROP TABLE IF EXISTS staging_customers;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS employees;

-- ---------------------------------------------------------------------------
-- dim_date -- the persisted calendar dimension (ref §2.2, §3.7)
-- Your doc says: "ask whether yours does before hand-rolling a spine".
-- This one does. It carries the things a real date dim carries.
-- Range: 2024-01-01 .. 2026-12-31
-- ---------------------------------------------------------------------------
CREATE TABLE dim_date (
    day             DATE PRIMARY KEY,
    year            INTEGER NOT NULL,
    quarter         INTEGER NOT NULL,
    month           INTEGER NOT NULL,
    day_of_month    INTEGER NOT NULL,
    day_of_year     INTEGER NOT NULL,
    iso_dow         INTEGER NOT NULL,   -- 1=Monday .. 7=Sunday (ISO, ref §3.2)
    dow_sun0        INTEGER NOT NULL,   -- 0=Sunday .. 6=Saturday (Postgres DOW)
    day_name        TEXT    NOT NULL,
    is_weekday      INTEGER NOT NULL,   -- 1 if Mon-Fri
    is_holiday      INTEGER NOT NULL,
    holiday_name    TEXT,               -- NULL unless is_holiday = 1
    month_start     DATE    NOT NULL,
    month_end       DATE    NOT NULL,
    week_start_mon  DATE    NOT NULL,   -- ISO week start (Postgres/Redshift/Trino/Snowflake)
    week_start_sun  DATE    NOT NULL,   -- BigQuery default -- ref §3.1 mismatch
    iso_week        INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- customers
-- segment and city are NULLABLE on purpose -> COALESCE / NOT IN / NULL semantics
-- utc_offset_minutes supports fixed-offset tz conversion practice (ref §3.4).
-- SQLite cannot do IANA zones; tz_name is carried so the exercise can show you
-- what you WOULD write in Redshift/Trino and why EST != America/New_York.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
    customer_id        INTEGER PRIMARY KEY,
    full_name          TEXT NOT NULL,
    email              TEXT,
    country            TEXT NOT NULL,
    city               TEXT,
    segment            TEXT,            -- NULLable: 'Consumer','SMB','Enterprise'
    signup_ts          TIMESTAMP NOT NULL,   -- naive UTC (like Redshift TIMESTAMP)
    tz_name            TEXT NOT NULL,   -- IANA name, e.g. 'America/New_York'
    utc_offset_minutes INTEGER NOT NULL,-- fixed offset, DST ignored (that is the lesson)
    is_active          INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- cards -- one customer may hold several. Supports the fan-out lesson and
-- the velocity-fraud problem (Part 7 #8): same card, <60s apart, different MCC.
-- ---------------------------------------------------------------------------
CREATE TABLE cards (
    card_id     INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    network     TEXT NOT NULL,          -- 'visa','mastercard','amex'
    issued_date DATE NOT NULL,
    status      TEXT NOT NULL           -- 'active','blocked','expired'
);

CREATE TABLE merchants (
    merchant_id   INTEGER PRIMARY KEY,
    merchant_name TEXT NOT NULL,
    category      TEXT NOT NULL,        -- the MCC-ish grouping
    country       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- transactions -- the main event table.
-- Serves: rolling 30d sums (#1), z-score anomaly (#2), velocity fraud (#8),
--         as-of balance join (#4), ROWS-vs-RANGE ties demo (§1.3).
-- Contains deliberate same-timestamp ties and deliberate quiet/burst periods.
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
    txn_id      INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    card_id     INTEGER NOT NULL,
    merchant_id INTEGER NOT NULL,
    txn_ts      TIMESTAMP NOT NULL,     -- naive UTC
    amount      DECIMAL(12,2) NOT NULL,
    status      TEXT NOT NULL           -- 'settled','pending','reversed'
);

-- ---------------------------------------------------------------------------
-- balance_snapshots -- sparse and irregular, ON PURPOSE.
-- Part 7 #4: attach balance as of the most recent snapshot <= txn time.
-- Snapshots do NOT line up with transaction times. That is the whole point.
-- ---------------------------------------------------------------------------
CREATE TABLE balance_snapshots (
    snapshot_id  INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL,
    snapshot_ts  TIMESTAMP NOT NULL,
    balance      DECIMAL(14,2) NOT NULL
);

-- ---------------------------------------------------------------------------
-- logins -- Part 7 #3: longest streak of consecutive days (gaps & islands).
-- Multiple logins per day exist, so you must DISTINCT the day first.
-- failed logins exist, so "at least one login" needs a think about success.
-- ---------------------------------------------------------------------------
CREATE TABLE logins (
    login_id    INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    login_ts    TIMESTAMP NOT NULL,
    device      TEXT NOT NULL,          -- 'ios','android','web'
    success     INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- clickstream -- Part 7 #6 (sessionize, 30-min timeout) and funnel analysis.
-- Event gaps are generated to straddle the 30-minute boundary on both sides.
-- ---------------------------------------------------------------------------
CREATE TABLE clickstream (
    event_id    INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    event_ts    TIMESTAMP NOT NULL,
    event_type  TEXT NOT NULL,          -- view_home|view_product|add_to_cart|begin_checkout|purchase
    product_id  INTEGER                 -- NULL for non-product events
);

-- ---------------------------------------------------------------------------
-- categories -- self-referencing hierarchy for recursive CTE practice
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
    category_id   INTEGER PRIMARY KEY,
    category_name TEXT NOT NULL,
    parent_id     INTEGER  -- NULL at root
);

CREATE TABLE products (
    product_id   INTEGER PRIMARY KEY,
    product_name TEXT NOT NULL,
    category_id  INTEGER NOT NULL,
    unit_price   DECIMAL(10,2) NOT NULL,
    unit_cost    DECIMAL(10,2) NOT NULL,
    launched_on  DATE NOT NULL,
    discontinued INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- orders / order_items / payments
-- The classic 1:many fan-out setup. Joining orders -> order_items and then
-- SUM(orders.shipping_fee) double counts. Prep guide Tier 1 calls this out
-- by name; there are exercises that make you detect and fix it.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
    order_id      INTEGER PRIMARY KEY,
    customer_id   INTEGER NOT NULL,
    order_ts      TIMESTAMP NOT NULL,
    status        TEXT NOT NULL,        -- 'completed','shipped','pending','cancelled','returned'
    channel       TEXT NOT NULL,        -- 'web','mobile','phone','partner'
    shipping_fee  DECIMAL(8,2) NOT NULL,        -- order-level: the fan-out landmine
    employee_id   INTEGER               -- NULL for self-serve orders
);

CREATE TABLE order_items (
    order_id   INTEGER NOT NULL,
    item_no    INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    discount   DECIMAL(4,3) NOT NULL,           -- 0.00 .. 0.25
    PRIMARY KEY (order_id, item_no)
);

CREATE TABLE payments (
    payment_id INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL,
    paid_ts    TIMESTAMP NOT NULL,
    amount     DECIMAL(12,2) NOT NULL,
    method     TEXT NOT NULL            -- 'card','paypal','bank_transfer','gift_card'
);

-- ---------------------------------------------------------------------------
-- subscriptions -- Part 7 #7: daily count of active subscriptions.
-- end_date IS NULL means still active. Half-open: active on d when
-- start_date <= d AND (end_date IS NULL OR d < end_date).
-- Some customers have two sequential subscriptions (win-back), which breaks
-- a naive COUNT(DISTINCT customer_id).
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
    subscription_id INTEGER PRIMARY KEY,
    customer_id     INTEGER NOT NULL,
    plan            TEXT NOT NULL,      -- 'basic','plus','pro'
    start_date      DATE NOT NULL,
    end_date        DATE,               -- NULL = active
    mrr             DECIMAL(10,2) NOT NULL
);

-- ---------------------------------------------------------------------------
-- dim_customer_scd -- SCD Type 2 (ref §4.4)
-- HALF-OPEN intervals: valid_from inclusive, valid_to EXCLUSIVE, NULL = current.
-- Rows are contiguous: version N's valid_to == version N+1's valid_from.
-- Use <= on both ends and you WILL double count. That is an exercise.
-- ---------------------------------------------------------------------------
CREATE TABLE dim_customer_scd (
    scd_id       INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL,
    segment_name TEXT NOT NULL,
    valid_from   TIMESTAMP NOT NULL,
    valid_to     TIMESTAMP              -- NULL = current version
);

-- ---------------------------------------------------------------------------
-- bookings -- ref §4.5 overlapping intervals / interval merging
-- Deliberate overlaps on the same resource_id.
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
    booking_id  INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    start_ts    TIMESTAMP NOT NULL,
    end_ts      TIMESTAMP NOT NULL
);

-- ---------------------------------------------------------------------------
-- daily_revenue -- the metrics table for frame mechanics.
-- HAS DELIBERATE GAPS (missing days) and a few ZERO-revenue days.
--   * gaps       -> ROWS 6 PRECEDING is NOT a 7-day window (ref §2.2)
--   * zero days  -> NULLIF on the denominator is not optional (ref §2.4)
-- ---------------------------------------------------------------------------
CREATE TABLE daily_revenue (
    day     DATE PRIMARY KEY,
    revenue DECIMAL(12,2) NOT NULL
);

-- ---------------------------------------------------------------------------
-- staging_customers -- raw CDC-style landing table with duplicates.
-- Dedup with ROW_NUMBER() OVER (PARTITION BY .. ORDER BY updated_at DESC)
-- ---------------------------------------------------------------------------
CREATE TABLE staging_customers (
    row_id             INTEGER PRIMARY KEY,
    source_customer_id INTEGER NOT NULL,
    email              TEXT,
    full_name          TEXT NOT NULL,
    country            TEXT,
    updated_at         TIMESTAMP NOT NULL
);

-- ---------------------------------------------------------------------------
-- departments / employees -- hierarchy + left-join traps.
-- * one department has ZERO employees  -> anti-join / LEFT JOIN ... IS NULL
-- * some employees have NULL department_id (contractors) -> NOT IN trap
-- * manager_id self-reference, 4 levels deep -> recursive CTE
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
    department_id INTEGER PRIMARY KEY,
    dept_name     TEXT NOT NULL,
    location      TEXT NOT NULL
);

CREATE TABLE employees (
    employee_id   INTEGER PRIMARY KEY,
    full_name     TEXT NOT NULL,
    department_id INTEGER,  -- NULLable
    manager_id    INTEGER,      -- NULL for CEO
    title         TEXT NOT NULL,
    salary        DECIMAL(12,2) NOT NULL,
    hire_date     DATE NOT NULL
);

CREATE INDEX idx_txn_card_ts    ON transactions(card_id, txn_ts);
CREATE INDEX idx_login_cust_ts  ON logins(customer_id, login_ts);
CREATE INDEX idx_items_order    ON order_items(order_id);
