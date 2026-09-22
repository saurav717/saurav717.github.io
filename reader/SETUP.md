# The reader at /reader/

A built copy of [saurav717/reader](https://github.com/saurav717/reader). Nothing
here is written by hand: the whole directory is the output of

```bash
npm run build:pages       # VITE_BASE=/reader/ VITE_API_BASE=none
```

run in that repository, copied over `reader/`. Rebuild it the same way whenever
the app changes.

## Two things to set in the app, not here

GitHub Pages is a static host, so the app is compiled with no proxy of its own
(`VITE_API_BASE=none`). Both of the settings that make Google Drive and PDFs
work are entered in the running app — **Settings**, top left — and kept in your
browser, so neither needs a rebuild of this site.

**Google OAuth client ID.** A Web application client from the Google Cloud
Console, on a project with the Drive API enabled, with
`https://saurav717.github.io` in **Authorised JavaScript origins** — the origin
only: `https://saurav717.github.io/reader/` is a path, and pasting that is why
sign-in fails. Then **Sign in with Google**, then **Connect Drive**, which is a
separate consent for the `drive.file` scope: the app can see the files it
creates and nothing else in your Drive.

**Paper proxy.** arXiv and the publishers send no CORS headers, so a browser
cannot fetch a paper from them directly and a static site has no server to do
it. Deploy the Cloudflare Worker in the app repository's `worker/` —
`npx wrangler deploy`, free tier, with `https://saurav717.github.io` in its
`ALLOWED_ORIGINS` — and paste the Worker's URL into **Settings → Paper proxy**.
**Test it** says whether it answers.

Without the proxy the site still runs: search works through OpenAlex, Crossref
and Semantic Scholar, and the reader shows abstracts. But no PDF can be fetched,
so none can be read here or saved to Drive either — Drive gets the metadata
sidecar alone. With it, opening a paper shows the PDF and puts that same copy in
`My Drive/Paper Reader/<collection>/`.

The full walkthrough, including what lands in Drive and what to check when
nothing does, is in the app repository's README.
