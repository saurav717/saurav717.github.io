# The reader at /reader/

A built copy of [saurav717/reader](https://github.com/saurav717/reader). Nothing
here is written by hand: the whole directory is the output of

```bash
VITE_API_BASE=https://reader-arxiv-proxy.es16btech11007.workers.dev npm run build:pages
```

run in that repository, copied over `reader/`. Rebuild it the same way whenever
the app changes. `VITE_API_BASE` is the proxy below; leave it off and the
build has no proxy, and every browser has to be told one in Settings.

## The Implementation tab, and running things on your own machine

Explain has a second page, **Implementation**: the paper as a project — what
to build, the datasets, the repository and its starter files, and a compute
budget worked out for the machine picked on the page. **Colab** in its bar
commits the scaffold to the Git mirror and opens it in Colab, or downloads
the notebook or a zip; that part works from this static copy. **Local** — the
scaffold written onto your own disk, your GPU detected, commands run there
with the output on the page — needs the reader's own proxy on your machine,
which the Worker cannot stand in for:

```bash
READER_WORKSPACE=~/reader-workspace npm start     # in the app repository
```

and its address in Settings → Paper proxy. Without it the Local menu says so.

## OpenReview papers come from OpenReview's API, signed in

openreview.net sends every fetch of a paper to a check of its own
(`/challenge?redirect=…`, *Verifying your browser*), which has Cloudflare's box
inside. From the Worker's browser that box never passes: it ticks, retries, and
comes back. OpenReview's API (`api2.openreview.net`, then `api.openreview.net`)
now asks anonymous requests for the same check, but a signed-in request skips
it. So the Worker signs in with an OpenReview account and fetches the file from
the API. The pane, if it lands on the check anyway, has the Worker do the same
and says there is nothing to tick. It no longer watches the check go round
(*Success!*, *Verifying…*, back to the check). It closes the Worker's browser
there, and if the API fails too it offers the file from a tab of your own.
Each API ask has a 30 s deadline, so a silent API shows as that, not as
Safari's bare *Load failed*. Give the Worker the account once, in the app
repository:

```bash
npx --yes wrangler@4 secret put OPENREVIEW_USERNAME   # the account's email
npx --yes wrangler@4 secret put OPENREVIEW_PASSWORD
npm run deploy:worker
```

Without them an OpenReview paper fails with what the API answered
(`ChallengeRequiredError`) and names the two secrets. Anyone who can reach the
Worker's `/pdf` then reads OpenReview papers as that account, so a spare account
is the tidy choice.

## Reflow reads the PDF

**Reflow** — the reading mode you can highlight in — is made from the PDF
itself wherever there is one: the file is opened in the browser with pdf.js
(the `pdfReflow-*.js` chunk and `pdf.worker.min-*.mjs` here, loaded the first
time it is needed — `pdfWorkerMain-*.js` is the same code as a module of the
app, for a browser that will not start the worker, which then reads on the
main thread) and every page is read out — the text set as paragraphs
and headings, the figures and display equations painted from the page and
shown in their place, the tables read into tables. arXiv's HTML rendering
and the abstract are what it falls back to when no copy of the PDF will come
here, or the file is a scan with no text to read. The app repository's
README says how the reading is done, under *Getting the PDF*.

## Papers behind a login (IEEE and the like)

The Worker fetches every paper anonymously, and a publisher that wants an
institutional sign-in answers it with a page, not a PDF — the result says
*IEEE asks for a sign-in*. The Worker cannot sign in: it has no browser and no
screen. The reader can, when its proxy runs on your own machine:

```bash
git clone https://github.com/saurav717/reader.git && cd reader
npm install && npm run build && npm start      # http://localhost:8080
```

Then, on this site, **Settings → Paper proxy → `http://localhost:8080` → Test
it**. The build here already answers that proxy's origin, and the proxy answers
this site's. From then on the offer under a walled result — **Sign in at
ieeexplore.ieee.org with your institution** — opens a Chromium window on your
machine at the publisher, you sign in through your institution there, close it,
and the paper is fetched again through that browser and saved to Drive. The
session is kept in `~/.reader/browser-profile`; **Settings → Institutional
access → Forget sign-ins** deletes it. The app repository's README has the
whole story under *Papers behind a login*.

**Or browse to it inside the reader, with nothing running of your own.** The
same offer has a second form that needs no screen and, from this site, no
proxy but the Worker: **Browse to ieeexplore.ieee.org and sign in here**
opens a browser *in the PDF pane* — a headless Chrome the Worker drives
through Cloudflare's Browser Rendering, streamed into the page and driven from
it. It asks which site to go to (the one that asked for the sign-in, the other
copies, Google Scholar, or any address), you sign in there as anywhere, and the
moment that browser meets the PDF — or you press **Fetch the PDF from this
page**, or **Signed in — try the copies again** — the paper opens on it and
goes to Drive. From then on the paper opens on that copy: Drive is asked
before any publisher, by the id the library recorded or, failing that, by
name, so the sign-in is for the first open only, and a copy saved from
another browser counts too. Drive is asked the moment the paper opens, and
the copies — when Drive has nothing — three at a time, first to answer wins,
with **Browse to a copy and sign in here** offered while they are still being
asked rather than only once every one has refused.

A Worker deployed before this answered every open of the pane with *putting
the sign-in back took longer than 10 seconds*: the kept sign-in's cookies
went back one at a time, two round trips each, and the open's deadline went
before the page was asked for. Now they go back in one call, and a restore
that runs long costs the sign-in, not the open. `npm run deploy:worker` from
the current app repository brings the Worker up to date.

*Browserless would not open a browser: code: 429* is Browserless's one
browser on the free plan being in use — by the last pane, closed a moment
ago, or by a copy of the paper being fetched through it. The Worker now
hands that up as a wait, and the pane counts twenty seconds down and tries
again on its own; the reader asks one copy per site at a time and stops the
copies when the pane opens, so they do not hold the slot the pane needs.

That takes the Worker redeployed from the current app repository, since the
browser binding — and the Durable Object that keeps the session open, which
is what makes the pane quick — are in its `wrangler.toml`:

```bash
git clone https://github.com/saurav717/reader.git && cd reader
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm run deploy:worker        # the SERPLY_KEY and SERPAPI_KEY secrets already set stay set
```

Browser Rendering is on Cloudflare's free plan, which rations browsers
rather than requests: a few new browsers a minute, three alive at once, and
ten minutes of browser time a day (the Workers Paid plan has hours a month).
A sign-in and a couple more tries inside one minute used to hit the limit,
because every time the pane closed — a PDF collected, **Retry**, the X —
its browser was closed with it, and the next site card pressed started a
new one. The Worker deployed from the current app repository spends those
sparingly: a browser already open is pointed at the next site rather than
started again; closing the pane keeps its browser for most of a minute,
blank, so a site card pressed after a close points that same browser
somewhere else rather than asking for another (it is closed for good when
nobody comes back, since browser time is counted by the day too); a page
the site closed is replaced by a new page in the same browser; and a
session left behind, or any of the account's that nothing is connected to,
is adopted. Before it asks Cloudflare for a browser it asks what Cloudflare
will allow — how many are alive against how many may be, and whether
another may be started this minute, and if not, in how long — and waits
out exactly the time named, once, rather than asking for a browser every
few seconds (a refused ask may count against the minute the way an
answered one does, which is how the old way could keep the minute spent on
its own). When every browser it allows is alive and held it looks again
every few seconds for one come free. After most of a minute of that the
pane says *Cloudflare would not start another browser just now*, then
which limit it was and how long until another try, then Cloudflare's own
words — and counts that wait down and tries again on its own, twice,
before leaving it to you with **Try again**.

Every step of opening has a deadline, and so does the whole open (a minute
and a half): a session Cloudflare lists as free but whose Chrome has
stopped answering, or a held browser whose socket went quietly, used to
leave *Opening the proxy's browser…* spinning for minutes, with every click
after queued behind it. Now the step that ran out is named in the pane, the
session is left alone for a few minutes, and the next click starts afresh;
the site gives up on its side after two minutes with a sentence.

The day's browser time being spent is told apart from a minute's: Cloudflare
refuses both with the same code, but its words differ, and when they say the
day is spent the pane says so at once — *today's are spent, so no browser
will start until its day rolls over* — with no countdown, since no wait short
of tomorrow cures it. Under a countdown the pane now also shows the reason
the Worker gave, Cloudflare's own words included.

Cloudflare's words do not always differ, though: with the day spent it
has said only *Rate limit exceeded*, the same as for a minute. So a
refusal its limits contradict — a start allowed, nothing to wait for, room
for one more, and refused all the same — is looked at once more and then
said to be most likely the day's time, with no countdown. Whether it is,
the Cloudflare dashboard settles: **Compute → Browser Run** shows the
month's browser hours and, under **Runs**, every session with how long it
lived. The free plan allows ten minutes of browser time a day, and one
session left running to Cloudflare's ten-minute cap spends the whole of it
— which is what a session whose Chrome stopped answering used to do, held
by a socket nobody closed; the Worker now closes that socket the moment
its first ask over it fails, and gives up on any ask after thirty seconds
rather than Puppeteer's three minutes.

**On the free plan or the paid one.** Everything here runs on Workers Free,
and the one thing that does not fit in it is browsing: ten minutes a day
is one sign-in and a couple of pages, and a day of trying things spends it
before lunch. The Workers Paid plan (**Compute → Workers plans** in the
dashboard) includes hours of browser time a month instead, more browsers
alive at once, and more starts a minute; check the plan page for the
current numbers, since they change. Nothing in the reader needs changing
to use it — the same Worker, redeployed or not, simply stops being
refused. The alternative that costs nothing is the Node proxy on your own
machine (`npm start`, pointed at from Settings → Paper proxy), which has
no browser-time limit and can show captchas, but only works while that
machine is on.

When it keeps refusing or hangs, `/browse/status` on the Worker —
`https://reader-arxiv-proxy.es16btech11007.workers.dev/browse/status` —
says what the Worker holds and what Cloudflare last said its limits were:
`held` and `page` (a browser held, with a page), `opening` (how long an
open has been in flight), `avoiding` (sessions that would not answer
lately), `lastError` (what last went wrong, and when), `log` (the last twenty
things that happened, with when — kept in the Worker's storage, so an
instance started after an eviction still has them), and `browsers` —
`alive` against `max`, `allowed` this minute, and `nextInMs`. Three alive and none
free means something is still connected to each (the pane open in another
tab, or the last connection not yet let go — each is freed a minute and a
half after whatever drove it disconnects), so a minute and a half of
leaving it alone clears it. No new browsers allowed and no time named, for
longer than a minute, means the day's ten minutes are spent: the Node
proxy on your own machine has no such limit, and the Workers Paid plan
has hours a month. The bare *Unable to create new browser: code: 429* on
its own is the same refusal from a Worker deployed before all this, and the
`npm run deploy:worker` above is the fix — and it is the fix for this
build too, which expects the Worker to say how long to wait.

A sign-in lasts for the next paper too — which is also what stops the
browser being needed again for a publisher already signed in to — because
the Worker has somewhere to keep the cookies: a KV namespace bound as
`SESSIONS` in the `[[kv_namespaces]]` block of `wrangler.toml`, whose id is
the one `npx wrangler kv namespace create SESSIONS` printed on this account.
With it bound the offer under a walled result gains **Signed in — try the
copies again**. A Worker deployed to another account needs a namespace of
its own there; without one a sign-in lasts only as long as the browser
session.
The Node proxy on your own machine, or on any server with a Chromium, does
the same thing with a profile of its own. *A browser inside the reader* in
the app repository's README has the details.

Some sites put a check for a person in front of the file — academia.edu's
downloads sit behind Cloudflare's *Performing security verification* page,
which shows a box to tick when it is not sure. In the pane that page is the
site's page like any other: the line under it names the site and says the
box, if one appears, is yours to click, and once the check passes the page
follows on to the file by itself. For that to work the Worker's browser now
presents itself as what it is (a typed-in user-agent string used to leave it
with no client hints at all, which is the mismatch such a check looks for,
and the box never came), and the file is fetched by the page that was let
in, since the clearance is bound to the browser that earned it. Whether the
check passes is the site's call — and from the Worker, Cloudflare's check
never passes, by Cloudflare's own design: the browser the Worker drives is
Cloudflare's, and Cloudflare tells every site it protects that requests
from its rendering browsers are bots, whoever is behind them (its Browser
Rendering documentation says so, and offers a WAF skip rule to a site that
wants to let them in). So the box ticks, the widget verifies, the page
reloads, and the box is back — a refused visitor, not a failed solve, and
no number of ticks changes it. The pane now says so instead of letting
anyone find out by ticking: the Worker notices the check from the
`cf-mitigated: challenge` header Cloudflare puts on every challenge page,
counts how many times it has come and how many of those after you did
something to the page, and the line under the page says, from the Worker,
that the check is Cloudflare's and so is the browser and is not expected
to pass from here — or, once it has come back after a tick, that it will
keep coming back — with **Open it in a tab of your own** on the end, where
your own browser passes such a check without noticing, and the file
dropped on the paper. The same line from the Node proxy on your own machine,
whose browser is its own, says the box is yours to tick, and that the site
is refusing the browser if it comes back after a tick. This too takes the
Worker redeployed from the current app repository; until then this build
still tells the Worker's browser from the proxy's by the session id only
the Worker hands out, and words the line from the page's title.

It is not one site's quirk: every site that puts Cloudflare's check in
front of its files — academia.edu, Europe PMC, more each month — loops
the same way from the Worker's browser, and the Worker's plain fetch of
the file meets the same check first. So the redeployed Worker now answers
such a check as a check rather than as a sign-in wall, and the failure
under the paper says so: that the check is Cloudflare's and the Worker's
requests never pass it, with the file's own address on the drop-in for a
tab of your own. And for one family of such sites there is a way round
that needs no person: a paper in PubMed Central whose page on
ncbi.nlm.nih.gov or europepmc.org will not hand over the file is asked
for through NCBI's OA Web Service and Europe PMC's REST API — interfaces
meant for programs, with no check on them — and the PDF comes from
NCBI's own file host, for any article in the open-access subset.

**And now for every such site, with a browser that is neither Cloudflare's
nor yours.** The Worker redeployed from the current app repository can hand
such a check to a browser at [Browserless](https://www.browserless.io) —
Chromiums on addresses of their own, driven over the same protocol — once it
has a token for one:

```bash
npx --yes wrangler@4 secret put BROWSERLESS_TOKEN    # paste the key from the Browserless dashboard
npm run deploy:worker
```

With the token set nothing changes for the sites that serve no check:
Cloudflare's free browser opens first, as before. When a page comes back as
Cloudflare's check, the line under the pane says the session is being handed
to a browser at Browserless, the same page opens again there a few seconds
later, and a box that appears then is yours to tick — and the tick counts,
since that browser is nobody's bot. The site is remembered for a week, so the
next paper from academia.edu opens at Browserless straight away. A file asked
for plainly — the way **Add to collection** asks — is asked again from a
Browserless page when the check meets it, which passes the checks that need
no box and hands the file back on its own; one that needs a person is said,
under the failure, to have been met at Browserless, and **Browse to a copy**
opens the pane there with the box ready. Browserless's free plan has some
thousand units a month (a session is a unit per half minute) and allows a
session two minutes, which is what the Worker asks for: enough to tick a
box and have the file follow, and the pane simply closes when it is up, to
be opened again, saying why it closed (`BROWSERLESS_SESSION_MS` under
`[vars]` raises it on a paid plan). A check passed in a session that ended
does not carry over to the next, so the box may come again. A click split
across the hand-over — pressed on Cloudflare's page, released on
Browserless's — used to fail the whole batch of input and leave *'left' is
not pressed* under the page; it is let pass now, and the next click is whole. The browser is closed the moment the pane closes, so ordinary reading
stays well inside the month. When Browserless gives no browser — a bad token,
the plan's browsers all in use — the line under the page says so in
Browserless's own words, and the check stays on Cloudflare's browser. If a box keeps coming back after a tick, `BROWSERLESS_PROXY =
"residential"` under `[vars]` in the Worker's `wrangler.toml` makes the
browser leave from a home address, at extra units per megabyte. The app
repository's README, under *Through Browserless, from the Worker*, has the
rest. This build carries the wording for it; the Worker has to be redeployed
with the token for it to happen.

**With only the Worker**, the same result offers the route that needs no proxy
at all: open the paper at the publisher in a tab of your own, where your
institution's sign-in already holds, download the PDF, and drop it on the
result (or choose the file). It goes to the paper's folder in Drive and opens
here, with *PDF from your file* under the title.

## The pane, made quick

The pane from the Worker used to be slow to do anything in — a scroll,
a keystroke, a click each waited most of a second — for two reasons in the
Worker's session object. It applied each event and waited for the browser
to take it before the next, a round trip to the browser per event, from an
object far from its browser; and a frame came one a round trip, by a
poll. The Worker redeployed from the current app repository sends every
event in a batch down the wire at once and answers at once, and this build
takes the frames over one WebSocket the object pushes on the moment
something is newer, with input going back over the same socket (a Worker
deployed before that refuses the upgrade, and this build polls as before).
A scroll up, which the old bound on its size floored at nothing, scrolls
up. The object itself lives where the pane was first opened from — near
you, and far from a browser at Browserless; `BROWSER_SESSION_LOCATION =
"wnam"` under `[vars]` in the Worker's `wrangler.toml` (for Browserless's
San Francisco; `weur` for London or Amsterdam) makes a new one next to
the browser, so the only long hop left is yours. And a site that refuses
Cloudflare's browser in its own words — ResearchGate's *unusual activity
from your network* — is handed to the browser at Browserless the way
Cloudflare's check is.

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

With the client ID compiled in, the site opens on the connect screen, and
signing in with Google is the only way past it — one button, one consent
covering your name and the `drive.file` scope, and then the app. There is no
**Not now** until someone is signed in (this build is made with
`VITE_REQUIRE_SIGN_IN=true`, which `npm run build:pages` sets); signed in,
Drive can still be put off for later.

It asks once an hour at most. The sign-in is kept in this browser for as long
as the token Google issued lasts — about an hour — so a reload, or a tab closed
and reopened, comes back signed in and connected with no window at all. Nothing
here can hold a refresh token, so once that hour is up the visit starts
disconnected, and a paper added before you reconnect is one Drive never hears
about. The asking is quiet then: the grant you already gave is reused, and
Google's window opens and closes without a question.

**The proxy is compiled in.** arXiv and the publishers send no CORS headers,
so a browser cannot fetch a paper from them directly and a static site has no
server to do it. The Cloudflare Worker in the app repository's `worker/` does
it instead, deployed on the free tier with `npm run deploy:worker` to

```
https://reader-arxiv-proxy.es16btech11007.workers.dev
```

and that address is baked into this build, so nothing needs pasting into
Settings. Its `ALLOWED_ORIGINS` lists `https://saurav717.github.io`, the
origin alone, since the `/reader/` path is not part of one. Check it from a
terminal:

```bash
curl -H 'Origin: https://saurav717.github.io' https://reader-arxiv-proxy.es16btech11007.workers.dev/health
```

says `{"ok":true}`, with `Access-Control-Allow-Origin` echoing this site back.
**Settings → Paper proxy** still overrides the compiled-in address in one
browser, for pointing at a different proxy without a rebuild.

If the Worker is ever redeployed under another account, its subdomain
changes; rebuild with the new address, or paste it into Settings.

With the proxy, opening a paper shows the PDF and puts that same copy in
`My Drive/Papers_collection/<paper>/` — a folder of its own for every paper,
which the Drive button beside it in a collection opens. Without one the site
still runs: search works through OpenAlex, Crossref and Semantic Scholar, and
the reader shows abstracts, but no PDF can be fetched, so none can be read
here or saved to Drive either — Drive gets the metadata sidecar alone.

## Nobody pastes a token: signing in with Google is enough

Scholar and the browser inside the reader run on the Worker's paid accounts,
so they need to know who is asking. They used to want the Worker's
`READER_TOKEN` pasted into Settings → Paper proxy. Now signing in with Google in
the reader is enough: the app swaps the sign-in for a thirty-day pass from the
Worker and fills it in by itself. A labmate opens the site, signs in, and it
works. Anyone signed in may use it unless `READER_EMAILS` (a Worker secret:
addresses or `@domain`s) names who; one person may ask Scholar thirty times a
minute. Changing `READER_TOKEN` ends every pass. The token still works pasted,
unlimited, for the owner. Name your own Google email in `READER_OWNERS` (a Worker
secret) and, signed in, you see who uses it and how much from the chart button on the left rail.

## Keeping bots out of the sign-in

The gate on the page is only a courtesy — anyone can read a static site's
JavaScript. What stops a bot is at the Worker, where a Google sign-in is
swapped for a pass (`/auth/google`):

- **Five sign-ins a minute per IP address** (`LOGIN_LIMIT` in the app
  repository's `wrangler.toml`). The sixth gets a 429 before Google is even
  asked, and the page goes back to the sign-in screen saying to wait a minute.
- **A captcha, optional** — Cloudflare Turnstile, free. In the Cloudflare
  dashboard, **Turnstile → Add widget**, hostnames `saurav717.github.io` and
  `localhost`, mode *Managed*. Put the site key in `wrangler.toml` as
  `TURNSTILE_SITE_KEY`, then, in the app repository:

  ```bash
  npx --yes wrangler@4 secret put TURNSTILE_SECRET   # the widget's secret key
  npm run deploy:worker
  ```

  The sign-in screen then shows Turnstile's box, and the Google button waits
  until it is ticked. No rebuild of this site is needed to turn it on or off.

Both need the Worker redeployed (`npm run deploy:worker`) with the app
repository's current `wrangler.toml`; until then the Worker takes sign-ins
without either.

## Google Scholar

Scholar is the source a fresh search asks here, with a chip of its own in the
Discover panel; arXiv, OpenAlex, Semantic Scholar and Crossref are the chips
beside it, on when pressed. It publishes no API, so the proxy opens the same
pages you would — the results, a profile, an "all versions" cluster — and reads
them. That is how the app finds a thesis, a technical report or a person who
has no record in OpenAlex.

**It is on by default and it will often refuse.** Scholar blocks servers far
more readily than people, and a proxy is a server. When it answers with a
captcha the panel says exactly that and the other four sources carry on; a
refusal is never shown as "no results". A proxy on Cloudflare Workers will see
captchas most of the time — Workers run in datacentres, which is precisely what
Scholar's captcha is for. Running the proxy on a laptop or a home machine, with
`SCHOLAR_BROWSER=1 npm start` so it drives a real Chromium, is what makes it
work.

**When it refuses with a captcha, you can be shown it.** The warning in the
panel ends with **Show me the captcha**. With the proxy running on your own
machine (the `npm start` above, `http://localhost:8080` in Settings), pressing
it opens the refused Scholar page in a Chromium window on your machine, captcha
and all. Solve it there; the moment Scholar accepts the answer the window closes
on its own and the search runs again, this time through that browser. From then
on the proxy asks Scholar through that browser, whose profile is kept in
`~/.reader/scholar-profile` — delete it to go back to plain requests. The window
has to be the proxy's rather than a tab of your own, because it is the proxy
Scholar is refusing, not you. The Worker cannot show the captcha — no browser,
no screen — and the panel says so in place of the button.

**On the Worker, a Serply key gets Scholar through.** With `SERPLY_KEY` set
on the Worker, every Scholar ask goes through [Serply](https://serply.io),
whose Scholar and Google endpoints Scholar answers: a search comes from its Scholar results, and a paper's versions from the
same asked with the paper's title beside the cluster (the app sends it); people from Google's listing of
Scholar's profile pages (full name, affiliation, citations, interests) and
the bylines of their papers; a profile's works from a search for the
person's papers, kept to those linked to that profile. An entry of a profile
cannot be opened by id, so the app finds the paper by its title, as it does
when that page is refused. The h-index and i10-index are on the profile page
alone, which Scholar refuses Serply, so the hover card leaves them out. A
credit per request (2,500 free a month), cached five minutes.

Keep a `SERPAPI_KEY` beside it and each ask goes to the one that answers it
better, then to the other when that one refuses: searches, people and
versions to Serply first, a profile, a person and an entry opened to SerpApi
first (it reads the profile page exactly, h-index and all). A service out of
credits is asked last for ten minutes, so a spent SerpApi account does not
slow every ask; `/health` says `"scholar": "serply+serpapi"`. Either key is
spent only for the `READER_TOKEN` pasted into Settings.

```bash
cd reader                                        # the app repository
npx --yes wrangler@4 secret put SERPLY_KEY       # paste the key from app.serply.io
npm run deploy:worker
curl https://reader-arxiv-proxy.es16btech11007.workers.dev/health   # "scholar": "serply+serpapi"
```

A refusal of Serply's — a bad key, a spent allowance — is reported as
Serply's, so the panel does not offer a captcha window that could not help.

`node scripts/scholar-live.mjs` in the app repository says which is happening
from a given machine: Scholar refusing, or the request never reaching it.
`SERPLY_KEY=… node scripts/scholar-live.mjs --raw` asks the same through Serply.

## Removing a paper moves it to Junk in Drive

The bin on a collection row asks first. A notice names the paper, says it
leaves every collection with its highlights, and says what happens in Drive
before it happens: with Drive connected, the paper's folder is **moved to
`My Drive/Papers_collection/Junk/`** — PDF and sidecar inside it — not deleted,
so getting it back is dragging the folder up one level in Drive. Saving the
same paper again later makes a fresh folder and leaves the junked one alone.

If Drive refuses the move the paper stays in the library and the notice says
why, offering to remove the entry anyway and leave the copy in Drive where it
is. With Drive not connected the notice says the copy stays put and offers to
connect first; a paper that was never saved to Drive says so, and only the
entry goes.

It used to remove the paper at once, with no question asked, and leave its
folder in Drive behind with nothing in the library pointing at it any more.

## Every copy of a paper, and what Add to collection does

Opening a search result lists **everywhere that paper can be read** — the
publisher's copy, the preprint, each repository deposit — which is what Google
Scholar shows as "All 14 versions". The list comes from Unpaywall, OpenAlex,
Semantic Scholar and Crossref, because Scholar itself publishes no API and
blocks the datacentre IPs a proxy runs from; every result and every person
carries a link to their Scholar page instead.

**Add to collection** on a result then does the whole chain in one press: put
the paper in the collection, try each copy until one hands over a PDF, upload
that file to `My Drive/Papers_collection/<paper>/`, and open the paper here on
the copy that was just saved, read back out of Drive. The button says which
step it is on, and the reader opens once the file is in Drive.

It used to stop at the first step. Adding only put the paper in the collection
and handed Drive a background job; nothing opened, and the outcome — the PDF
saved, or only the metadata because there was no proxy, or nothing because
Drive refused — went into the sync log behind Settings and nowhere else. A
separate **Save to Drive** button did the whole chain, but it was the second
button on the result rather than the one that reads as "add this". That
button is gone; adding is the chain now, and what did not happen is said on
the result itself: *Added, but the file is not in Drive* with the copies that
were tried, or *Added, but Drive would not take it* with Google's own reason.
The paper is added and opened either way. **Read** beside it is the same add
without the wait.

Both Drive and a proxy are needed for the file to reach Drive, and until they
are there a line under the button says so, naming which half is missing and
where it is set. The list of copies right
above it can make that look like an oversight, since those links do open on a
click. They open because that is a *navigation*, which a browser allows across
origins; reading the same URL from script is a *fetch*, which it refuses. So
the page never holds the file, and there is nothing to upload until the proxy
fetches it. Drive cannot stand in: its API takes bytes, not a URL to go and
collect.

The full walkthrough, including what lands in Drive and what to check when
nothing does, is in the app repository's README.

## Reading a different copy

The first copy to hand over a PDF is not always the paper. A conference's
link is often the poster that was shown there, and a repository's can be the
slides. So each file a copy hands over is measured before it is shown. One
that looks like a poster (one or two enormous pages), slides (landscape
pages) or an abstract (a page or two) is held back while the other copies
are asked. It is shown only when none of them has anything better, with a
line saying why it may not be the paper. **Add to collection** makes the
same check, so a poster is not what gets saved to Drive.

The bar under the title says which copy is on screen. **Reading the copy at
… ▾** opens the list of every copy, each with what it answered when it was
asked. Pick one and it is fetched on its own, and the file on screen stays
until it arrives. If the copy you picked refuses, the bar says why and
offers the way round. For a sign-in, that is the browser in the pane. For
Cloudflare's "Verify you are human", which the Worker never passes, it is a
link to the copy: open it in a tab of your own (your browser passes the
check), download the PDF, and drop it on the bar.

The pick is remembered for that paper and asked first on the next open. It
also replaces the file in Drive, so a paper saved as its poster is fixed by
picking the right copy once. **Forget my pick** goes back to the ranked order.

## Changing the Browserless token

The Browserless API token is not in this site. It lives on the Worker as the
secret `BROWSERLESS_TOKEN`, and nothing here needs rebuilding when it changes.
To move the Worker to a new Browserless account, from a clone of
[saurav717/reader](https://github.com/saurav717/reader), logged in to the
Cloudflare account the Worker deploys to (`npx --yes wrangler@4 login`):

```bash
npx --yes wrangler@4 secret put BROWSERLESS_TOKEN   # paste the new token when asked
npx --yes wrangler@4 secret list                    # BROWSERLESS_TOKEN is listed; its value never is
```

`secret put` replaces the old value and the Worker picks it up at once; no
`npm run deploy:worker` is needed. To check the token on its own first:

```bash
BROWSERLESS_TOKEN=<new token> node scripts/browserless-live.mjs https://www.academia.edu/download/78156473/10.pdf
```

A bad token shows up in Browserless's words in the line under the page, and in
`lastError` on the Worker's `/browse/status`. If the new account is in a
different Browserless region, set `BROWSERLESS_URL` in `wrangler.toml` (for
example `wss://production-lon.browserless.io`) and run `npm run deploy:worker`.

## Ask Claude needs no setup here

**⌘\\** opens a Claude window over the paper. Each visitor pastes their own
Anthropic API key the first time; it stays in their browser and goes straight to
`api.anthropic.com`, so nothing is deployed for it and nobody but the visitor pays.
The Anthropic SDK is its own chunk here (the second `index-*.js`), fetched only
when a question is first sent. The app repository's README says more, under
*Ask Claude*.

## The cards over a name or a citation need no setup here

Resting the pointer on an author's name, a citation or a bibliography entry
in Reflow opens a card about the person or the cited paper. It asks
OpenAlex and Crossref straight from the page — they send CORS headers — and
asks Google Scholar for the person's profile through the Worker's
`/scholar/authors`, the same route Discover's people search uses, so there
is nothing to deploy. When Scholar will not answer, the card links to
Scholar's own search for the name instead. The app repository's README says
how the cards find their answers, under *Who wrote it, and what it cites*.

## Explain needs only the Claude key

**Explain** (E, or the button in the top bar) has Claude write the whole paper
out as a lesson: figures, Python cells with their expected output, and caveats
on what has aged since. It uses the same API key as Ask Claude, entered in the
browser, and calls `api.anthropic.com` directly, so the Worker plays no part in
it. **Run in Colab** is shown but switched off until the Colab connection is
built; **Notebook ↓** downloads the cells as an `.ipynb` for Colab meanwhile.
The bar across the top of the page takes a question or a change ("simpler",
"use PyTorch") and Claude edits just the sections concerned, with Undo — also
straight to Anthropic with that key.

With Drive connected, each explanation is also kept in the paper's own folder,
as `<paper> — explained by Claude.md`, and fetched from there when Explain is
opened in another browser, so it is not paid for twice. Nothing to set up:
it uses the same Drive grant as the PDFs and sidecars.

## Ask Claude can show you where

Ask *"show me where the paper talks about …"* and the paper scrolls to the
passage and marks it for a few seconds, with a caption saying what it is.
Nothing to set up: it runs in the page, with the same key.
