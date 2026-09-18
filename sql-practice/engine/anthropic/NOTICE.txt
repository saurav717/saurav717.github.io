# Vendored third-party code

## @anthropic-ai/sdk 0.126.0
File: `anthropic-browser.bundle.mjs` (the `Anthropic` client, bundled for the browser)
Source: https://github.com/anthropics/anthropic-sdk-typescript  (npm: `@anthropic-ai/sdk`)
License: MIT — https://github.com/anthropics/anthropic-sdk-typescript/blob/main/LICENSE

Vendored for the same reason DuckDB-Wasm is: this site has no bundler, the
browser loads `assets/js/*.js` as plain modules, and an npm-shaped package
cannot be imported that way. 185 KB on disk, ~48 KB over the wire, and only
`assets/js/assistant.js` imports it — so a visitor who never opens the Ask
Claude panel never downloads it.

Rebuild with:

    npm install
    npm run build:sdk

and update the version above.
