# The reader at /reader/

A built copy of [saurav717/reader](https://github.com/saurav717/reader). Nothing
here is written by hand: the whole directory is the output of

```bash
npm run build:pages       # VITE_BASE=/reader/ VITE_API_BASE=none
```

run in that repository, copied over `reader/`. Rebuild it the same way whenever
the app changes.

## What is already set, and what is not

**The Google OAuth client ID is compiled in**, from `.env.production` in the app
repository, so the site does not ask for one. It is a Web application client on
a project with the Drive API enabled, and `https://saurav717.github.io` is in
its **Authorised JavaScript origins** — the origin only, since
`https://saurav717.github.io/reader/` is a path and would not match. A client ID
is not a secret: every browser-side OAuth flow puts it in the page source, and
Google only honours it on that client's own listed origins.

So all that is left in the app is **Sign in with Google**, then **Connect
Drive** — a separate consent for the `drive.file` scope, which lets the app see
the files it creates and nothing else in your Drive. Its consent screen is in
**Testing**, so only accounts added as test users in the Cloud Console can sign
in; everyone else gets "Access blocked", which is the intended behaviour for a
personal reading tool.

**The proxy is not set**, and has to be, in the app itself — **Settings → Paper
proxy**, kept in your browser, no rebuild of this site needed.

arXiv and the publishers send no CORS headers, so a browser
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
