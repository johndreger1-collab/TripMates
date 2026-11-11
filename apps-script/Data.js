/**
 * Data.gs: the data-access layer. The UI never touches the Sheet; it calls the
 * public functions at the bottom of this file (Section 6 of the spec).
 *
 * Pattern: each public function (getPlaces) is a thin wrapper that reads the
 * caller's email and calls an internal function (getPlaces_) taking the email
 * as a parameter. Functions ending in "_" are private: google.script.run cannot
 * call them.
 *
 * Writes use the script lock. Reads of Trips/Members/Places are cached for
 * ~25 s and the cache is cleared on every write.
 */

var APP = {
  SHEET_ID: '',      // leave blank when bound to the spreadsheet
  LOCK_MS: 10000,
  CACHE_SECONDS: 25
};

var CATEGORIES = ['Pub', 'Restaurant', 'Cocktails', 'Grab_and_Go', 'Whisky_Bar', 'Sight', 'Tasting', 'Anchor'];
var COORD_SOURCES = ['Geocoded', 'Manual', 'Link', 'Seed'];
// What kind of reference point an Anchor place is. Lodging drives "Get Me Home" in Phase 6.
var ANCHOR_KINDS = ['Lodging', 'Stadium', 'Station', 'Other'];

// ===========================================================================
// Low-level sheet access
// ===========================================================================

function ss_() {
  return APP.SHEET_ID ? SpreadsheetApp.openById(APP.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" is missing. Run initSpreadsheet() first.');
  return sh;
}

function nowIso_() { return new Date().toISOString(); }
function newId_() { return Utilities.getUuid(); }

/** Runs fn while holding the script lock. Always releases it. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(APP.LOCK_MS);
  } catch (e) {
    throw new Error('The sheet is busy right now. Please try again in a few seconds.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sheets evaluates text beginning with = + - or @ as a formula, even in a
 * plain-text column (confirmed on a real Sheet). So on write we put one leading
 * space in front of such text, which Sheets always keeps as text, and on read
 * we take it off again. Text is trimmed on the way in, so a real value can never
 * start with a space and this marker is unambiguous.
 */
function sheetSafe_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? ' ' + v : v;
}

function normCell_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return v.toISOString(); // google.script.run cannot return Dates
  if (typeof v === 'string' && /^ [=+\-@]/.test(v)) return v.slice(1); // undo sheetSafe_
  return v;
}

function cacheKey_(name) { return 'rows:' + name; }

function cacheGet_(name) {
  try {
    var s = CacheService.getScriptCache().get(cacheKey_(name));
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

function cachePut_(name, rows) {
  try {
    var s = JSON.stringify(rows);
    if (s.length < 90000) CacheService.getScriptCache().put(cacheKey_(name), s, APP.CACHE_SECONDS); // 100 KB limit per key
  } catch (e) { /* caching is only an optimisation */ }
}

function cacheClear_(name) {
  try { CacheService.getScriptCache().remove(cacheKey_(name)); } catch (e) { /* ignore */ }
}

function cacheClearAll_() {
  try { CacheService.getScriptCache().removeAll(Object.keys(SCHEMA).map(cacheKey_)); } catch (e) { /* ignore */ }
}

/** All rows of a tab as objects keyed by header, each with _row (1-based sheet row). May be cached. */
function readRows_(name) {
  var cached = cacheGet_(name);
  if (cached) return cached;
  var rows = readRowsFresh_(name);
  cachePut_(name, rows);
  return rows;
}

/** Always reads the sheet. Used inside locks so writes never act on stale data. */
function readRowsFresh_(name) {
  var values = sheet_(name).getDataRange().getValues(); // one batched read
  var headers = SCHEMA[name];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var raw = values[i];
    if (raw[0] === '' || raw[0] === null || raw[0] === undefined) continue; // first column is the key
    var o = { _row: i + 1 };
    for (var c = 0; c < headers.length; c++) o[headers[c]] = normCell_(raw[c]);
    rows.push(o);
  }
  return rows;
}

function rowArray_(name, obj) {
  return SCHEMA[name].map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : sheetSafe_(v);
  });
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var arr = rowArray_(name, obj);
  sh.getRange(sh.getLastRow() + 1, 1, 1, arr.length).setValues([arr]);
}

/** Overwrites one row, after checking it still holds the record we think it does. */
function writeRow_(name, rowNumber, key, obj) {
  var sh = sheet_(name);
  if (String(sh.getRange(rowNumber, 1).getValue()) !== String(key)) {
    throw new Error('The sheet changed while saving. Please try again.');
  }
  sh.getRange(rowNumber, 1, 1, SCHEMA[name].length).setValues([rowArray_(name, obj)]);
}

// ===========================================================================
// Validation helpers (everything from the client is untrusted)
// ===========================================================================

function cleanText_(v, max, label, required) {
  var s = v === null || v === undefined ? '' : String(v);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (required && !s) throw new Error(label + ' is required.');
  if (s.length > max) throw new Error(label + ' must be ' + max + ' characters or fewer.');
  return s;
}

function cleanNumber_(v, min, max, label) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v.trim() === '') return '';
  var n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!isFinite(n) || n < min || n > max) {
    throw new Error(label + ' must be a number between ' + min + ' and ' + max + '.');
  }
  return n;
}

function cleanDate_(v, label) {
  var s = cleanText_(v, 10, label);
  if (!s) return '';
  var d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z') : null;
  if (!d || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(label + ' must be a real date in the form YYYY-MM-DD.');
  }
  return s;
}

/** Accepts any ISO 8601 date-time; stores it as UTC. */
function cleanIso_(v, label) {
  var s = cleanText_(v, 40, label);
  if (!s) return '';
  var t = Date.parse(s);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || isNaN(t)) throw new Error(label + ' must be a valid date and time.');
  return new Date(t).toISOString();
}

function cleanEmail_(v) {
  var s = normEmail_(v);
  if (!s || s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('Enter a valid email address.');
  return s;
}

function cleanEnum_(v, list, label, allowBlank) {
  var s = cleanText_(v, 40, label);
  if (!s) {
    if (allowBlank) return '';
    throw new Error(label + ' is required.');
  }
  if (list.indexOf(s) < 0) throw new Error(label + ' must be one of: ' + list.join(', ') + '.');
  return s;
}

function cleanTags_(v, label) {
  var arr = Array.isArray(v) ? v : String(v === null || v === undefined ? '' : v).split(',');
  var seen = {};
  var out = [];
  arr.forEach(function (t) {
    t = String(t).trim().toLowerCase();
    if (!t) return;
    if (!/^[a-z0-9_]{1,40}$/.test(t)) throw new Error(label + ' contains an invalid tag. Use letters, numbers and underscores.');
    if (!seen[t]) { seen[t] = true; out.push(t); }
  });
  if (out.length > 20) throw new Error(label + ' can have at most 20 tags.');
  return out.join(',');
}

/** Only Google Maps links are stored, so a saved link can never be a javascript: URL. */
function cleanUrl_(v) {
  var s = cleanText_(v, 2000, 'Google Maps link');
  if (!s) return '';
  var ok = /^https:\/\/(www\.|maps\.)?google\.(com|co\.uk|[a-z]{2,3})\//i.test(s) ||
           /^https:\/\/(maps\.app\.)?goo\.gl\//i.test(s);
  if (!ok) throw new Error('That does not look like a Google Maps link.');
  return s;
}

function requirePair_(a, b, label) {
  if ((a === '') !== (b === '')) throw new Error(label + ' latitude and longitude must both be set or both be blank.');
}

function numOrNull_(v) { return v === '' || v === null || v === undefined ? null : Number(v); }
function splitTags_(s) { return s ? String(s).split(',') : []; }
function toBool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

// ===========================================================================
// Shapes returned to the client (camelCase; sheet columns stay PascalCase)
// ===========================================================================

function tripFromRow_(r, role) {
  return {
    tripId: r.TripID, city: r.City, startDate: r.StartDate, endDate: r.EndDate, fixture: r.Fixture,
    kickoffIso: r.KickoffISO, venueName: r.VenueName, venueLat: numOrNull_(r.VenueLat), venueLng: numOrNull_(r.VenueLng),
    lodgingName: r.LodgingName, lodgingLat: numOrNull_(r.LodgingLat), lodgingLng: numOrNull_(r.LodgingLng),
    createdBy: r.CreatedBy, createdAt: r.CreatedAt, role: role
  };
}

function memberFromRow_(r) {
  return { tripId: r.TripID, email: normEmail_(r.Email), displayName: r.DisplayName, role: r.Role, addedAt: r.AddedAt };
}

function parseDesire_(s) {
  try {
    var o = JSON.parse(s || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

function placeFromRow_(r) {
  return {
    placeId: r.PlaceID, tripId: r.TripID, name: r.Name, category: r.Category, area: r.Area, address: r.Address,
    lat: numOrNull_(r.Lat), lng: numOrNull_(r.Lng), coordSource: r.CoordSource, coordConfirmed: toBool_(r.CoordConfirmed),
    googleMapsUrl: r.GoogleMapsUrl, source: r.Source, desireToTry: parseDesire_(r.DesireToTry),
    localTags: splitTags_(r.LocalTags), matchDayTags: splitTags_(r.MatchDayTags), hoursNote: r.HoursNote,
    notes: r.Notes, lastVerified: r.LastVerified, addedBy: r.AddedBy, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt,
    city: r.City || '', anchorKind: r.AnchorKind || ''
  };
}

// ===========================================================================
// Trips and Members (internal)
// ===========================================================================

function getMyTrips_(email) {
  email = normEmail_(email);
  var roleByTrip = {};
  var any = false;
  readRows_('Members').forEach(function (m) {
    if (normEmail_(m.Email) === email) { roleByTrip[m.TripID] = m.Role; any = true; }
  });
  if (!any) return [];
  return readRows_('Trips')
    .filter(function (t) { return roleByTrip[t.TripID]; })
    .map(function (t) { return tripFromRow_(t, roleByTrip[t.TripID]); })
    .sort(function (a, b) { return String(b.startDate || b.createdAt).localeCompare(String(a.startDate || a.createdAt)); });
}

function createTrip_(email, d) {
  email = normEmail_(email);
  d = d || {};
  var trip = {
    TripID: newId_(),
    City: cleanText_(d.city, 80, 'City', true),
    StartDate: cleanDate_(d.startDate, 'Start date'),
    EndDate: cleanDate_(d.endDate, 'End date'),
    Fixture: cleanText_(d.fixture, 120, 'Fixture'),
    KickoffISO: cleanIso_(d.kickoffIso, 'Kickoff'),
    VenueName: cleanText_(d.venueName, 120, 'Venue name'),
    VenueLat: cleanNumber_(d.venueLat, -90, 90, 'Venue latitude'),
    VenueLng: cleanNumber_(d.venueLng, -180, 180, 'Venue longitude'),
    LodgingName: cleanText_(d.lodgingName, 120, 'Lodging name'),
    LodgingLat: cleanNumber_(d.lodgingLat, -90, 90, 'Lodging latitude'),
    LodgingLng: cleanNumber_(d.lodgingLng, -180, 180, 'Lodging longitude'),
    CreatedBy: email,
    CreatedAt: nowIso_()
  };
  if (trip.StartDate && trip.EndDate && trip.EndDate < trip.StartDate) throw new Error('The end date cannot be before the start date.');
  requirePair_(trip.VenueLat, trip.VenueLng, 'Venue');
  requirePair_(trip.LodgingLat, trip.LodgingLng, 'Lodging');
  var display = cleanText_(d.displayName, 60, 'Display name') || email.split('@')[0];

  withLock_(function () {
    appendRow_('Trips', trip);
    appendRow_('Members', { TripID: trip.TripID, Email: email, DisplayName: display, Role: 'Owner', AddedAt: trip.CreatedAt });
    cacheClear_('Trips');
    cacheClear_('Members');
  });
  return tripFromRow_(trip, 'Owner');
}

function addMember_(email, tripId, newEmail, displayName) {
  requireOwner_(email, tripId);
  var target = cleanEmail_(newEmail);
  var name = cleanText_(displayName, 60, 'Display name') || target.split('@')[0];

  return withLock_(function () {
    var dupe = readRowsFresh_('Members').some(function (m) {
      return m.TripID === tripId && normEmail_(m.Email) === target;
    });
    if (dupe) throw new Error('That person is already a member of this trip.');
    var row = { TripID: tripId, Email: target, DisplayName: name, Role: 'Member', AddedAt: nowIso_() };
    appendRow_('Members', row);
    cacheClear_('Members');
    var m = memberFromRow_(row);
    m.note = 'Remember to share the spreadsheet with ' + target + ' (Editor access). The app cannot do that for you.';
    return m;
  });
}

function getMembers_(email, tripId) {
  requireMember_(email, tripId);
  return readRows_('Members')
    .filter(function (m) { return m.TripID === tripId; })
    .map(memberFromRow_);
}

// ===========================================================================
// Places (internal)
// ===========================================================================

/**
 * Validates and normalises place fields from the client. For updates only the
 * fields that were sent are returned (patch semantics), so two people editing
 * different fields do not overwrite each other.
 */
function cleanPlaceFields_(p, isCreate, defaultCity) {
  var out = {};
  function has(k) { return Object.prototype.hasOwnProperty.call(p, k); }

  if (isCreate || has('name')) out.Name = cleanText_(p.name, 120, 'Name', true);
  if (isCreate || has('category')) out.Category = cleanEnum_(p.category, CATEGORIES, 'Category');
  if (isCreate || has('area')) out.Area = cleanText_(p.area, 80, 'Area');
  if (isCreate || has('city')) out.City = cleanText_(p.city, 80, 'City') || (isCreate ? (defaultCity || '') : '');
  if (isCreate || has('anchorKind')) out.AnchorKind = cleanEnum_(p.anchorKind, ANCHOR_KINDS, 'Anchor type', true);
  if (isCreate || has('address')) out.Address = cleanText_(p.address, 200, 'Address');

  if (isCreate || has('lat') || has('lng')) {
    if (!isCreate && has('lat') !== has('lng')) throw new Error('Send lat and lng together.');
    var lat = cleanNumber_(p.lat, -90, 90, 'Latitude');
    var lng = cleanNumber_(p.lng, -180, 180, 'Longitude');
    requirePair_(lat, lng, 'Place');
    out.Lat = lat;
    out.Lng = lng;
  }
  if (isCreate || has('coordSource')) out.CoordSource = cleanEnum_(p.coordSource, COORD_SOURCES, 'Coordinate source', true);
  if (isCreate || has('coordConfirmed')) out.CoordConfirmed = p.coordConfirmed === true || p.coordConfirmed === 'TRUE';
  if (isCreate || has('googleMapsUrl')) out.GoogleMapsUrl = cleanUrl_(p.googleMapsUrl);
  if (isCreate || has('localTags')) out.LocalTags = cleanTags_(p.localTags, 'Local tags');
  if (isCreate || has('matchDayTags')) out.MatchDayTags = cleanTags_(p.matchDayTags, 'Match-day tags');
  if (isCreate || has('hoursNote')) out.HoursNote = cleanText_(p.hoursNote, 300, 'Hours note');
  if (isCreate || has('notes')) out.Notes = cleanText_(p.notes, 2000, 'Notes');
  if (isCreate || has('lastVerified')) out.LastVerified = cleanDate_(p.lastVerified, 'Last verified');

  if (isCreate) {
    out.Source = cleanEnum_(p.source || 'Own', ['Own', 'Seed'], 'Source');
    if (out.Lat !== '' && !out.CoordSource) out.CoordSource = 'Manual';
    normaliseAnchor_(out);
  }
  return out;
}

/** Only Anchor places have a kind: Anchors default to "Other", everything else has none. */
function normaliseAnchor_(row) {
  if (row.Category === 'Anchor') { if (!row.AnchorKind) row.AnchorKind = 'Other'; }
  else row.AnchorKind = '';
  return row;
}

function tripCityFor_(tripId) {
  var city = '';
  readRows_('Trips').forEach(function (t) { if (t.TripID === tripId) city = String(t.City || ''); });
  return city;
}

/**
 * Each person owns only their own entry in the DesireToTry map. Whatever map the
 * client sends is ignored; the client sends myDesire (1-4, or null to clear).
 */
function mergeDesire_(existingJson, email, myDesire) {
  var map = parseDesire_(existingJson);
  if (myDesire === null) {
    delete map[email];
  } else {
    var n = Number(myDesire);
    if (!(n === 1 || n === 2 || n === 3 || n === 4)) throw new Error('Desire to try must be 1, 2, 3 or 4.');
    map[email] = n;
  }
  return JSON.stringify(map);
}

function getPlaces_(email, tripId) {
  requireMember_(email, tripId);
  var rows = readRows_('Places').filter(function (p) { return p.TripID === tripId; });
  return decoratePlaces_(tripId, rows);
}

function savePlace_(email, p) {
  email = normEmail_(email);
  if (!p || typeof p !== 'object') throw new Error('No place was sent.');
  var tripId = p.tripId;
  requireMember_(email, tripId);

  var fields = cleanPlaceFields_(p, true, tripCityFor_(tripId));
  var now = nowIso_();
  var row = Object.assign({}, fields, {
    PlaceID: newId_(), TripID: tripId, AddedBy: email, CreatedAt: now, UpdatedAt: now,
    DesireToTry: '{}'
  });
  if (Object.prototype.hasOwnProperty.call(p, 'myDesire') && p.myDesire !== undefined) {
    row.DesireToTry = mergeDesire_('{}', email, p.myDesire);
  }

  withLock_(function () {
    appendRow_('Places', row);
    cacheClear_('Places');
  });
  return decoratePlaces_(tripId, [row])[0];
}

function updatePlace_(email, p) {
  email = normEmail_(email);
  if (!p || typeof p !== 'object' || !p.placeId) throw new Error('placeId is required.');
  var NOT_FOUND = 'Place not found, or you are not a member of its trip.';

  return withLock_(function () {
    var cur = null;
    readRowsFresh_('Places').forEach(function (r) { if (r.PlaceID === p.placeId) cur = r; });
    // The trip comes from the stored row, never from the client.
    if (!cur || !findMember_(cur.TripID, email)) throw new Error(NOT_FOUND);

    var updates = cleanPlaceFields_(p, false);
    if (Object.prototype.hasOwnProperty.call(p, 'myDesire')) {
      updates.DesireToTry = mergeDesire_(cur.DesireToTry, email, p.myDesire);
    }
    var merged = normaliseAnchor_(Object.assign({}, cur, updates, { UpdatedAt: nowIso_() }));
    writeRow_('Places', cur._row, cur.PlaceID, merged);
    cacheClear_('Places');
    return decoratePlaces_(cur.TripID, [merged])[0];
  });
}

// ===========================================================================
// Settings (read side). Saving settings arrives in Phase 6.
// ===========================================================================

function num_(v, dflt) {
  if (v === '' || v === null || v === undefined) return dflt;
  var n = Number(v);
  return isFinite(n) ? n : dflt;
}

/** Every setting as text, with defaults filled in for anything missing from the sheet. */
function settingsMap_() {
  var map = {};
  DEFAULT_SETTINGS.forEach(function (kv) { map[kv[0]] = kv[1]; });
  readRows_('Settings').forEach(function (r) { map[String(r.Key)] = String(r.Value); });
  return map;
}

/** Settings parsed into the types the app needs. */
function settingsForClient_() {
  var m = settingsMap_();
  return {
    scoreRed: num_(m.ScoreRed, 35),
    scoreAmber: num_(m.ScoreAmber, 60),
    scoreLightGreen: num_(m.ScoreLightGreen, 80),
    splitThreshold: num_(m.SplitThreshold, 30),
    nearbyDefaultMinutes: num_(m.NearbyDefaultMinutes, 10),
    refreshSeconds: num_(m.RefreshSeconds, 20),
    pacingEnabled: String(m.PacingEnabled).toLowerCase() === 'true',
        pacingFoodNudgeDrinks: num_(m.PacingFoodNudgeDrinks, 4),
    pacingWindDownHour: num_(m.PacingWindDownHour, 21),
    walkMetersPerMinute: num_(m.WalkMetersPerMinute, 80),
    detourFactor: num_(m.DetourFactor, 1.3),
    matchDayWindowHoursBefore: num_(m.MatchDayWindowHoursBefore, 6),
    matchDayWindowHoursAfter: num_(m.MatchDayWindowHoursAfter, 4),
    maxWaypoints: num_(m.MaxWaypoints, 9),
    currency: m.Currency || 'GBP',
    localTags: splitTags_(m.LocalTags),
    matchDayTags: splitTags_(m.MatchDayTags)
  };
}

// ===========================================================================
// Derived data: status, blended score, split flag (never stored)
// ===========================================================================

/**
 * For one trip, works out per place:
 *   status        Been if any ARRIVE check-in or any rating exists; else Skipped if
 *                 a SKIP check-in exists; else Want.
 *   personScores  each member's latest PersonScore (a skipped-everything rating has none)
 *   blendedScore  mean of those, one decimal; null when nobody has a score
 *   split         true when two members' scores differ by SplitThreshold or more
 * Only places with some rating or check-in appear in the result.
 */
function deriveForTrip_(tripId) {
  var threshold = num_(settingsMap_().SplitThreshold, 30);
  var latest = {}, hasRating = {}, arrive = {}, skip = {};

  function rank(r) { return String(r.VisitTimestamp || '') + '|' + String(r.CreatedAt || ''); }

  readRows_('Ratings').forEach(function (r) {
    if (r.TripID !== tripId) return;
    hasRating[r.PlaceID] = true;
    var byUser = latest[r.PlaceID] || (latest[r.PlaceID] = {});
    var email = normEmail_(r.UserEmail);
    if (!byUser[email] || rank(r) >= rank(byUser[email])) byUser[email] = r; // latest row per person wins
  });
  readRows_('CheckIns').forEach(function (c) {
    if (c.TripID !== tripId) return;
    if (c.Type === 'ARRIVE') arrive[c.PlaceID] = true;
    else if (c.Type === 'SKIP') skip[c.PlaceID] = true;
  });

  var ids = {};
  [hasRating, arrive, skip].forEach(function (m) { Object.keys(m).forEach(function (k) { ids[k] = true; }); });

  var out = {};
  Object.keys(ids).forEach(function (id) {
    var scores = {}, vals = [];
    var byUser = latest[id] || {};
    Object.keys(byUser).forEach(function (email) {
      var v = byUser[email].PersonScore;
      if (v !== '' && v !== null && isFinite(Number(v))) {
        scores[email] = Math.round(Number(v) * 10) / 10;
        vals.push(Number(v));
      }
    });
    var blended = null, split = false;
    if (vals.length) {
      var sum = vals.reduce(function (a, b) { return a + b; }, 0);
      blended = Math.round((sum / vals.length) * 10) / 10;
      split = vals.length >= 2 && (Math.max.apply(null, vals) - Math.min.apply(null, vals)) >= threshold;
    }
    out[id] = {
      status: (hasRating[id] || arrive[id]) ? 'Been' : (skip[id] ? 'Skipped' : 'Want'),
      blendedScore: blended,
      personScores: scores,
      split: split
    };
  });
  return out;
}

/** Place rows to client objects, with the derived fields attached. */
function decoratePlaces_(tripId, rows) {
  var derived = deriveForTrip_(tripId);
  return rows.map(function (r) {
    var p = placeFromRow_(r);
    var d = derived[r.PlaceID];
    p.status = d ? d.status : 'Want';
    p.blendedScore = d ? d.blendedScore : null;
    p.personScores = d ? d.personScores : {};
    p.split = d ? d.split : false;
    return p;
  });
}

// ===========================================================================
// Check-ins (append-only). Phase 2 uses ARRIVE and SKIP; the rest are for Phase 4.
// ===========================================================================

var CHECKIN_TYPES = ['ARRIVE', 'LEAVE', 'PINT', 'WHISKY', 'OTHER_DRINK', 'FOOD', 'MOOD', 'SKIP'];
var PLACE_CHECKIN_TYPES = ['ARRIVE', 'LEAVE', 'SKIP']; // these must name a place in the trip

function addCheckIn_(email, c) {
  email = normEmail_(email);
  if (!c || typeof c !== 'object') throw new Error('No check-in was sent.');
  var tripId = c.tripId;
  requireMember_(email, tripId);

var type = cleanEnum_(c.type, CHECKIN_TYPES, 'Type');
 var value = cleanCheckInValue_(type, c.value);
  var placeId = cleanText_(c.placeId, 64, 'Place');
  if (PLACE_CHECKIN_TYPES.indexOf(type) >= 0 && !placeId) throw new Error('A place is required for ' + type + '.');
  if (placeId) {
    var inTrip = readRows_('Places').some(function (p) { return p.PlaceID === placeId && p.TripID === tripId; });
    if (!inTrip) throw new Error('That place is not in this trip.');
  }
  var lat = cleanNumber_(c.lat, -90, 90, 'Latitude');
  var lng = cleanNumber_(c.lng, -180, 180, 'Longitude');
  requirePair_(lat, lng, 'Check-in');

  var row = {
    CheckInID: newId_(), TripID: tripId, UserEmail: email, PlaceID: placeId, Type: type,
    Value: value, Timestamp: nowIso_(), Lat: lat, Lng: lng
  };
  withLock_(function () {
    appendRow_('CheckIns', row);
    cacheClear_('CheckIns');
  });
  return { checkInId: row.CheckInID, tripId: tripId, placeId: placeId, type: type, value: row.Value, userEmail: email, timestamp: row.Timestamp };
}

// ----------------------------- BLOCK A -------------------------------------
 
// ===========================================================================
// Criteria and ratings (Phase 3)
// ===========================================================================
 
var WOULD_RETURN = ['Yes', 'Maybe', 'No'];
 
/**
 * Active criteria for one category, in SortOrder. A criterion is hidden when
 * Active is not TRUE or its Weight is 0 (spec 4.4: edit the Criteria tab, no code change).
 */
function criteriaFor_(category) {
  return readRows_('Criteria')
    .filter(function (c) { return c.Category === category && toBool_(c.Active) && num_(c.Weight, 1) > 0; })
    .sort(function (a, b) { return num_(a.SortOrder, 0) - num_(b.SortOrder, 0); })
    .map(function (c) { return { key: c.CriterionKey, label: c.Label, weight: num_(c.Weight, 1) }; });
}
 
/** Every ratable category's criteria in one object, for the client to build forms without more calls. */
function criteriaByCategory_() {
  var out = {};
  CATEGORIES.forEach(function (cat) { if (cat !== 'Anchor') out[cat] = criteriaFor_(cat); });
  return out;
}
 
function getCriteria_(email, category) {
  requireAnyTrip_(email);
  var cat = cleanEnum_(category, CATEGORIES.filter(function (c) { return c !== 'Anchor'; }), 'Category');
  return criteriaFor_(cat);
}
 
/**
 * The spec 4.2 formula. scores maps criterion key to 1-4 or null (skipped).
 * Skipped criteria are left out of the weighted average. Returns 0-100 rounded
 * to one decimal, or '' when everything was skipped (no score).
 */
function computeScore_(scores, criteria) {
  var sum = 0, weights = 0;
  criteria.forEach(function (c) {
    var v = scores[c.key];
    if (v === null || v === undefined) return;
    sum += c.weight * v;
    weights += c.weight;
  });
  if (!weights) return '';
  return Math.round((((sum / weights) - 1) / 3) * 1000) / 10;
}
 
/** Validates the client's scores. Unsent criteria count as skipped; unknown keys and values outside 1-4 are errors. */
function cleanScores_(raw, criteria) {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Scores must be an object.');
  var known = {};
  var out = {};
  criteria.forEach(function (c) { known[c.key] = true; out[c.key] = null; });
  Object.keys(raw).forEach(function (k) {
    if (!known[k]) throw new Error('Unknown criterion "' + String(k).slice(0, 40) + '" for this category.');
    var v = raw[k];
    if (v === null || v === undefined || v === '') { out[k] = null; return; }
    var n = Number(v);
    if (!(n === 1 || n === 2 || n === 3 || n === 4)) throw new Error('Each score must be 1, 2, 3 or 4, or skipped.');
    out[k] = n;
  });
  return out;
}
 
/** Same ordering deriveForTrip_ uses: latest VisitTimestamp, then latest CreatedAt. */
function ratingRank_(r) { return String(r.VisitTimestamp || '') + '|' + String(r.CreatedAt || ''); }
 
function parseScores_(s) {
  try {
    var o = JSON.parse(s || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
 
function ratingFromRow_(r) {
  return {
    ratingId: r.RatingID, placeId: r.PlaceID, tripId: r.TripID, userEmail: normEmail_(r.UserEmail),
    visitTimestamp: r.VisitTimestamp, scores: parseScores_(r.ScoresJSON), personScore: numOrNull_(r.PersonScore),
    wouldReturn: r.WouldReturn, pintPrice: numOrNull_(r.PintPrice), notes: r.Notes, createdAt: r.CreatedAt
  };
}
 
/**
 * Appends one rating row (ratings are never edited in place).
 *   r = { tripId, placeId, scores:{key:1-4|null}, wouldReturn, pintPrice, notes, updateLast }
 * The rater is always the signed-in caller; any email in r is ignored.
 * updateLast true: the row reuses the VisitTimestamp of the caller's latest rating for
 * this place, so it replaces that rating in the blend. Otherwise it is a new visit (now).
 * The score is worked out here from the weights as they are today, and stored, so
 * changing weights later never rewrites old ratings.
 * Returns { rating, place } where place carries the refreshed derived fields.
 */
function saveRating_(email, r) {
  email = normEmail_(email);
  if (!r || typeof r !== 'object') throw new Error('No rating was sent.');
  var tripId = r.tripId;
  requireMember_(email, tripId);
 
  var placeId = cleanText_(r.placeId, 64, 'Place', true);
  var place = null;
  readRows_('Places').forEach(function (p) { if (p.PlaceID === placeId && p.TripID === tripId) place = p; });
  if (!place) throw new Error('That place is not in this trip.');
  if (place.Category === 'Anchor') throw new Error('Reference points cannot be rated.');
 
  var criteria = criteriaFor_(place.Category);
  var scores = cleanScores_(r.scores, criteria);
  var wouldReturn = cleanEnum_(r.wouldReturn, WOULD_RETURN, 'Would return', true);
  var pint = place.Category === 'Pub' ? cleanNumber_(r.pintPrice, 0, 100, 'Pint price') : '';
  var notes = cleanText_(r.notes, 1000, 'Notes');
  var now = nowIso_();
 
  var row = {
    RatingID: newId_(), PlaceID: placeId, TripID: tripId, UserEmail: email, VisitTimestamp: now,
    ScoresJSON: JSON.stringify(scores), PersonScore: computeScore_(scores, criteria),
    WouldReturn: wouldReturn, PintPrice: pint, Notes: notes, CreatedAt: now
  };
 
  withLock_(function () {
    if (r.updateLast === true) {
      var latest = null;
      readRowsFresh_('Ratings').forEach(function (x) {
        if (x.PlaceID === placeId && x.TripID === tripId && normEmail_(x.UserEmail) === email &&
            (!latest || ratingRank_(x) >= ratingRank_(latest))) latest = x;
      });
      if (latest && latest.VisitTimestamp) row.VisitTimestamp = String(latest.VisitTimestamp);
    }
    appendRow_('Ratings', row);
    cacheClear_('Ratings');
  });
  return { rating: ratingFromRow_(row), place: decoratePlaces_(tripId, [place])[0] };
}
 
/**
 * Every rating for a place (all members, all visits), newest first. Each has
 * current:true when it is the one that counts toward that person's score.
 */
function getRatings_(email, placeId) {
  email = normEmail_(email);
  if (!placeId || typeof placeId !== 'string') throw new Error('placeId is required.');
  var place = null;
  readRows_('Places').forEach(function (p) { if (p.PlaceID === placeId) place = p; });
  if (!place || !findMember_(place.TripID, email)) throw new Error('Place not found, or you are not a member of its trip.');
 
  var rows = readRows_('Ratings').filter(function (r) { return r.PlaceID === placeId && r.TripID === place.TripID; });
  var best = {};
  rows.forEach(function (r) {
    var e = normEmail_(r.UserEmail);
    if (!best[e] || ratingRank_(r) >= ratingRank_(best[e])) best[e] = r;
  });
  rows = rows.slice().sort(function (a, b) { return ratingRank_(a) < ratingRank_(b) ? 1 : ratingRank_(a) > ratingRank_(b) ? -1 : 0; });
  return rows.map(function (r) {
    var o = ratingFromRow_(r);
    o.current = best[normEmail_(r.UserEmail)] === r;
    return o;
  });
}

// ===========================================================================
// Live sync, check-in reading, tally and mood rules (Phase 4)
// ===========================================================================

var TALLY_TYPES = ['PINT', 'WHISKY', 'OTHER_DRINK', 'FOOD'];
var MOODS = ['Fresh', 'Warming up', 'Feeling it', 'Time to eat', 'Winding down'];
var CHECKIN_PAGE = 2000; // most check-ins one call will return

function hoursAgoIso_(hours) { return new Date(Date.now() - hours * 3600000).toISOString(); }

/**
 * Tally entries are +1, or -1 to undo (check-ins are append-only, so an undo is a new row).
 * Moods must be one of the five. Everything else keeps the free-text rule.
 */
function cleanCheckInValue_(type, v) {
  var s = cleanText_(v, 100, 'Value');
  if (TALLY_TYPES.indexOf(type) >= 0) {
    if (s === '') return '1';
    if (s !== '1' && s !== '-1') throw new Error('A tally entry must be 1 or -1.');
    return s;
  }
  if (type === 'MOOD') {
    if (MOODS.indexOf(s) < 0) throw new Error('Mood must be one of: ' + MOODS.join(', ') + '.');
    return s;
  }
  return s;
}

function checkInFromRow_(r) {
  return {
    checkInId: r.CheckInID, tripId: r.TripID, userEmail: normEmail_(r.UserEmail), placeId: r.PlaceID,
    type: r.Type, value: String(r.Value === undefined || r.Value === null ? '' : r.Value), timestamp: r.Timestamp
  };
}

/**
 * Check-ins for a trip with a Timestamp strictly after sinceIso (blank = all), oldest first.
 * Capped at the newest CHECKIN_PAGE rows. Used to open a trip and to poll.
 */
function getCheckIns_(email, tripId, sinceIso) {
  requireMember_(email, tripId);
  var since = cleanIso_(sinceIso, 'Since');
  var rows = readRows_('CheckIns').filter(function (r) {
    return r.TripID === tripId && (!since || String(r.Timestamp) > since);
  });
  rows.sort(function (a, b) {
    var x = String(a.Timestamp), y = String(b.Timestamp);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (rows.length > CHECKIN_PAGE) rows = rows.slice(rows.length - CHECKIN_PAGE);
  return rows.map(checkInFromRow_);
}

/**
 * A short text that changes whenever anything the places list depends on changes:
 * a place added or edited, a rating, an ARRIVE or SKIP check-in, or a member added.
 * Drink, mood and LEAVE check-ins do not change it. The app compares it with the
 * last one it saw and only downloads the full place list when it differs.
 */
function tripStamp_(tripId) {
  var pc = 0, pm = '', rc = 0, rm = '', cc = 0, cm = '', mc = 0;
  readRows_('Places').forEach(function (p) {
    if (p.TripID !== tripId) return;
    pc++;
    var u = String(p.UpdatedAt || ''); if (u > pm) pm = u;
  });
  readRows_('Ratings').forEach(function (r) {
    if (r.TripID !== tripId) return;
    rc++;
    var c = String(r.CreatedAt || ''); if (c > rm) rm = c;
  });
  readRows_('CheckIns').forEach(function (c) {
    if (c.TripID !== tripId || (c.Type !== 'ARRIVE' && c.Type !== 'SKIP')) return;
    cc++;
    var t = String(c.Timestamp || ''); if (t > cm) cm = t;
  });
  readRows_('Members').forEach(function (m) { if (m.TripID === tripId) mc++; });
  return [pc, pm, rc, rm, cc, cm, mc].join('|');
}

/**
 * The poll. Always returns new check-ins since sinceIso. Returns places and members
 * only when stamp (what the app last saw) no longer matches, otherwise null.
 */
function getSync_(email, tripId, sinceIso, stamp, routeStamp) {
  requireMember_(email, tripId);
  var now = tripStamp_(tripId);
  var changed = String(stamp === undefined || stamp === null ? '' : stamp) !== now;
  var rs = routeStamp_(tripId);
  return {
    serverTime: nowIso_(), stamp: now, changed: changed,
    places: changed ? getPlaces_(email, tripId) : null,
    members: changed ? getMembers_(email, tripId) : null,
    checkIns: getCheckIns_(email, tripId, sinceIso),
    routeStamp: rs,
    routes: rs !== String(routeStamp === undefined || routeStamp === null ? '' : routeStamp) ? getRoutes_(email, tripId) : null
  };
}
// ===========================================================================
// Routes (Phase 5). One row per stop in the Routes tab. A route with no stops does not exist.
// ===========================================================================

var MAX_STOPS = 60;
var ROUTE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Rows of one route become one route object. A rewrite saves the new rows before it deletes the
 * old ones, so an interruption can leave both versions behind; only the newest UpdatedAt counts.
 */
function buildRoute_(rows) {
  if (!rows.length) return null;
  var newest = '';
  rows.forEach(function (r) { var u = String(r.UpdatedAt || ''); if (u > newest) newest = u; });
  var cur = rows.filter(function (r) { return String(r.UpdatedAt || '') === newest; })
    .sort(function (a, b) { return num_(a.StopOrder, 0) - num_(b.StopOrder, 0); });
  return {
    routeId: cur[0].RouteID, routeName: String(cur[0].RouteName), updatedAt: newest,
    stops: cur.map(function (r) {
      return { placeId: r.PlaceID, plannedArrival: String(r.PlannedArrival || ''), stopNote: String(r.StopNote || ''), visited: toBool_(r.Visited) };
    })
  };
}

/** Every route of a trip, sorted by name. */
function getRoutes_(email, tripId) {
  requireMember_(email, tripId);
  var by = {};
  readRows_('Routes').forEach(function (r) {
    if (r.TripID !== tripId) return;
    (by[r.RouteID] = by[r.RouteID] || []).push(r);
  });
  return Object.keys(by).map(function (id) { return buildRoute_(by[id]); }).sort(function (a, b) {
    var x = a.routeName.toLowerCase(), y = b.routeName.toLowerCase();
    return x < y ? -1 : x > y ? 1 : (a.routeId < b.routeId ? -1 : 1);
  });
}

function getRoute_(email, tripId, routeId) {
  requireMember_(email, tripId);
  var rows = readRows_('Routes').filter(function (r) { return r.TripID === tripId && r.RouteID === routeId; });
  return buildRoute_(rows);
}

/** Changes whenever any route of the trip is saved or deleted. The poll compares it to skip route downloads. */
function routeStamp_(tripId) {
  var n = 0, max = '';
  readRows_('Routes').forEach(function (r) {
    if (r.TripID !== tripId) return;
    n++;
    var u = String(r.UpdatedAt || ''); if (u > max) max = u;
  });
  return n + '|' + max;
}

/** Deletes sheet rows, grouping neighbours into as few calls as possible. */
function deleteSheetRows_(sh, rowNumbers) {
  var rows = rowNumbers.slice().sort(function (a, b) { return b - a; });
  var i = 0;
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sh.deleteRows(rows[j], j - i + 1);
    i = j + 1;
  }
}

/**
 * Replaces the whole stop list of one route.
 *   r = { tripId, routeId, routeName, baseUpdatedAt, stops:[{placeId, plannedArrival, stopNote, visited}] }
 * baseUpdatedAt is the route version the caller started from ('' for a new route). If someone saved
 * in the meantime it no longer matches, nothing is written, and { ok:false, stale:true, route } returns
 * the latest (route is null if it was deleted) so the caller can re-apply its change and try again.
 * An empty stop list deletes the route. Returns { ok:true, route }.
 */
function saveRouteStops_(email, r) {
  email = normEmail_(email);
  if (!r || typeof r !== 'object') throw new Error('No route was sent.');
  var tripId = r.tripId;
  requireMember_(email, tripId);

  var routeId = cleanText_(r.routeId, 64, 'Route', true);
  if (!ROUTE_ID_RE.test(routeId)) throw new Error('That route id is not valid.');
  var base = cleanText_(r.baseUpdatedAt, 40, 'Version');
  var name = cleanText_(r.routeName, 60, 'Route name');
  if (!Array.isArray(r.stops)) throw new Error('Stops must be a list.');
  if (r.stops.length > MAX_STOPS) throw new Error('A route can have at most ' + MAX_STOPS + ' stops.');

  var inTrip = {};
  readRows_('Places').forEach(function (p) { if (p.TripID === tripId) inTrip[p.PlaceID] = true; });
  var seen = {};
  var stops = r.stops.map(function (s) {
    if (!s || typeof s !== 'object') throw new Error('Each stop must be an object.');
    var pid = cleanText_(s.placeId, 64, 'Place', true);
    if (!inTrip[pid]) throw new Error('A stop refers to a place that is not in this trip.');
    if (seen[pid]) throw new Error('Each place can appear only once in a route.');
    seen[pid] = true;
    return { placeId: pid, plannedArrival: cleanIso_(s.plannedArrival, 'Planned arrival'), stopNote: cleanText_(s.stopNote, 200, 'Stop note'), visited: s.visited === true };
  });

  return withLock_(function () {
    var existing = readRowsFresh_('Routes').filter(function (x) { return x.RouteID === routeId; });
    if (existing.some(function (x) { return x.TripID !== tripId; })) throw new Error('That route id is already in use.');
    var current = buildRoute_(existing);
    var currentVersion = current ? current.updatedAt : '';
    if (currentVersion !== base) return { ok: false, stale: true, route: current };

    var sh = sheet_('Routes');
    var route = null;
    if (stops.length) {
      var now = nowIso_();
      if (currentVersion && now <= currentVersion) now = new Date(Date.parse(currentVersion) + 1).toISOString(); // always moves forward
      var label = name || (current ? current.routeName : 'Route');
      var values = stops.map(function (s, i) {
        return rowArray_('Routes', { RouteID: routeId, TripID: tripId, RouteName: label, StopOrder: i + 1, PlaceID: s.placeId,
          PlannedArrival: s.plannedArrival, StopNote: s.stopNote, Visited: s.visited, UpdatedBy: email, UpdatedAt: now });
      });
      sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);   // new rows first...
      route = { routeId: routeId, routeName: label, updatedAt: now, stops: stops };
    }
    deleteSheetRows_(sh, existing.map(function (x) { return x._row; }));                          // ...then the old ones
    cacheClear_('Routes');
    return { ok: true, stale: false, route: route };
  });
}

// ===========================================================================
// Trip tools (Phase 6): starter lists, CSV import, pin finding, members, settings
// ===========================================================================

var GEOCODE_BUDGET_MS = 200000;   // stop looking up pins after about 3 minutes, inside Apps Script's 6-minute limit
var MAX_GEOCODES_PER_CALL = 40;   // pin lookups per import call; the rest are found later with geocodeMissing
var MAX_CSV_ROWS = 200;
var MAX_CSV_CHARS = 100000;

/** Spec section 7 search link, used when a seed row has no Google Maps link of its own. */
function searchUrl_(name, area, city) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([name, area, city].filter(Boolean).join(' '));
}

/** The seed has no "kind" column, so Anchors are classified from their name and notes. */
function inferAnchorKind_(name, notes) {
  var n = String(name || '').toLowerCase(), t = (n + ' ' + String(notes || '')).toLowerCase();
  if (/\b(stadium|ground)\b/.test(n) || /^ground\b/.test(String(notes || '').toLowerCase())) return 'Stadium';
  if (/\b(station|tram|rail)\b/.test(t)) return 'Station';
  if (/\b(hotel|hostel|b&b|apartment|lodging)\b/.test(n)) return 'Lodging';
  return 'Other';
}

function placeKey_(name, city) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim() + '|' + String(city || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Writes several rows with one call. */
function appendRows_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  var values = objs.map(function (o) { return rowArray_(name, o); });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, values[0].length).setValues(values);
}

// ---------------------------------------------------------------- the Edinburgh starter list (spec section 14)
// [Name, Category, Area, LocalTags, MatchDayTags, HoursNote, Notes]. Research starters, not verified listings.
var STARTER_CITY = 'Edinburgh';
var STARTER_ROWS = [
  ['Murrayfield Stadium', 'Anchor', 'Murrayfield', '', '', '', 'Ground. Set as the trip venue'],
  ['Haymarket Station', 'Anchor', 'Haymarket', '', '', '', 'Rail and tram hub on the route to the ground'],
  ['Edinburgh Waverley', 'Anchor', 'City Centre', '', '', '', 'Main station. Check last trains and trams for the night'],
  ["Ryrie's Bar", 'Pub', 'Haymarket', '', 'queue_risk,shows_live_rugby', '', 'Traditional pub next to Haymarket on the walk to the ground'],
  ['The Roseburn Bar', 'Pub', 'Roseburn', '', 'queue_risk,shows_live_rugby', '', 'Near the ground; expect crowds on match days'],
  ['The Athletic Arms (Diggers)', 'Pub', 'Gorgie', 'proper_boozer,locals_favourite', 'queue_risk', '', 'Famous local; pies and a pint. Football-heavy area so check fixtures'],
  ['Sheep Heid Inn', 'Pub', 'Duddingston', 'proper_boozer,hidden_gem', '', '', "Historic pub near Arthur's Seat; good for an unhurried day"],
  ['The Oxford Bar', 'Pub', 'New Town', 'proper_boozer,locals_favourite', '', 'Check opening hours', 'Small and old-school; space is tight'],
  ['Bennets Bar', 'Pub', 'Tollcross', 'proper_boozer,locals_favourite', '', '', 'Victorian interior and a good whisky back-bar'],
  ["Kay's Bar", 'Pub', 'New Town', 'proper_boozer,hidden_gem', '', '', 'Tiny and cosy; very limited space'],
  ["Sandy Bell's", 'Pub', 'Old Town', 'proper_boozer,locals_favourite', '', '', 'Folk music sessions; check what is on'],
  ['Caf\u00e9 Royal Circle Bar', 'Pub', 'New Town', '', '', '', 'Ornate Victorian bar; known for oysters and ales'],
  ['The Bow Bar', 'Whisky_Bar', 'Old Town', 'whisky_bar_real_list,proper_boozer', 'queue_risk', '', 'Large whisky range and cask ales; small and busy'],
  ['Teuchters Landing', 'Pub', 'Leith', 'locals_favourite', '', '', 'Waterfront in Leith; good for a pre- or post-match wander'],
  ["Malone's Irish Bar", 'Pub', 'Central', 'great_guinness', 'queue_risk', '', 'Irish bar to test the Guinness; confirm location and opening hours'],
  ["Finnegan's Wake", 'Pub', 'Old Town', 'great_guinness', 'queue_risk', '', 'Irish bar near the Old Town; confirm'],
  ['The Scotch Whisky Experience', 'Tasting', 'Royal Mile', 'tourist_trap', '', 'Book ahead', 'Structured whisky tour and tasting; check tour times against kickoff'],
  ['Holyrood Distillery', 'Tasting', 'Holyrood', '', '', 'Book ahead', 'Distillery tour'],
  ['Bramble', 'Cocktails', 'New Town', '', '', '', 'Basement cocktail bar'],
  ['Panda & Sons', 'Cocktails', 'New Town', 'hidden_gem', '', '', 'Speakeasy-style; look for the barber shop entrance'],
  ['Mums Great Comfort Food', 'Restaurant', 'Old Town', '', '', '', 'Hearty sit-down food; good for a food stop'],
  ['Dishoom Edinburgh', 'Restaurant', 'New Town', '', 'queue_risk', '', 'Often has a queue; plan ahead'],
  ['The Fishmarket Newhaven', 'Restaurant', 'Newhaven', '', '', '', 'Seafood and fish and chips by the harbour'],
  ['Oink', 'Grab_and_Go', 'Old Town', '', '', '', 'Hog roast rolls; easy between pubs'],
  ["Mary's Milk Bar", 'Grab_and_Go', 'Grassmarket', '', '', '', 'Ice cream stop in the Grassmarket'],
  ['Edinburgh Castle', 'Sight', 'Old Town', 'tourist_trap', '', 'Book ahead', 'Allow 2-3 hours; best on a non-match day'],
  ["Arthur's Seat", 'Sight', 'Holyrood Park', '', '', '', 'Allow 1.5-2 hours; check the weather and daylight'],
  ['Greyfriars Kirkyard', 'Sight', 'Old Town', '', '', '', 'Short walk; free'],
  ['Calton Hill', 'Sight', 'City Centre', '', '', '', 'Short climb; good city views']
];

/** Adds any starter rows missing from the Seed tab (matched by city and name). Safe to run again. */
function loadStarterSeed_() {
  return withLock_(function () {
    var have = {};
    readRowsFresh_('Seed').forEach(function (r) { have[placeKey_(r.Name, r.City)] = true; });
    var rows = [];
    STARTER_ROWS.forEach(function (s) {
      if (have[placeKey_(s[0], STARTER_CITY)]) return;
      rows.push({ City: STARTER_CITY, Name: s[0], Category: s[1], Area: s[2], GoogleMapsUrl: searchUrl_(s[0], s[2], STARTER_CITY),
        LocalTags: s[3], MatchDayTags: s[4], HoursNote: s[5], Notes: s[6], VerifyFlag: 'Yes' });
    });
    appendRows_('Seed', rows);
    cacheClear_('Seed');
    return rows.length;
  });
}

function getSeedCities_(email) {
  requireAnyTrip_(email);
  var by = {};
  readRows_('Seed').forEach(function (r) { var c = String(r.City); by[c] = (by[c] || 0) + 1; });
  return Object.keys(by).sort().map(function (c) { return { city: c, count: by[c] }; });
}

// ---------------------------------------------------------------- shared import code
/**
 * Validates, de-duplicates, finds pins for, and saves a list of places in one go.
 * items are place inputs as savePlace takes them, plus _line (for messages), _error (a problem found
 * earlier) and geocodeSource (what to record when a pin is found by lookup).
 */
function importPlaces_(email, tripId, items) {
  var defaultCity = tripCityFor_(tripId);
  var existing = {}, sumLat = 0, sumLng = 0, n = 0, near = null;
  readRows_('Places').forEach(function (p) {
    if (p.TripID !== tripId) return;
    existing[placeKey_(p.Name, p.City)] = true;
    var la = numOrNull_(p.Lat), ln = numOrNull_(p.Lng);
    if (la !== null && ln !== null) { sumLat += la; sumLng += ln; n++; }
  });
  if (n) near = { lat: sumLat / n, lng: sumLng / n };

  var out = { total: items.length, added: 0, duplicates: 0, rejected: [], geocoded: 0, notFound: 0, notAttempted: 0, quotaHit: false };
  var ready = [];
  items.forEach(function (it) {
    try {
      if (it._error) throw new Error(it._error);
      var f = cleanPlaceFields_(it, true, defaultCity);
      var key = placeKey_(f.Name, f.City);
      if (existing[key]) { out.duplicates++; return; }
      existing[key] = true;
      ready.push({ f: f, item: it });
    } catch (e) {
      out.rejected.push({ line: it._line || 0, name: String(it.name || '').slice(0, 60), reason: e.message });
    }
  });

  var deadline = Date.now() + GEOCODE_BUDGET_MS, tried = 0;
  ready.forEach(function (r) {
    var f = r.f;
    if (f.Lat !== '') return;
    if (out.quotaHit || tried >= MAX_GEOCODES_PER_CALL || Date.now() > deadline) { out.notAttempted++; return; }
    tried++;
    var g = geocodePlace_([f.Name, f.Area, f.City].filter(Boolean).join(', '), near);
    if (g && g.ok) {
      f.Lat = g.lat; f.Lng = g.lng; f.Address = String(g.formatted || '').slice(0, 200);
      f.CoordSource = r.item.geocodeSource || 'Geocoded'; f.CoordConfirmed = false;
      out.geocoded++;
    } else {
      out.notFound++;
      if (g && /limit/i.test(String(g.error || ''))) out.quotaHit = true;
    }
  });

  var now = nowIso_();
  var rows = ready.map(function (r) {
    return Object.assign({}, r.f, { PlaceID: newId_(), TripID: tripId, AddedBy: email, CreatedAt: now, UpdatedAt: now, DesireToTry: '{}' });
  });
  withLock_(function () {
    appendRows_('Places', rows);
    cacheClear_('Places');
  });
  out.added = rows.length;
  return out;
}

// ---------------------------------------------------------------- seed import
function importSeed_(email, tripId, city) {
  email = normEmail_(email);
  requireMember_(email, tripId);
  var wanted = cleanText_(city, 80, 'City', true).toLowerCase();
  var rows = readRows_('Seed').filter(function (r) { return String(r.City).toLowerCase() === wanted; });
  if (!rows.length) throw new Error('There is no starter list for "' + cleanText_(city, 80, 'City') + '".');
  var items = rows.map(function (r, i) {
    var it = {
      name: r.Name, category: r.Category, area: r.Area, city: r.City,
      googleMapsUrl: r.GoogleMapsUrl || searchUrl_(r.Name, r.Area, r.City),
      localTags: r.LocalTags, matchDayTags: r.MatchDayTags, hoursNote: r.HoursNote, notes: r.Notes,
      lastVerified: r.LastVerified, source: 'Seed', coordConfirmed: false, geocodeSource: 'Seed', _line: i + 1
    };
    var la = numOrNull_(r.Lat), ln = numOrNull_(r.Lng);
    if (la !== null && ln !== null) { it.lat = la; it.lng = ln; it.coordSource = 'Seed'; }
    if (r.Category === 'Anchor') it.anchorKind = inferAnchorKind_(r.Name, r.Notes);
    return it;
  });
  return importPlaces_(email, tripId, items);
}

// ---------------------------------------------------------------- CSV import
/** Reads CSV text into rows of cells. Handles quotes, doubled quotes, commas and line breaks inside quotes, CRLF, a BOM. */
function parseCsv_(text) {
  var s = String(text).replace(/^\uFEFF/, '');
  var rows = [], row = [], field = '', inQ = false, line = 1, rowLine = 1, qLine = 1;
  function endRow() {
    row.push(field); field = '';
    if (row.some(function (c) { return String(c).trim() !== ''; })) rows.push({ line: rowLine, cells: row });
    row = [];
  }
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (inQ) {
      if (ch === '"') { if (s.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false; }
      else { field += ch; if (ch === '\n') line++; }
    } else if (ch === '"' && field === '') { inQ = true; qLine = line; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s.charAt(i + 1) === '\n') i++;
      endRow(); line++; rowLine = line;
    } else field += ch;
  }
  if (inQ) throw new Error('A quoted value starting on line ' + qLine + ' is never closed.');
  if (field !== '' || row.length) endRow();
  return rows;
}

var CSV_COLUMNS = {
  name: 'name', category: 'category', type: 'category', city: 'city', area: 'area',
  lat: 'lat', latitude: 'lat', lng: 'lng', lon: 'lng', long: 'lng', longitude: 'lng',
  googlemapsurl: 'url', mapsurl: 'url', url: 'url', link: 'url',
  localtags: 'localTags', matchdaytags: 'matchDayTags', hoursnote: 'hoursNote', hours: 'hoursNote',
  notes: 'notes', note: 'notes', lastverified: 'lastVerified', anchorkind: 'anchorKind'
};
var CSV_CATEGORIES = {
  pub: 'Pub', pubs: 'Pub', restaurant: 'Restaurant', restaurants: 'Restaurant', cocktails: 'Cocktails', cocktail: 'Cocktails', cocktailbar: 'Cocktails',
  grabandgo: 'Grab_and_Go', grabgo: 'Grab_and_Go', takeaway: 'Grab_and_Go', whiskybar: 'Whisky_Bar', whiskeybar: 'Whisky_Bar',
  sight: 'Sight', sights: 'Sight', tasting: 'Tasting', tastings: 'Tasting', anchor: 'Anchor'
};

function csvTags_(v) {
  return String(v || '').split(/[,;|]/).map(function (t) { return t.trim().toLowerCase().replace(/\s+/g, '_'); }).filter(Boolean).join(',');
}

function importCsv_(email, tripId, csvText) {
  email = normEmail_(email);
  requireMember_(email, tripId);
  var text = csvText === undefined || csvText === null ? '' : String(csvText);
  if (!text.trim()) throw new Error('Paste or choose a CSV first.');
  if (text.length > MAX_CSV_CHARS) throw new Error('That CSV is too large (the limit is ' + MAX_CSV_CHARS + ' characters).');
  var rows = parseCsv_(text);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one place.');

  var col = {}, ignored = [];
  rows[0].cells.forEach(function (h, i) {
    var key = CSV_COLUMNS[String(h).toLowerCase().replace(/[^a-z]/g, '')];
    if (key && col[key] === undefined) col[key] = i; else if (String(h).trim()) ignored.push(String(h).trim());
  });
  if (col.name === undefined || col.category === undefined) throw new Error('The header row needs at least a Name column and a Category column.');
  var data = rows.slice(1);
  if (data.length > MAX_CSV_ROWS) throw new Error('That CSV has ' + data.length + ' places; the limit is ' + MAX_CSV_ROWS + '. Split it into smaller files.');

  var items = data.map(function (r) {
    function cell(k) { return col[k] === undefined ? '' : String(r.cells[col[k]] === undefined ? '' : r.cells[col[k]]).trim(); }
    var it = { name: cell('name'), _line: r.line, source: 'Own', geocodeSource: 'Geocoded' };
    var catKey = cell('category').toLowerCase().replace(/[^a-z]/g, '');
    if (!CSV_CATEGORIES[catKey]) { it._error = 'Category "' + cell('category').slice(0, 30) + '" is not one of: ' + CATEGORIES.join(', ') + '.'; return it; }
    it.category = CSV_CATEGORIES[catKey];
    it.city = cell('city'); it.area = cell('area');
    it.googleMapsUrl = cell('url'); it.hoursNote = cell('hoursNote'); it.notes = cell('notes');
    it.localTags = csvTags_(cell('localTags')); it.matchDayTags = csvTags_(cell('matchDayTags'));
    if (cell('lastVerified')) it.lastVerified = cell('lastVerified');
    if (cell('lat') !== '' || cell('lng') !== '') { it.lat = cell('lat'); it.lng = cell('lng'); it.coordSource = 'Manual'; it.coordConfirmed = true; }
    if (it.category === 'Anchor') it.anchorKind = cell('anchorKind') ? cell('anchorKind') : inferAnchorKind_(it.name, it.notes);
    return it;
  });
  var res = importPlaces_(email, tripId, items);
  res.ignoredColumns = ignored;
  return res;
}

// ---------------------------------------------------------------- finding pins later
/** Looks up pins for places that have none (at most 20 per call). Returns { tried, found, remaining, quotaHit }. */
function geocodeMissing_(email, tripId) {
  email = normEmail_(email);
  requireMember_(email, tripId);
  var blank = readRows_('Places').filter(function (p) { return p.TripID === tripId && numOrNull_(p.Lat) === null; });
  var out = { tried: 0, found: 0, remaining: blank.length, quotaHit: false };
  var sumLat = 0, sumLng = 0, n = 0, near = null;
  readRows_('Places').forEach(function (p) {
    var la = numOrNull_(p.Lat), ln = numOrNull_(p.Lng);
    if (p.TripID === tripId && la !== null && ln !== null) { sumLat += la; sumLng += ln; n++; }
  });
  if (n) near = { lat: sumLat / n, lng: sumLng / n };

  var found = [], deadline = Date.now() + GEOCODE_BUDGET_MS;
  for (var i = 0; i < blank.length && out.tried < 20 && Date.now() < deadline && !out.quotaHit; i++) {
    var p = blank[i];
    out.tried++;
    var g = geocodePlace_([p.Name, p.Area, p.City].filter(Boolean).join(', '), near);
    if (g && g.ok) found.push({ id: p.PlaceID, g: g });
    else if (g && /limit/i.test(String(g.error || ''))) out.quotaHit = true;
  }
  if (found.length) {
    withLock_(function () {
      var fresh = {};
      readRowsFresh_('Places').forEach(function (r) { fresh[r.PlaceID] = r; });
      found.forEach(function (f) {
        var cur = fresh[f.id];
        if (!cur || numOrNull_(cur.Lat) !== null) return;            // someone placed it by hand meanwhile
        var merged = Object.assign({}, cur, {
          Lat: f.g.lat, Lng: f.g.lng, Address: cur.Address || String(f.g.formatted || '').slice(0, 200),
          CoordSource: cur.Source === 'Seed' ? 'Seed' : 'Geocoded', CoordConfirmed: false, UpdatedAt: nowIso_()
        });
        writeRow_('Places', cur._row, cur.PlaceID, merged);
        out.found++;
      });
      cacheClear_('Places');
    });
  }
  out.remaining = Math.max(0, blank.length - out.found);
  return out;
}

// ---------------------------------------------------------------- members
function removeMember_(email, tripId, memberEmail) {
  email = normEmail_(email);
  requireOwner_(email, tripId);
  var target = cleanEmail_(memberEmail);
  return withLock_(function () {
    var row = null;
    readRowsFresh_('Members').forEach(function (m) { if (m.TripID === tripId && normEmail_(m.Email) === target) row = m; });
    if (!row) throw new Error('That person is not a member of this trip.');
    if (row.Role === 'Owner') throw new Error('The trip owner cannot be removed.');
    sheet_('Members').deleteRow(row._row);
    cacheClear_('Members');
    return { removed: target };
  });
}

// ---------------------------------------------------------------- settings
function requireAnyOwner_(email) {
  email = normEmail_(email);
  var ok = readRows_('Members').some(function (m) { return normEmail_(m.Email) === email && m.Role === 'Owner'; });
  if (!ok) throw new Error('Only a trip owner can change settings.');
}

var SETTING_FIELDS = [
  { key: 'ScoreRed', label: 'Red pins: scores below', type: 'int', min: 1, max: 100, help: 'Scores under this are red.' },
  { key: 'ScoreAmber', label: 'Amber pins: scores below', type: 'int', min: 1, max: 100, help: 'Scores from the red limit up to this are amber.' },
  { key: 'ScoreLightGreen', label: 'Light green pins: scores below', type: 'int', min: 1, max: 100, help: 'At or above this is dark green.' },
  { key: 'SplitThreshold', label: 'Split decision: points apart', type: 'int', min: 1, max: 100, help: 'Two people\u2019s scores this far apart raise the split flag.' },
  { key: 'NearbyDefaultMinutes', label: 'Nearby radius to start with (minutes)', type: 'enum', options: ['5', '10', '15'], help: 'Estimated walk.' },
  { key: 'RefreshSeconds', label: 'Live refresh (seconds)', type: 'int', min: 5, max: 120, help: 'How often phones check for changes.' },
  { key: 'WalkMetersPerMinute', label: 'Walking speed (metres per minute)', type: 'num', min: 30, max: 150, help: '80 is a steady walk.' },
  { key: 'DetourFactor', label: 'Detour factor', type: 'num', min: 1, max: 3, help: 'Straight-line distance is multiplied by this to estimate the walk.' },
  { key: 'MatchDayWindowHoursBefore', label: 'Match day starts (hours before kickoff)', type: 'int', min: 0, max: 48, help: '' },
  { key: 'MatchDayWindowHoursAfter', label: 'Match day ends (hours after kickoff)', type: 'int', min: 0, max: 48, help: '' },
  { key: 'MaxWaypoints', label: 'Stops per Google Maps leg', type: 'int', min: 2, max: 20, help: 'Google Maps kept 9 in the spike test.' },
    { key: 'PacingEnabled', label: 'Food nudge', type: 'enum', options: ['true', 'false'], help: 'true turns on the "food stop?" nudge and the wind-down ranking. Each phone nudges its own user.' },
  { key: 'PacingFoodNudgeDrinks', label: 'Drinks before the food nudge', type: 'int', min: 1, max: 20, help: 'Pints, whiskies and other drinks since your last food entry.' },
  { key: 'PacingWindDownHour', label: 'Wind-down hour (24 h clock)', type: 'int', min: 0, max: 23, help: 'After this hour the app will favour whisky bars and short walks.' },
  { key: 'Currency', label: 'Currency code', type: 'currency', help: 'Three letters, for example GBP.' },
  { key: 'LocalTags', label: 'Local tags', type: 'tags', help: 'Comma separated, letters, numbers and underscores.' },
  { key: 'MatchDayTags', label: 'Match-day tags', type: 'tags', help: 'Comma separated, letters, numbers and underscores.' }
];

/** The settings form: every editable setting with its current value, limits and help text. */
function getSettingsForm_(email) {
  requireAnyTrip_(email);
  var m = settingsMap_();
  return SETTING_FIELDS.map(function (f) {
    return { key: f.key, label: f.label, type: f.type, min: f.min, max: f.max, options: f.options, help: f.help, value: String(m[f.key] === undefined ? '' : m[f.key]) };
  });
}

function cleanSettingValue_(f, v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  if (f.type === 'int' || f.type === 'num') {
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(f.label + ' must be a number.');
    var n = Number(s);
    if (f.type === 'int' && n !== Math.floor(n)) throw new Error(f.label + ' must be a whole number.');
    if (n < f.min || n > f.max) throw new Error(f.label + ' must be between ' + f.min + ' and ' + f.max + '.');
    return String(n);
  }
  if (f.type === 'enum') {
    if (f.options.indexOf(s) < 0) throw new Error(f.label + ' must be one of: ' + f.options.join(', ') + '.');
    return s;
  }
  if (f.type === 'currency') {
    s = s.toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) throw new Error('Currency must be a three-letter code such as GBP.');
    return s;
  }
  var tags = cleanTags_(s, f.label);
  if (!tags) throw new Error(f.label + ' cannot be empty.');
  return tags;
}

/**
 * Saves the settings that were sent (any subset). Only an owner of some trip may do this.
 * Returns { settings, fields } so the app can update at once.
 */
function saveSettings_(email, values) {
  email = normEmail_(email);
  requireAnyOwner_(email);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('No settings were sent.');
  var byKey = {};
  SETTING_FIELDS.forEach(function (f) { byKey[f.key] = f; });
  var clean = {};
  Object.keys(values).forEach(function (k) {
    if (!byKey[k]) throw new Error('Unknown setting "' + String(k).slice(0, 40) + '".');
    clean[k] = cleanSettingValue_(byKey[k], values[k]);
  });
  var merged = Object.assign({}, settingsMap_(), clean);
  var red = Number(merged.ScoreRed), amber = Number(merged.ScoreAmber), green = Number(merged.ScoreLightGreen);
  if (!(red < amber && amber < green)) throw new Error('The score limits must go up: red below amber below light green.');

  withLock_(function () {
    var sh = sheet_('Settings');
    var rows = readRowsFresh_('Settings');
    Object.keys(clean).forEach(function (k) {
      var hit = null;
      rows.forEach(function (r) { if (String(r.Key) === k) hit = r; });
      if (hit) sh.getRange(hit._row, 2).setValue(clean[k]);
      else appendRow_('Settings', { Key: k, Value: clean[k] });
    });
    cacheClear_('Settings');
  });
  return { settings: settingsForClient_(), fields: getSettingsForm_(email) };
}

// ===========================================================================
// One-call bundle for opening a trip (one round trip instead of four)
// ===========================================================================

function getTripData_(email, tripId) {
  var me = requireMember_(email, tripId);
  var tripRow = null;
  readRows_('Trips').forEach(function (t) { if (t.TripID === tripId) tripRow = t; });
  if (!tripRow) throw new Error(MSG_NOT_MEMBER);
  return {
    you: normEmail_(email),
    trip: tripFromRow_(tripRow, me.Role),
    members: getMembers_(email, tripId),
    settings: settingsForClient_(),
    places: getPlaces_(email, tripId),
    criteria: criteriaByCategory_(),
    serverTime: nowIso_(),
   checkIns: getCheckIns_(email, tripId, hoursAgoIso_(36)),
   stamp: tripStamp_(tripId),
   routes: getRoutes_(email, tripId),
   routeStamp: routeStamp_(tripId)
  };
}
// ===========================================================================
// Phase 7: exact walking times and the trip recap
// ===========================================================================

var MAX_EXACT_LEGS = 25;
var WALK_CACHE_SECONDS = 21600; // exact times are cached for 6 hours

function r5_(n) { return Math.round(Number(n) * 1e5) / 1e5; }
function walkCacheKey_(a, b) { return 'walk:' + [a.lat, a.lng, b.lat, b.lng].map(r5_).join(','); }

/** One real walking lookup (free Maps service). Never throws. Tests replace this function. */
function fetchWalk_(a, b) {
  try {
    var res = Maps.newDirectionFinder().setOrigin(a.lat, a.lng).setDestination(b.lat, b.lng)
      .setMode(Maps.DirectionFinder.Mode.WALKING).getDirections();
    if (res.status === 'OVER_QUERY_LIMIT') return { ok: false, quota: true };
    if (res.status !== 'OK' || !res.routes || !res.routes.length || !res.routes[0].legs.length) return { ok: false };
    var l = res.routes[0].legs[0];
    return { ok: true, sec: l.duration.value, m: l.distance.value };
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    return { ok: false, quota: /too many times|quota|limit/i.test(msg) };
  }
}

function cleanPoint_(p, label) {
  if (!p || typeof p !== 'object') throw new Error(label + ' is missing.');
  var lat = cleanNumber_(p.lat, -90, 90, label + ' latitude');
  var lng = cleanNumber_(p.lng, -180, 180, label + ' longitude');
  if (lat === '' || lng === '') throw new Error(label + ' needs a latitude and longitude.');
  return { lat: lat, lng: lng };
}

/**
 * legs: [{from:{lat,lng}, to:{lat,lng}}], at most 25. Returns { results, tried, quotaHit } where
 * results[i] is { min, m } (walking minutes, metres) or null if that leg could not be found.
 * Cached answers cost no quota. Stops at once if the free daily limit is hit.
 */
function getExactWalkingTimes_(email, tripId, legs) {
  requireMember_(email, tripId);
  if (!Array.isArray(legs)) throw new Error('Legs must be a list.');
  if (legs.length > MAX_EXACT_LEGS) throw new Error('At most ' + MAX_EXACT_LEGS + ' legs at a time.');
  var clean = legs.map(function (l) {
    if (!l || typeof l !== 'object') throw new Error('Each leg must be an object.');
    return { from: cleanPoint_(l.from, 'Start'), to: cleanPoint_(l.to, 'End') };
  });
  var cache = CacheService.getScriptCache();
  var out = { results: [], tried: 0, quotaHit: false };
  var deadline = Date.now() + GEOCODE_BUDGET_MS;
  clean.forEach(function (l) {
    var key = walkCacheKey_(l.from, l.to), hit = null;
    try { hit = cache.get(key); } catch (e) { /* optional */ }
    if (hit) { out.results.push(JSON.parse(hit)); return; }
    if (out.quotaHit || Date.now() > deadline) { out.results.push(null); return; }
    out.tried++;
    var w = fetchWalk_(l.from, l.to);
    if (w.ok) {
      var r = { min: Math.round(w.sec / 6) / 10, m: Math.round(w.m) };
      out.results.push(r);
      try { cache.put(key, JSON.stringify(r), WALK_CACHE_SECONDS); } catch (e) { /* optional */ }
    } else {
      if (w.quota) out.quotaHit = true;
      out.results.push(null);
    }
  });
  return out;
}

/** Whole-trip summary, worked out from the sheet (nothing stored). */
function getTripRecap_(email, tripId) {
  requireMember_(email, tripId);
  var places = getPlaces_(email, tripId);
  var byId = {};
  places.forEach(function (p) { byId[p.placeId] = p; });
  var ratable = places.filter(function (p) { return p.category !== 'Anchor'; });
  var scored = ratable.filter(function (p) { return p.blendedScore !== null; });
  var top = scored.slice().sort(function (a, b) { return b.blendedScore - a.blendedScore || a.name.localeCompare(b.name); })
    .slice(0, 3).map(function (p) { return { name: p.name, score: p.blendedScore, split: p.split }; });
  var split = null;
  ratable.forEach(function (p) {
    if (!p.split) return;
    var v = Object.keys(p.personScores).map(function (k) { return p.personScores[k]; });
    var spread = Math.round(Math.max.apply(null, v) - Math.min.apply(null, v));
    if (!split || spread > split.spread) split = { name: p.name, spread: spread };
  });

  // Drink and food tallies: replay every entry, an undo (-1) takes one off (never below zero).
  var per = {};
  readRows_('CheckIns').filter(function (c) { return c.TripID === tripId && TALLY_TYPES.indexOf(c.Type) >= 0; })
    .sort(function (a, b) { var x = String(a.Timestamp), y = String(b.Timestamp); return x < y ? -1 : x > y ? 1 : 0; })
    .forEach(function (c) {
      var e = normEmail_(c.UserEmail);
      var t = per[e] || (per[e] = { PINT: 0, WHISKY: 0, OTHER_DRINK: 0, FOOD: 0 });
      t[c.Type] = Math.max(0, t[c.Type] + (String(c.Value) === '-1' ? -1 : 1));
    });
  var group = { PINT: 0, WHISKY: 0, OTHER_DRINK: 0, FOOD: 0 };
  Object.keys(per).forEach(function (e) { TALLY_TYPES.forEach(function (t) { group[t] += per[e][t]; }); });
  var people = getMembers_(email, tripId).map(function (m) {
    var t = per[m.email] || { PINT: 0, WHISKY: 0, OTHER_DRINK: 0, FOOD: 0 };
    return { name: m.displayName, PINT: t.PINT, WHISKY: t.WHISKY, OTHER_DRINK: t.OTHER_DRINK, FOOD: t.FOOD };
  });

  var cheapest = null, dearest = null;
  readRows_('Ratings').forEach(function (r) {
    if (r.TripID !== tripId || r.PintPrice === '' || r.PintPrice === null || r.PintPrice === undefined) return;
    var price = Number(r.PintPrice), p = byId[r.PlaceID];
    if (!isFinite(price) || !p) return;
    if (!cheapest || price < cheapest.price) cheapest = { name: p.name, price: price };
    if (!dearest || price > dearest.price) dearest = { name: p.name, price: price };
  });

  return {
    visited: ratable.filter(function (p) { return p.status === 'Been'; }).length,
    totalPlaces: ratable.length, rated: scored.length, topRated: top, biggestSplit: split,
    group: group, people: people, cheapestPint: cheapest, dearestPint: dearest
  };
}
// ===========================================================================
// PUBLIC API: callable from the browser via google.script.run
// ===========================================================================

function getMyTrips() { return getMyTrips_(currentEmail_()); }
function createTrip(tripData) { return createTrip_(currentEmail_(), tripData); }
function addMember(tripId, email, displayName) { return addMember_(currentEmail_(), tripId, email, displayName); }
function getMembers(tripId) { return getMembers_(currentEmail_(), tripId); }
function getPlaces(tripId) { return getPlaces_(currentEmail_(), tripId); }
function savePlace(place) { return savePlace_(currentEmail_(), place); }
function updatePlace(place) { return updatePlace_(currentEmail_(), place); }
function addCheckIn(checkIn) { return addCheckIn_(currentEmail_(), checkIn); }
function getTripData(tripId) { return getTripData_(currentEmail_(), tripId); }
function getSettings() { var e = currentEmail_(); requireAnyTrip_(e); return settingsForClient_(); }
// ----------------------------- BLOCK B -------------------------------------
// Add to the PUBLIC API section at the bottom of Data.gs:
 
function getCriteria(category) { return getCriteria_(currentEmail_(), category); }
function saveRating(rating) { return saveRating_(currentEmail_(), rating); }
function getRatings(placeId) { return getRatings_(currentEmail_(), placeId); }

function getCheckIns(tripId, sinceIso) { return getCheckIns_(currentEmail_(), tripId, sinceIso); }
function getSync(tripId, sinceIso, stamp, routeStamp) { return getSync_(currentEmail_(), tripId, sinceIso, stamp, routeStamp); }
 function getRoute(tripId, routeId) { return getRoute_(currentEmail_(), tripId, routeId); }
function saveRouteStops(route) { return saveRouteStops_(currentEmail_(), route); }
function getSeedCities() { return getSeedCities_(currentEmail_()); }
function importSeed(tripId, city) { return importSeed_(currentEmail_(), tripId, city); }
function importCsv(tripId, csvText) { return importCsv_(currentEmail_(), tripId, csvText); }
function geocodeMissing(tripId) { return geocodeMissing_(currentEmail_(), tripId); }
function removeMember(tripId, memberEmail) { return removeMember_(currentEmail_(), tripId, memberEmail); }
function getSettingsForm() { return getSettingsForm_(currentEmail_()); }
function saveSettings(values) { return saveSettings_(currentEmail_(), values); }
/** Run this once from the Apps Script editor to put the Edinburgh starter list in the Seed tab. Safe to run again. */
function loadStarterSeed() { requireAnyTrip_(currentEmail_()); var n = loadStarterSeed_(); Logger.log('Starter list: ' + n + ' place(s) added to the Seed tab.'); return n; }

function getExactWalkingTimes(tripId, legs) { return getExactWalkingTimes_(currentEmail_(), tripId, legs); }
function getTripRecap(tripId) { return getTripRecap_(currentEmail_(), tripId); }