# CLAUDE.md — Tripmates

Standing instructions for Claude Code in this repository. Read this file, then
`docs/STATUS.md`, before doing anything else in a session.

## What this is

**Tripmates** (formerly Rugby Trip Companion): a mobile-first app for small
groups who travel together, from rugby weekends with friends to family holidays.
A shared list of places per trip, a map with score-coloured pins, independent 1-4 ratings blended into a
score, a nearby view, a route (crawl) builder, check-ins and a drink tally, and a
one-tap "Get me home". Navigation, live hours, photos and reviews are handed to
Google Maps by link. Rugby is the default trip type; Family and General
trip types and event-day mode arrive in R12. Keep column, setting and function
names that say "match day" or "kickoff" as they are (compatibility); change only
what the user sees.

The app already exists as an Apps Script `HtmlService` web app, feature-complete
through Phase 7 of the original build. This repository moves it to the same framework as the owner's
**Level UP** project: a static PWA on GitHub Pages talking to an Apps Script JSON
API, with Google Sheets as the database. See `docs/ARCHITECTURE.md`.

## Documents (source of truth, in this order)

1. `docs/STATUS.md` — where things stand right now. Update it at the end of every phase.
2. `docs/REQUIREMENTS.md` — what the app must do (v3).
3. `docs/ARCHITECTURE.md` — how it is built: hosting, auth, API contract, data model.
4. `docs/PHASES.md` — the build plan, one phase at a time, with acceptance checks.
5. `docs/DECISIONS.md` — why things are the way they are. Add an entry for every new decision.
6. `docs/SETUP.md` — one-time accounts and tooling (all free).

If a document and the code disagree, say so, and ask before changing either.

## Level UP is a style reference

Level UP is a separate app by the same owner, built on this framework. It is a
style reference only; this app has its own repo. If the owner gives you Level
UP's **source** folder (not its built site on GitHub Pages), copy its
conventions: folder layout, language (JS or TS), lint and format config, API
client, sign-in flow, service worker, `config.js`, build and deploy scripts.
Record each in `docs/DECISIONS.md`. If it is not available, use the defaults in
`docs/ARCHITECTURE.md` and do not wait for it.

## Hard constraints

- **Free only.** No paid service, no API that needs a billing account or card, no
  Google Maps Platform keys (Maps JS, Places, Routes). If something seems to need
  one, stop and propose a free alternative.
- **Scale:** 2 users now, 10 at most. Do not add a database server, a backend
  framework or a state-management library unless Level UP already uses it.
- **Data stays in Google Sheets**, reached only through the data layer
  (`apps-script/Data.gs`). The web client never touches the Sheet.
- **Every server write** holds `LockService.getScriptLock()` in try/finally.
- **Ratings, check-ins and route stops are append-only or per-user.** Two people
  must never overwrite each other. Routes use the `baseUpdatedAt` stale check.
- **Every API action** verifies the caller's identity server-side and checks trip
  membership (or ownership) before touching data. Never trust an email, trip id
  or role sent by the client.
- **No secrets in the repo.** The OAuth client ID and the `/exec` URL are public
  by design and live in `web/public/config.js`. Anything secret goes in Apps
  Script Script Properties.

## UI rules

- Tap targets at least 48 px, one-handed use, readable in a dim pub and in sun glare.
- Never colour alone: every pin and badge shows its number or letter.
- Every estimate (distance, walking time) is shown with `~`.
- Visible errors (toast) and visible loading states. A server call takes 1-3 s.
- Keep all Leaflet code behind one small map module (today's `RTMap` API), so the
  map library can be swapped.

## How to work a phase

When the owner says "Do Phase Rn":

1. Read `docs/STATUS.md` and the phase in `docs/PHASES.md`.
2. Before writing code, list the files you will create or change and every
   assumption. Ask about anything ambiguous. Wait for a go-ahead if the owner is
   present.
3. Build only that phase. If something seems missing, list it at the end instead
   of building it.
4. Run every automated check you can (lint, unit tests, build). Apps Script
   functions that need Google services cannot run locally; say which ones the
   owner must run in the editor.
5. Give the owner manual test steps for **two phones** (iPhone Safari and Android
   Chrome), plus any quota or cost note.
6. Update `docs/STATUS.md` (and `docs/DECISIONS.md` if anything was decided).
7. Commit on a branch named `phase-rn-short-name`, open a PR to `main`. Do not
   push to `main` directly and do not run `clasp deploy` without asking.

## Commands (adjust to match Level UP once R0 is done)

```bash
# web client
cd web && npm install
npm run dev          # local dev server
npm run build        # production build (output deployed to GitHub Pages)
npm test             # unit tests (Vitest)

# Apps Script
cd apps-script
npx clasp pull       # fetch the live project (do this before editing)
npx clasp push       # upload local files to the Apps Script project
npx clasp deployments
# Deploying a new version changes what the phones run: ask first.
```

## Things that have bitten this project before

- Text starting with `= + - @` becomes a formula in Sheets. `sheetSafe_` and
  `normCell_` in `Data.gs` handle it; keep using them.
- Dates in Sheets cells turn into `Date` objects; text columns are formatted `@`
  by `initSpreadsheet()`. `google.script.run` cannot return `Date`s; JSON from
  `doPost` cannot either, so keep returning ISO strings.
- Google Maps short links (`maps.app.goo.gl`) usually carry no coordinates. Keep
  the link for "View in Google Maps" and ask for a pin another way.
- Google Maps hand-off keeps 9 waypoints (11 points) on iPhone. Split routes at
  `MaxWaypoints` (default 9).
- Apps Script web apps cannot answer a CORS preflight. The client must POST with
  `Content-Type: text/plain;charset=utf-8` and `redirect: 'follow'`.
- A new Apps Script deployment version is needed before phones see server
  changes. GitHub Pages can take a minute or two to publish.
