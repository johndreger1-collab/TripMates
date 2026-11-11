# Architecture — Tripmates (v3)

Target architecture after the move to the Level UP framework. Everything here
is free to build and run.

## 1. Big picture

```
Phone browser / installed PWA  (GitHub Pages, HTTPS)
  ├─ app shell: index.html, assets/, sw.js, manifest, config.js
  ├─ Google Identity Services sign-in  -> Google ID token
  ├─ Leaflet + OpenStreetMap tiles (display only)
  └─ fetch POST text/plain  ─────────────────────────────┐
                                                         ▼
Apps Script web app  (Execute as: Me, Access: Anyone)   doPost(e)
  ├─ Api.gs     parse request, verify session, route action, shape reply
  ├─ Auth.gs    verify Google ID token, issue/check session tokens, members checks
  ├─ Data.gs    the only code that touches the Sheet (unchanged internals)
  ├─ Geo.gs     Maps.newGeocoder(), Google Maps link reading
  └─ Setup.gs   schema, initSpreadsheet()
                                                         ▼
Google Sheet (owner's Drive only; no longer shared with members)
```

Navigation, live opening hours, photos and reviews: links that open Google Maps.

## 2. Free services used

| Need | Service | Cost note |
|---|---|---|
| Code hosting, history, PRs | GitHub | Free. GitHub Pages on the free plan needs a **public** repo; Pages from a private repo needs a paid plan. Nothing secret is in the repo, and the data is in the Sheet, so public is fine. |
| Front-end hosting | GitHub Pages | Free for public repos. |
| Build and deploy | GitHub Actions | Free for public repos. |
| Sign-in | Google Identity Services (OAuth client ID in a Google Cloud project) | Free; no billing account needed for sign-in only. |
| API | Apps Script web app | Free; daily quotas apply to the owner's account. |
| Database | Google Sheets | Free. |
| Geocoding, walking time | Apps Script `Maps` service | Free, no key, daily quota. |
| Map display | Leaflet + OpenStreetMap tiles | Free for light use; keep attribution; do not bulk-download tiles. |
| Apps Script from the terminal | `clasp` (npm) | Free; needs the Apps Script API switched on in the owner's Apps Script settings. |
| Coding agent | Claude Code | Owner's existing plan. |

## 3. Repository layout

Match Level UP's layout if it differs. Default:

```
tripmates/
├─ CLAUDE.md
├─ README.md
├─ docs/                    STATUS, REQUIREMENTS, ARCHITECTURE, PHASES, DECISIONS, SETUP
├─ apps-script/             clasp project (server)
│  ├─ .clasp.json           scriptId (not secret), rootDir
│  ├─ appsscript.json       manifest
│  ├─ Api.gs  Auth.gs  Data.gs  Geo.gs  Setup.gs  Tests.gs
│  └─ legacy/               old HtmlService UI, kept until cutover (R9)
├─ web/                     static PWA (client)
│  ├─ package.json  vite.config.*
│  ├─ public/  config.js  manifest.webmanifest  sw.js  icons
│  └─ src/
│     ├─ api/               fetch client, session handling, error codes
│     ├─ auth/              Google sign-in
│     ├─ map/               the only Leaflet code (RTMap API)
│     ├─ logic/             pure functions: score, blend, split, walk estimate, legs, rhythm, tally, event-day window
│     ├─ screens/           Map, List, Route, Trip, Rate, AddPlace, CheckIn, Home, Settings, PinFix
│     └─ state/             app state and sync loop
├─ shared/
│  └─ test-vectors/         JSON cases both server and client tests must pass (scores, legs, rhythm)
├─ data/seed/edinburgh.csv
└─ .github/workflows/       build + deploy web to Pages; lint/test on PRs
```

Built output goes wherever Level UP puts it (Level UP's `config.js` comment
mentions `docs/config.js`, so it may publish from a `docs/` folder). If the built
site must live in `docs/`, rename the documentation folder to `project-docs/` to
avoid a clash, and update CLAUDE.md.

## 4. Request and reply contract

Mirrors Level UP (observed in its built client):

```http
POST {API_URL}            # the Apps Script /exec URL from config.js
Content-Type: text/plain;charset=utf-8     # a "simple" request: no CORS preflight
```

```json
{ "action": "getTripData",
  "sessionToken": "…",          // or "idToken" for startSession only
  "requestId": "uuid-v4",       // client-generated, one per logical request
  "payload": { "tripId": "…" } }
```

Reply (always HTTP 200; the body says what happened):

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "NOT_MEMBER", "message": "You are not a member of this trip." } }
```

Error codes (extend as needed, keep stable): `AUTH_REQUIRED`, `AUTH_EXPIRED`,
`AUTH_INVALID`, `AUTH_UNAVAILABLE`, `NOT_MEMBER`, `NOT_OWNER`, `VALIDATION`,
`NOT_FOUND`, `STALE` (route saves), `BUSY` (lock timeout), `QUOTA`
(geocoder daily limit), `UNKNOWN_ACTION`, `SERVER`.

Map existing thrown messages to codes in `Api.gs`; keep the human-readable
message for the toast.

## 5. Sign-in and sessions

1. The web app loads Google Identity Services and gets an **ID token** (JWT)
   for the configured client ID.
2. `startSession` (payload: none, `idToken` at top level): the server verifies
   the token with Google (`https://oauth2.googleapis.com/tokeninfo?id_token=…`
   via `UrlFetchApp`, or local JWT checks), and requires:
   `aud` = our client ID (Script Property `OAUTH_CLIENT_ID`),
   `iss` = `accounts.google.com` or `https://accounts.google.com`,
   `exp` in the future, `email_verified` = true.
3. The server creates a random session token, stores `token → email` in
   `CacheService` (up to 6 h, the CacheService maximum), and returns
   `{ sessionToken, expiresAt, email }`.
4. Every other action sends `sessionToken`. `Api.gs` resolves it to an email and
   passes that email into the existing internal functions (`getPlaces_(email, …)`
   etc.). This is why the move is cheap: those functions already take the email
   as a parameter.
5. On `AUTH_EXPIRED` the client silently gets a fresh ID token and calls
   `startSession` again, then retries once.
6. ID tokens are kept in memory only (Level UP rule). The session token may be
   kept in `sessionStorage` or memory; never `localStorage`.

Who can use the app is still decided by the `Members` tab, server-side. After
cutover the Sheet is shared with nobody but the owner.

## 6. Action allow-list (Api.gs)

Only these actions exist. Each maps to an existing internal function unless
marked new.

| Action | Internal function | Access |
|---|---|---|
| `startSession` | new | anyone with a valid Google ID token |
| `whoami` | new | signed in |
| `getMyTrips` | `getMyTrips_` | signed in |
| `createTrip` | `createTrip_` | signed in |
| `updateTrip` | **new** | owner |
| `getTripData` | `getTripData_` | member |
| `getMembers` / `addMember` / `removeMember` | `getMembers_` / `addMember_` / `removeMember_` | member / owner / owner |
| `getPlaces` / `savePlace` / `updatePlace` | `getPlaces_` / `savePlace_` / `updatePlace_` | member |
| `geocodePlace` / `resolveMapsLink` | `geocodePlace_` / `resolveMapsLink_` | member of any trip |
| `getCriteria` | `getCriteria_` | member of any trip |
| `saveRating` / `getRatings` | `saveRating_` / `getRatings_` | member |
| `addCheckIn` / `getCheckIns` | `addCheckIn_` / `getCheckIns_` | member |
| `getSync` | `getSync_` | member |
| `getRoute` / `saveRouteStops` | `getRoute_` / `saveRouteStops_` | member |
| `getSeedCities` / `importSeed` / `importCsv` / `geocodeMissing` | same names + `_` | member (cities: any trip) |
| `getSettings` / `getSettingsForm` / `saveSettings` | `settingsForClient_` / `getSettingsForm_` / `saveSettings_` | any trip / any trip / owner of any trip |
| `getExactWalkingTimes` / `getTripRecap` | `getExactWalkingTimes_` / `getTripRecap_` (Phase 7) | member |
| `saveEvent` / `deleteEvent` | **new (R12)** | owner |
| (trip type, show tally) | via `updateTrip` (R12 adds the two fields) | owner |

Editor-only (never actions): `initSpreadsheet`, `loadStarterSeed`, all test and
demo functions.

## 7. Idempotent writes

Every write carries `requestId`. `Api.gs` stores `requestId → reply` in
`CacheService` for 10 minutes and returns the stored reply if the same id comes
again. This stops a retried or offline-queued check-in, tally entry or rating
from being appended twice. Reads ignore it.

## 8. Data model

Unchanged from the current `Setup.gs` `SCHEMA` (the spec's v2 model plus the
Phase 2 additions). Column order is the contract; new columns go at the end.

- **Trips:** TripID, City, StartDate, EndDate, Fixture, KickoffISO, VenueName, VenueLat, VenueLng, LodgingName, LodgingLat, LodgingLng, CreatedBy, CreatedAt
- **Members:** TripID, Email, DisplayName, Role, AddedAt
- **Places:** PlaceID, TripID, Name, Category, Area, Address, Lat, Lng, CoordSource, CoordConfirmed, GoogleMapsUrl, Source, DesireToTry, LocalTags, MatchDayTags, HoursNote, Notes, LastVerified, AddedBy, CreatedAt, UpdatedAt, City, AnchorKind
- **Ratings:** RatingID, PlaceID, TripID, UserEmail, VisitTimestamp, ScoresJSON, PersonScore, WouldReturn, PintPrice, Notes, CreatedAt
- **CheckIns:** CheckInID, TripID, UserEmail, PlaceID, Type, Value, Timestamp, Lat, Lng
- **Routes:** RouteID, TripID, RouteName, StopOrder, PlaceID, PlannedArrival, StopNote, Visited, UpdatedBy, UpdatedAt
- **Criteria:** Category, CriterionKey, Label, Weight, Active, SortOrder
- **Settings:** Key, Value
- **Seed:** City, Name, Category, Area, Lat, Lng, GoogleMapsUrl, LocalTags, MatchDayTags, HoursNote, Notes, LastVerified, VerifyFlag

Planned additions in **R12** (trailing columns and one new tab, so
`initSpreadsheet()` upgrades in place and nothing existing moves):

- **Trips** + `TripType` (Rugby / Family / General; blank = Rugby), `ShowTally`
  (TRUE / FALSE; blank = the type's default).
- **Criteria** + `TripTypes` (comma list; blank = every type). A one-off
  `upgradeCriteriaForTripTypes()` marks the Rugby-only and drink rows and adds
  the Family rows from REQUIREMENTS §4.6, only where they are missing.
- **Events** (new tab): EventID, TripID, Kind (Match / Concert / Show / Park /
  Other), Name, StartISO, EndISO, VenuePlaceID, CreatedBy, CreatedAt, UpdatedAt.
  A trip with no Events rows but a KickoffISO behaves as if it had one Match
  event (Name = Fixture, Start = KickoffISO, venue = the trip venue or a
  Stadium anchor). The upgrade does not copy it, so old and new code agree.

`getTripData` gains `events` and `trip.tripType` / `trip.showTally`; the
client filters criteria by trip type (the server checks the same rule in
`saveRating_`, so a rating can only use criteria that apply to the trip).

Planned addition (R2): Script Properties `OAUTH_CLIENT_ID` and `SHEET_ID`
(the latter only if the API runs as a standalone script).

Derived, never stored: status (Want/Been/Skipped), blended score, person
scores, split flag, drink totals, time since last drink, walking estimates.

## 9. Live sync

Unchanged design, now over `fetch`: every `RefreshSeconds` (default 20) the
client calls `getSync(tripId, sinceIso, stamp, routeStamp)`. The server always
returns new check-ins since `sinceIso` (the client asks for a minute of
overlap; ids de-duplicate), returns places and members only when the trip stamp
changed, and routes only when the route stamp changed. Polling pauses when the
page is hidden and catches up on return.

## 10. Offline (Phase R10)

- Service worker caches the app shell only (Level UP rule: never cache Google
  sign-in or API calls).
- IndexedDB keeps the last `getTripData` result per trip, so the map and list
  open with no signal (read-only, marked "offline, last updated …").
- Writes made offline (check-ins, tally, mood, ratings) go into an IndexedDB
  queue with their `requestId` and are sent in order when back online. Route
  edits and place edits stay online-only at first.

## 11. Deployments

- **Web:** GitHub Actions builds `web/` and publishes to GitHub Pages on every
  merge to `main`.
- **Apps Script:** `clasp push` uploads code; a new **version** of the web-app
  deployment makes phones use it. Keep the same deployment id so the `/exec` URL
  in `config.js` never changes. Deploys are manual and owner-approved.
- During migration the old HtmlService UI and the new API run side by side
  (see PHASES R2 for the two options and their lock caveat).

## 12. Testing

- **Pure logic** (score formula, blend, split, haversine walk estimate, leg
  splitting, rhythm warning, tally with undo, match-day window): unit tests in
  Vitest on the client, and the same cases from `shared/test-vectors/` in
  `Tests.gs` on the server.
- **Server:** existing `runPhase1Tests` … `runPhase6Tests` and the public smoke
  tests, run in the Apps Script editor; add `runApiTests` for the router, auth
  and idempotency. Optionally a Node harness with stubbed `SpreadsheetApp`,
  `CacheService` and `LockService` so Claude Code can run server logic locally.
- **Two phones:** every phase ends with a manual iPhone + Android script.
