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

## "Access blocked", Error 403: `access_denied`

This is the block page, and it is the one thing anyone signing in here is
likely to hit:

> **Access blocked: saurav717.github.io has not completed the Google
> verification process.** The app is currently being tested and can only be
> accessed by developer-approved testers. Error 403: `access_denied`

The wording sends people to Google's verification and brand-verification docs,
and that is a dead end: this app is not waiting on a review. It asks for
`openid`, `email`, `profile` and `drive.file` — Google classes none of those as
sensitive or restricted, so it needs no verification to be used by anyone.
Verification and brand verification are for apps that ask for sensitive or
restricted scopes, or that want a logo and a verified name on the consent
screen. What is actually refusing the sign-in is one setting: the consent
screen is in **Testing**, and an app in testing only admits the accounts listed
on it.

Two ways out, in the Cloud project this site's client ID belongs to — its
number is the first field of the ID, `308274983351`, and the page is
[**Google Auth Platform → Audience**](https://console.cloud.google.com/auth/audience)
(older consoles: **APIs & Services → OAuth consent screen**):

1. **Add the account under Test users.** Use the address printed at the bottom
   of the block page, not the one you meant to sign in with — Google refuses
   the account the browser is actually signed into, which is often a different
   one. Up to 100 addresses, and it keeps the app private.
2. **Press Publish app**, which moves the audience to *In production* and
   retires the test-user list entirely. No review is involved, because of the
   scopes above — but the button stays greyed out until the **Branding** page
   is complete, which is the next section. Publishing lists the app nowhere and
   gives nobody access to anything of yours: each person who signs in grants
   the app the same `drive.file` access to *their own* Drive, and to nothing
   else.

Testing costs something either way: a grant from an app in testing expires
after seven days, so even a listed test user is asked to consent again about
weekly. Publishing stops that too.

Nothing of this reaches the app while it is happening: the block page ends the
window it opened in without answering, so all the app sees is a window that
closed. The build here says so — its message for a closed window carries the
same advice — but the setting is only changeable in the console.

### What Publish app is waiting for

**Google Auth Platform → Branding**, where the app name and support email are
set but the three link fields below them are empty. Production wants them
filled, and the pages exist on this site for exactly that:

| Field | Value |
| --- | --- |
| Application home page | `https://saurav717.github.io/reader/` |
| Application privacy policy link | `https://saurav717.github.io/reader/privacy/` |
| Application Terms of Service link | `https://saurav717.github.io/reader/terms/` |

Those three fill **Authorised domains** with `saurav717.github.io` on their own
— add it by hand if the console does not. Save the Branding page, go back to
**Audience**, and **Publish app** is clickable.

The policy pages are [`_pages/reader-privacy.md`](../_pages/reader-privacy.md)
and [`_pages/reader-terms.md`](../_pages/reader-terms.md) in this repository,
Jekyll pages like any other. They describe the app as it is — browser-only
storage, `drive.file` and nothing wider, no analytics, no data reaching anyone
who runs the site — so they need editing whenever that stops being true.

If sign-in fails with something else — a window that closes at once, or
`redirect_uri_mismatch` — it is the other setting: `https://saurav717.github.io`
has to be on the client's **Authorised JavaScript origins**, as the origin
alone. The app repository's README has the rest.

## What opening the site does

With the client ID compiled in, the site opens on the connect screen and stays
there until Drive is connected — one button, one consent covering your name and
the `drive.file` scope, and then the app. **Not now** goes past it with
everything kept in this browser.

It asks every visit. Nothing here can hold a refresh token, so the token dies
with the tab, and a paper added before you reconnect is one Drive never hears
about. After the first time the asking is quiet: the grant you already gave is
reused, and Google's window opens and closes without a question.

**The proxy is not set**, and has to be, in the app itself — **Settings → Paper
proxy**, kept in your browser, no rebuild of this site needed. Until it is, the
connect screen says so: Drive would receive each paper's details without its
file.

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
`My Drive/Papers_collection/<paper>/` — a folder of its own for every paper,
which the Drive button beside it in a collection opens.

The full walkthrough, including what lands in Drive and what to check when
nothing does, is in the app repository's README.
