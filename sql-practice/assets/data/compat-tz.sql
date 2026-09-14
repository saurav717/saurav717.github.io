-- ============================================================================
--  Time-zone compatibility macros.
--
--  Loaded ONLY when DuckDB's ICU extension is present -- ICU carries the IANA
--  time-zone database, and without it DuckDB understands UTC and nothing else.
--  The extension is an optional ~2 MB download from extensions.duckdb.org the
--  first time it is used, so the practice site treats it as a bonus: every
--  exercise works without it.
--
--  To make it permanent and offline, download the extension once and load it
--  from disk -- see the README section "Optional: full time-zone support".
-- ============================================================================
-- --- Time zones --------------------------------------------------------------
-- Snowflake / Redshift:  CONVERT_TIMEZONE('UTC','America/New_York', ts)
-- Postgres / Trino:      ts AT TIME ZONE 'America/New_York'
-- Spark:                 from_utc_timestamp(ts, 'America/New_York')
-- Full IANA zones with real DST handling -- 'EST' would NOT do this correctly.
CREATE OR REPLACE MACRO convert_timezone(src, tgt, ts) AS
  (ts::TIMESTAMP AT TIME ZONE src) AT TIME ZONE tgt;

CREATE OR REPLACE MACRO from_utc_timestamp(ts, tgt) AS   -- Spark spelling
  (ts::TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE tgt;

CREATE OR REPLACE MACRO to_utc_timestamp(ts, src) AS     -- Spark spelling
  (ts::TIMESTAMP AT TIME ZONE src) AT TIME ZONE 'UTC';

