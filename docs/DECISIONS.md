# Decision log

Newest at the bottom. One entry per decision: what, why, consequences.

---

**D1. Free only (spec v2, Oct 2026).** No Google Maps Platform APIs or keys.
Map is Leaflet + OpenStreetMap; geocoding and walking times use the Apps Script
`Maps` service; navigation, hours, photos and reviews via Google Maps links.
*Consequence:* hours are a manual note; walking times are straight-line estimates.

**D2. Data access only through `Data.gs`.** Internal functions take the
caller's email as a parameter (`getPlaces_(email, tripId)`); public wrappers
supply it. *Consequence:* tests can act as several people, and the API rewrite
only has to replace the wrappers.

**D3. Append-only ratings and check-ins; whole-route rewrite with a stale check.**
*Consequence:* two people never overwrite each other; undo is a new -1 row.

**D4. Desire to try on the add-place screen and the place card, not the rating screen** (owner, Phase 2).

**D5. Lodging, ground and stations are Anchor places with AnchorKind** (Phase 2).
Supports several lodgings and multi-city trips. Trip lodging/venue columns kept
for compatibility; trip venue still counts as a ground.

**D6. Places have a City; one trip can cover several cities** (Phase 2).

**D7. `MaxWaypoints = 9`** from spike S4 (iPhone kept 9 waypoints, 11 points).

**D8. Google Maps short links are not resolved to a pin** (spike S8). The link
is kept for View in Google Maps; the user places the pin another way.

**D9. Ratings default to "update my last rating" if it is under 12 hours old** (Phase 3).

**D10. Move to the Level UP framework (Nov 2026).** Static PWA on GitHub Pages +
Apps Script JSON API + Google Sheets, built with Claude Code from a GitHub repo.
*Why:* one way of working across projects; version control and PRs; a real PWA
(home-screen app, offline later); the Sheet no longer needs sharing with members;
an action allow-list replaces "every global function is callable".
*Cost:* a rewrite of the client (nine vanilla-JS HTML files), new sign-in setup,
a second deployment during migration. The server data layer is reused almost
unchanged.

**D11. Sign-in with Google ID token verified server-side, then a session token**
(mirrors Level UP: `startSession`, `sessionToken`, `requestId`, `{ok,data|error}`).
Deployment runs as the owner ("Execute as: Me", "Anyone").

**D12. Writes are idempotent by `requestId`** (10-minute reply cache). Needed for
retries and the R10 offline queue.

**D13. Rewrite phases use the prefix R** (R0-R11) so they do not collide with the
original Phases 0-7.

**D14. Route "Mark visited" also marks the place Been** (owner, Nov 2026).
Marking a stop visited records an ARRIVE check-in for that place (with the
phone's position if known), so the place card and pin show Been. Undoing
"visited" only clears the route flag; the ARRIVE stays, because check-ins are
append-only. If the place is already Been, no extra check-in is added.

**D15. This app has its own GitHub repo; Level UP is a style reference only.**
Claude Code copies Level UP's conventions if it can read Level UP's source;
otherwise it uses the defaults in ARCHITECTURE.md.

**D16. The app is renamed Tripmates** (owner, Nov 2026) and widened from rugby
trips to family and general travel. Repo name `tripmates`. Rugby stays the
default trip type, so nothing changes for existing trips.

**D17. Trip types select criteria by a `TripTypes` column on each Criteria row**
(blank = every type) rather than separate copies per type. *Why:* shared rows
(value, service, ambiance) stay single and editable once; scores are stored by
key, so changing a trip's type never breaks old ratings. Family trips hide the
drink tally and food nudge by default (`Trips.ShowTally` overrides).

**D18. Match-day mode becomes event-day mode with an Events tab** (several
events per trip). Old column and setting names (`KickoffISO`, `Fixture`,
`MatchDayTags`, `MatchDayWindow…`) are kept and relabelled; a trip with no
Events rows treats its kickoff as one Match event, so no data migration is
needed. Built in R12, after cutover, so it cannot put the March trip at risk.

---

*Add entries below as Phase R0 records Level UP's conventions (language, folder
layout, lint, tests, service worker, deploy).*

**D19. R0 tooling: clasp 3, plain JavaScript, `.js` files, docs' default layout**
(Nov 2026). Level UP's source was not available, so the defaults in
ARCHITECTURE.md stand (D15). `clasp` 3.4.1, run with `npx @google/clasp`, no
global install. clasp 3 saves server files as `.js`; the Apps Script editor
still shows them as `.gs`, so `Data.gs` in the docs is `apps-script/Data.js`
on disk. Server code stays plain JavaScript (V8), not TypeScript. The live
project's manifest is unchanged (`executeAs: USER_ACCESSING`) until R2.
*Why:* clasp's default extension needs no config, and a byte-for-byte baseline
keeps the first diff honest.

**D20. Route "Suggest order" already exists** (found in R0). Phase 7 built a
nearest-neighbour + 2-opt reorder in `Route.html` (straight-line distances,
visited stops stay put, nothing changes until Apply). R11's "route
auto-optimisation" therefore means porting it, not designing it.
