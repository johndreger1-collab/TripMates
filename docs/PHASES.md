# Build Phases — Tripmates (migration to the Level UP framework)

Give Claude Code one phase at a time: **"Do Phase Rn. Follow CLAUDE.md."**
Each phase: list files and assumptions first, build, run checks, give two-phone
test steps, update `docs/STATUS.md`, open a PR.

The original Phases 0-7 are recorded in STATUS.md. The phases below are new and
use the prefix **R** (rewrite) so the two numbering schemes never mix.

```
R0  Repo baseline ──► R0b (optional) tidy and phone-test the old app for an imminent trip
 │
R1  Spike: sign-in + API + PWA on both phones
 │
R2  API layer in Apps Script (old UI keeps working)
 │
R3  Web shell: sign-in, trip picker, deploy pipeline
 │
R4  Map, list, place card, add place
R5  Ratings
R6  Live sync, nearby, check-ins, tally, mood
R7  Route builder
R8  Trip tools: Get me home, event day (match day), imports, pins, members, settings, edit trip
 │
R9  Cutover + MVP acceptance on two phones
 │
R10 Offline (PWA data cache and write queue)
R11 Port Phase 7 extras, then route auto-optimisation
 │
R12 Trip types (Rugby / Family / General) and event-day mode with several events
```

---

## R0 — Repository baseline

**Goal:** the live Apps Script code is in GitHub, unchanged, so every later change
is a reviewable diff.

Build:
- Create the repo (public, see ARCHITECTURE §2) with the layout in ARCHITECTURE §3.
- `clasp login`, then `clasp clone <scriptId>` into `apps-script/`. Commit as-is:
  "Baseline: live Apps Script project as of <date>".
- Add these docs, `data/seed/edinburgh.csv`, `.gitignore` (node_modules, build
  output, `.clasprc.json`), and a short README.
- If the owner provides the Level UP source folder, read it, record every
  convention adopted from it in `docs/DECISIONS.md`, and adjust CLAUDE.md
  commands and ARCHITECTURE §3 to match. If not, keep the defaults.
- Re-check every item in STATUS.md "Defects found in the live scripts" against the live code and
  correct STATUS.md.
- Fix only the trivial, no-behaviour-change items if the owner agrees (STATUS
  defects 2-5 and 10). `clasp push`, run all `runPhase*Tests` in the
  editor, all must pass.

Out of scope: any feature or UI change.

Done when: repo exists; `apps-script/` matches the live project; all editor test
suites pass; STATUS.md is corrected; tooling choices are recorded in DECISIONS.md.

---

## R0b — (Optional) Make the old app trip-ready

Do this only if a real trip is close (owner decides; STATUS open item 1). The
old app is already feature-complete through Phase 7; this phase only tidies and
tests it.

Build: fix STATUS defects 1-5 (write real `.nudgebar`, `.nudgebar .btn-row` and
`.homefab.wind` styles in keeping with `.matchbar` and `.homefab`; remove the
duplicate IDs, the stray `</style>`, the first `Auth.gs` copy and two of the
three Phase 5 test blocks); update the `Code.gs` comment. Run every
`runPhase*Tests` in the editor. Then remove `Tests.gs` from the project before
deploying the trip version (keep it in git).

Done when: two-phone scripts for Phases 4-7 pass (live sync, Nearby, check-ins,
tally and undo, two phones editing one route at once (S6), Get me home, match
day with a kickoff set to now, imports, pin review, members, settings, food
nudge with `PacingEnabled=true`, search shortcuts, recap, exact walking times),
and the REQUIREMENTS §13 acceptance criteria pass on the old app.

---

## R1 — Spike: new hosting and sign-in

**Goal:** prove the risky parts before building on them. Throwaway code in
`spike/` (or a branch), modelled on Level UP's `test/` page.

Tests (record pass/fail and numbers in STATUS.md):

| # | Test | Pass condition |
|---|---|---|
| S9 | Google sign-in on GitHub Pages, both phones, in the browser **and** installed to the home screen | ID token received; email shown |
| S10 | `startSession` verifies the ID token in Apps Script (Execute as Me, Anyone) | Correct email back; a token for another client ID is refused |
| S11 | Round trip: `fetch` POST `text/plain` to `/exec` from Pages | Works on both phones; median latency recorded |
| S12 | Old UI and new API side by side | Confirm whether one script project can have two deployments with different "Execute as" settings. If not, plan a standalone API script that opens the Sheet by `SHEET_ID` |
| S13 | Geolocation on GitHub Pages, both phones, browser and home-screen app | Coordinates returned (closes the open Android S1 item) |
| S14 | Leaflet + OSM tiles from npm bundle on mobile data | Usable within ~3 s with 30 pins |
| S15 | Polling every 20 s through `fetch` for 10 minutes on both phones | Each sees the other's check-in within ~30 s; no auth errors |

Done when: S9-S15 recorded. If S9 or S13 fail on iPhone home-screen mode,
record the workaround (e.g., use in Safari, not installed) before R3.

---

## R2 — API layer (server only)

**Goal:** the existing data layer is reachable over `doPost` with verified
identity, without breaking the old UI.

Build:
- `Api.gs`: `doPost(e)` parses JSON, checks `action` against the allow-list
  (ARCHITECTURE §6), resolves the session, calls the internal function, maps
  errors to codes, returns `ContentService` JSON. `requestId` idempotency for
  writes (ARCHITECTURE §7).
- `Auth.gs`: `verifyIdToken_`, `startSession_`, `sessionEmail_`; keep
  `requireMember_`, `requireOwner_`, `requireAnyTrip_`. `currentEmail_()` stays
  for the legacy UI only.
- Script Properties: `OAUTH_CLIENT_ID` (and `SHEET_ID` if standalone).
- `updateTrip_` (owner only): city, dates, fixture, kickoff. Validation as in `createTrip_`.
- `Tests.gs`: `runApiTests()` covering: unknown action, missing/expired/forged
  session, member vs outsider for every trip-scoped action, owner-only actions,
  idempotent replay returns the same reply and appends one row, error-code
  mapping, `updateTrip_`.
- Deployment per the S12 result. The old `doGet` UI keeps working.

Caveat if the API is a separate script: `LockService.getScriptLock()` is per
script, so the two UIs do not lock against each other. Do not write from both
at the same time during migration.

Done when: all old suites plus `runApiTests` pass; the R1 spike page (or curl)
can call `getMyTrips` and `getTripData` with a real session.

---

## R3 — Web shell and deploy pipeline

**Goal:** an installable app on GitHub Pages that signs in and lists trips.

Build (match Level UP's tooling):
- `web/` with Vite (+ React if Level UP uses it), lint, format, Vitest.
- `public/config.js` (`GOOGLE_CLIENT_ID`, `API_URL`), manifest, icons, `sw.js`
  caching the app shell only.
- `src/api`: request builder (`action`, `sessionToken`, `requestId`, `payload`),
  error-code handling, one silent re-auth retry, loading counter, toasts.
- Sign-in screen, trip picker, "Start a new trip" form, bottom nav
  (Map | List | Route | Trip) with placeholder screens.
- GitHub Actions: test + build on PRs; deploy to Pages on `main`.

Done when: both phones can open the Pages URL, install it, sign in, see their
trips, and create a trip that shows up in the Sheet.

---

## R4 — Map, list, place card, add place

Port Phase 2 behaviour (REQUIREMENTS §7.1-7.3, 7.5):
- `src/map/`: the RTMap API (`create`, `setPins`, `setMe`, `fit`, `flyTo`,
  `onTap`, `setDraft`, `clearDraft`, `setRoute`, `invalidate`, `destroy`).
- Pins: grey/red/amber/light green/dark green with the number; anchors square
  with a letter (H/G/T/A); unrated shows mean desire-to-try or "–".
- Category chips, city picker, list sort (score, distance, status, name).
- Place card: scores, desire-to-try picker, ~walk, hours warning, tags, notes,
  source, unconfirmed-pin warning, Go, View in Google Maps, Mark Been (two taps),
  Skip, Show on map.
- Add place: search (geocode + draggable pin + confirm), tap the map, paste a
  Google Maps link; category, anchor kind, tags, hours note, notes, desire.
- `src/logic` unit tests: haversine walk estimate, tone thresholds, pin text.

Done when: both phones show the same places and pins as the old app for the
same trip; all three add methods work.

---

## R5 — Ratings

Port Phase 3: form built from `criteria` in `getTripData`; Poor/OK/Good/Great
plus Skip (a new visit starts all on Skip; "update" starts from your last
rating); live score; Would return; pint price (pubs only, in
`Currency`); notes; "Update my last rating" vs "Log a new visit" (default update
if the last rating is under 12 h old); ratings list on the card with earlier
visits; Mine / Mate's / Both (Mine / Others / All for 3+).

Client score uses the same test vectors as `computeScore_`.

Done when: Phase 3 two-phone script passes in the new app; a skipped criterion
does not change the score; a 30-point gap shows the split flag.

---

## R6 — Live sync, Nearby, check-ins, tally, mood

Port Phase 4: sync loop (pause when hidden, minute overlap, stamps), Nearby chip
with ~5/~10/~15 min, position refresh while Nearby is on, check-in screen
(nearest first, ARRIVE, Leave), Tonight card (+Pint, +Whisky, +Other drink,
+Food, Undo last, counts from 5 am), mood chips, the group summary, recent
activity feed.

Done when: a check-in or new place on phone A appears on phone B within ~30 s;
tally undo works; Nearby filters correctly.

---

## R7 — Route builder

Port Phase 5: several named routes, add from the card, up/down reorder,
mark visited (also records ARRIVE so the place becomes Been, D14), remove, delete
route (two taps), save queue with `baseUpdatedAt` and up to 3 stale retries,
~walking times per leg and total, rhythm warning for 3+ drink stops in a row,
dashed straight-line polyline, numbered pins with the next stop highlighted,
Google Maps legs split at `MaxWaypoints`.

Done when: two phones editing one route at the same time lose nothing (this is
spike S6, finally run); legs open correctly in Google Maps with 12+ stops.

---

## R8 — Trip tools

Port Phase 6 (and wire what the old app never wired):
- **Get me home** floating button on every trip screen: nearest pinned lodging
  (or the selected one), ~walk, walk and transit links, nearest station.
- **Event day (match day):** build the logic over a *list* of events, so R12 only
  adds more of them. Until R12 the list is the trip's single kickoff, and the
  screen looks exactly like today's match-day mode. Banner with countdown, Near the ground (~15 min of a stadium
  anchor or the trip venue), Easy to get in, highlighted tags, full hours note.
- **Add places in bulk:** starter list (Seed) and CSV (file or paste), with the
  result summary and rejected lines.
- **Pins to review** with the pin checker and Find missing pins (repeats while
  progress is made).
- **Members:** owner adds (no more "share the Sheet" step after R9) and removes.
- **Settings** form (owner) and **Edit trip** (owner, uses `updateTrip`).

Done when: Phase 6 two-phone script passes in the new app.

---

## R9 — Cutover and MVP acceptance

- Run every REQUIREMENTS §13 acceptance criterion on two phones in the new app.
- Switch to the API deployment for good; retire the HtmlService UI (`doGet`
  returns a short "moved to <Pages URL>" page) and `Phase1Check.html`.
- Remove members' access to the Sheet; only the owner keeps it.
- Confirm a non-member Google account gets `NOT_MEMBER` for every trip action.

Done when: all acceptance criteria pass; STATUS.md says "MVP live".

---

## R10 — Offline

ARCHITECTURE §10: last trip data cached in IndexedDB; map and list open
read-only with no signal; check-ins, tally, mood and ratings queued offline and
sent in order (idempotent by `requestId`); clear "offline" and "n waiting to
send" indicators.

Done when: airplane mode → log two pints and a check-in → back online → both
phones show exactly one of each.

---

## R11 — Port the Phase 7 extras

These exist in the old app (`Extras.html`, `Live.html` pacing code,
`getExactWalkingTimes_`, `getTripRecap_`) and need porting to the new client:
"Search in Google Maps" shortcuts centred on you; trip recap on the Trip tab;
food nudge banner and wind-down ranking behind `PacingEnabled`; exact walking
times for route legs. Add the `getExactWalkingTimes` and `getTripRecap` actions.
One PR per feature. Then, as new work: the route auto-optimisation suggestion.

---

## R12 — Trip types and event-day mode

**Goal:** Tripmates works as well for a family holiday as for a rugby weekend.
Specification: REQUIREMENTS §4.6 and §8; data: ARCHITECTURE §8.

Build:
- Schema upgrade (trailing columns, new Events tab) in `Setup.gs`; one-off
  `upgradeCriteriaForTripTypes()` run from the editor (adds rows only where
  missing, never overwrites an edited row).
- `updateTrip` accepts `tripType` and `showTally`; `createTrip` asks for the type
  (default Rugby). `saveEvent` / `deleteEvent` (owner) with validation: kind from
  the list, name ≤ 120, valid ISO start, end after start, venue must be a place in
  the trip.
- `criteriaFor_` filters by trip type; `saveRating_` rejects criteria that do
  not apply to the trip; `getTripData` returns `events`, `tripType`, `showTally`.
- Client: trip type on the new-trip form and Edit trip; Events card on the Trip
  tab; event-day logic reads every event (the R8 code, now with real data);
  wording by event kind; Family defaults (tally and food nudge hidden unless
  switched on; default chips); Family tags added to the Settings lists.
- Tests (server and client test vectors): type filtering, the fallback single
  Match event from KickoffISO, overlapping events, end-time windows, a type
  change keeping old scores, outsiders and non-owners refused.

Done when: REQUIREMENTS §13.1 passes on two phones, and a Rugby trip with one
kickoff looks and behaves exactly as before.

Timing: after R9 (and after the March trip if time is short). It does not block
the rugby trip.
