-- ============================================================================
--  Dialect compatibility layer
--
--  The practice engine is DuckDB (Postgres-family, like Redshift and Snowflake).
--  These macros make the Snowflake / Redshift spellings of common functions
--  actually RUN, so you build muscle memory on the syntax you will really type
--  rather than on DuckDB-only spellings.
--
--  Anything defined here is a COMPATIBILITY SHIM, not standard DuckDB. The
--  per-exercise dialect notes tell you which engines accept which spelling.
-- ============================================================================

-- --- Date arithmetic, Snowflake / Redshift style -----------------------------
-- Snowflake:  DATEADD('day', 7, ts)      Redshift: DATEADD(day, 7, ts)
-- Trino:      date_add('day', 7, ts)     Spark:    ts + INTERVAL 7 DAY
CREATE OR REPLACE MACRO dateadd(part, n, d) AS
  CASE lower(part)
    WHEN 'year'    THEN d + (n      || ' years')::INTERVAL
    WHEN 'quarter' THEN d + (n * 3  || ' months')::INTERVAL
    WHEN 'month'   THEN d + (n      || ' months')::INTERVAL
    WHEN 'week'    THEN d + (n * 7  || ' days')::INTERVAL
    WHEN 'day'     THEN d + (n      || ' days')::INTERVAL
    WHEN 'hour'    THEN d + (n      || ' hours')::INTERVAL
    WHEN 'minute'  THEN d + (n      || ' minutes')::INTERVAL
    WHEN 'second'  THEN d + (n      || ' seconds')::INTERVAL
  END;

-- DATEDIFF / date_diff are already native in DuckDB and count BOUNDARY
-- CROSSINGS, same as Redshift, Snowflake and SQL Server. This is the trap in
-- reference 3.3:  DATEDIFF('year', '2025-12-31', '2026-01-01') = 1
-- One day apart, one year boundary crossed. Verify it yourself in the sandbox.

-- Time-zone macros live in compat-tz.sql, which is loaded ONLY when the ICU
-- extension is available (it carries the IANA time-zone database). Without it
-- DuckDB knows UTC and nothing else. See assets/js/engine.js.

-- --- NULL handling helpers ---------------------------------------------------
CREATE OR REPLACE MACRO nvl(a, b)          AS coalesce(a, b);
CREATE OR REPLACE MACRO nvl2(a, b, c)      AS CASE WHEN a IS NOT NULL THEN b ELSE c END;
CREATE OR REPLACE MACRO iff(cond, a, b)    AS CASE WHEN cond THEN a ELSE b END;
CREATE OR REPLACE MACRO zeroifnull(a)      AS coalesce(a, 0);
CREATE OR REPLACE MACRO nullifzero(a)      AS nullif(a, 0);
CREATE OR REPLACE MACRO decode2(e, a, b, d) AS CASE WHEN e = a THEN b ELSE d END;

-- --- Formatting --------------------------------------------------------------
-- Snowflake / Redshift / Postgres use TO_CHAR with YYYY-MM-DD style patterns;
-- Trino uses format_datetime, Spark uses date_format. This shim accepts the
-- TO_CHAR pattern and translates it to DuckDB's strftime codes.
CREATE OR REPLACE MACRO to_char(d, fmt) AS strftime(d,
  replace(replace(replace(replace(replace(replace(replace(fmt,
    'YYYY','%Y'), 'MON','%b'), 'MM','%m'), 'DD','%d'),
    'HH24','%H'), 'MI','%M'), 'SS','%S'));

CREATE OR REPLACE MACRO to_date(s) AS s::DATE;

-- --- Misc --------------------------------------------------------------------
CREATE OR REPLACE MACRO getdate()  AS current_timestamp;   -- Redshift
CREATE OR REPLACE MACRO sysdate()  AS current_timestamp;   -- Redshift
CREATE OR REPLACE MACRO to_unixtime(ts) AS epoch(ts);      -- Trino
CREATE OR REPLACE MACRO from_unixtime(n) AS to_timestamp(n); -- Trino / Spark
CREATE OR REPLACE MACRO unix_timestamp(ts) AS epoch(ts);   -- Spark
