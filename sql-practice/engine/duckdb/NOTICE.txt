# Vendored third-party code

## DuckDB-Wasm 1.33.1-dev57.0  (DuckDB v1.5.5)
Files: `duckdb-browser.bundle.mjs` (apache-arrow bundled in), `duckdb-browser-eh.worker.js`, `duckdb-eh.wasm`
Source: https://github.com/duckdb/duckdb-wasm  (npm: `@duckdb/duckdb-wasm`)
License: MIT — https://github.com/duckdb/duckdb-wasm/blob/main/LICENSE

Vendored rather than loaded from a CDN so the practice site works offline and
cannot break when a CDN version moves. `duckdb-eh.wasm` is ~36 MB on disk but
~7.7 MB over the wire (servers gzip it) and the browser caches it after the
first load. To switch to a CDN instead, see the note at the top of
`assets/js/engine.js`.
