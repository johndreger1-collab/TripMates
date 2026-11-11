# Status — Tripmates (formerly Rugby Trip Companion)

*Last updated: 11 November 2026, Phase R0 (live code pulled with `clasp clone`
and committed as a baseline; defects 1-5 and 10 fixed). Update this file at the
end of every phase.

## One-line summary

The original Apps Script app is **feature-complete through Phase 7 (v1.1)**,
every file passes a syntax check, and the owner has tested Phases 0-7 on phones.
A handful of small defects are listed below. The next trip is in **early March
2027**, so there is time to migrate first; the old app stays as the fallback.
R0 put the live code in GitHub (`apps-script/`). Next: finish R0 (owner pushes
the fixes and runs the editor tests, see below), then Phase R1.

## Repository

`https://github.com/johndreger1-collab/TripMates` (public, default branch
`main`). GitHub Pages will serve it at
`https://johndreger1-collab.github.io/TripMates/`; the path is case-sensitive.

## Where the live app lives

One Google spreadsheet in the owner's Drive is both the database and the home of
the code: the Apps Script project is **bound to it** (Extensions → Apps Script).
`clasp clone <Script ID>` in R0 pulls that bound project. The spreadsheet URL is
deliberately not recorded in this public repo.

Manifest: V8, time zone Europe/London, web app `executeAs: USER_ACCESSING`,
`access: ANYONE`.

Files (19; in `apps-script/` the `.gs` files are saved as `.js`, see D19): `appsscript.json`, `Code.gs`, `Setup.gs`, `Auth.gs`, `Data.gs`,
`Geo.gs`, `Tests.gs`, `Index.html`, `Styles.html`, `Map.html`, `Client.html`,
`AddPlace.html`, `Rate.html`, `Live.html`, `Route.html`, `Home.html`,
`Tools.html`, `Extras.html`, `Phase1Check.html`.

## Phase by phase (original build)

| Phase | What | Code | Tested | Notes |
|---|---|---|---|---|
| 0 | Spike S1-S8 | Retired | Yes, on phones | See results below |
| 1 | Data layer, tabs, Members checks | Done | Yes: editor tests, smoke test, two real accounts | |
| 2 | Map, list, filters, card, add place (3 ways), status | Done | Yes, on phones | |
| 3 | Ratings, Skip, blend, split flag, Mine/Mate/Both | Done | Yes, on phones (owner, Nov 2026) | |
| 4 | Nearby, live sync, check-in, tally, mood | Done | Yes, on phones (owner, Nov 2026) | |
| 5 | Route builder, stale-save retry, legs, rhythm warning | Done | Yes, on phones (owner, Nov 2026). Confirm that S6 (two phones editing one route at once) was part of it | |
| 6 | Get me home (floating button), match day, seed/CSV import, pins to review, members, settings | Done and wired in | Yes, on phones (owner, Nov 2026) | The `?page=phase1` member workaround has gone from the Trip tab |
| 7 | Google Maps search shortcuts (`Extras.html`, `#find`), trip recap (`getTripRecap`), food nudge + wind-down (`Live.html`, `#nudgebar`, `PacingEnabled`), exact walking times for route legs (`getExactWalkingTimes`, `Maps.newDirectionFinder`), route "Suggest order" (nearest neighbour + 2-opt, `Route.html`) | Done | Yes, on phones (owner, Nov 2026). Confirm "Suggest order" was included | Styles fixed in R0 (defect 1) |

Not built: offline use, editing a trip after
creation (`updateTrip`).

### Phase 0 spike results (recorded)

- **S1 location:** pass on iPhone Safari. Android not tested.
- **S2 identity:** pass for both accounts (second account confirmed in Phase 1).
- **S3 Leaflet map:** pass.
- **S4 directions link:** pass. Google Maps keeps 9 waypoints (11 points); split at 9.
- **S5 geocoding and walking time:** pass, 5/5 pins right; straight-line estimates run about 11% low.
- **S6 two phones writing at once:** deferred to Phase 5; covered by the owner's Phase 5 phone tests (to confirm).
- **S7 polling:** pass; a remote write was seen in about 7 s.
- **S8 links:** view and search-nearby pass; full-link resolve passes; short links fail by design.

## Decisions already made (details in DECISIONS.md)

- v2 spec: free only. Leaflet + OpenStreetMap, no Google Maps Platform APIs.
- "Desire to try" (1-4) is set on the add-place screen and the place card, not the rating screen.
- Ratings are append-only; "Update my last rating" reuses the last VisitTimestamp.
- Lodging, the ground and stations are `Anchor` places with an `AnchorKind`.
- One trip can span several cities (`Places.City`).
- `MaxWaypoints=9`.
- Google Maps short links are kept for "View in Google Maps" but not resolved to a pin.
- The food nudge is per phone: each person's own tally since their last food entry.
- Renamed **Tripmates**; adding Family / General trip types and event-day mode in R12 (D16-D18).
- Route "Mark visited" also marks the place Been (D14).

## Defects found in the live scripts (11 Nov 2026)

All small. Re-checked against the cloned code in R0: every item below is
confirmed. **1-5 and 10 are fixed in R0** (in git; live once the owner runs
`clasp push`). 6-9 carry into the rewrite; 11 is new.

1. *(Fixed in R0.)* **Phase 7 styles are placeholders.** `Styles.html` contains literally
   `.nudgebar { ... }`, `.nudgebar .btn-row { ... }` and `.homefab.wind { ... }`
   (probably pasted from a chat summary). The food-nudge banner and the
   wind-down Get me home highlight are therefore unstyled.
2. *(Fixed in R0.)* **Duplicate element IDs in `Index.html`:** `#matchbar` (twice), `#btn-home`
   (twice), and `#home`, `#pinfix`, `#settings` (twice each). The code only finds
   the first of each, so it works, but delete the second copies.
3. *(Fixed in R0.)* **`Styles.html` has a stray second `</style>`** and a repeated
   `.appbar .btn` rule. Harmless.
4. *(Fixed in R0.)* **`Auth.gs` holds two copies of itself** (joined at `}/**`). The second copy
   wins, and it is the complete one (it has `requireAnyTrip_`). Delete the first.
5. *(Fixed in R0; the three copies were identical.)* **`Tests.gs` has the Phase 5 test block three times** (`runPhase5Tests`,
   `runPhase5PublicSmokeTest` and their helpers). The last copy wins. Delete two.
6. **Every global function is callable from the browser**, including test and
   demo functions (`runPhase6Tests` temporarily edits Settings; `createDemoTrip`).
   Quick fix in the old app: delete `Tests.gs` from the deployed project before a
   trip. The rewrite fixes it properly with an action allow-list.
7. **Members can open and edit the Sheet directly** (a consequence of
   "Execute as: User accessing"). The rewrite fixes this.
8. **No `updateTrip`.** City, dates, fixture and kickoff cannot be changed after creation.
9. **Route "Mark visited" does not record an ARRIVE check-in**, so the place does
   not become Been. Owner decided it should (D14); build it in R7.
10. *(Fixed in R0.)* `Code.gs` header comment is out of date (still describes Phase 1).
11. **Stray text on the map screen** (found in R0, not fixed: outside the agreed
    list). `Index.html` has the literal text `+ Add place:` just before the
    "Search Google Maps" button, so it probably shows on the map. Delete the
    text in R0b or carry into the rewrite (R4 replaces this screen).

Fixed since the 8 October snapshots: Phase 6 is wired in; Get me home is a
floating button; `cleanupTestData_` now deletes `Routes` rows.

## Open items (owner to answer)

1. ~~When is the next trip?~~ **Early March 2027.** Migrate first; keep the old
   app deployed and working as a fallback until R9 passes.
2. ~~Phone tests for Phases 4-7?~~ **Done** (owner). Confirm S6 was included.
3. Lodging for the March trip (needed for Get me home).
4. Fixture and kickoff time.
5. ~~Should route "Mark visited" also mark the place Been?~~ **Yes** (D14).
6. ~~Level UP source~~ This app gets **its own new repo** (owner will create it).
   Level UP is a separate app, used only as a style reference. If Claude Code
   can read Level UP's source folder, it copies the conventions; if not, it uses
   the defaults in ARCHITECTURE.md. Nothing waits on this.
7. The Android phone test is still outstanding for S1 (location), unless the
   Phase 4-7 tests covered an Android phone.

## Next phase and schedule

**R0: Repository baseline: code done, owner steps left.**

Done (11 Nov 2026): `apps-script/` holds the live project exactly as cloned
(commit "Baseline: live Apps Script project…"); defects 1-5 and 10 are fixed
in a separate commit; every server file and every inline `<script>` passes a
syntax check; the new styles were checked in a browser, light and dark.

Owner steps to finish R0:
1. Approve `clasp push` (Claude Code asks first). This changes the code in the
   editor but not what the phones run, until a new deployment version.
2. In the editor, run `runPhase1Tests` … `runPhase7Tests` and the
   `…PublicSmokeTest` / `runPhase2LiveChecks` functions. All must pass.
3. When happy, Deploy → Manage deployments → edit → New version, and check the
   food nudge (`PacingEnabled=true`) and wind-down on one phone.

Then **R1** (spike: sign-in, API, PWA on both phones). Skip R0b; the old app is
tested and is the fallback.

Suggested schedule for an early-March trip (about 16 weeks):

| By | Phases |
|---|---|
| end of November | R0 baseline, R1 spike (sign-in, PWA, polling on both phones) |
| mid December | R2 API layer, R3 web shell and deploy pipeline |
| end of January | R4 map and list, R5 ratings, R6 live sync, R7 routes |
| mid February | R8 trip tools, R11 Phase 7 extras, **R9 cutover and acceptance on two phones** |
| late February | Verify the seed list for the trip city, load the trip, freeze changes |

R12 (trip types and event-day mode for family travel) comes after R9; do it
in March after the trip if February is tight.

If R9 has not passed by mid February, use the old app for the trip and finish
afterwards. R10 (offline) is optional before March.
