# Tripmates — Requirements (v3)

**v3 changes from v2:** the front end moves to a static PWA on GitHub Pages
using the Level UP framework; Apps Script becomes a JSON API; sign-in is Google
Identity Services with server-side token checks; the Sheet is no longer shared
with members; the app is renamed **Tripmates** and widened from rugby trips to
family and general travel, with trip types and event-day mode (§4.6, §8;
built in Phase R12). Decisions taken during Phases 0-7 are folded in (marked *[decided]*).
Everything is still free. Hosting, auth and API details are in ARCHITECTURE.md;
the build order is in PHASES.md.

---

## 0. Context

**Tripmates** is a mobile-first app for small groups who travel together: me
and friends on rugby trips, and my family on holidays and days out. On a rugby
trip we go to a city for a match, then walk between pubs, restaurants,
grab-and-go food, whisky and cocktail bars, tastings and sights. On a family
trip it is restaurants, sights, activities and food stops, maybe around a show,
a concert or a theme-park day. The app must:

1. Hold a shared list of candidate places per trip.
2. Show them on a simple map, with pins coloured by our blended rating.
3. Let each of us rate places independently on category-specific criteria.
4. Show what is nearby using the phone's location, with filters.
5. Let us build and follow a route (crawl) between stops.
6. Hand off to Google Maps (links) for navigation, live hours, photos and
   reviews, and offer a one-tap "Get me home".

**Hard constraint:** free to design, deploy and run. No paid services, no API
that needs a billing account or card, no Google Maps Platform keys.

**Scale:** 2 users now, 10 at most. Do not over-engineer.

## 1. Goals and non-goals

**Goals:** replace the spreadsheet + Google Maps saved list; rate venues on
category criteria; show what is nearby mid-crawl and let us decide (the app
informs, never chooses); keep history across trips and cities; cost nothing.

**Non-goals:** writing to Google Maps saved lists (no API); any Google Maps
Platform API; automatic opening hours, photos, Google ratings or "open at
arrival time"; in-app turn-by-turn navigation; background location; public
accounts or ratings; app store release.

## 2. Scope

### MVP
1. Trips: create (city, dates, fixture, kickoff) and edit *[new in v3]*; add and remove members by Google email.
2. Seed lists: copy a city's starter list into the trip and look up pins.
3. Add places three ways: search a name or address (then confirm or drag the
   pin), tap the map, or paste a Google Maps link.
4. Places list and Leaflet map with score-coloured, numbered pins.
5. Place card with **Go** and **View in Google Maps**.
6. Nearby filter with category chips and a ~5/~10/~15 minute walking radius.
7. Independent ratings (1-4 with Skip) blended into a score; split-decision flag.
8. Status per place: Want / Been / Skipped (derived).
9. Route builder: manual order, ~walking times, rhythm warning, dashed line,
   Google Maps hand-off split into legs, mark visited.
10. Check-ins and drink tally (data only; no nudges yet).
11. Get me home.
12. Event-day tags (match-day tags on a rugby trip), local tags, hours note, notes.
13. CSV import.
14. Live refresh every 20 s so phones stay in sync.
15. Sign in with Google; installable to the home screen *[new in v3]*.

### Version 1.1
Already built in the old app (port in R11): "Search in Google Maps" shortcuts;
food nudge and wind-down ranking; exact walking times for route legs; trip recap.
Still to build: offline use (cached trip data, queued writes) *[moved up from
"Later"; the PWA makes it possible]*; route auto-optimisation suggestion.

### Version 1.2 (Phase R12, after cutover)
Trip types (Rugby / Family / General) with criteria sets and per-type defaults
(§4.6); event-day mode with several events per trip (§8).

### Later
Scaling past about 10 people (swap `Data.gs` for a free-tier backend).

## 3. Users and roles

- **Owner:** creates trips; edits the trip, criteria and settings; adds and removes members.
- **Member:** added by Google email. Adds places, rates, checks in, edits routes.
- Everyone sees all ratings in the trip; each person can only add their own.
- Who may use a trip is decided only by the server, from the Members tab.

## 4. Rating system

### 4.1 Scale
1 Poor · 2 OK · 3 Good · 4 Great · **Skip** (null: not applicable or didn't
notice). No neutral option. Skipped criteria are left out of the average. If
everything is skipped, the rating has no score (the place still counts as Been).

### 4.2 Score
- Person score = weighted average of non-skipped criteria, as 0-100:
  `((weightedAvg - 1) / 3) * 100`, one decimal.
- The server computes it with the weights at save time and stores it; later
  weight changes never rewrite old ratings *[decided]*.
- Blended score = mean of each member's latest person score for the place.
- Split flag when any two members' scores differ by ≥ `SplitThreshold` (30).
- Each rating stores WouldReturn (Yes/Maybe/No, optional), PintPrice (pubs only,
  in `Currency`), Notes and VisitTimestamp.
- Ratings are append-only. "Update my last rating" reuses the last
  VisitTimestamp; "Log a new visit" uses now; default is update if the last
  rating is under 12 hours old *[decided]*.
- "Noise" is noise **comfort** (4 = pleasant for conversation); say so in the label.

### 4.3 Pin colours (thresholds in Settings)
Unrated: grey, showing the mean desire-to-try (or "–"). Below `ScoreRed` (35):
red. Below `ScoreAmber` (60): amber. Below `ScoreLightGreen` (80): light green.
Otherwise dark green. Always show the number. Anchors: square neutral pin with a
letter (H lodging, G ground, T station, A other), never rated.

### 4.4 Criteria (Criteria tab; never hard-coded)

| Category | Criteria (key: label) |
|---|---|
| Pub | guinness_temp: Guinness temperature; guinness_head: Guinness head; guinness_taste: Guinness taste; whiskey_selection: Whisky selection; ambiance: Ambiance; noise: Noise comfort; music: Music; rugby_friendliness: Rugby-friendliness; value: Value; service: Service |
| Restaurant | food; service; value; ambiance; noise (Noise comfort) |
| Cocktails | drinks; ambiance; service; value; music |
| Grab_and_Go | food; speed; value; walkability (Walkable between pubs) |
| Whisky_Bar | whiskey_selection (Selection); knowledge (Staff knowledge); ambiance; value |
| Sight | worth_the_time; crowds (Crowd comfort); value; duration_fit (Fits our schedule) |
| Tasting | quality; host; value; worth_the_time |
| Anchor | not rated |

Default weight 1. A criterion with Active not TRUE or Weight 0 is hidden.
Which trip types each row applies to is set by its `TripTypes` column (§4.6).

### 4.6 Trip types and criteria sets *[new in v3, Phase R12]*
Each trip has a **TripType**: `Rugby` (default; all existing trips),
`Family` or `General`. The type sets:

| | Rugby | Family | General |
|---|---|---|---|
| Rating criteria | Standard set incl. Guinness and rugby-friendliness | Standard set without the drink-specific rows, plus the Family rows below | Standard set without the Rugby-only rows |
| Drink tally and food nudge | Shown | Hidden by default (owner can switch on per trip) | Shown |
| Event wording | Match: "Kickoff", "Match day", "Near the ground" | From each event's kind (§8) | From each event's kind (§8) |
| Default chips | All categories | Restaurant, Grab & Go, Sights, Tastings | All categories |

Criteria rows get a `TripTypes` column (comma list; blank = every type). After
the R12 upgrade: guinness_temp, guinness_head, guinness_taste and
rugby_friendliness are `Rugby`; whiskey_selection (Pub), all Cocktails and
Whisky_Bar rows are `Rugby,General`; everything else stays blank. New Family rows:

| Category | Family criteria (key: label) |
|---|---|
| Pub | food: Food; kid_welcome: Welcoming to kids; space: Space and seating |
| Restaurant | kid_welcome: Welcoming to kids; kids_menu: Kids' menu; speed: Speed of service; space: Room for buggies |
| Grab_and_Go | kid_appeal: Kids liked it |
| Sight | kid_appeal: Kids enjoyed it; facilities: Toilets and baby changing; access: Buggy / step-free access |
| Tasting | kid_welcome: Welcoming to kids |

The rating form shows a category's rows whose TripTypes is blank or contains the
trip's type. Scores are stored by criterion key, so old ratings stay valid. The
owner can add, rename, reweight or retarget rows in the Criteria tab without
code changes. A trip's type can be changed later; each rating keeps the score it
was saved with.

### 4.5 Desire to try
Optional 1-4 per person on any place, set on the add-place screen and the place
card (not the rating screen) *[decided]*. Shown as the grey pin number; never
mixed into the blended score. Each person can only change their own value.

## 5. Data model

See ARCHITECTURE §8 for the exact columns (current `Setup.gs` SCHEMA). Rules:
UUID ids, ISO 8601 UTC timestamps, header row, one record per row, text columns
formatted as plain text, text starting with `= + - @` stored safely,
`initSpreadsheet()` only ever adds.

**Lodging, ground and stations** are Anchor places with `AnchorKind`
(Lodging / Stadium / Station / Other) *[decided]*. The Trip's Venue/Lodging
columns remain for compatibility; the trip venue coordinates still count as a
ground for "Near the ground".

**Multi-city trips:** each place has a City (defaults to the trip's city) *[decided]*.

### 5.1 Derived (never stored)
- **Status:** Been if any ARRIVE check-in or any rating; else Skipped if any
  SKIP check-in; else Want.
- Blended score, person scores, split flag, drink totals, last drink time.
- Walking estimate (browser): `minutes ≈ straightLineMetres × DetourFactor ÷ WalkMetersPerMinute`,
  always shown as "~8 min", with one note that hills and lanes make it approximate.
  Beyond about 3 hours' walk, show nothing (another city).

### 5.2 Settings (defaults)
`ScoreRed=35`, `ScoreAmber=60`, `ScoreLightGreen=80`, `SplitThreshold=30`,
`NearbyDefaultMinutes=10`, `RefreshSeconds=20`, `PacingEnabled=false`,
`PacingFoodNudgeDrinks=4`, `PacingWindDownHour=21`, `Currency=GBP`,
`WalkMetersPerMinute=80`, `DetourFactor=1.3`, `MatchDayWindowHoursBefore=6`,
`MatchDayWindowHoursAfter=4`, `MaxWaypoints=9` *[decided]*, `LocalTags`, `MatchDayTags`.
The `MatchDay…` keys and columns keep their names for compatibility; the app
labels them "Event day" (§8).
Settings apply to every trip in the spreadsheet; only an owner of some trip may change them.

### 5.3 Tags
Local: proper_boozer, tourist_trap, whisky_bar_real_list, locals_favourite,
hidden_gem, great_guinness, plus (R12) kid_friendly, pram_friendly,
baby_changing, rainy_day, quiet_space. Event-day (stored as `MatchDayTags`):
ticket_only, queue_risk, cash_only, away_fans_welcome, shows_live_rugby,
good_overflow, closes_early_on_matchday, plus (R12) book_ahead, busy_after_event.
Lists live in Settings and can grow. Tags are lowercase letters, numbers and underscores.

## 6. Backend contract

The API actions and their access rules are in ARCHITECTURE §6. Every action
verifies identity from the session (never from the request body) and checks
membership or ownership first. Every write uses the script lock. Reads of heavy
tabs are cached for about 25 s and the cache is cleared on every write. Geocode
results are cached by query for 6 hours.

## 7. Screens and flows

Bottom navigation: **Map | List | Route | Trip**. A **Get me home** button is
always visible inside a trip.

**Google Maps links (no key):**
- Walking directions: `https://www.google.com/maps/dir/?api=1&destination=LAT,LNG&travelmode=walking`
- Route: `…&origin=LAT,LNG&destination=LAT,LNG&waypoints=LAT,LNG|LAT,LNG&travelmode=walking`, at most `MaxWaypoints` waypoints per leg.
- View a place: the stored `GoogleMapsUrl`, or `https://www.google.com/maps/search/?api=1&query=NAME AREA CITY`.
- Transit home: as walking, with `travelmode=transit`.
Open in a new tab so the app keeps its state.

1. **Sign in:** Google button; then the trip picker (opens straight into the trip if there is only one).
2. **Map (home):** full-screen Leaflet map, "you are here" dot, pins as §4.3,
   category chips (Pub, Restaurant, Grab & Go, Cocktails, Whisky bar, Tastings,
   Sights, Anchors), Nearby chip with radius, city picker for multi-city trips,
   Mine / Mate's / Both, buttons: Locate me, Check in, + Add place, Get me home.
3. **Place card (bottom sheet):** name, category, area, city; score in the
   current view and each person's score; split flag with the gap; desire-to-try
   picker and others' values; ~walk from here; hours note with ⚠; tags; notes;
   added by and source; unconfirmed-pin warning; ratings (current and earlier
   visits). Buttons: Go, View in Google Maps, Rate, Add to route / In route,
   Mark Been (two taps), Skip, Show on map (from the list).
4. **List:** same data and filters; sort by score, distance, status, name.
5. **Rate:** criteria from the tab; Poor/OK/Good/Great + Skip; live score;
   Would return; pint price (pubs); notes; update-last vs new visit; one-tap save.
6. **Add place:** search + confirm/drag; tap the map; paste a link (short links
   kept but not resolved); then category (and anchor kind), city, area, tags,
   hours note, notes, desire to try.
7. **Route:** several named routes; ordered stops with up/down, Mark visited,
   Remove; ~walk per leg and total (and "still to go"); Mark visited also checks you in (ARRIVE, so the
   place becomes Been; undo clears only the route flag) *[decided]*; rhythm warning for 3+
   drink stops (Pub, Whisky_Bar, Cocktails) in a row; dashed straight line on a
   map with numbered pins and the next stop highlighted; Open in Google Maps as
   one link or numbered legs; delete route (two taps).
8. **Trip:** trip details (owner can edit, including trip type from R12); Tonight (tally buttons, undo, mood,
   last drink); the group (each person's drinks, food, mood, last drink, where
   they are; hidden on Family trips unless switched on); recent activity;
   events (R12: add, edit, remove; kind, name, start, optional end, venue);
   lodging and key places (+ Add lodging / venue / station); cities; members (owner adds/removes); add places in bulk (starter
   list, CSV); pins to review; settings (owner); switch trip; sign out.
9. **Get me home:** the nearest pinned lodging (or chosen one), ~walk, Walk home
   and Transit home links, nearest station with ~walk; "no lodging yet" prompt
   with Add lodging.
10. **Check in:** places sorted nearest first, search, confirm ARRIVE; Leave the
    current place.

**Live sync:** every `RefreshSeconds`, without a full reload; pause while hidden.

## 8. Event-day mode (was match-day mode)
A trip can hold several **events** *[R12; until then, the trip's single
Fixture and KickoffISO]*. Each event has a kind (Match, Concert, Show, Park
day, Other), a name, a start time, an optional end time and an optional venue
(an Anchor place; the Stadium anchor kind is labelled "Venue / ground").

An event is **on** from `MatchDayWindowHoursBefore` before its start until
`MatchDayWindowHoursAfter` after its end (or its start, if no end is set).
While an event is on: countdown banner with the event's name; "Near the venue"
filter (~15 min of the event's venue, else any venue anchor, else the trip
venue); "Easy to get in" (hides queue_risk and ticket_only); highlighted
ticket_only, queue_risk, cash_only, away_fans_welcome and book_ahead; hours note
shown in full with a View in Google Maps shortcut. If two events overlap, the
banner shows the soonest.

Wording follows the kind: a Match says "Kickoff", "Match day" and "Near the
ground", exactly as today; other kinds say "Starts", "Event day" and "Near the venue".

## 9. Pacing (data in MVP, nudges in v1.1)
Hidden on Family trips unless the owner switches the tally on (§4.6). Inputs: today's tally (from 5 am), mood, time of day, recent categories. All
nudges are suggestions behind `PacingEnabled`:
fewer than `PacingFoodNudgeDrinks` drinks → nothing; around that many or mood
Feeling it → "Food stop?" banner and boost food; mood Time to eat → food filter,
nearest well-rated first, plus a water-and-snack option; after
`PacingWindDownHour` or mood Winding down → boost whisky bars and short walks,
make Get me home prominent. The route rhythm warning ships in the MVP.

## 10. Hours, notes and quirks
`HoursNote` free text with a ⚠ icon on the card and list; live hours via View
in Google Maps; one shared `Notes` per place; personal notes per rating.

## 11. Non-functional

- **Cost:** free only (ARCHITECTURE §2). Catch geocoder quota errors with a
  friendly message; cache lookups; never bulk-download OSM tiles; keep attribution.
- **Security:** Google sign-in verified server-side; sessions expire; action
  allow-list; members check on every call; the Sheet shared with the owner only;
  no secrets in the repo; never log or return another trip's data.
- **Performance:** one batched read per tab; ~25 s cache; one `getTripData`
  call to open a trip; polls download places only when the stamp changes;
  skeleton/loading states.
- **Reliability:** idempotent writes by `requestId`; stale-save protection on routes.
- **Accessibility:** 48 px targets, never colour alone, focus outlines, readable
  in dim light and glare, reduced-motion respected.
- **Platform limits:** no background location; geocoding pub names is imperfect
  (always confirm the pin); walking times are estimates unless exact times are
  turned on in v1.1; GitHub Pages and Apps Script deploys take a minute.

## 12. Spike results
S1-S8 in STATUS.md. New S9-S15 in PHASES R1.

## 13. Acceptance criteria (MVP)

- [ ] Runs with no API keys, no billing account, no paid services.
- [ ] Both phones sign in with Google and can install the app to the home screen.
- [ ] I can create an Edinburgh trip, import the starter list, and see pins, with unconfirmed ones listed for review.
- [ ] I can add a place by search (and drag), by tapping the map, and by pasting a Google Maps link.
- [ ] Both phones show the same places; a place added on one appears on the other within 30 s.
- [ ] Each of us rates a pub 1-4 with skips; blended score and pin colour update correctly.
- [ ] A skipped criterion does not affect the score.
- [ ] Scores 30+ points apart show the split flag.
- [ ] Nearby filters by category and ~walking radius from my location; estimates show "~".
- [ ] Tapping a pin opens the card; Go opens walking directions; View in Google Maps opens the place.
- [ ] I can build a route, reorder it, see ~walking times, the dashed line and a rhythm warning.
- [ ] Open in Google Maps works for a route, split into legs past `MaxWaypoints`.
- [ ] Two people editing a route at once lose nothing.
- [ ] Get me home opens walking directions to the lodging in one tap.
- [ ] Tags, hours note and notes save and display.
- [ ] A Google account not in Members gets nothing back for any trip, and cannot open the Sheet.

### 13.1 Acceptance criteria (Phase R12)
- [ ] I can create a Family trip; its rating form shows the Family criteria and no Guinness rows, and the drink tally is hidden.
- [ ] Changing a trip's type leaves earlier ratings and scores unchanged.
- [ ] I can add two events to a trip (e.g. a show and a park day); each switches event-day mode on for its own window, with its own name and venue.
- [ ] A Match event looks exactly like today's match-day mode.

## 14. Seed list (Edinburgh, rugby)
The Edinburgh starter list (29 rows, all `VerifyFlag=Yes`, coordinates blank)
is in `data/seed/edinburgh.csv` and also built into `Data.gs` as
`STARTER_ROWS` (`loadStarterSeed()` in the editor). Import geocodes
`Name, Area, City`, sets `CoordSource=Seed`, `CoordConfirmed=FALSE`, generates a
search link, infers anchor kinds, and lists anything unmatched for a manual pin.
Re-verify before each trip.

Edinburgh notes (confirm before the trip): Murrayfield is about 3 km west of the
centre; tram to Murrayfield or walk from Haymarket (20-25 min). Pubs near the
ground and Haymarket fill early; Grassmarket, Old Town and Leith are easier.
