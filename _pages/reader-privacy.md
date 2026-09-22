---
permalink: /reader/privacy/
title: "Reader — Privacy Policy"
excerpt: "What the paper reader at /reader/ does with your data, and what it never sees."
modified: 2026-09-22
---

{% include base_path %}

*Last updated: 22 September 2026. This policy covers the paper reader at
[saurav717.github.io/reader/]({{ base_path }}/reader/) — "the app" below — and
nothing else on this site.*

## The short version

The app is a static web page. There is no server behind it, no account to make
and no database anywhere holding your library. Your papers, highlights and
settings are stored by your own browser, on your own device. If you connect
Google Drive, the app writes copies into *your* Drive — and no one else,
myself included, can see any of it.

## What the app stores, and where

**In this browser.** The papers you collect, your highlights and notes, your
reading progress and your settings are kept in the browser's own storage
(IndexedDB and `localStorage`) on the device you are using. They are not synced
anywhere by default and they are not sent to me. Clearing this site's data in
your browser deletes all of it.

**In your Google Drive, only if you connect it.** Each paper you add is saved
as a PDF plus a JSON file of its details and your highlights, under
`My Drive/Paper Reader/<collection>/`. These are ordinary files in your own
Drive: you can read, move or delete them yourself at any time, and deleting
them there does not need this app.

**In a Git repository, only if you configure one.** The app can optionally
mirror your notes and bibliography to a repository you name, using a token you
supply. The token is stored in this browser like every other setting and is
sent only to GitHub.

## What the app receives from Google

Signing in is optional; the app works without it. There are two separate
consents, asked at different times:

| Consent | Scopes | What the app does with it |
| --- | --- | --- |
| Sign in | `openid`, `email`, `profile` | Shows your name, email address and profile picture in the interface, so you can see which account is connected. Held in memory for the session only. |
| Connect Drive | `drive.file` | Creates and reads back **only the files the app itself created** — the PDFs and JSON sidecars above. This scope gives no access to anything else in your Drive. |

Access tokens live in the page's memory and are gone when the tab closes. The
app has no backend, so it cannot hold a refresh token and cannot act on your
account when you are not using it. **Sign out** revokes the token; you can also
withdraw access at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

**Limited Use.** The app's use and transfer of information received from Google
APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Google user data is used only to
provide the features described above. It is never sold, never used for
advertising, never used to train any model, and never transferred to anyone
except as needed to provide those features or as required by law.

## What the app sends elsewhere

Searching and opening papers means talking to the places papers live. Your
search terms and the identifiers of papers you open are sent to whichever of
these answers the request:

- arXiv, OpenAlex, Semantic Scholar, Crossref and Unpaywall, for search results
  and metadata;
- Google (`accounts.google.com`, `googleapis.com`), for sign-in and Drive;
- Google Fonts, for the typefaces the page uses;
- a PDF proxy, **only if you configure one** in Settings — the fetching of a
  paper's file is passed through it because publishers' servers refuse a
  browser directly;
- GitHub, only if you configure the mirror above.

Each of these has its own privacy policy and I have no control over what they
log. Beyond those requests, the app sends nothing anywhere. It carries no
analytics, no advertising and no third-party trackers of any kind, and it sets
no cookies.

## Deleting your data

- **From this browser:** clear site data for `saurav717.github.io`, or use the
  app's own controls to remove papers and highlights.
- **From Drive:** delete the `Paper Reader` folder; nothing in the app is
  needed to do it.
- **The connection itself:** revoke it at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

There is nothing on my side to delete, because nothing about your use of the
app reaches me.

## Children

The app is not directed at children under 13 and collects nothing from anyone
knowingly.

## Changes

If this policy changes, the date at the top changes with it, and the history of
every edit is public in the
[repository for this site](https://github.com/saurav717/saurav717.github.io).

## Contact

Questions about this policy, or about the app's use of Google user data:
**es16btech11007@gmail.com**.
