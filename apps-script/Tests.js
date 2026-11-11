/**
 * Tests.gs: run these from the Apps Script editor (pick the function, press Run,
 * then read the Execution log).
 *
 *   runPhase1Tests()           Phase 1 regression suite (data layer, access rules).
 *   runPhase2Tests()           Phase 2: derived status and scores, check-ins, settings, link reading.
 *   runPhase1PublicSmokeTest() Real public functions, as YOU.
 *   runPhase2LiveChecks()      One real geocoding lookup (uses a little of the free daily quota).
 *   createDemoTrip()           A demo trip showing every pin colour, status and the split flag.
 *   removeDemoData()           Deletes the demo trip.
 *   cleanupAllTestData()       Removes leftovers if a test run was interrupted.
 *
 * Test data is a trip whose city starts with ZZTEST (tests) or ZZDEMO (demo).
 * These functions are callable by any member, so delete this file before real use.
 */

var TEST_PREFIX = 'ZZTEST';

function runPhase1Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner.' + stamp + '@example.com';
  var mate = 'mate.' + stamp + '@example.com';
  var stranger = 'stranger.' + stamp + '@example.com';
  var otherOwner = 'other.' + stamp + '@example.com';
  var tripA = null, tripB = null, placeA = null, placeB = null;

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }

  try {
    // ---- Setup ---------------------------------------------------------
    check('initSpreadsheet creates every tab with the right headers', function () {
      initSpreadsheet();
      Object.keys(SCHEMA).forEach(function (name) {
        var sh = sheet_(name);
        var head = sh.getRange(1, 1, 1, SCHEMA[name].length).getValues()[0];
        assert(head.join('|') === SCHEMA[name].join('|'), name + ' headers do not match');
      });
    });

    check('initSpreadsheet is idempotent and adds nothing the second time', function () {
      var r = initSpreadsheet();
      assert(r.created.length === 0, 'created tabs on second run: ' + r.created);
      assert(r.settingsAdded === 0, 'settings added on second run: ' + r.settingsAdded);
      assert(r.criteriaAdded === 0, 'criteria added on second run: ' + r.criteriaAdded);
    });

    check('Settings and Criteria defaults are present', function () {
      var settings = readRowsFresh_('Settings');
      var byKey = {};
      settings.forEach(function (s) { byKey[s.Key] = s.Value; });
      assert(String(byKey.ScoreRed) === '35' && String(byKey.SplitThreshold) === '30', 'missing score settings');
      assert(String(byKey.MaxWaypoints) === '9', 'missing MaxWaypoints');
      assert(String(byKey.MatchDayTags).indexOf('queue_risk') >= 0, 'missing tag list');
      var crit = readRowsFresh_('Criteria');
      assert(crit.length >= 36, 'expected at least 36 criteria, found ' + crit.length);
      var pub = crit.filter(function (c) { return c.Category === 'Pub'; });
      assert(pub.length === 10, 'Pub should have 10 criteria, found ' + pub.length);
      assert(crit.every(function (c) { return String(c.Weight) === '1'; }), 'default weights should all be 1');
    });

    check('re-running initSpreadsheet keeps a Setting someone edited', function () {
      var sh = sheet_('Settings');
      var rows = readRowsFresh_('Settings');
      var target = rows.filter(function (r) { return r.Key === 'ScoreRed'; })[0];
      var original = String(target.Value);
      try {
        sh.getRange(target._row, 2).setValue('99');
        initSpreadsheet();
        assert(String(sh.getRange(target._row, 2).getValue()) === '99', 'edited value was overwritten');
      } finally {
        sh.getRange(target._row, 2).setValue(original);
        cacheClearAll_();
      }
    });

    // ---- Trips and Members ---------------------------------------------
    check('createTrip makes the caller the Owner and normalises kickoff to UTC', function () {
      tripA = createTrip_(owner, {
        city: TEST_PREFIX + ' Edinburgh ' + stamp, startDate: '2026-10-10', endDate: '2026-10-12',
        fixture: 'Test v Test', kickoffIso: '2026-10-10T15:00:00Z', venueName: 'Test Ground',
        venueLat: 55.9422, venueLng: -3.2406, displayName: 'Olive'
      });
      tripIds.push(tripA.tripId);
      assert(tripA.role === 'Owner', 'role should be Owner');
      assert(tripA.kickoffIso === '2026-10-10T15:00:00.000Z', 'kickoff not normalised: ' + tripA.kickoffIso);
      var mine = getMyTrips_(owner);
      assert(mine.length === 1 && mine[0].tripId === tripA.tripId, 'owner should see exactly the new trip');
      var members = getMembers_(owner, tripA.tripId);
      assert(members.length === 1 && members[0].role === 'Owner' && members[0].displayName === 'Olive', 'owner member row wrong');
    });

    check('createTrip rejects bad input', function () {
      expectError(function () { createTrip_(owner, { city: '' }); }, 'City is required');
      expectError(function () { createTrip_(owner, { city: 'X', startDate: '2026-02-30' }); }, 'real date');
      expectError(function () { createTrip_(owner, { city: 'X', startDate: '2026-10-12', endDate: '2026-10-10' }); }, 'end date');
      expectError(function () { createTrip_(owner, { city: 'X', venueLat: 95, venueLng: 0 }); }, 'between');
      expectError(function () { createTrip_(owner, { city: 'X', venueLat: 55 }); }, 'both be set');
      expectError(function () { createTrip_(owner, { city: 'X', kickoffIso: 'tomorrow' }); }, 'valid date');
    });

    check('a stranger sees no trips and cannot read members', function () {
      assert(getMyTrips_(stranger).length === 0, 'stranger should see no trips');
      expectError(function () { getMembers_(stranger, tripA.tripId); }, 'not a member');
    });

    check('only the owner can add members; duplicates and bad emails are rejected', function () {
      var m = addMember_(owner, tripA.tripId, '  ' + mate.toUpperCase() + ' ', 'Matt');
      assert(m.email === mate && m.role === 'Member', 'member not added correctly: ' + JSON.stringify(m));
      assert(m.note.indexOf('share the spreadsheet') >= 0, 'missing sharing reminder');
      expectError(function () { addMember_(owner, tripA.tripId, mate, 'Again'); }, 'already a member');
      expectError(function () { addMember_(mate, tripA.tripId, stranger, 'X'); }, 'Only the trip owner');
      expectError(function () { addMember_(stranger, tripA.tripId, stranger, 'X'); }, 'not a member');
      expectError(function () { addMember_(owner, tripA.tripId, 'not-an-email', 'X'); }, 'valid email');
    });

    check('a new member sees the trip straight away (cache was cleared)', function () {
      getMyTrips_(mate); // warm the cache
      var mine = getMyTrips_(mate);
      assert(mine.length === 1 && mine[0].role === 'Member', 'mate should see the trip as Member');
      assert(getMembers_(mate, tripA.tripId).length === 2, 'trip should have 2 members');
    });

    // ---- Places --------------------------------------------------------
    check('a member can save a place and everyone in the trip sees it', function () {
      placeA = savePlace_(mate, {
        tripId: tripA.tripId, name: "Sandy Bell's", category: 'Pub', area: 'Old Town',
        lat: 55.9472, lng: -3.1926, localTags: ['proper_boozer', 'Hidden_Gem', 'proper_boozer'],
        matchDayTags: 'queue_risk, cash_only', googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=Sandys',
        hoursNote: 'Check hours', notes: 'Folk sessions', myDesire: 3
      });
      assert(placeA.addedBy === mate && placeA.source === 'Own' && placeA.coordSource === 'Manual', 'defaults wrong');
      assert(placeA.localTags.join(',') === 'proper_boozer,hidden_gem', 'tags not cleaned: ' + placeA.localTags);
      assert(placeA.matchDayTags.join(',') === 'queue_risk,cash_only', 'match-day tags wrong');
      assert(placeA.desireToTry[mate] === 3, 'own desire not saved');
      var list = getPlaces_(owner, tripA.tripId);
      assert(list.length === 1 && list[0].placeId === placeA.placeId, 'owner should see the place');
    });

    check('a stranger cannot read or add places', function () {
      expectError(function () { getPlaces_(stranger, tripA.tripId); }, 'not a member');
      expectError(function () { savePlace_(stranger, { tripId: tripA.tripId, name: 'X', category: 'Pub' }); }, 'not a member');
      expectError(function () { savePlace_(stranger, { name: 'X', category: 'Pub' }); }, 'trip is required');
    });

    check('savePlace rejects bad input', function () {
      var base = { tripId: tripA.tripId, name: 'Bad', category: 'Pub' };
      function with_(extra) { return Object.assign({}, base, extra); }
      expectError(function () { savePlace_(owner, with_({ name: '' })); }, 'Name is required');
      expectError(function () { savePlace_(owner, with_({ category: 'Nightclub' })); }, 'Category must be');
      expectError(function () { savePlace_(owner, with_({ lat: 123, lng: 0 })); }, 'between');
      expectError(function () { savePlace_(owner, with_({ lat: 55.9 })); }, 'both be set');
      expectError(function () { savePlace_(owner, with_({ googleMapsUrl: 'javascript:alert(1)' })); }, 'Google Maps link');
      expectError(function () { savePlace_(owner, with_({ googleMapsUrl: 'https://google.evil.com/maps/x' })); }, 'Google Maps link');
      expectError(function () { savePlace_(owner, with_({ localTags: ['bad tag!'] })); }, 'invalid tag');
      expectError(function () { savePlace_(owner, with_({ coordSource: 'Guess' })); }, 'Coordinate source');
      expectError(function () { savePlace_(owner, with_({ myDesire: 7 })); }, 'Desire to try');
      expectError(function () { savePlace_(owner, with_({ notes: new Array(2102).join('x') })); }, '2000');
      assert(getPlaces_(owner, tripA.tripId).length === 1, 'a rejected place must not be saved');
    });

    check('a place can be saved with blank coordinates (seed rows start that way)', function () {
      var p = savePlace_(owner, { tripId: tripA.tripId, name: 'No pin yet', category: 'Restaurant', source: 'Seed', coordSource: 'Seed' });
      assert(p.lat === null && p.lng === null && p.coordConfirmed === false && p.source === 'Seed', 'blank-coordinate place wrong');
    });

    check('cache is cleared on write: a new place shows up immediately', function () {
      var before = getPlaces_(owner, tripA.tripId).length;
      getPlaces_(owner, tripA.tripId); // warm the cache
      savePlace_(owner, { tripId: tripA.tripId, name: 'Cache check', category: 'Sight', lat: 55.95, lng: -3.19 });
      assert(getPlaces_(owner, tripA.tripId).length === before + 1, 'new place not visible');
    });

    check('updatePlace changes only the fields sent and keeps the rest', function () {
      var before = placeA;
      var after = updatePlace_(owner, { placeId: placeA.placeId, notes: 'Updated by owner' });
      assert(after.notes === 'Updated by owner', 'notes not updated');
      assert(after.name === before.name && after.area === before.area && after.lat === before.lat, 'other fields changed');
      assert(after.addedBy === before.addedBy && after.createdAt === before.createdAt, 'immutable fields changed');
      assert(after.updatedAt >= before.updatedAt, 'UpdatedAt should move forward');
    });

    check('updatePlace cannot move a place to another trip', function () {
      tripB = createTrip_(otherOwner, { city: TEST_PREFIX + ' Dublin ' + stamp });
      tripIds.push(tripB.tripId);
      var after = updatePlace_(owner, { placeId: placeA.placeId, tripId: tripB.tripId, notes: 'Still in trip A' });
      assert(after.tripId === tripA.tripId, 'place moved trips');
      assert(getPlaces_(owner, tripA.tripId).some(function (p) { return p.placeId === placeA.placeId; }), 'place left trip A');
      assert(getPlaces_(otherOwner, tripB.tripId).length === 0, 'trip B should be empty');
    });

    check('two members keep their own desire-to-try entries', function () {
      updatePlace_(owner, { placeId: placeA.placeId, myDesire: 4 });
      var p = updatePlace_(mate, { placeId: placeA.placeId, myDesire: 2, desireToTry: { 'someone@else.com': 1 } });
      assert(p.desireToTry[owner] === 4 && p.desireToTry[mate] === 2, 'both entries should exist: ' + JSON.stringify(p.desireToTry));
      assert(p.desireToTry['someone@else.com'] === undefined, 'client-sent map must be ignored');
      var cleared = updatePlace_(mate, { placeId: placeA.placeId, myDesire: null });
      assert(cleared.desireToTry[owner] === 4 && cleared.desireToTry[mate] === undefined, 'clearing mine must not touch theirs');
    });

    check('trips are isolated from each other', function () {
      placeB = savePlace_(otherOwner, { tripId: tripB.tripId, name: 'Dublin pub', category: 'Pub' });
      expectError(function () { getPlaces_(otherOwner, tripA.tripId); }, 'not a member');
      expectError(function () { getPlaces_(owner, tripB.tripId); }, 'not a member');
      expectError(function () { savePlace_(otherOwner, { tripId: tripA.tripId, name: 'X', category: 'Pub' }); }, 'not a member');
      expectError(function () { updatePlace_(otherOwner, { placeId: placeA.placeId, notes: 'hack' }); }, 'not found');
      expectError(function () { updatePlace_(owner, { placeId: placeB.placeId, notes: 'hack' }); }, 'not found');
      expectError(function () { updatePlace_(owner, { placeId: 'no-such-id', notes: 'x' }); }, 'not found');
      assert(getMyTrips_(owner).length === 1 && getMyTrips_(otherOwner).length === 1, 'each owner should see only their own trip');
    });

    check('text that starts with = + - or @ is stored as text, never a formula', function () {
      var tricky = ['=1+1', '+1+1', '-1+1', '@SUM(1,1)'];
      tricky.forEach(function (text) {
        var p = savePlace_(owner, { tripId: tripA.tripId, name: '=HYPERLINK("x")', category: 'Pub', notes: text });
        var row = readRowsFresh_('Places').filter(function (r) { return r.PlaceID === p.placeId; })[0];
        var cell = sheet_('Places').getRange(row._row, SCHEMA.Places.indexOf('Notes') + 1);
        assert(!cell.getFormula(), '"' + text + '" became a formula: ' + cell.getFormula());
        assert(typeof cell.getValue() === 'string', '"' + text + '" was stored as ' + typeof cell.getValue() + ': ' + cell.getValue() + ' (column format ' + cell.getNumberFormat() + ')');
        var back = getPlaces_(owner, tripA.tripId).filter(function (x) { return x.placeId === p.placeId; })[0];
        assert(back.notes === text, 'round trip changed "' + text + '" into "' + back.notes + '"');
        assert(back.name === '=HYPERLINK("x")', 'name changed to "' + back.name + '"');
      });
    });

    check('trip dates are kept as plain text, not turned into Date cells', function () {
      var t = getMyTrips_(owner).filter(function (x) { return x.tripId === tripA.tripId; })[0];
      assert(t.startDate === '2026-10-10' && t.endDate === '2026-10-12', 'dates read back as ' + t.startDate + ' / ' + t.endDate);
      assert(t.kickoffIso === '2026-10-10T15:00:00.000Z', 'kickoff read back as ' + t.kickoffIso);
      var row = readRowsFresh_('Trips').filter(function (r) { return r.TripID === tripA.tripId; })[0];
      var cell = sheet_('Trips').getRange(row._row, SCHEMA.Trips.indexOf('StartDate') + 1);
      assert(typeof cell.getValue() === 'string', 'StartDate cell holds a ' + typeof cell.getValue() + ' (column format ' + cell.getNumberFormat() + ')');
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Exercises the real public functions with YOUR Google account. */
function runPhase1PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' public ' + new Date().getTime(), venueName: 'Smoke Ground', venueLat: 55.94, venueLng: -3.24 });
    tripId = trip.tripId;
    if (trip.role !== 'Owner') throw new Error('Expected Owner role');
    if (getMyTrips().filter(function (t) { return t.tripId === tripId; }).length !== 1) throw new Error('getMyTrips missed the new trip');
    var p = savePlace({ tripId: tripId, name: 'Smoke pub', category: 'Pub', lat: 55.95, lng: -3.19, myDesire: 3 });
    var places = getPlaces(tripId);
    if (places.length !== 1 || places[0].desireToTry[me] !== 3) throw new Error('getPlaces did not return the saved place');
    updatePlace({ placeId: p.placeId, notes: 'smoke' });
    if (getMembers(tripId)[0].email !== me) throw new Error('Owner email mismatch');
    Logger.log('Public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}

/** Removes every trip whose city starts with ZZTEST, plus its members and places. */
function cleanupAllTestData() {
  var ids = readRowsFresh_('Trips')
    .filter(function (t) { return String(t.City).indexOf(TEST_PREFIX) === 0; })
    .map(function (t) { return t.TripID; });
  cleanupTestData_(ids);
  Logger.log('Removed ' + ids.length + ' test trip(s).');
  return ids.length;
}

function cleanupTestData_(tripIds) {
  if (!tripIds || !tripIds.length) return;
  withLock_(function () {
    deleteRowsWhere_('Ratings', 'TripID', tripIds);
    deleteRowsWhere_('CheckIns', 'TripID', tripIds);
        deleteRowsWhere_('Routes', 'TripID', tripIds);
    deleteRowsWhere_('Places', 'TripID', tripIds);
    deleteRowsWhere_('Members', 'TripID', tripIds);
    deleteRowsWhere_('Trips', 'TripID', tripIds);
  });
}

function deleteRowsWhere_(name, column, values) {
  var sh = sheet_(name);
  var idx = SCHEMA[name].indexOf(column);
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) { // bottom-up so row numbers stay valid
    if (values.indexOf(String(data[i][idx])) >= 0) sh.deleteRow(i + 1);
  }
  cacheClear_(name);
}


// ===========================================================================
// Phase 2 tests
// ===========================================================================

function insertRating_(tripId, placeId, email, score, ts) {
  appendRow_('Ratings', {
    RatingID: newId_(), PlaceID: placeId, TripID: tripId, UserEmail: email, VisitTimestamp: ts,
    ScoresJSON: '{}', PersonScore: score === null ? '' : score, WouldReturn: 'Yes', PintPrice: '',
    Notes: 'test', CreatedAt: ts
  });
  cacheClear_('Ratings');
}

function runPhase2Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner2.' + stamp + '@example.com';
  var mate = 'mate2.' + stamp + '@example.com';
  var stranger = 'stranger2.' + stamp + '@example.com';
  var tripA = null, tripB = null, pA = null, pB = null, pC = null, pD = null;
  var T1 = '2026-10-10T18:00:00.000Z', T2 = '2026-10-10T19:00:00.000Z', T3 = '2026-10-10T20:00:00.000Z';

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function place(owner_, tripId, name) {
    return savePlace_(owner_, { tripId: tripId, name: name, category: 'Pub', lat: 55.95, lng: -3.19 });
  }
  function fresh(email, tripId, placeId) {
    return getPlaces_(email, tripId).filter(function (p) { return p.placeId === placeId; })[0];
  }

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P2 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(mate, { city: TEST_PREFIX + ' P2 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');
    pA = place(owner, tripA.tripId, 'Place A');
    pB = place(owner, tripA.tripId, 'Place B');
    pC = place(owner, tripA.tripId, 'Place C');
    pD = place(owner, tripA.tripId, 'Place D');

    check('getTripData returns everything the app needs in one call', function () {
      var d = getTripData_(mate, tripA.tripId);
      assert(d.you === mate, 'you should be the caller');
      assert(d.trip.role === 'Member' && d.trip.tripId === tripA.tripId, 'trip/role wrong');
      assert(d.members.length === 2, 'members: ' + d.members.length);
      assert(d.places.length === 4, 'places: ' + d.places.length);
      var s = d.settings;
      assert(s.scoreRed === 35 && s.scoreAmber === 60 && s.scoreLightGreen === 80 && s.splitThreshold === 30, 'score settings wrong');
      assert(s.detourFactor === 1.3 && s.walkMetersPerMinute === 80 && s.maxWaypoints === 9, 'walking settings wrong');
      assert(s.pacingEnabled === false && s.currency === 'GBP', 'other settings wrong');
      assert(s.localTags.indexOf('proper_boozer') >= 0 && s.matchDayTags.indexOf('queue_risk') >= 0, 'tag lists wrong');
      assert(typeof d.serverTime === 'string', 'missing serverTime');
    });

    check('getTripData and settings refuse outsiders', function () {
      expectError(function () { getTripData_(stranger, tripA.tripId); }, 'not a member');
      expectError(function () { getTripData_(mate, tripB.tripId + 'x'); }, 'not a member');
      expectError(function () { requireAnyTrip_(stranger); }, 'not a member of any trip');
      requireAnyTrip_(mate); // a member of at least one trip is fine
    });

    check('an edited setting reaches the app', function () {
      var rows = readRowsFresh_('Settings');
      var row = rows.filter(function (r) { return r.Key === 'SplitThreshold'; })[0];
      var original = String(row.Value);
      try {
        sheet_('Settings').getRange(row._row, 2).setValue('25');
        cacheClearAll_();
        assert(getTripData_(owner, tripA.tripId).settings.splitThreshold === 25, 'edited value not picked up');
      } finally {
        sheet_('Settings').getRange(row._row, 2).setValue(original);
        cacheClearAll_();
      }
    });

    check('new places start as Want, unrated, not split', function () {
      [pA, pB, pC, pD].forEach(function (p) {
        assert(p.status === 'Want' && p.blendedScore === null && p.split === false, p.name + ' should start unrated');
        assert(Object.keys(p.personScores).length === 0, 'no person scores yet');
      });
      assert(fresh(owner, tripA.tripId, pA.placeId).status === 'Want', 'getPlaces should agree');
    });

    check('check-ins set the status: SKIP then ARRIVE', function () {
      addCheckIn_(mate, { tripId: tripA.tripId, placeId: pA.placeId, type: 'SKIP' });
      assert(fresh(owner, tripA.tripId, pA.placeId).status === 'Skipped', 'SKIP should give Skipped');
      addCheckIn_(owner, { tripId: tripA.tripId, placeId: pA.placeId, type: 'ARRIVE', lat: 55.95, lng: -3.19 });
      assert(fresh(owner, tripA.tripId, pA.placeId).status === 'Been', 'ARRIVE should beat SKIP');
      assert(fresh(owner, tripA.tripId, pB.placeId).status === 'Want', 'other places unaffected');
    });

    check('a rating makes a place Been and gives that person a score', function () {
      insertRating_(tripA.tripId, pC.placeId, owner, 80, T1);
      var p = fresh(owner, tripA.tripId, pC.placeId);
      assert(p.status === 'Been', 'status ' + p.status);
      assert(p.personScores[owner] === 80 && p.blendedScore === 80 && p.split === false, 'scores wrong: ' + JSON.stringify(p));
    });

    check('blended score is the mean of each person\'s latest rating', function () {
      insertRating_(tripA.tripId, pC.placeId, mate, 60, T1);
      var p = fresh(owner, tripA.tripId, pC.placeId);
      assert(p.blendedScore === 70 && p.split === false, 'expected 70, got ' + p.blendedScore);
      insertRating_(tripA.tripId, pC.placeId, owner, 20, T2); // a later rating replaces the earlier one
      p = fresh(owner, tripA.tripId, pC.placeId);
      assert(p.personScores[owner] === 20 && p.blendedScore === 40, 'latest should win: ' + JSON.stringify(p.personScores));
      assert(p.split === true, 'scores 40 apart should be a split decision');
    });

    check('a rating with every criterion skipped has no score, but the place counts as Been', function () {
      insertRating_(tripA.tripId, pC.placeId, mate, null, T3);
      var p = fresh(owner, tripA.tripId, pC.placeId);
      assert(p.personScores[mate] === undefined && p.blendedScore === 20 && p.status === 'Been', 'got ' + JSON.stringify(p));
    });

    check('split flag uses >= SplitThreshold exactly', function () {
      insertRating_(tripA.tripId, pD.placeId, owner, 70, T1);
      insertRating_(tripA.tripId, pD.placeId, mate, 40, T1);
      assert(fresh(owner, tripA.tripId, pD.placeId).split === true, '30 apart should split');
      insertRating_(tripA.tripId, pD.placeId, mate, 40.1, T2);
      assert(fresh(owner, tripA.tripId, pD.placeId).split === false, '29.9 apart should not split');
    });

    check('ratings and check-ins from another trip are ignored', function () {
      insertRating_(tripB.tripId, pB.placeId, owner, 100, T1);
      appendRow_('CheckIns', { CheckInID: newId_(), TripID: tripB.tripId, UserEmail: owner, PlaceID: pB.placeId, Type: 'ARRIVE', Timestamp: T1 });
      cacheClear_('CheckIns');
      var p = fresh(owner, tripA.tripId, pB.placeId);
      assert(p.status === 'Want' && p.blendedScore === null, 'leaked from another trip: ' + JSON.stringify(p));
    });

    check('addCheckIn validates its input and refuses outsiders', function () {
      var base = { tripId: tripA.tripId, placeId: pB.placeId, type: 'ARRIVE' };
      function with_(x) { return Object.assign({}, base, x); }
      expectError(function () { addCheckIn_(owner, with_({ type: 'DANCE' })); }, 'Type must be');
      expectError(function () { addCheckIn_(owner, with_({ placeId: '' })); }, 'place is required');
      expectError(function () { addCheckIn_(owner, with_({ placeId: 'nope' })); }, 'not in this trip');
      expectError(function () { addCheckIn_(owner, with_({ lat: 55.9 })); }, 'both be set');
      expectError(function () { addCheckIn_(owner, with_({ lat: 99, lng: 0 })); }, 'between');
      expectError(function () { addCheckIn_(owner, with_({ value: new Array(102).join('x') })); }, '100');
      expectError(function () { addCheckIn_(stranger, base); }, 'not a member');
      expectError(function () { addCheckIn_(owner, null); }, 'No check-in');
      var c = addCheckIn_(owner, { tripId: tripA.tripId, type: 'PINT', value: '1' }); // drink tally needs no place
      assert(c.type === 'PINT' && c.checkInId, 'PINT check-in failed');
      assert(fresh(owner, tripA.tripId, pB.placeId).status === 'Want', 'a rejected or unrelated check-in changed the status');
    });

    check('saving and updating a place return the derived fields too', function () {
      var upd = updatePlace_(owner, { placeId: pC.placeId, notes: 'derived check' });
      assert(upd.status === 'Been' && upd.blendedScore === 20, 'updatePlace lost derived data: ' + JSON.stringify(upd));
      var created = place(owner, tripA.tripId, 'Fresh');
      assert(created.status === 'Want' && created.blendedScore === null && created.split === false, 'savePlace derived wrong');
    });

    check('map links: coordinates are read from place pins, map centres and parameters', function () {
      var a = parseMapsUrl_('https://www.google.com/maps/place/Sandy+Bell%27s/@55.9473,-3.1927,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d55.9472!4d-3.1926');
      assert(a && a.lat === 55.9472 && a.lng === -3.1926 && a.method === 'place pin', 'place pin should win: ' + JSON.stringify(a));
      assert(a.name === "Sandy Bell's", 'name: ' + a.name);
      var b = parseMapsUrl_('https://www.google.com/maps/@55.95,-3.19,15z');
      assert(b && b.lat === 55.95 && b.method === 'map centre', 'map centre failed');
      var c = parseMapsUrl_('https://www.google.com/maps?q=55.95,-3.19');
      assert(c && c.lng === -3.19 && c.method === 'link parameter', 'parameter failed');
      var d = parseMapsUrl_('https://www.google.com/maps/dir/?api=1&destination=51.5,-0.12&travelmode=walking');
      assert(d && d.lat === 51.5, 'destination parameter failed');
      assert(parseMapsUrl_('https://www.google.com/maps/place/Foo/') === null, 'no coordinates should give null');
      assert(parseMapsUrl_('https://www.google.com/maps/@95.0,-3.19,15z') === null, 'out-of-range latitude should give null');
      assert(parseMapsUrl_('https://maps.google.com?ftid=0x4887c7858a13da65:0x50eb255e793d7aa1&entry=gps') === null, 'place-ID-only links have no coordinates');
    });

    check('only Google-owned hosts are accepted for link reading', function () {
      ['https://www.google.com/maps/x', 'https://maps.google.com/x', 'https://www.google.co.uk/maps', 'https://maps.app.goo.gl/abc', 'https://goo.gl/maps/x']
        .forEach(function (u) { assert(isGoogleHost_(u), 'should accept ' + u); });
      ['https://evil.example.com/maps', 'https://google.evil.com/maps', 'https://www.google.com.evil.com/maps', 'https://notgoogle.com/maps', 'http://', 'javascript:alert(1)']
        .forEach(function (u) { assert(!isGoogleHost_(u), 'should reject ' + u); });
    });

    check('resolveMapsLink_ rejects bad links without any network call, and reads full links offline', function () {
      assert(resolveMapsLink_('').ok === false, 'empty link');
      assert(resolveMapsLink_('http://www.google.com/maps/@55.9,-3.1,15z').ok === false, 'http should be refused');
      var bad = resolveMapsLink_('https://example.com/maps/@55.9,-3.1,15z');
      assert(bad.ok === false && /not a Google Maps link/i.test(bad.error), 'non-Google host should be refused: ' + JSON.stringify(bad));
      var good = resolveMapsLink_('https://www.google.com/maps/place/Foo+Bar/@55.9,-3.1,15z/data=!3d55.91!4d-3.11');
      assert(good.ok && good.lat === 55.91 && good.name === 'Foo Bar' && good.hops === 0, 'full link failed: ' + JSON.stringify(good));
    });

    check('places remember their city, defaulting to the trip\'s city', function () {
      var home = savePlace_(owner, { tripId: tripA.tripId, name: 'Home city pub', category: 'Pub', lat: 55.95, lng: -3.19 });
      assert(home.city === tripA.city, 'default city should be "' + tripA.city + '", got "' + home.city + '"');
      var far = savePlace_(owner, { tripId: tripA.tripId, name: 'Glasgow pub', category: 'Pub', city: ' Glasgow ', lat: 55.86, lng: -4.25 });
      assert(far.city === 'Glasgow', 'city should be trimmed and kept: "' + far.city + '"');
      expectError(function () { savePlace_(owner, { tripId: tripA.tripId, name: 'X', category: 'Pub', city: new Array(90).join('x') }); }, '80');
    });

    check('one trip can hold places in several cities', function () {
      var cities = {};
      getPlaces_(mate, tripA.tripId).forEach(function (p) { cities[p.city] = true; });
      assert(Object.keys(cities).length >= 2 && cities.Glasgow, 'expected places in 2+ cities: ' + Object.keys(cities));
      var moved = updatePlace_(mate, { placeId: pA.placeId, city: 'Glasgow' });
      assert(moved.city === 'Glasgow', 'city should be editable');
    });

    check('anchor places carry a kind; other places never do', function () {
      var base = { tripId: tripA.tripId, lat: 55.95, lng: -3.19 };
      var lodging = savePlace_(owner, Object.assign({}, base, { name: 'Hotel', category: 'Anchor', anchorKind: 'Lodging' }));
      assert(lodging.anchorKind === 'Lodging', 'kind lost');
      var plain = savePlace_(owner, Object.assign({}, base, { name: 'Some anchor', category: 'Anchor' }));
      assert(plain.anchorKind === 'Other', 'anchors default to Other, got "' + plain.anchorKind + '"');
      var pub = savePlace_(owner, Object.assign({}, base, { name: 'A pub', category: 'Pub', anchorKind: 'Lodging' }));
      assert(pub.anchorKind === '', 'a pub must not carry a kind');
      expectError(function () { savePlace_(owner, Object.assign({}, base, { name: 'X', category: 'Anchor', anchorKind: 'Castle' })); }, 'Anchor type');
      assert(updatePlace_(owner, { placeId: lodging.placeId, category: 'Pub' }).anchorKind === '', 'turning an anchor into a pub should clear the kind');
      assert(updatePlace_(owner, { placeId: pub.placeId, category: 'Anchor' }).anchorKind === 'Other', 'turning a pub into an anchor should default the kind');
      assert(updatePlace_(owner, { placeId: plain.placeId, anchorKind: 'Station' }).anchorKind === 'Station', 'kind should be editable');
    });

    check('initSpreadsheet upgrades an older tab by adding missing trailing columns, and still refuses real mismatches', function () {
      var sh = sheet_('Places');
      var cityCol = SCHEMA.Places.indexOf('City') + 1;
      var kindCol = SCHEMA.Places.indexOf('AnchorKind') + 1;
      var third = 3;
      var thirdOriginal = sh.getRange(1, third).getValue();
      try {
        sh.getRange(1, cityCol, 1, 2).setValues([['', '']]); // pretend this sheet predates multi-city
        var r = initSpreadsheet();
        assert(r.columnsAdded.length === 1 && r.columnsAdded[0] === 'Places: City, AnchorKind', 'columnsAdded: ' + JSON.stringify(r.columnsAdded));
        assert(sh.getRange(1, cityCol).getValue() === 'City' && sh.getRange(1, kindCol).getValue() === 'AnchorKind', 'headers not restored');
        sh.getRange(1, third).setValue('Bogus');
        expectError(function () { initSpreadsheet(); }, 'unexpected headers');
      } finally {
        sh.getRange(1, third).setValue(thirdOriginal);
        sh.getRange(1, cityCol, 1, 2).setValues([['City', 'AnchorKind']]);
        cacheClearAll_();
      }
      assert(initSpreadsheet().columnsAdded.length === 0, 'a healthy sheet should need no upgrade');
    });

    check('geocodePlace_ refuses empty input without a lookup', function () {
      var r = geocodePlace_('   ', null);
      assert(r.ok === false && /name or address/i.test(r.error), 'got ' + JSON.stringify(r));
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** One real geocoding lookup, then the same lookup again to prove caching. Uses ~1 of the free daily quota. */
function runPhase2LiveChecks() {
  var near = { lat: 55.9533, lng: -3.1883 };
  var q = "Sandy Bell's, Old Town, Edinburgh";
  var a = geocodePlace_(q, near);
  var b = geocodePlace_(q, near);
  var lines = [
    'First lookup:  ' + JSON.stringify(a),
    'Second lookup: cached=' + b.cached,
    (a.ok && b.cached) ? 'LIVE CHECK PASSED' : 'LIVE CHECK FAILED'
  ];
  Logger.log(lines.join('\n'));
  return lines[2];
}

// ===========================================================================
// Demo trip: every pin colour, status and the split flag, for looking at on a phone
// ===========================================================================

function createDemoTrip() {
  var me = currentEmail_();
  var existing = readRowsFresh_('Trips').filter(function (t) { return String(t.City).indexOf('ZZDEMO') === 0; });
  if (existing.length) { Logger.log('A demo trip already exists. Run removeDemoData() first.'); return existing[0].TripID; }

  var A = 'demo.a@example.com', B = 'demo.b@example.com';
  var trip = createTrip_(me, { city: 'ZZDEMO Edinburgh (delete me)', fixture: 'Demo v Demo', displayName: 'You' });
  addMember_(me, trip.tripId, A, 'Demo A');
  addMember_(me, trip.tripId, B, 'Demo B');

  var C = { lat: 55.9533, lng: -3.1883 };
  // name, category, dLat, dLng, score A, score B (null = none)
  var defs = [
    ['Demo pub 01', 'Pub', 0, 0, 92, 88], ['Demo whisky 02', 'Whisky_Bar', 0.004, -0.006, 80, 80],
    ['Demo restaurant 03', 'Restaurant', -0.004, 0.007, 79, 79], ['Demo pub 04', 'Pub', 0.008, 0.010, 66, 70],
    ['Demo cocktails 05', 'Cocktails', -0.008, -0.010, 60, 60], ['Demo pub 06', 'Pub', 0.002, 0.015, 59, 59],
    ['Demo grab 07', 'Grab_and_Go', -0.002, -0.015, 48, 52], ['Demo pub 08', 'Pub', 0.010, -0.012, 35, 35],
    ['Demo pub 09', 'Pub', -0.010, 0.012, 34, 34], ['Demo pub 10', 'Pub', 0.006, 0.003, 12, 20],
    ['Demo sight 11', 'Sight', -0.006, -0.004, 0, 0], ['Demo pub 12 (split)', 'Pub', 0.012, 0, 90, 40],
    ['Demo tasting 13', 'Tasting', -0.012, 0.002, 100, 100], ['Demo pub 14 (wanted)', 'Pub', 0.003, 0.022, null, null],
    ['Demo pub 15 (wanted)', 'Pub', -0.003, -0.022, null, null], ['Demo restaurant 16 (nothing yet)', 'Restaurant', 0.009, 0.018, null, null],
    ['Demo pub 17 (been, unrated)', 'Pub', -0.009, -0.018, null, null], ['Demo pub 18 (skipped)', 'Pub', 0.001, -0.008, null, null],
    ['Demo sight 19 (one rating)', 'Sight', -0.001, 0.009, 57, null], ['Demo station 20', 'Anchor', 0.005, -0.018, null, null]
  ];
  // Anchor kinds, matched by name below.
  var anchorKinds = { 'Demo station 20': 'Station' };
  var ts = '2026-10-10T18:00:00.000Z';
  var made = [];
  defs.forEach(function (d) {
    var p = savePlace_(me, {
      tripId: trip.tripId, name: d[0], category: d[1], area: 'Demo area',
      lat: Math.round((C.lat + d[2]) * 1e6) / 1e6, lng: Math.round((C.lng + d[3]) * 1e6) / 1e6,
      coordSource: 'Manual', coordConfirmed: true, city: 'Edinburgh', anchorKind: anchorKinds[d[0]] || '',
      localTags: d[0].indexOf('12') > 0 ? ['proper_boozer'] : [], matchDayTags: d[0].indexOf('01') > 0 ? ['queue_risk'] : [],
      hoursNote: d[0].indexOf('06') > 0 ? 'Kitchen closes at 8' : '', notes: 'Demo place (not a real venue)'
    });
    made.push(p);
    if (d[4] !== null) insertRating_(trip.tripId, p.placeId, A, d[4], ts);
    if (d[5] !== null) insertRating_(trip.tripId, p.placeId, B, d[5], ts);
  });
  // desire to try: places 14 and 15
  updatePlace_(A, { placeId: made[13].placeId, myDesire: 4 });
  updatePlace_(B, { placeId: made[13].placeId, myDesire: 3 });
  updatePlace_(me, { placeId: made[14].placeId, myDesire: 2 });
  updatePlace_(A, { placeId: made[14].placeId, myDesire: 4 });
  addCheckIn_(me, { tripId: trip.tripId, placeId: made[16].placeId, type: 'ARRIVE' });
  addCheckIn_(me, { tripId: trip.tripId, placeId: made[17].placeId, type: 'SKIP' });

  // A second city, plus one lodging per city and the ground, to show multi-city trips.
  var G = { lat: 55.8642, lng: -4.2518 };
  [
    ['Demo hotel (Edinburgh)', 'Anchor', 'Edinburgh', 'Lodging', C.lat + 0.002, C.lng - 0.004],
    ['Demo ground', 'Anchor', 'Edinburgh', 'Stadium', C.lat - 0.011, C.lng - 0.052],
    ['Demo hotel (Glasgow)', 'Anchor', 'Glasgow', 'Lodging', G.lat, G.lng],
    ['Demo Glasgow pub 1', 'Pub', 'Glasgow', '', G.lat + 0.004, G.lng + 0.006],
    ['Demo Glasgow pub 2', 'Pub', 'Glasgow', '', G.lat - 0.005, G.lng - 0.004],
    ['Demo Glasgow sight', 'Sight', 'Glasgow', '', G.lat + 0.008, G.lng - 0.010]
  ].forEach(function (d, i) {
    var p = savePlace_(me, {
      tripId: trip.tripId, name: d[0], category: d[1], city: d[2], anchorKind: d[3], area: 'Demo area',
      lat: Math.round(d[4] * 1e6) / 1e6, lng: Math.round(d[5] * 1e6) / 1e6, coordSource: 'Manual', coordConfirmed: true,
      notes: 'Demo place (not a real venue)'
    });
    if (i === 3) insertRating_(trip.tripId, p.placeId, A, 75, ts);
    if (i === 4) insertRating_(trip.tripId, p.placeId, B, 30, ts);
  });

  Logger.log('Demo trip created: ' + trip.tripId + '. Open the app and pick "ZZDEMO Edinburgh". Run removeDemoData() when finished.');
  return trip.tripId;
}

function removeDemoData() {
  var ids = readRowsFresh_('Trips')
    .filter(function (t) { return String(t.City).indexOf('ZZDEMO') === 0; })
    .map(function (t) { return t.TripID; });
  cleanupTestData_(ids);
  Logger.log('Removed ' + ids.length + ' demo trip(s).');
  return ids.length;
}

// ===========================================================================
// PHASE 3 TESTS: paste this whole block at the END of Tests.gs.
// Run runPhase3Tests() from the Apps Script editor; you want "N passed, 0 failed".
// It briefly edits rows in the Criteria tab and restores them afterwards.
// ===========================================================================

function runPhase3Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner3.' + stamp + '@example.com';
  var mate = 'mate3.' + stamp + '@example.com';
  var stranger = 'stranger3.' + stamp + '@example.com';
  var other = 'other3.' + stamp + '@example.com';
  var tripA = null, tripB = null;

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function mk(email, tripId, name, category) {
    return savePlace_(email, { tripId: tripId, name: name, category: category || 'Pub', lat: 55.95, lng: -3.19 });
  }
  function fresh(email, tripId, placeId) {
    return getPlaces_(email, tripId).filter(function (p) { return p.placeId === placeId; })[0];
  }
  /** Changes one cell of one Criteria row. Returns a function that puts it back. */
  function tweak(category, key, column, value) {
    var row = readRowsFresh_('Criteria').filter(function (r) { return r.Category === category && r.CriterionKey === key; })[0];
    var cell = sheet_('Criteria').getRange(row._row, SCHEMA.Criteria.indexOf(column) + 1);
    var original = cell.getValue();
    cell.setValue(value);
    cacheClearAll_();
    return function () { cell.setValue(original); cacheClearAll_(); };
  }

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P3 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P3 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');

    var p1 = mk(owner, tripA.tripId, 'Main pub');
    var p2 = mk(owner, tripA.tripId, 'Update pub');
    var p3 = mk(owner, tripA.tripId, 'Weights pub');
    var p4 = mk(owner, tripA.tripId, 'Skipped pub');
    var p5 = mk(owner, tripA.tripId, 'Split pub');
    var rest = mk(owner, tripA.tripId, 'A restaurant', 'Restaurant');
    var anchor = mk(owner, tripA.tripId, 'A station', 'Anchor');
    var pB = mk(other, tripB.tripId, 'Other trip pub');

    check('computeScore_ follows the formula, weights and skips', function () {
      var c = [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }, { key: 'c', weight: 2 }];
      assert(computeScore_({ a: 4, b: 4, c: 4 }, c) === 100, 'all 4 should be 100');
      assert(computeScore_({ a: 1, b: 1, c: 1 }, c) === 0, 'all 1 should be 0');
      assert(computeScore_({ a: 4, b: 4, c: 1 }, c) === 50, 'weighted: (4+4+2)/4=2.5 -> 50, got ' + computeScore_({ a: 4, b: 4, c: 1 }, c));
      assert(computeScore_({ a: 4, b: null, c: null }, c) === 100, 'skips must not count');
      assert(computeScore_({ a: null, b: null, c: null }, c) === '', 'all skipped should have no score');
      assert(computeScore_({ a: 2, b: 3, c: null }, c) === 50, '(2+3)/2=2.5 -> 50');
    });

    check('getCriteria returns the active criteria in order, and refuses outsiders and anchors', function () {
      var pub = getCriteria_(owner, 'Pub');
      assert(pub.length === 10 && pub[0].key === 'guinness_temp' && pub[9].key === 'service', 'pub criteria wrong: ' + pub.length);
      assert(pub[0].label === 'Guinness temperature' && pub[0].weight === 1, 'label/weight wrong');
      assert(getCriteria_(owner, 'Restaurant').length === 5, 'restaurant should have 5');
      expectError(function () { getCriteria_(owner, 'Anchor'); }, 'Category must be');
      expectError(function () { getCriteria_(owner, 'Nightclub'); }, 'Category must be');
      expectError(function () { getCriteria_(stranger, 'Pub'); }, 'not a member of any trip');
    });

    check('inactive or zero-weight criteria are hidden and cannot be scored', function () {
      var undo1 = tweak('Pub', 'music', 'Active', false);
      try {
        var keys = getCriteria_(owner, 'Pub').map(function (c) { return c.key; });
        assert(keys.length === 9 && keys.indexOf('music') < 0, 'music should be hidden: ' + keys.length);
        expectError(function () { saveRating_(owner, { tripId: tripA.tripId, placeId: p4.placeId, scores: { music: 3 } }); }, 'Unknown criterion');
      } finally { undo1(); }
      var undo2 = tweak('Pub', 'service', 'Weight', 0);
      try {
        assert(getCriteria_(owner, 'Pub').every(function (c) { return c.key !== 'service'; }), 'weight 0 should hide it');
      } finally { undo2(); }
      assert(getCriteria_(owner, 'Pub').length === 10, 'criteria not restored');
    });

    check('saveRating computes the score, makes the place Been, and returns the refreshed place', function () {
      var res = saveRating_(owner, {
        tripId: tripA.tripId, placeId: p1.placeId, wouldReturn: 'Yes', pintPrice: 5.2, notes: 'Lovely pint',
        scores: { guinness_temp: 4, guinness_taste: 4, value: 1, noise: null }
      });
      assert(res.rating.personScore === 66.7, 'expected 66.7, got ' + res.rating.personScore);
      assert(res.rating.userEmail === owner && res.rating.wouldReturn === 'Yes' && res.rating.pintPrice === 5.2, 'fields wrong: ' + JSON.stringify(res.rating));
      assert(res.rating.scores.guinness_temp === 4 && res.rating.scores.music === null, 'scores map wrong: ' + JSON.stringify(res.rating.scores));
      assert(res.place.status === 'Been' && res.place.blendedScore === 66.7, 'place not refreshed: ' + JSON.stringify(res.place));
      var again = fresh(mate, tripA.tripId, p1.placeId);
      assert(again.status === 'Been' && again.personScores[owner] === 66.7, 'a member should see it straight away (cache cleared)');
    });

    check('the rater is always the signed-in caller, never a name sent by the client', function () {
      var res = saveRating_(mate, { tripId: tripA.tripId, placeId: p1.placeId, userEmail: owner, scores: { value: 3 } });
      assert(res.rating.userEmail === mate, 'rated as ' + res.rating.userEmail);
      var rows = getRatings_(owner, p1.placeId);
      assert(rows.filter(function (x) { return x.userEmail === mate; }).length === 1, 'mate row missing');
    });

    check('saveRating rejects bad input and writes nothing', function () {
      var before = getRatings_(owner, p4.placeId).length;
      var base = { tripId: tripA.tripId, placeId: p4.placeId, scores: { value: 3 } };
      function with_(x) { return Object.assign({}, base, x); }
      expectError(function () { saveRating_(owner, null); }, 'No rating');
      expectError(function () { saveRating_(owner, with_({ scores: { value: 5 } })); }, 'must be 1, 2, 3 or 4');
      expectError(function () { saveRating_(owner, with_({ scores: { value: 0 } })); }, 'must be 1, 2, 3 or 4');
      expectError(function () { saveRating_(owner, with_({ scores: { value: 2.5 } })); }, 'must be 1, 2, 3 or 4');
      expectError(function () { saveRating_(owner, with_({ scores: { value: 'great' } })); }, 'must be 1, 2, 3 or 4');
      expectError(function () { saveRating_(owner, with_({ scores: { nonsense: 3 } })); }, 'Unknown criterion');
      expectError(function () { saveRating_(owner, with_({ scores: [3] })); }, 'object');
      expectError(function () { saveRating_(owner, with_({ wouldReturn: 'Definitely' })); }, 'Would return');
      expectError(function () { saveRating_(owner, with_({ pintPrice: -1 })); }, 'Pint price');
      expectError(function () { saveRating_(owner, with_({ pintPrice: 'abc' })); }, 'Pint price');
      expectError(function () { saveRating_(owner, with_({ notes: new Array(1102).join('x') })); }, '1000');
      expectError(function () { saveRating_(owner, with_({ placeId: '' })); }, 'Place is required');
      assert(getRatings_(owner, p4.placeId).length === before, 'a rejected rating must not be saved');
    });

    check('access rules: outsiders, other trips and anchors are refused', function () {
      expectError(function () { saveRating_(stranger, { tripId: tripA.tripId, placeId: p4.placeId, scores: {} }); }, 'not a member');
      expectError(function () { saveRating_(owner, { placeId: p4.placeId, scores: {} }); }, 'trip is required');
      expectError(function () { saveRating_(owner, { tripId: tripA.tripId, placeId: pB.placeId, scores: {} }); }, 'not in this trip');
      expectError(function () { saveRating_(owner, { tripId: tripB.tripId, placeId: pB.placeId, scores: {} }); }, 'not a member');
      expectError(function () { saveRating_(owner, { tripId: tripA.tripId, placeId: anchor.placeId, scores: {} }); }, 'cannot be rated');
      expectError(function () { getRatings_(stranger, p1.placeId); }, 'not found');
      expectError(function () { getRatings_(owner, pB.placeId); }, 'not found');
      expectError(function () { getRatings_(owner, 'no-such-id'); }, 'not found');
      expectError(function () { getRatings_(owner, ''); }, 'placeId is required');
    });

    check('updating the last rating replaces it in the blend; a new visit also becomes the latest', function () {
      saveRating_(owner, { tripId: tripA.tripId, placeId: p2.placeId, scores: { value: 4 } });
      var up = saveRating_(owner, { tripId: tripA.tripId, placeId: p2.placeId, scores: { value: 2 }, updateLast: true });
      assert(up.place.blendedScore === 33.3, 'update should give 33.3, got ' + up.place.blendedScore);
      var rows = getRatings_(owner, p2.placeId);
      assert(rows.length === 2, 'append-only: expected 2 rows, got ' + rows.length);
      assert(rows[0].visitTimestamp === rows[1].visitTimestamp, 'an update should keep the same visit timestamp');
      assert(rows.filter(function (x) { return x.current; }).length === 1 && rows[0].current && rows[0].personScore === 33.3, 'the newer row should be the only current one');
      var nv = saveRating_(owner, { tripId: tripA.tripId, placeId: p2.placeId, scores: { value: 3 }, updateLast: false });
      assert(nv.place.blendedScore === 66.7, 'new visit should give 66.7, got ' + nv.place.blendedScore);
      assert(getRatings_(owner, p2.placeId).length === 3, 'expected 3 rows');
      var first = saveRating_(mate, { tripId: tripA.tripId, placeId: p2.placeId, scores: { value: 1 }, updateLast: true });
      assert(first.rating.personScore === 0 && getRatings_(owner, p2.placeId).length === 4, 'updateLast with no earlier rating should just add a row');
    });

    check('changing weights later does not rewrite earlier ratings', function () {
      var r1 = saveRating_(owner, { tripId: tripA.tripId, placeId: p3.placeId, scores: { guinness_temp: 4, guinness_taste: 4, value: 1 } });
      assert(r1.rating.personScore === 66.7, 'baseline ' + r1.rating.personScore);
      var undo = tweak('Pub', 'value', 'Weight', 2);
      try {
        var r2 = saveRating_(owner, { tripId: tripA.tripId, placeId: p3.placeId, scores: { guinness_temp: 4, guinness_taste: 4, value: 1 } });
        assert(r2.rating.personScore === 50, 'doubled value weight should give 50, got ' + r2.rating.personScore);
        var stored = getRatings_(owner, p3.placeId).filter(function (x) { return x.ratingId === r1.rating.ratingId; })[0];
        assert(stored.personScore === 66.7, 'earlier rating changed to ' + stored.personScore);
      } finally { undo(); }
    });

    check('a rating with everything skipped has no score but the place is Been', function () {
      var res = saveRating_(owner, { tripId: tripA.tripId, placeId: p4.placeId, scores: {}, wouldReturn: 'Maybe' });
      assert(res.rating.personScore === null, 'score should be null');
      assert(res.place.status === 'Been' && res.place.blendedScore === null, 'status/blend wrong: ' + JSON.stringify(res.place));
      assert(Object.keys(res.rating.scores).length === 10 && res.rating.scores.food === undefined, 'all active criteria should be stored as null');
    });

    check('two members blend and a 100-point gap raises the split flag', function () {
      saveRating_(owner, { tripId: tripA.tripId, placeId: p5.placeId, scores: { value: 4, service: 4 } });
      var res = saveRating_(mate, { tripId: tripA.tripId, placeId: p5.placeId, scores: { value: 1, service: 1 } });
      assert(res.place.blendedScore === 50 && res.place.split === true, 'got ' + JSON.stringify(res.place));
      assert(res.place.personScores[owner] === 100 && res.place.personScores[mate] === 0, 'person scores wrong');
    });

    check('pint price is kept for pubs only', function () {
      var r = saveRating_(owner, { tripId: tripA.tripId, placeId: rest.placeId, pintPrice: 4, scores: { food: 3 } });
      assert(r.rating.pintPrice === null, 'restaurant rating kept a pint price: ' + r.rating.pintPrice);
      assert(r.rating.personScore === 66.7, 'food 3 should score 66.7, got ' + r.rating.personScore);
      var q = saveRating_(owner, { tripId: tripA.tripId, placeId: p1.placeId, scores: { value: 3 } });
      assert(q.rating.pintPrice === null, 'blank pint price should read back as null');
    });

    check('getRatings returns every member\'s ratings, newest first, with notes intact', function () {
      var rows = getRatings_(mate, p1.placeId);
      assert(rows.length === 3, 'expected 3 rows on Main pub, got ' + rows.length);
      for (var i = 1; i < rows.length; i++) assert(ratingRank_({ VisitTimestamp: rows[i - 1].visitTimestamp, CreatedAt: rows[i - 1].createdAt }) >= ratingRank_({ VisitTimestamp: rows[i].visitTimestamp, CreatedAt: rows[i].createdAt }), 'not newest first');
      assert(rows.some(function (x) { return x.notes === 'Lovely pint'; }), 'notes missing');
      var current = rows.filter(function (x) { return x.current; });
      assert(current.length === 2, 'one current row per person, got ' + current.length);
    });

    check('notes that start with = are stored as text and read back unchanged', function () {
      var res = saveRating_(owner, { tripId: tripA.tripId, placeId: p4.placeId, scores: {}, notes: '=1+1' });
      var row = readRowsFresh_('Ratings').filter(function (r) { return r.RatingID === res.rating.ratingId; })[0];
      var cell = sheet_('Ratings').getRange(row._row, SCHEMA.Ratings.indexOf('Notes') + 1);
      assert(!cell.getFormula() && typeof cell.getValue() === 'string', 'became a formula or number');
      assert(getRatings_(owner, p4.placeId)[0].notes === '=1+1', 'round trip changed the note');
    });

    check('getTripData carries the criteria for every ratable category', function () {
      var d = getTripData_(mate, tripA.tripId);
      assert(d.criteria && d.criteria.Pub.length === 10 && d.criteria.Restaurant.length === 5, 'criteria missing');
      assert(d.criteria.Anchor === undefined, 'anchors have no criteria');
      assert(Object.keys(d.criteria).length === 7, 'expected 7 categories, got ' + Object.keys(d.criteria).length);
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

// ===========================================================================
// PHASE 4 TESTS: paste this whole block at the END of Tests.gs.
// Run runPhase4Tests() and runPhase4PublicSmokeTest() from the Apps Script editor.
// ===========================================================================

function runPhase4Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner4.' + stamp + '@example.com';
  var mate = 'mate4.' + stamp + '@example.com';
  var stranger = 'stranger4.' + stamp + '@example.com';
  var other = 'other4.' + stamp + '@example.com';
  var tripA = null, tripB = null, pub = null;
  var T1 = '2026-01-10T18:00:00.000Z', T2 = '2026-01-10T18:05:00.000Z', T3 = '2026-01-10T18:10:00.000Z'; // in the past, so polls never see them as "new"

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  /** Writes a check-in row with a chosen timestamp, so ordering tests are exact. */
  function put(tripId, email, type, value, ts, placeId) {
    var id = newId_();
    appendRow_('CheckIns', { CheckInID: id, TripID: tripId, UserEmail: email, PlaceID: placeId || '', Type: type, Value: value, Timestamp: ts });
    cacheClear_('CheckIns');
    return id;
  }

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P4 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P4 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');
    pub = savePlace_(owner, { tripId: tripA.tripId, name: 'P4 pub', category: 'Pub', lat: 55.95, lng: -3.19 });

    check('tally check-ins default to 1 and accept only 1 or -1', function () {
      var a = addCheckIn_(owner, { tripId: tripA.tripId, type: 'PINT' });
      assert(a.value === '1' && a.userEmail === owner && a.type === 'PINT', 'default wrong: ' + JSON.stringify(a));
      assert(addCheckIn_(owner, { tripId: tripA.tripId, type: 'PINT', value: 1 }).value === '1', 'number 1 should become "1"');
      assert(addCheckIn_(owner, { tripId: tripA.tripId, type: 'WHISKY', value: -1 }).value === '-1', 'an undo should keep -1');
      assert(addCheckIn_(owner, { tripId: tripA.tripId, type: 'OTHER_DRINK', value: '1' }).value === '1', 'other drink failed');
      assert(addCheckIn_(owner, { tripId: tripA.tripId, type: 'FOOD' }).value === '1', 'food failed');
      expectError(function () { addCheckIn_(owner, { tripId: tripA.tripId, type: 'PINT', value: 2 }); }, 'must be 1 or -1');
      expectError(function () { addCheckIn_(owner, { tripId: tripA.tripId, type: 'FOOD', value: 'lots' }); }, 'must be 1 or -1');
    });

    check('mood check-ins accept only the five moods', function () {
      MOODS.forEach(function (m) { assert(addCheckIn_(mate, { tripId: tripA.tripId, type: 'MOOD', value: m }).value === m, 'mood ' + m + ' failed'); });
      expectError(function () { addCheckIn_(mate, { tripId: tripA.tripId, type: 'MOOD', value: 'Hangry' }); }, 'Mood must be');
      expectError(function () { addCheckIn_(mate, { tripId: tripA.tripId, type: 'MOOD' }); }, 'Mood must be');
    });

    check('place check-ins keep their free-text value, within 100 characters', function () {
      var c = addCheckIn_(owner, { tripId: tripA.tripId, placeId: pub.placeId, type: 'LEAVE', value: 'heading on' });
      assert(c.value === 'heading on', 'value changed: ' + c.value);
      expectError(function () { addCheckIn_(owner, { tripId: tripA.tripId, placeId: pub.placeId, type: 'LEAVE', value: new Array(102).join('x') }); }, '100');
    });

    check('a rejected check-in writes nothing', function () {
      var before = getCheckIns_(owner, tripA.tripId, '').length;
      try { addCheckIn_(owner, { tripId: tripA.tripId, type: 'PINT', value: 9 }); } catch (e) { /* expected */ }
      try { addCheckIn_(owner, { tripId: tripA.tripId, type: 'MOOD', value: 'No' }); } catch (e) { /* expected */ }
      assert(getCheckIns_(owner, tripA.tripId, '').length === before, 'a rejected check-in was saved');
    });

    // From here the trip's check-in history is replaced by exact, known rows.
    deleteRowsWhere_('CheckIns', 'TripID', [tripA.tripId]);
    put(tripA.tripId, owner, 'PINT', '1', T2);
    put(tripA.tripId, mate, 'MOOD', 'Fresh', T1);
    put(tripA.tripId, mate, 'PINT', '1', T3);
    put(tripB.tripId, other, 'PINT', '1', T2);

    check('getCheckIns returns this trip\'s rows, oldest first, with who and when', function () {
      var rows = getCheckIns_(owner, tripA.tripId, '');
      assert(rows.length === 3, 'expected 3, got ' + rows.length);
      assert(rows[0].timestamp === T1 && rows[1].timestamp === T2 && rows[2].timestamp === T3, 'not oldest first');
      assert(rows[0].userEmail === mate && rows[0].type === 'MOOD' && rows[0].value === 'Fresh', 'row shape wrong: ' + JSON.stringify(rows[0]));
      assert(getCheckIns_(owner, tripA.tripId).length === 3, 'undefined since should mean all');
    });

    check('getCheckIns "since" is strict, and bad values are refused', function () {
      assert(getCheckIns_(mate, tripA.tripId, T1).length === 2, 'since T1 should give 2');
      assert(getCheckIns_(mate, tripA.tripId, T3).length === 0, 'since T3 should give none');
      assert(getCheckIns_(mate, tripA.tripId, '2026-01-10T18:04:59Z').length === 2, 'an ISO value without milliseconds should work');
      expectError(function () { getCheckIns_(mate, tripA.tripId, 'yesterday'); }, 'valid date');
    });

    check('getCheckIns and getSync refuse outsiders and other trips', function () {
      expectError(function () { getCheckIns_(stranger, tripA.tripId, ''); }, 'not a member');
      expectError(function () { getCheckIns_(owner, tripB.tripId, ''); }, 'not a member');
      expectError(function () { getSync_(stranger, tripA.tripId, '', ''); }, 'not a member');
      expectError(function () { getSync_(owner, tripB.tripId, '', ''); }, 'not a member');
      assert(getCheckIns_(other, tripB.tripId, '').length === 1 && getCheckIns_(other, tripB.tripId, '')[0].userEmail === other, 'trip B should only see its own');
    });

    check('getTripData carries the last 36 hours of check-ins and a stamp', function () {
      var oldId = put(tripA.tripId, owner, 'FOOD', '1', new Date(Date.now() - 40 * 3600000).toISOString());
      var recent = addCheckIn_(mate, { tripId: tripA.tripId, type: 'FOOD' });
      var d = getTripData_(owner, tripA.tripId);
      assert(typeof d.stamp === 'string' && d.stamp.length > 0, 'missing stamp');
      assert(d.checkIns.some(function (c) { return c.checkInId === recent.checkInId; }), 'the recent check-in is missing');
      assert(!d.checkIns.some(function (c) { return c.checkInId === oldId; }), 'a 40-hour-old check-in should be left out');
    });

    check('the stamp is steady, and changes for places, ratings, ARRIVE/SKIP and members only', function () {
      var s0 = tripStamp_(tripA.tripId);
      assert(tripStamp_(tripA.tripId) === s0, 'stamp changed with no write');
      addCheckIn_(owner, { tripId: tripA.tripId, type: 'PINT' });
      addCheckIn_(owner, { tripId: tripA.tripId, type: 'MOOD', value: 'Feeling it' });
      addCheckIn_(owner, { tripId: tripA.tripId, placeId: pub.placeId, type: 'LEAVE' });
      assert(tripStamp_(tripA.tripId) === s0, 'drinks, mood and LEAVE must not change the stamp');
      var p2 = savePlace_(owner, { tripId: tripA.tripId, name: 'Stamp pub', category: 'Pub', lat: 55.95, lng: -3.19 });
      var s1 = tripStamp_(tripA.tripId); assert(s1 !== s0, 'new place should change the stamp');
      Utilities.sleep(5); // edits in the same millisecond would share a timestamp
      updatePlace_(owner, { placeId: p2.placeId, notes: 'edited' });
      var s2 = tripStamp_(tripA.tripId); assert(s2 !== s1, 'an edit should change the stamp');
      saveRating_(mate, { tripId: tripA.tripId, placeId: p2.placeId, scores: { value: 3 } });
      var s3 = tripStamp_(tripA.tripId); assert(s3 !== s2, 'a rating should change the stamp');
      addCheckIn_(owner, { tripId: tripA.tripId, placeId: pub.placeId, type: 'ARRIVE' });
      var s4 = tripStamp_(tripA.tripId); assert(s4 !== s3, 'ARRIVE should change the stamp');
      var p3 = savePlace_(owner, { tripId: tripA.tripId, name: 'Skip me', category: 'Pub', lat: 55.95, lng: -3.19 });
      var s5a = tripStamp_(tripA.tripId);
      addCheckIn_(owner, { tripId: tripA.tripId, placeId: p3.placeId, type: 'SKIP' });
      assert(tripStamp_(tripA.tripId) !== s5a, 'SKIP should change the stamp');
      var s5 = tripStamp_(tripA.tripId);
      addMember_(owner, tripA.tripId, 'third.' + stamp + '@example.com', 'Tom');
      assert(tripStamp_(tripA.tripId) !== s5, 'a new member should change the stamp');
      assert(tripStamp_(tripB.tripId) === tripStamp_(tripB.tripId), 'other trip stable');
    });

    check('getSync sends places only when something changed, and always sends new check-ins', function () {
      var first = getSync_(owner, tripA.tripId, '', '');
      assert(first.changed === true && first.places.length >= 3 && first.members.length >= 2, 'a blank stamp should return everything');
      var again = getSync_(owner, tripA.tripId, first.serverTime, first.stamp);
      assert(again.changed === false && again.places === null && again.members === null, 'nothing changed, so no places: ' + JSON.stringify(again).slice(0, 120));
      assert(again.checkIns.length === 0, 'no new check-ins expected');
      var before = first.serverTime;
      var c = addCheckIn_(mate, { tripId: tripA.tripId, type: 'WHISKY' });
      var drink = getSync_(owner, tripA.tripId, before, first.stamp);
      assert(drink.changed === false && drink.places === null, 'a drink must not trigger a places download');
      assert(drink.checkIns.some(function (x) { return x.checkInId === c.checkInId && x.userEmail === mate; }), 'the other member\'s drink should arrive in the poll');
      savePlace_(mate, { tripId: tripA.tripId, name: 'Added by mate', category: 'Pub', lat: 55.95, lng: -3.19 });
      var moved = getSync_(owner, tripA.tripId, before, first.stamp);
      assert(moved.changed === true && moved.places.some(function (p) { return p.name === 'Added by mate'; }), 'a new place should come down with the poll');
      assert(moved.stamp !== first.stamp, 'stamp should move');
      var tripBSync = getSync_(other, tripB.tripId, '', '');
      assert(tripBSync.places.every(function (p) { return p.tripId === tripB.tripId; }) && tripBSync.checkIns.length === 1, 'trip B leaked');
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Runs the real public functions as YOU: createTrip, addCheckIn, getCheckIns, getSync, getTripData. */
function runPhase4PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' p4 public ' + new Date().getTime() });
    tripId = trip.tripId;
    addCheckIn({ tripId: tripId, type: 'PINT' });
    addCheckIn({ tripId: tripId, type: 'MOOD', value: 'Fresh' });
    var rows = getCheckIns(tripId, '');
    if (rows.length !== 2 || rows[0].userEmail !== me) throw new Error('getCheckIns returned ' + JSON.stringify(rows));
    var s = getSync(tripId, '', '');
    if (!s.changed || s.checkIns.length !== 2 || !s.places || !s.members) throw new Error('getSync (blank stamp) wrong');
    var s2 = getSync(tripId, s.serverTime, s.stamp);
    if (s2.changed || s2.places !== null) throw new Error('getSync with the current stamp should report no change');
    var d = getTripData(tripId);
    if (d.checkIns.length !== 2 || !d.stamp) throw new Error('getTripData is missing checkIns or stamp');
    Logger.log('Phase 4 public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}

// ===========================================================================
// PHASE 5 TESTS: paste this whole block at the END of Tests.gs.
// Run runPhase5Tests() and runPhase5PublicSmokeTest() from the Apps Script editor.
// (Phase 5 also needs one extra line in cleanupTestData_, described in the edit sheet.)
// ===========================================================================

function runPhase5Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner5.' + stamp + '@example.com';
  var mate = 'mate5.' + stamp + '@example.com';
  var stranger = 'stranger5.' + stamp + '@example.com';
  var other = 'other5.' + stamp + '@example.com';
  var tripA = null, tripB = null, a = null, b = null, c = null, d = null, pB = null;

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function mk(email, tripId, name) { return savePlace_(email, { tripId: tripId, name: name, category: 'Pub', lat: 55.95, lng: -3.19 }); }
  function stop(p, visited) { return { placeId: p.placeId, plannedArrival: '', stopNote: '', visited: !!visited }; }
  function ids(route) { return route.stops.map(function (s) { return s.placeId; }).join(','); }
  function rowsFor(routeId) { return readRowsFresh_('Routes').filter(function (r) { return r.RouteID === routeId; }); }
  var RID = 'route' + stamp, RID2 = 'routeB' + stamp;

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P5 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P5 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');
    a = mk(owner, tripA.tripId, 'Stop A'); b = mk(owner, tripA.tripId, 'Stop B');
    c = mk(owner, tripA.tripId, 'Stop C'); d = mk(owner, tripA.tripId, 'Stop D');
    pB = mk(other, tripB.tripId, 'Other trip pub');

    var v1 = null;
    check('a new route is saved, in order, and every member can read it', function () {
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, routeName: 'Friday crawl', baseUpdatedAt: '', stops: [stop(a), stop(b), stop(c)] });
      assert(res.ok === true && res.stale === false, 'should succeed: ' + JSON.stringify(res));
      assert(res.route.routeName === 'Friday crawl' && ids(res.route) === [a, b, c].map(function (p) { return p.placeId; }).join(','), 'route wrong');
      v1 = res.route.updatedAt;
      var rows = rowsFor(RID);
      assert(rows.length === 3 && rows[0].StopOrder === 1 && rows[2].StopOrder === 3, 'rows wrong: ' + rows.length);
      assert(rows[0].UpdatedBy === owner && rows[0].TripID === tripA.tripId, 'owner/trip not recorded');
      var got = getRoutes_(mate, tripA.tripId);
      assert(got.length === 1 && got[0].routeId === RID && got[0].stops.length === 3, 'mate should see the route');
      assert(getRoute_(mate, tripA.tripId, RID).updatedAt === v1, 'getRoute should match');
    });

    check('saving rewrites the route: new order, visited flags, no leftover rows, other routes untouched', function () {
      var other1 = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID2, routeName: 'Saturday', baseUpdatedAt: '', stops: [stop(d)] });
      assert(other1.ok, 'second route failed');
      var res = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(c), stop(a, true)] });
      assert(res.ok === true, 'rewrite failed: ' + JSON.stringify(res));
      assert(res.route.updatedAt > v1, 'UpdatedAt must move forward');
      assert(res.route.routeName === 'Friday crawl', 'a blank name should keep the old one');
      var rows = rowsFor(RID);
      assert(rows.length === 2, 'expected exactly 2 rows, got ' + rows.length);
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(ids(back) === c.placeId + ',' + a.placeId && back.stops[1].visited === true && back.stops[0].visited === false, 'order/visited wrong');
      assert(rows[0].UpdatedBy === mate, 'UpdatedBy should be the editor');
      assert(rowsFor(RID2).length === 1 && getRoutes_(owner, tripA.tripId).length === 2, 'the other route must be untouched');
      v1 = res.route.updatedAt;
    });

    check('a stale save is rejected and returns the latest; retrying on that version works', function () {
      var older = v1;
      var win = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: older, stops: [stop(c), stop(a, true), stop(b)] });
      assert(win.ok, 'first writer should win');
      var lose = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: older, stops: [stop(a), stop(c)] });
      assert(lose.ok === false && lose.stale === true, 'second writer should be told it is stale');
      assert(ids(lose.route) === [c, a, b].map(function (p) { return p.placeId; }).join(','), 'stale reply should carry the latest route');
      assert(rowsFor(RID).length === 3, 'a rejected save must not change anything');
      var retry = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: lose.route.updatedAt, stops: lose.route.stops.slice().reverse() });
      assert(retry.ok === true, 'retry on the latest version should work');
      v1 = retry.route.updatedAt;
    });

    check('a brand-new route id that already exists, or a route someone deleted, counts as stale', function () {
      var dupe = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: '', stops: [stop(a)] });
      assert(dupe.stale === true && dupe.route && dupe.route.routeId === RID, 'creating over an existing id should be stale');
      var gone = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: 'neverMade' + stamp, baseUpdatedAt: '2026-01-01T00:00:00.000Z', stops: [stop(a)] });
      assert(gone.stale === true && gone.route === null, 'a version for a route that does not exist should be stale with route null');
    });

    check('saving with no stops deletes the route, and a later save on the old version is stale with route null', function () {
      var stampBefore = routeStamp_(tripA.tripId);
      var del = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID2, baseUpdatedAt: getRoute_(owner, tripA.tripId, RID2).updatedAt, stops: [] });
      assert(del.ok === true && del.route === null, 'delete should succeed: ' + JSON.stringify(del));
      assert(routeStamp_(tripA.tripId) !== stampBefore, 'deleting an older route must change the stamp, or other phones never hear about it');
      assert(rowsFor(RID2).length === 0 && getRoutes_(owner, tripA.tripId).length === 1, 'rows should be gone');
      var late = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID2, baseUpdatedAt: 'whatever', stops: [stop(d)] });
      assert(late.stale === true && late.route === null, 'editing a deleted route should be stale');
    });

    check('saveRouteStops rejects bad input and writes nothing', function () {
      var before = rowsFor(RID).length;
      var base = { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] };
      function with_(x) { return Object.assign({}, base, x); }
      expectError(function () { saveRouteStops_(owner, null); }, 'No route');
      expectError(function () { saveRouteStops_(owner, with_({ routeId: 'bad id!' })); }, 'not valid');
      expectError(function () { saveRouteStops_(owner, with_({ routeId: 'abc' })); }, 'not valid');
      expectError(function () { saveRouteStops_(owner, with_({ stops: 'x' })); }, 'must be a list');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [null] })); }, 'must be an object');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [stop(a), stop(a)] })); }, 'only once');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [{ placeId: 'nope' }] })); }, 'not in this trip');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [stop(pB)] })); }, 'not in this trip');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [Object.assign(stop(a), { stopNote: new Array(202).join('x') })] })); }, '200');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [Object.assign(stop(a), { plannedArrival: 'soon' })] })); }, 'valid date');
      expectError(function () { saveRouteStops_(owner, with_({ routeName: new Array(63).join('x') })); }, '60');
      var many = []; for (var i = 0; i < 61; i++) many.push(stop(a));
      expectError(function () { saveRouteStops_(owner, with_({ stops: many })); }, 'at most 60');
      assert(rowsFor(RID).length === before, 'a rejected save must not change rows');
    });

    check('outsiders and other trips are refused, and a route id cannot be hijacked across trips', function () {
      expectError(function () { getRoutes_(stranger, tripA.tripId); }, 'not a member');
      expectError(function () { getRoute_(stranger, tripA.tripId, RID); }, 'not a member');
      expectError(function () { saveRouteStops_(stranger, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] }); }, 'not a member');
      expectError(function () { saveRouteStops_(owner, { routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] }); }, 'trip is required');
      expectError(function () { saveRouteStops_(other, { tripId: tripB.tripId, routeId: RID, baseUpdatedAt: '', stops: [stop(pB)] }); }, 'already in use');
      assert(getRoutes_(other, tripB.tripId).length === 0, 'trip B must see none of trip A\'s routes');
      assert(getRoute_(owner, tripA.tripId, RID).stops.length === 3, 'trip A route intact');
    });

    check('notes that start with = are stored as text, and planned arrival is normalised', function () {
      var cur = getRoute_(owner, tripA.tripId, RID);
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt,
        stops: [Object.assign(stop(a), { stopNote: '=1+1', plannedArrival: '2026-10-10T18:00:00Z' }), stop(b)] });
      assert(res.ok, 'save failed');
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(back.stops[0].stopNote === '=1+1', 'note changed to "' + back.stops[0].stopNote + '"');
      assert(back.stops[0].plannedArrival === '2026-10-10T18:00:00.000Z', 'arrival not normalised: ' + back.stops[0].plannedArrival);
      var row = rowsFor(RID)[0];
      var cell = sheet_('Routes').getRange(row._row, SCHEMA.Routes.indexOf('StopNote') + 1);
      assert(!cell.getFormula() && typeof cell.getValue() === 'string', 'note became a formula');
      v1 = back.updatedAt;
    });

    check('if an interrupted rewrite left two versions behind, only the newest counts', function () {
      var cur = getRoute_(owner, tripA.tripId, RID);
      appendRow_('Routes', { RouteID: RID, TripID: tripA.tripId, RouteName: 'Old', StopOrder: 1, PlaceID: d.placeId, Visited: false, UpdatedBy: owner, UpdatedAt: '2020-01-01T00:00:00.000Z' });
      appendRow_('Routes', { RouteID: RID, TripID: tripA.tripId, RouteName: 'Old', StopOrder: 2, PlaceID: c.placeId, Visited: false, UpdatedBy: owner, UpdatedAt: '2020-01-01T00:00:00.000Z' });
      cacheClear_('Routes');
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(back.stops.length === cur.stops.length && back.updatedAt === cur.updatedAt && back.routeName !== 'Old', 'old version leaked: ' + JSON.stringify(back));
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: cur.stops });
      assert(res.ok && rowsFor(RID).length === cur.stops.length, 'the next save should clear the leftovers, rows: ' + rowsFor(RID).length);
      v1 = res.route.updatedAt;
    });

    check('the route stamp changes on save and delete only, and getSync returns routes only when it differs', function () {
      var s0 = routeStamp_(tripA.tripId);
      assert(routeStamp_(tripA.tripId) === s0, 'stamp changed with no write');
      var tripStampBefore = tripStamp_(tripA.tripId);
      var sync0 = getSync_(owner, tripA.tripId, '', tripStampBefore, s0);
      assert(sync0.routes === null && sync0.routeStamp === s0, 'same stamp should give no routes: ' + JSON.stringify(sync0.routes));
      var cur = getRoute_(owner, tripA.tripId, RID);
      saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: cur.stops.slice().reverse() });
      var s1 = routeStamp_(tripA.tripId);
      assert(s1 !== s0, 'a save should change the stamp');
      assert(tripStamp_(tripA.tripId) === tripStampBefore, 'a route save must not trigger a places download');
      var sync1 = getSync_(owner, tripA.tripId, '', tripStampBefore, s0);
      assert(sync1.routes && sync1.routes.length === 1 && sync1.routeStamp === s1 && sync1.changed === false, 'routes should come down with the new stamp');
      assert(getSync_(owner, tripA.tripId, '', tripStampBefore).routes.length === 1, 'no stamp given means send routes');
      expectError(function () { getSync_(stranger, tripA.tripId, '', '', ''); }, 'not a member');
      v1 = getRoute_(owner, tripA.tripId, RID).updatedAt;
    });

    check('getTripData carries the routes and their stamp', function () {
      var data = getTripData_(mate, tripA.tripId);
      assert(data.routes && data.routes.length === 1 && data.routes[0].routeId === RID, 'routes missing');
      assert(data.routeStamp === routeStamp_(tripA.tripId), 'route stamp missing');
      assert(getTripData_(other, tripB.tripId).routes.length === 0, 'trip B should have no routes');
    });

    check('many quick saves, each on the latest version, all land in order', function () {
      var cur = getRoute_(owner, tripA.tripId, RID), n;
      for (n = 0; n < 8; n++) {
        var stops = cur.stops.slice(); stops.push(stops.shift());   // rotate
        var res = saveRouteStops_(n % 2 ? owner : mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: stops });
        assert(res.ok, 'save ' + n + ' failed');
        assert(res.route.updatedAt > cur.updatedAt, 'version must always move forward (save ' + n + ')');
        cur = res.route;
      }
      assert(ids(getRoute_(owner, tripA.tripId, RID)) === ids(cur) && rowsFor(RID).length === cur.stops.length, 'final state wrong');
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Runs the real public functions as YOU: createTrip, savePlace, saveRouteStops, getRoute, getSync, getTripData. */
function runPhase5PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' p5 public ' + new Date().getTime() });
    tripId = trip.tripId;
    var p1 = savePlace({ tripId: tripId, name: 'Smoke 1', category: 'Pub', lat: 55.95, lng: -3.19 });
    var p2 = savePlace({ tripId: tripId, name: 'Smoke 2', category: 'Restaurant', lat: 55.951, lng: -3.191 });
    var rid = 'smoke' + new Date().getTime();
    var saved = saveRouteStops({ tripId: tripId, routeId: rid, routeName: 'Smoke route', baseUpdatedAt: '',
      stops: [{ placeId: p1.placeId, visited: false }, { placeId: p2.placeId, visited: true }] });
    if (!saved.ok || saved.route.stops.length !== 2) throw new Error('saveRouteStops failed: ' + JSON.stringify(saved));
    var got = getRoute(tripId, rid);
    if (!got || got.stops[1].visited !== true) throw new Error('getRoute returned ' + JSON.stringify(got));
    var stale = saveRouteStops({ tripId: tripId, routeId: rid, baseUpdatedAt: '2020-01-01T00:00:00.000Z', stops: [{ placeId: p1.placeId }] });
    if (stale.ok || !stale.stale) throw new Error('an old version should be stale');
    var s = getSync(tripId, '', '', '');
    if (!s.routes || s.routes.length !== 1) throw new Error('getSync should carry the route');
    var s2 = getSync(tripId, s.serverTime, s.stamp, s.routeStamp);
    if (s2.routes !== null) throw new Error('getSync with the current route stamp should send no routes');
    if (getTripData(tripId).routes.length !== 1) throw new Error('getTripData is missing routes');
    var del = saveRouteStops({ tripId: tripId, routeId: rid, baseUpdatedAt: got.updatedAt, stops: [] });
    if (!del.ok || del.route !== null) throw new Error('delete failed');
    Logger.log('Phase 5 public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}// ===========================================================================
// PHASE 5 TESTS: paste this whole block at the END of Tests.gs.
// Run runPhase5Tests() and runPhase5PublicSmokeTest() from the Apps Script editor.
// (Phase 5 also needs one extra line in cleanupTestData_, described in the edit sheet.)
// ===========================================================================

function runPhase5Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner5.' + stamp + '@example.com';
  var mate = 'mate5.' + stamp + '@example.com';
  var stranger = 'stranger5.' + stamp + '@example.com';
  var other = 'other5.' + stamp + '@example.com';
  var tripA = null, tripB = null, a = null, b = null, c = null, d = null, pB = null;

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function mk(email, tripId, name) { return savePlace_(email, { tripId: tripId, name: name, category: 'Pub', lat: 55.95, lng: -3.19 }); }
  function stop(p, visited) { return { placeId: p.placeId, plannedArrival: '', stopNote: '', visited: !!visited }; }
  function ids(route) { return route.stops.map(function (s) { return s.placeId; }).join(','); }
  function rowsFor(routeId) { return readRowsFresh_('Routes').filter(function (r) { return r.RouteID === routeId; }); }
  var RID = 'route' + stamp, RID2 = 'routeB' + stamp;

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P5 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P5 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');
    a = mk(owner, tripA.tripId, 'Stop A'); b = mk(owner, tripA.tripId, 'Stop B');
    c = mk(owner, tripA.tripId, 'Stop C'); d = mk(owner, tripA.tripId, 'Stop D');
    pB = mk(other, tripB.tripId, 'Other trip pub');

    var v1 = null;
    check('a new route is saved, in order, and every member can read it', function () {
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, routeName: 'Friday crawl', baseUpdatedAt: '', stops: [stop(a), stop(b), stop(c)] });
      assert(res.ok === true && res.stale === false, 'should succeed: ' + JSON.stringify(res));
      assert(res.route.routeName === 'Friday crawl' && ids(res.route) === [a, b, c].map(function (p) { return p.placeId; }).join(','), 'route wrong');
      v1 = res.route.updatedAt;
      var rows = rowsFor(RID);
      assert(rows.length === 3 && rows[0].StopOrder === 1 && rows[2].StopOrder === 3, 'rows wrong: ' + rows.length);
      assert(rows[0].UpdatedBy === owner && rows[0].TripID === tripA.tripId, 'owner/trip not recorded');
      var got = getRoutes_(mate, tripA.tripId);
      assert(got.length === 1 && got[0].routeId === RID && got[0].stops.length === 3, 'mate should see the route');
      assert(getRoute_(mate, tripA.tripId, RID).updatedAt === v1, 'getRoute should match');
    });

    check('saving rewrites the route: new order, visited flags, no leftover rows, other routes untouched', function () {
      var other1 = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID2, routeName: 'Saturday', baseUpdatedAt: '', stops: [stop(d)] });
      assert(other1.ok, 'second route failed');
      var res = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(c), stop(a, true)] });
      assert(res.ok === true, 'rewrite failed: ' + JSON.stringify(res));
      assert(res.route.updatedAt > v1, 'UpdatedAt must move forward');
      assert(res.route.routeName === 'Friday crawl', 'a blank name should keep the old one');
      var rows = rowsFor(RID);
      assert(rows.length === 2, 'expected exactly 2 rows, got ' + rows.length);
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(ids(back) === c.placeId + ',' + a.placeId && back.stops[1].visited === true && back.stops[0].visited === false, 'order/visited wrong');
      assert(rows[0].UpdatedBy === mate, 'UpdatedBy should be the editor');
      assert(rowsFor(RID2).length === 1 && getRoutes_(owner, tripA.tripId).length === 2, 'the other route must be untouched');
      v1 = res.route.updatedAt;
    });

    check('a stale save is rejected and returns the latest; retrying on that version works', function () {
      var older = v1;
      var win = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: older, stops: [stop(c), stop(a, true), stop(b)] });
      assert(win.ok, 'first writer should win');
      var lose = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: older, stops: [stop(a), stop(c)] });
      assert(lose.ok === false && lose.stale === true, 'second writer should be told it is stale');
      assert(ids(lose.route) === [c, a, b].map(function (p) { return p.placeId; }).join(','), 'stale reply should carry the latest route');
      assert(rowsFor(RID).length === 3, 'a rejected save must not change anything');
      var retry = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: lose.route.updatedAt, stops: lose.route.stops.slice().reverse() });
      assert(retry.ok === true, 'retry on the latest version should work');
      v1 = retry.route.updatedAt;
    });

    check('a brand-new route id that already exists, or a route someone deleted, counts as stale', function () {
      var dupe = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: '', stops: [stop(a)] });
      assert(dupe.stale === true && dupe.route && dupe.route.routeId === RID, 'creating over an existing id should be stale');
      var gone = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: 'neverMade' + stamp, baseUpdatedAt: '2026-01-01T00:00:00.000Z', stops: [stop(a)] });
      assert(gone.stale === true && gone.route === null, 'a version for a route that does not exist should be stale with route null');
    });

    check('saving with no stops deletes the route, and a later save on the old version is stale with route null', function () {
      var stampBefore = routeStamp_(tripA.tripId);
      var del = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID2, baseUpdatedAt: getRoute_(owner, tripA.tripId, RID2).updatedAt, stops: [] });
      assert(del.ok === true && del.route === null, 'delete should succeed: ' + JSON.stringify(del));
      assert(routeStamp_(tripA.tripId) !== stampBefore, 'deleting an older route must change the stamp, or other phones never hear about it');
      assert(rowsFor(RID2).length === 0 && getRoutes_(owner, tripA.tripId).length === 1, 'rows should be gone');
      var late = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID2, baseUpdatedAt: 'whatever', stops: [stop(d)] });
      assert(late.stale === true && late.route === null, 'editing a deleted route should be stale');
    });

    check('saveRouteStops rejects bad input and writes nothing', function () {
      var before = rowsFor(RID).length;
      var base = { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] };
      function with_(x) { return Object.assign({}, base, x); }
      expectError(function () { saveRouteStops_(owner, null); }, 'No route');
      expectError(function () { saveRouteStops_(owner, with_({ routeId: 'bad id!' })); }, 'not valid');
      expectError(function () { saveRouteStops_(owner, with_({ routeId: 'abc' })); }, 'not valid');
      expectError(function () { saveRouteStops_(owner, with_({ stops: 'x' })); }, 'must be a list');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [null] })); }, 'must be an object');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [stop(a), stop(a)] })); }, 'only once');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [{ placeId: 'nope' }] })); }, 'not in this trip');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [stop(pB)] })); }, 'not in this trip');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [Object.assign(stop(a), { stopNote: new Array(202).join('x') })] })); }, '200');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [Object.assign(stop(a), { plannedArrival: 'soon' })] })); }, 'valid date');
      expectError(function () { saveRouteStops_(owner, with_({ routeName: new Array(63).join('x') })); }, '60');
      var many = []; for (var i = 0; i < 61; i++) many.push(stop(a));
      expectError(function () { saveRouteStops_(owner, with_({ stops: many })); }, 'at most 60');
      assert(rowsFor(RID).length === before, 'a rejected save must not change rows');
    });

    check('outsiders and other trips are refused, and a route id cannot be hijacked across trips', function () {
      expectError(function () { getRoutes_(stranger, tripA.tripId); }, 'not a member');
      expectError(function () { getRoute_(stranger, tripA.tripId, RID); }, 'not a member');
      expectError(function () { saveRouteStops_(stranger, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] }); }, 'not a member');
      expectError(function () { saveRouteStops_(owner, { routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] }); }, 'trip is required');
      expectError(function () { saveRouteStops_(other, { tripId: tripB.tripId, routeId: RID, baseUpdatedAt: '', stops: [stop(pB)] }); }, 'already in use');
      assert(getRoutes_(other, tripB.tripId).length === 0, 'trip B must see none of trip A\'s routes');
      assert(getRoute_(owner, tripA.tripId, RID).stops.length === 3, 'trip A route intact');
    });

    check('notes that start with = are stored as text, and planned arrival is normalised', function () {
      var cur = getRoute_(owner, tripA.tripId, RID);
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt,
        stops: [Object.assign(stop(a), { stopNote: '=1+1', plannedArrival: '2026-10-10T18:00:00Z' }), stop(b)] });
      assert(res.ok, 'save failed');
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(back.stops[0].stopNote === '=1+1', 'note changed to "' + back.stops[0].stopNote + '"');
      assert(back.stops[0].plannedArrival === '2026-10-10T18:00:00.000Z', 'arrival not normalised: ' + back.stops[0].plannedArrival);
      var row = rowsFor(RID)[0];
      var cell = sheet_('Routes').getRange(row._row, SCHEMA.Routes.indexOf('StopNote') + 1);
      assert(!cell.getFormula() && typeof cell.getValue() === 'string', 'note became a formula');
      v1 = back.updatedAt;
    });

    check('if an interrupted rewrite left two versions behind, only the newest counts', function () {
      var cur = getRoute_(owner, tripA.tripId, RID);
      appendRow_('Routes', { RouteID: RID, TripID: tripA.tripId, RouteName: 'Old', StopOrder: 1, PlaceID: d.placeId, Visited: false, UpdatedBy: owner, UpdatedAt: '2020-01-01T00:00:00.000Z' });
      appendRow_('Routes', { RouteID: RID, TripID: tripA.tripId, RouteName: 'Old', StopOrder: 2, PlaceID: c.placeId, Visited: false, UpdatedBy: owner, UpdatedAt: '2020-01-01T00:00:00.000Z' });
      cacheClear_('Routes');
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(back.stops.length === cur.stops.length && back.updatedAt === cur.updatedAt && back.routeName !== 'Old', 'old version leaked: ' + JSON.stringify(back));
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: cur.stops });
      assert(res.ok && rowsFor(RID).length === cur.stops.length, 'the next save should clear the leftovers, rows: ' + rowsFor(RID).length);
      v1 = res.route.updatedAt;
    });

    check('the route stamp changes on save and delete only, and getSync returns routes only when it differs', function () {
      var s0 = routeStamp_(tripA.tripId);
      assert(routeStamp_(tripA.tripId) === s0, 'stamp changed with no write');
      var tripStampBefore = tripStamp_(tripA.tripId);
      var sync0 = getSync_(owner, tripA.tripId, '', tripStampBefore, s0);
      assert(sync0.routes === null && sync0.routeStamp === s0, 'same stamp should give no routes: ' + JSON.stringify(sync0.routes));
      var cur = getRoute_(owner, tripA.tripId, RID);
      saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: cur.stops.slice().reverse() });
      var s1 = routeStamp_(tripA.tripId);
      assert(s1 !== s0, 'a save should change the stamp');
      assert(tripStamp_(tripA.tripId) === tripStampBefore, 'a route save must not trigger a places download');
      var sync1 = getSync_(owner, tripA.tripId, '', tripStampBefore, s0);
      assert(sync1.routes && sync1.routes.length === 1 && sync1.routeStamp === s1 && sync1.changed === false, 'routes should come down with the new stamp');
      assert(getSync_(owner, tripA.tripId, '', tripStampBefore).routes.length === 1, 'no stamp given means send routes');
      expectError(function () { getSync_(stranger, tripA.tripId, '', '', ''); }, 'not a member');
      v1 = getRoute_(owner, tripA.tripId, RID).updatedAt;
    });

    check('getTripData carries the routes and their stamp', function () {
      var data = getTripData_(mate, tripA.tripId);
      assert(data.routes && data.routes.length === 1 && data.routes[0].routeId === RID, 'routes missing');
      assert(data.routeStamp === routeStamp_(tripA.tripId), 'route stamp missing');
      assert(getTripData_(other, tripB.tripId).routes.length === 0, 'trip B should have no routes');
    });

    check('many quick saves, each on the latest version, all land in order', function () {
      var cur = getRoute_(owner, tripA.tripId, RID), n;
      for (n = 0; n < 8; n++) {
        var stops = cur.stops.slice(); stops.push(stops.shift());   // rotate
        var res = saveRouteStops_(n % 2 ? owner : mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: stops });
        assert(res.ok, 'save ' + n + ' failed');
        assert(res.route.updatedAt > cur.updatedAt, 'version must always move forward (save ' + n + ')');
        cur = res.route;
      }
      assert(ids(getRoute_(owner, tripA.tripId, RID)) === ids(cur) && rowsFor(RID).length === cur.stops.length, 'final state wrong');
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Runs the real public functions as YOU: createTrip, savePlace, saveRouteStops, getRoute, getSync, getTripData. */
function runPhase5PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' p5 public ' + new Date().getTime() });
    tripId = trip.tripId;
    var p1 = savePlace({ tripId: tripId, name: 'Smoke 1', category: 'Pub', lat: 55.95, lng: -3.19 });
    var p2 = savePlace({ tripId: tripId, name: 'Smoke 2', category: 'Restaurant', lat: 55.951, lng: -3.191 });
    var rid = 'smoke' + new Date().getTime();
    var saved = saveRouteStops({ tripId: tripId, routeId: rid, routeName: 'Smoke route', baseUpdatedAt: '',
      stops: [{ placeId: p1.placeId, visited: false }, { placeId: p2.placeId, visited: true }] });
    if (!saved.ok || saved.route.stops.length !== 2) throw new Error('saveRouteStops failed: ' + JSON.stringify(saved));
    var got = getRoute(tripId, rid);
    if (!got || got.stops[1].visited !== true) throw new Error('getRoute returned ' + JSON.stringify(got));
    var stale = saveRouteStops({ tripId: tripId, routeId: rid, baseUpdatedAt: '2020-01-01T00:00:00.000Z', stops: [{ placeId: p1.placeId }] });
    if (stale.ok || !stale.stale) throw new Error('an old version should be stale');
    var s = getSync(tripId, '', '', '');
    if (!s.routes || s.routes.length !== 1) throw new Error('getSync should carry the route');
    var s2 = getSync(tripId, s.serverTime, s.stamp, s.routeStamp);
    if (s2.routes !== null) throw new Error('getSync with the current route stamp should send no routes');
    if (getTripData(tripId).routes.length !== 1) throw new Error('getTripData is missing routes');
    var del = saveRouteStops({ tripId: tripId, routeId: rid, baseUpdatedAt: got.updatedAt, stops: [] });
    if (!del.ok || del.route !== null) throw new Error('delete failed');
    Logger.log('Phase 5 public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}// ===========================================================================
// PHASE 5 TESTS: paste this whole block at the END of Tests.gs.
// Run runPhase5Tests() and runPhase5PublicSmokeTest() from the Apps Script editor.
// (Phase 5 also needs one extra line in cleanupTestData_, described in the edit sheet.)
// ===========================================================================

function runPhase5Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner5.' + stamp + '@example.com';
  var mate = 'mate5.' + stamp + '@example.com';
  var stranger = 'stranger5.' + stamp + '@example.com';
  var other = 'other5.' + stamp + '@example.com';
  var tripA = null, tripB = null, a = null, b = null, c = null, d = null, pB = null;

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function mk(email, tripId, name) { return savePlace_(email, { tripId: tripId, name: name, category: 'Pub', lat: 55.95, lng: -3.19 }); }
  function stop(p, visited) { return { placeId: p.placeId, plannedArrival: '', stopNote: '', visited: !!visited }; }
  function ids(route) { return route.stops.map(function (s) { return s.placeId; }).join(','); }
  function rowsFor(routeId) { return readRowsFresh_('Routes').filter(function (r) { return r.RouteID === routeId; }); }
  var RID = 'route' + stamp, RID2 = 'routeB' + stamp;

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P5 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P5 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');
    a = mk(owner, tripA.tripId, 'Stop A'); b = mk(owner, tripA.tripId, 'Stop B');
    c = mk(owner, tripA.tripId, 'Stop C'); d = mk(owner, tripA.tripId, 'Stop D');
    pB = mk(other, tripB.tripId, 'Other trip pub');

    var v1 = null;
    check('a new route is saved, in order, and every member can read it', function () {
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, routeName: 'Friday crawl', baseUpdatedAt: '', stops: [stop(a), stop(b), stop(c)] });
      assert(res.ok === true && res.stale === false, 'should succeed: ' + JSON.stringify(res));
      assert(res.route.routeName === 'Friday crawl' && ids(res.route) === [a, b, c].map(function (p) { return p.placeId; }).join(','), 'route wrong');
      v1 = res.route.updatedAt;
      var rows = rowsFor(RID);
      assert(rows.length === 3 && rows[0].StopOrder === 1 && rows[2].StopOrder === 3, 'rows wrong: ' + rows.length);
      assert(rows[0].UpdatedBy === owner && rows[0].TripID === tripA.tripId, 'owner/trip not recorded');
      var got = getRoutes_(mate, tripA.tripId);
      assert(got.length === 1 && got[0].routeId === RID && got[0].stops.length === 3, 'mate should see the route');
      assert(getRoute_(mate, tripA.tripId, RID).updatedAt === v1, 'getRoute should match');
    });

    check('saving rewrites the route: new order, visited flags, no leftover rows, other routes untouched', function () {
      var other1 = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID2, routeName: 'Saturday', baseUpdatedAt: '', stops: [stop(d)] });
      assert(other1.ok, 'second route failed');
      var res = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(c), stop(a, true)] });
      assert(res.ok === true, 'rewrite failed: ' + JSON.stringify(res));
      assert(res.route.updatedAt > v1, 'UpdatedAt must move forward');
      assert(res.route.routeName === 'Friday crawl', 'a blank name should keep the old one');
      var rows = rowsFor(RID);
      assert(rows.length === 2, 'expected exactly 2 rows, got ' + rows.length);
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(ids(back) === c.placeId + ',' + a.placeId && back.stops[1].visited === true && back.stops[0].visited === false, 'order/visited wrong');
      assert(rows[0].UpdatedBy === mate, 'UpdatedBy should be the editor');
      assert(rowsFor(RID2).length === 1 && getRoutes_(owner, tripA.tripId).length === 2, 'the other route must be untouched');
      v1 = res.route.updatedAt;
    });

    check('a stale save is rejected and returns the latest; retrying on that version works', function () {
      var older = v1;
      var win = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: older, stops: [stop(c), stop(a, true), stop(b)] });
      assert(win.ok, 'first writer should win');
      var lose = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: older, stops: [stop(a), stop(c)] });
      assert(lose.ok === false && lose.stale === true, 'second writer should be told it is stale');
      assert(ids(lose.route) === [c, a, b].map(function (p) { return p.placeId; }).join(','), 'stale reply should carry the latest route');
      assert(rowsFor(RID).length === 3, 'a rejected save must not change anything');
      var retry = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: lose.route.updatedAt, stops: lose.route.stops.slice().reverse() });
      assert(retry.ok === true, 'retry on the latest version should work');
      v1 = retry.route.updatedAt;
    });

    check('a brand-new route id that already exists, or a route someone deleted, counts as stale', function () {
      var dupe = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: '', stops: [stop(a)] });
      assert(dupe.stale === true && dupe.route && dupe.route.routeId === RID, 'creating over an existing id should be stale');
      var gone = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: 'neverMade' + stamp, baseUpdatedAt: '2026-01-01T00:00:00.000Z', stops: [stop(a)] });
      assert(gone.stale === true && gone.route === null, 'a version for a route that does not exist should be stale with route null');
    });

    check('saving with no stops deletes the route, and a later save on the old version is stale with route null', function () {
      var stampBefore = routeStamp_(tripA.tripId);
      var del = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID2, baseUpdatedAt: getRoute_(owner, tripA.tripId, RID2).updatedAt, stops: [] });
      assert(del.ok === true && del.route === null, 'delete should succeed: ' + JSON.stringify(del));
      assert(routeStamp_(tripA.tripId) !== stampBefore, 'deleting an older route must change the stamp, or other phones never hear about it');
      assert(rowsFor(RID2).length === 0 && getRoutes_(owner, tripA.tripId).length === 1, 'rows should be gone');
      var late = saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID2, baseUpdatedAt: 'whatever', stops: [stop(d)] });
      assert(late.stale === true && late.route === null, 'editing a deleted route should be stale');
    });

    check('saveRouteStops rejects bad input and writes nothing', function () {
      var before = rowsFor(RID).length;
      var base = { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] };
      function with_(x) { return Object.assign({}, base, x); }
      expectError(function () { saveRouteStops_(owner, null); }, 'No route');
      expectError(function () { saveRouteStops_(owner, with_({ routeId: 'bad id!' })); }, 'not valid');
      expectError(function () { saveRouteStops_(owner, with_({ routeId: 'abc' })); }, 'not valid');
      expectError(function () { saveRouteStops_(owner, with_({ stops: 'x' })); }, 'must be a list');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [null] })); }, 'must be an object');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [stop(a), stop(a)] })); }, 'only once');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [{ placeId: 'nope' }] })); }, 'not in this trip');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [stop(pB)] })); }, 'not in this trip');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [Object.assign(stop(a), { stopNote: new Array(202).join('x') })] })); }, '200');
      expectError(function () { saveRouteStops_(owner, with_({ stops: [Object.assign(stop(a), { plannedArrival: 'soon' })] })); }, 'valid date');
      expectError(function () { saveRouteStops_(owner, with_({ routeName: new Array(63).join('x') })); }, '60');
      var many = []; for (var i = 0; i < 61; i++) many.push(stop(a));
      expectError(function () { saveRouteStops_(owner, with_({ stops: many })); }, 'at most 60');
      assert(rowsFor(RID).length === before, 'a rejected save must not change rows');
    });

    check('outsiders and other trips are refused, and a route id cannot be hijacked across trips', function () {
      expectError(function () { getRoutes_(stranger, tripA.tripId); }, 'not a member');
      expectError(function () { getRoute_(stranger, tripA.tripId, RID); }, 'not a member');
      expectError(function () { saveRouteStops_(stranger, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] }); }, 'not a member');
      expectError(function () { saveRouteStops_(owner, { routeId: RID, baseUpdatedAt: v1, stops: [stop(a)] }); }, 'trip is required');
      expectError(function () { saveRouteStops_(other, { tripId: tripB.tripId, routeId: RID, baseUpdatedAt: '', stops: [stop(pB)] }); }, 'already in use');
      assert(getRoutes_(other, tripB.tripId).length === 0, 'trip B must see none of trip A\'s routes');
      assert(getRoute_(owner, tripA.tripId, RID).stops.length === 3, 'trip A route intact');
    });

    check('notes that start with = are stored as text, and planned arrival is normalised', function () {
      var cur = getRoute_(owner, tripA.tripId, RID);
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt,
        stops: [Object.assign(stop(a), { stopNote: '=1+1', plannedArrival: '2026-10-10T18:00:00Z' }), stop(b)] });
      assert(res.ok, 'save failed');
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(back.stops[0].stopNote === '=1+1', 'note changed to "' + back.stops[0].stopNote + '"');
      assert(back.stops[0].plannedArrival === '2026-10-10T18:00:00.000Z', 'arrival not normalised: ' + back.stops[0].plannedArrival);
      var row = rowsFor(RID)[0];
      var cell = sheet_('Routes').getRange(row._row, SCHEMA.Routes.indexOf('StopNote') + 1);
      assert(!cell.getFormula() && typeof cell.getValue() === 'string', 'note became a formula');
      v1 = back.updatedAt;
    });

    check('if an interrupted rewrite left two versions behind, only the newest counts', function () {
      var cur = getRoute_(owner, tripA.tripId, RID);
      appendRow_('Routes', { RouteID: RID, TripID: tripA.tripId, RouteName: 'Old', StopOrder: 1, PlaceID: d.placeId, Visited: false, UpdatedBy: owner, UpdatedAt: '2020-01-01T00:00:00.000Z' });
      appendRow_('Routes', { RouteID: RID, TripID: tripA.tripId, RouteName: 'Old', StopOrder: 2, PlaceID: c.placeId, Visited: false, UpdatedBy: owner, UpdatedAt: '2020-01-01T00:00:00.000Z' });
      cacheClear_('Routes');
      var back = getRoute_(owner, tripA.tripId, RID);
      assert(back.stops.length === cur.stops.length && back.updatedAt === cur.updatedAt && back.routeName !== 'Old', 'old version leaked: ' + JSON.stringify(back));
      var res = saveRouteStops_(owner, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: cur.stops });
      assert(res.ok && rowsFor(RID).length === cur.stops.length, 'the next save should clear the leftovers, rows: ' + rowsFor(RID).length);
      v1 = res.route.updatedAt;
    });

    check('the route stamp changes on save and delete only, and getSync returns routes only when it differs', function () {
      var s0 = routeStamp_(tripA.tripId);
      assert(routeStamp_(tripA.tripId) === s0, 'stamp changed with no write');
      var tripStampBefore = tripStamp_(tripA.tripId);
      var sync0 = getSync_(owner, tripA.tripId, '', tripStampBefore, s0);
      assert(sync0.routes === null && sync0.routeStamp === s0, 'same stamp should give no routes: ' + JSON.stringify(sync0.routes));
      var cur = getRoute_(owner, tripA.tripId, RID);
      saveRouteStops_(mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: cur.stops.slice().reverse() });
      var s1 = routeStamp_(tripA.tripId);
      assert(s1 !== s0, 'a save should change the stamp');
      assert(tripStamp_(tripA.tripId) === tripStampBefore, 'a route save must not trigger a places download');
      var sync1 = getSync_(owner, tripA.tripId, '', tripStampBefore, s0);
      assert(sync1.routes && sync1.routes.length === 1 && sync1.routeStamp === s1 && sync1.changed === false, 'routes should come down with the new stamp');
      assert(getSync_(owner, tripA.tripId, '', tripStampBefore).routes.length === 1, 'no stamp given means send routes');
      expectError(function () { getSync_(stranger, tripA.tripId, '', '', ''); }, 'not a member');
      v1 = getRoute_(owner, tripA.tripId, RID).updatedAt;
    });

    check('getTripData carries the routes and their stamp', function () {
      var data = getTripData_(mate, tripA.tripId);
      assert(data.routes && data.routes.length === 1 && data.routes[0].routeId === RID, 'routes missing');
      assert(data.routeStamp === routeStamp_(tripA.tripId), 'route stamp missing');
      assert(getTripData_(other, tripB.tripId).routes.length === 0, 'trip B should have no routes');
    });

    check('many quick saves, each on the latest version, all land in order', function () {
      var cur = getRoute_(owner, tripA.tripId, RID), n;
      for (n = 0; n < 8; n++) {
        var stops = cur.stops.slice(); stops.push(stops.shift());   // rotate
        var res = saveRouteStops_(n % 2 ? owner : mate, { tripId: tripA.tripId, routeId: RID, baseUpdatedAt: cur.updatedAt, stops: stops });
        assert(res.ok, 'save ' + n + ' failed');
        assert(res.route.updatedAt > cur.updatedAt, 'version must always move forward (save ' + n + ')');
        cur = res.route;
      }
      assert(ids(getRoute_(owner, tripA.tripId, RID)) === ids(cur) && rowsFor(RID).length === cur.stops.length, 'final state wrong');
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Runs the real public functions as YOU: createTrip, savePlace, saveRouteStops, getRoute, getSync, getTripData. */
function runPhase5PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' p5 public ' + new Date().getTime() });
    tripId = trip.tripId;
    var p1 = savePlace({ tripId: tripId, name: 'Smoke 1', category: 'Pub', lat: 55.95, lng: -3.19 });
    var p2 = savePlace({ tripId: tripId, name: 'Smoke 2', category: 'Restaurant', lat: 55.951, lng: -3.191 });
    var rid = 'smoke' + new Date().getTime();
    var saved = saveRouteStops({ tripId: tripId, routeId: rid, routeName: 'Smoke route', baseUpdatedAt: '',
      stops: [{ placeId: p1.placeId, visited: false }, { placeId: p2.placeId, visited: true }] });
    if (!saved.ok || saved.route.stops.length !== 2) throw new Error('saveRouteStops failed: ' + JSON.stringify(saved));
    var got = getRoute(tripId, rid);
    if (!got || got.stops[1].visited !== true) throw new Error('getRoute returned ' + JSON.stringify(got));
    var stale = saveRouteStops({ tripId: tripId, routeId: rid, baseUpdatedAt: '2020-01-01T00:00:00.000Z', stops: [{ placeId: p1.placeId }] });
    if (stale.ok || !stale.stale) throw new Error('an old version should be stale');
    var s = getSync(tripId, '', '', '');
    if (!s.routes || s.routes.length !== 1) throw new Error('getSync should carry the route');
    var s2 = getSync(tripId, s.serverTime, s.stamp, s.routeStamp);
    if (s2.routes !== null) throw new Error('getSync with the current route stamp should send no routes');
    if (getTripData(tripId).routes.length !== 1) throw new Error('getTripData is missing routes');
    var del = saveRouteStops({ tripId: tripId, routeId: rid, baseUpdatedAt: got.updatedAt, stops: [] });
    if (!del.ok || del.route !== null) throw new Error('delete failed');
    Logger.log('Phase 5 public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}

// ===========================================================================
// PHASE 6 TESTS: paste this whole block at the END of Tests.gs.
// Run runPhase6Tests() and runPhase6PublicSmokeTest() from the Apps Script editor.
// They use a stand-in for the geocoder, so no Google Maps lookups are spent.
// They briefly change rows in the Settings tab and put them back afterwards.
// ===========================================================================

/** Swaps the pin-lookup function for a test one. Returns a function that puts the real one back. */
function stubGeocoder_(fn) { var orig = geocodePlace_; geocodePlace_ = fn; return function () { geocodePlace_ = orig; }; }

/** Finds a pin for any name, except names containing NOMATCH (no result) or QUOTA (daily limit reached). */
function fakeGeocode_(query) {
  var q = String(query);
  if (q.indexOf('QUOTA') >= 0) return { ok: false, error: 'The free daily lookup limit has been reached. Drop a pin on the map instead, or try again tomorrow.' };
  if (q.indexOf('NOMATCH') >= 0) return { ok: false, error: 'No match found.' };
  var h = 0; for (var i = 0; i < q.length; i++) h = (h * 31 + q.charCodeAt(i)) % 9973;
  return { ok: true, lat: 55.9 + h / 100000, lng: -3.2 - h / 100000, formatted: '1 Test Street, ' + q.slice(0, 30), locationType: 'APPROXIMATE', partialMatch: true };
}

function runPhase6Tests() {
  var results = [];
  var tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner6.' + stamp + '@example.com';
  var mate = 'mate6.' + stamp + '@example.com';
  var stranger = 'stranger6.' + stamp + '@example.com';
  var other = 'other6.' + stamp + '@example.com';
  var tripA = null, tripB = null;
  var SEEDCITY = 'ZZTEST Seedville ' + stamp;
  var savedSettings = null;
  var unstub = null;

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function placesOf(email, tripId) { return getPlaces_(email, tripId); }
  function byName(email, tripId, name) { return placesOf(email, tripId).filter(function (p) { return p.name === name; })[0]; }
  function seedRow(name, cat, area, extra) {
    appendRow_('Seed', Object.assign({ City: SEEDCITY, Name: name, Category: cat, Area: area, VerifyFlag: 'Yes' }, extra || {}));
  }

  try {
    initSpreadsheet();
    unstub = stubGeocoder_(fakeGeocode_);
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P6 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P6 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');
    savedSettings = {};
    getSettingsForm_(owner).forEach(function (f) { savedSettings[f.key] = f.value; });

    // ------------------------------------------------------------ CSV reading
    check('parseCsv_ handles quotes, commas and line breaks inside quotes, CRLF, a BOM and blank lines', function () {
      var rows = parseCsv_('\uFEFFName,Notes\r\n"Smith, J",\"He said \"\"hi\"\"\"\r\n\r\n"two\nlines",x\n');
      assert(rows.length === 3, 'expected 3 rows, got ' + rows.length);
      assert(rows[0].cells[0] === 'Name' && rows[1].cells[0] === 'Smith, J' && rows[1].cells[1] === 'He said "hi"', 'quotes wrong: ' + JSON.stringify(rows[1].cells));
      assert(rows[2].cells[0] === 'two\nlines' && rows[2].line === 4, 'line break in quotes or line number wrong: ' + rows[2].line);
      assert(parseCsv_('a,b').length === 1 && parseCsv_('a,b\n1,2').length === 2, 'no trailing newline should still work');
      expectError(function () { parseCsv_('a,"never closed\nb,c'); }, 'never closed');
    });

    // ------------------------------------------------------------ starter list
    check('the Edinburgh starter list loads once and shows up as a city', function () {
      var first = loadStarterSeed_();
      var again = loadStarterSeed_();
      assert(again === 0, 'running it again must add nothing, added ' + again);
      assert(first === 0 || first === STARTER_ROWS.length, 'first run should add all or none (already loaded), added ' + first);
      var cities = getSeedCities_(owner);
      var ed = cities.filter(function (c) { return c.city === 'Edinburgh'; })[0];
      assert(ed && ed.count >= 29, 'Edinburgh should list 29 rows: ' + JSON.stringify(cities));
      expectError(function () { getSeedCities_(stranger); }, 'not a member of any trip');
      var murray = readRowsFresh_('Seed').filter(function (r) { return r.Name === 'Murrayfield Stadium'; })[0];
      assert(murray && murray.Lat === '' && murray.VerifyFlag === 'Yes' && /^https:\/\/www\.google\.com\/maps\/search\//.test(murray.GoogleMapsUrl), 'seed row wrong: ' + JSON.stringify(murray));
    });

    check('anchor kinds are inferred from names and notes', function () {
      assert(inferAnchorKind_('Murrayfield Stadium', 'Ground. Set as the trip venue') === 'Stadium', 'stadium');
      assert(inferAnchorKind_('Haymarket Station', 'Rail and tram hub on the route to the ground') === 'Station', 'station by name');
      assert(inferAnchorKind_('Edinburgh Waverley', 'Main station. Check last trains and trams') === 'Station', 'station by notes');
      assert(inferAnchorKind_('Premier Hotel', '') === 'Lodging' && inferAnchorKind_('Somewhere', 'x') === 'Other', 'lodging / other');
    });

    // ------------------------------------------------------------ seed import
    check('importSeed copies a city\'s list into the trip with pins found, unconfirmed, and links made', function () {
      seedRow('ZZ Test Pub', 'Pub', 'Old Town', { LocalTags: 'proper_boozer', MatchDayTags: 'queue_risk,cash_only', HoursNote: 'Check hours' });
      seedRow('ZZ Ground Stadium', 'Anchor', 'West', { Notes: 'Ground. Set as the trip venue' });
      seedRow('ZZ Central Station', 'Anchor', 'Centre', { Notes: 'Main station' });
      seedRow('ZZ Known Restaurant', 'Restaurant', 'New Town', { Lat: 55.95, Lng: -3.19 });
      seedRow('ZZ NOMATCH Pub', 'Pub', 'Nowhere');
      cacheClear_('Seed');
      var cities = getSeedCities_(owner);
      assert(cities.some(function (c) { return c.city === SEEDCITY && c.count === 5; }), 'test city not listed');
      var res = importSeed_(mate, tripA.tripId, SEEDCITY.toLowerCase());
      assert(res.total === 5 && res.added === 5 && res.duplicates === 0 && res.rejected.length === 0, 'summary: ' + JSON.stringify(res));
      assert(res.geocoded === 3 && res.notFound === 1 && res.notAttempted === 0 && res.quotaHit === false, 'lookups: ' + JSON.stringify(res));
      var pub = byName(owner, tripA.tripId, 'ZZ Test Pub');
      assert(pub.source === 'Seed' && pub.coordSource === 'Seed' && pub.coordConfirmed === false && pub.lat !== null, 'pub should be Seed, unconfirmed, with a pin: ' + JSON.stringify(pub));
      assert(pub.address.indexOf('Test Street') >= 0 && pub.addedBy === mate && pub.city === SEEDCITY, 'address/addedBy/city wrong');
      assert(pub.localTags.join() === 'proper_boozer' && pub.matchDayTags.join() === 'queue_risk,cash_only' && pub.hoursNote === 'Check hours', 'tags/hours not copied');
      assert(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=ZZ%20Test%20Pub/.test(pub.googleMapsUrl), 'search link not generated: ' + pub.googleMapsUrl);
      assert(byName(owner, tripA.tripId, 'ZZ Ground Stadium').anchorKind === 'Stadium' && byName(owner, tripA.tripId, 'ZZ Central Station').anchorKind === 'Station', 'anchor kinds not inferred');
      var known = byName(owner, tripA.tripId, 'ZZ Known Restaurant');
      assert(known.lat === 55.95 && known.coordSource === 'Seed' && known.coordConfirmed === false, 'seed coordinates should be kept, still unconfirmed');
      var nomatch = byName(owner, tripA.tripId, 'ZZ NOMATCH Pub');
      assert(nomatch.lat === null && nomatch.lng === null && nomatch.coordConfirmed === false, 'unmatched place should have no pin');
    });

    check('importing the same list again adds nothing, and other trips and outsiders are handled', function () {
      var again = importSeed_(owner, tripA.tripId, SEEDCITY);
      assert(again.added === 0 && again.duplicates === 5 && again.geocoded === 0, 'second import: ' + JSON.stringify(again));
      assert(placesOf(owner, tripA.tripId).length === 5, 'places duplicated');
      expectError(function () { importSeed_(stranger, tripA.tripId, SEEDCITY); }, 'not a member');
      expectError(function () { importSeed_(owner, tripB.tripId, SEEDCITY); }, 'not a member');
      expectError(function () { importSeed_(owner, tripA.tripId, 'Atlantis'); }, 'no starter list');
      expectError(function () { importSeed_(owner, tripA.tripId, ''); }, 'City is required');
      var b = importSeed_(other, tripB.tripId, SEEDCITY);
      assert(b.added === 5, 'another trip should get its own copy, added ' + b.added);
    });

    check('an import looks up at most 40 pins; geocodeMissing finds the rest 20 at a time', function () {
      var t3 = createTrip_(owner, { city: TEST_PREFIX + ' P6 C ' + stamp }); tripIds.push(t3.tripId);
      var csv = 'Name,Category\n'; for (var i = 1; i <= 45; i++) csv += 'Bulk place ' + i + ',Pub\n';
      var res = importCsv_(owner, t3.tripId, csv);
      assert(res.added === 45 && res.geocoded === 40 && res.notAttempted === 5, 'cap wrong: ' + JSON.stringify(res));
      assert(placesOf(owner, t3.tripId).filter(function (p) { return p.lat === null; }).length === 5, 'five should have no pin yet');
      var m = geocodeMissing_(owner, t3.tripId);
      assert(m.tried === 5 && m.found === 5 && m.remaining === 0 && m.quotaHit === false, 'geocodeMissing: ' + JSON.stringify(m));
      var p = byName(owner, t3.tripId, 'Bulk place 45');
      assert(p.lat !== null && p.coordSource === 'Geocoded' && p.coordConfirmed === false, 'found pin should be Geocoded and unconfirmed: ' + JSON.stringify([p.coordSource, p.coordConfirmed]));
      expectError(function () { geocodeMissing_(stranger, t3.tripId); }, 'not a member');
    });

    check('geocodeMissing works in batches of 20, keeps hand-placed pins, and respects the seed source', function () {
      var t4 = createTrip_(owner, { city: TEST_PREFIX + ' P6 D ' + stamp }); tripIds.push(t4.tripId);
      var i;
      for (i = 1; i <= 25; i++) savePlace_(owner, { tripId: t4.tripId, name: 'No pin ' + i, category: 'Pub' });
      var s = savePlace_(owner, { tripId: t4.tripId, name: 'Seed no pin', category: 'Pub', source: 'Seed' });
      var hand = savePlace_(owner, { tripId: t4.tripId, name: 'Hand placed', category: 'Pub', lat: 55.9, lng: -3.1 });
      var r1 = geocodeMissing_(owner, t4.tripId);
      assert(r1.tried === 20 && r1.found === 20 && r1.remaining === 6, 'first batch: ' + JSON.stringify(r1));
      var r2 = geocodeMissing_(owner, t4.tripId);
      assert(r2.tried === 6 && r2.found === 6 && r2.remaining === 0, 'second batch: ' + JSON.stringify(r2));
      var back = placesOf(owner, t4.tripId);
      assert(back.filter(function (p) { return p.lat === null; }).length === 0, 'all should have pins');
      assert(back.filter(function (p) { return p.name === 'Seed no pin'; })[0].coordSource === 'Seed', 'a seed place keeps coordSource Seed');
      assert(back.filter(function (p) { return p.name === 'Hand placed'; })[0].lat === 55.9, 'a hand-placed pin must not move');
      assert(geocodeMissing_(owner, t4.tripId).tried === 0, 'nothing left to find');
    });

    check('when the free daily lookup limit is hit, the import still saves everything and stops looking', function () {
      var t5 = createTrip_(owner, { city: TEST_PREFIX + ' P6 E ' + stamp }); tripIds.push(t5.tripId);
      var csv = 'Name,Category\nFine one,Pub\nFine two,Pub\nQUOTA three,Pub\nAfter four,Pub\nAfter five,Pub\n';
      var res = importCsv_(owner, t5.tripId, csv);
      assert(res.added === 5 && res.geocoded === 2 && res.quotaHit === true && res.notAttempted === 2 && res.notFound === 1, 'quota handling: ' + JSON.stringify(res));
      var m = geocodeMissing_(owner, t5.tripId);
      assert(m.quotaHit === true && m.found === 0 && m.remaining === 3, 'geocodeMissing should stop at once on the limit: ' + JSON.stringify(m));
    });

    // ------------------------------------------------------------ CSV import
    check('importCsv reads friendly headers and categories, keeps given coordinates, and finds the rest', function () {
      var csv = 'name,Type,City,Area,Latitude,Longitude,Local Tags,Match Day Tags,Hours,Notes,VerifyFlag\n' +
        'Csv Pub,pub,Glasgow,Merchant City,55.86,-4.25,"proper_boozer, hidden gem","queue_risk;cash_only",Cash only,=1+1,Yes\n' +
        'Csv Grab,Grab & Go,,,,,,,,,\n' +
        'Csv Whisky,whisky bar,,Old Town,,,,,,,\n';
      var res = importCsv_(mate, tripA.tripId, csv);
      assert(res.total === 3 && res.added === 3 && res.rejected.length === 0, 'summary: ' + JSON.stringify(res));
      assert(res.ignoredColumns.join() === 'VerifyFlag', 'ignored columns: ' + res.ignoredColumns);
      assert(res.geocoded === 2, 'two blank-coordinate rows should be looked up, got ' + res.geocoded);
      var a = byName(owner, tripA.tripId, 'Csv Pub');
      assert(a.source === 'Own' && a.coordSource === 'Manual' && a.coordConfirmed === true && a.lat === 55.86 && a.city === 'Glasgow', 'given coordinates: ' + JSON.stringify(a));
      assert(a.localTags.join() === 'proper_boozer,hidden_gem' && a.matchDayTags.join() === 'queue_risk,cash_only', 'tags: ' + a.localTags + ' / ' + a.matchDayTags);
      assert(a.notes === '=1+1' && a.hoursNote === 'Cash only', 'notes should be stored as text');
      var g = byName(owner, tripA.tripId, 'Csv Grab');
      assert(g.category === 'Grab_and_Go' && g.city === tripA.city && g.coordSource === 'Geocoded' && g.coordConfirmed === false && g.lat !== null, 'geocoded row: ' + JSON.stringify(g));
      assert(byName(owner, tripA.tripId, 'Csv Whisky').category === 'Whisky_Bar', 'category variant');
    });

    check('importCsv reports each bad row with its line number, skips duplicates, and still imports the good rows', function () {
      var csv = 'Name,Category,Lat,Lng,GoogleMapsUrl,LocalTags,LastVerified\n' +
        'Good one,Pub,,,,,\n' +                                   // line 2
        ',Pub,,,,,\n' +                                           // line 3 no name
        'Bad cat,Nightclub,,,,,\n' +                              // line 4
        'Bad lat,Pub,95,0,,,\n' +                                 // line 5
        'Half pin,Pub,55.9,,,,\n' +                               // line 6
        'Bad link,Pub,,,https://evil.example.com/x,,\n' +         // line 7
        'Bad tag,Pub,,,,"!!",\n' +                                // line 8
        'Bad date,Pub,,,,,yesterday\n' +                          // line 9
        'Good one,Pub,,,,,\n' +                                   // line 10 duplicate within the file
        'Csv Pub,Pub,,,,,\n';                                     // line 11 already in the trip? (different city) ->added
      var res = importCsv_(owner, tripA.tripId, csv);
      var lines = res.rejected.map(function (r) { return r.line; }).join();
      assert(lines === '3,4,5,6,7,8,9', 'rejected lines: ' + lines + ' / ' + JSON.stringify(res.rejected));
      assert(res.rejected[1].reason.indexOf('Nightclub') >= 0 && res.rejected[0].reason.indexOf('Name') >= 0, 'reasons: ' + JSON.stringify(res.rejected.slice(0, 2)));
      assert(res.duplicates === 1 && res.added === 2 && res.total === 10, 'counts: ' + JSON.stringify({ added: res.added, dup: res.duplicates, total: res.total }));
      assert(placesOf(owner, tripA.tripId).filter(function (p) { return p.name === 'Good one'; }).length === 1, 'the duplicate must not be added');
    });

    check('importCsv refuses unusable files and outsiders, and writes nothing', function () {
      var before = placesOf(owner, tripA.tripId).length;
      expectError(function () { importCsv_(owner, tripA.tripId, ''); }, 'Paste or choose');
      expectError(function () { importCsv_(owner, tripA.tripId, 'Name,Category'); }, 'at least one place');
      expectError(function () { importCsv_(owner, tripA.tripId, 'Foo,Bar\n1,2'); }, 'Name column and a Category column');
      expectError(function () { importCsv_(owner, tripA.tripId, 'Name,Category\n"open,Pub'); }, 'never closed');
      var big = 'Name,Category\n'; for (var i = 0; i < 201; i++) big += 'P' + i + ',Pub\n';
      expectError(function () { importCsv_(owner, tripA.tripId, big); }, 'limit is 200');
      expectError(function () { importCsv_(owner, tripA.tripId, 'Name,Category\n' + new Array(MAX_CSV_CHARS + 2).join('x')); }, 'too large');
      expectError(function () { importCsv_(stranger, tripA.tripId, 'Name,Category\nX,Pub'); }, 'not a member');
      expectError(function () { importCsv_(owner, tripB.tripId, 'Name,Category\nX,Pub'); }, 'not a member');
      assert(placesOf(owner, tripA.tripId).length === before, 'a refused import must not save anything');
    });

    // ------------------------------------------------------------ members
    check('only the owner can remove a member; the owner and non-members cannot be removed', function () {
      expectError(function () { removeMember_(mate, tripA.tripId, owner); }, 'Only the trip owner');
      expectError(function () { removeMember_(stranger, tripA.tripId, mate); }, 'not a member');
      expectError(function () { removeMember_(owner, tripA.tripId, owner); }, 'cannot be removed');
      expectError(function () { removeMember_(owner, tripA.tripId, stranger); }, 'not a member of this trip');
      expectError(function () { removeMember_(owner, tripA.tripId, 'not-an-email'); }, 'valid email');
      var third = 'third6.' + stamp + '@example.com';
      addMember_(owner, tripA.tripId, third, 'Tom');
      var s0 = tripStamp_(tripA.tripId);
      var res = removeMember_(owner, tripA.tripId, third.toUpperCase());
      assert(res.removed === third, 'removed: ' + JSON.stringify(res));
      assert(getMembers_(owner, tripA.tripId).length === 2, 'should be back to two members');
      assert(tripStamp_(tripA.tripId) !== s0, 'removal must change the stamp so phones notice');
      expectError(function () { getPlaces_(third, tripA.tripId); }, 'not a member');
      assert(getMembers_(other, tripB.tripId).length === 1, 'other trip untouched');
    });

    // ------------------------------------------------------------ settings
    check('the settings form lists every editable setting with its current value', function () {
      var form = getSettingsForm_(mate);
      assert(form.length === 17, 'expected 17 fields, got ' + form.length);
      var by = {}; form.forEach(function (f) { by[f.key] = f; });
      assert(by.ScoreRed.value === savedSettings.ScoreRed && by.NearbyDefaultMinutes.options.join() === '5,10,15' && by.LocalTags.type === 'tags', 'form wrong');
      assert(by.MatchDayWindowHoursBefore.min === 0 && by.DetourFactor.max === 3, 'limits missing');
      expectError(function () { getSettingsForm_(stranger); }, 'not a member of any trip');
    });

    check('only an owner can save settings; changes persist, update in place, and reach the app', function () {
      expectError(function () { saveSettings_(stranger, { ScoreRed: '30' }); }, 'Only a trip owner');
      var rowsBefore = readRowsFresh_('Settings').length;
      var res = saveSettings_(owner, { ScoreRed: 30, SplitThreshold: '25', Currency: 'eur', NearbyDefaultMinutes: '15', LocalTags: 'Proper_Boozer, hidden_gem' });
      assert(res.settings.scoreRed === 30 && res.settings.splitThreshold === 25 && res.settings.currency === 'EUR' && res.settings.nearbyDefaultMinutes === 15, 'returned settings: ' + JSON.stringify(res.settings));
      assert(res.settings.localTags.join() === 'proper_boozer,hidden_gem', 'tags not cleaned: ' + res.settings.localTags);
      assert(readRowsFresh_('Settings').length === rowsBefore, 'existing rows must be updated, not duplicated');
      assert(getTripData_(mate, tripA.tripId).settings.scoreRed === 30, 'getTripData should carry the new value at once');
      var form = res.fields.filter(function (f) { return f.key === 'Currency'; })[0];
      assert(form.value === 'EUR', 'form should show the new value');
      var partial = saveSettings_(owner, { ScoreRed: '31' });
      assert(partial.settings.splitThreshold === 25 && partial.settings.scoreRed === 31, 'a partial save must leave the others alone');
    });

    check('settings are validated, and a bad value saves nothing', function () {
      var before = getSettingsForm_(owner).map(function (f) { return f.key + '=' + f.value; }).join('|');
      function bad(vals, contains) { expectError(function () { saveSettings_(owner, vals); }, contains); }
      bad({ ScoreRed: 'abc' }, 'must be a number');
      bad({ ScoreRed: '0' }, 'between 1 and 100');
      bad({ ScoreRed: '101' }, 'between 1 and 100');
      bad({ ScoreRed: '30.5' }, 'whole number');
      bad({ RefreshSeconds: '2' }, 'between 5 and 120');
      bad({ DetourFactor: '0.5' }, 'between 1 and 3');
      bad({ NearbyDefaultMinutes: '7' }, 'one of: 5, 10, 15');
      bad({ Currency: 'POUNDS' }, 'three-letter');
      bad({ LocalTags: 'bad tag!' }, 'invalid tag');
      bad({ MatchDayTags: '' }, 'cannot be empty');
      bad({ ScoreRed: '70', ScoreAmber: '60' }, 'must go up');
      bad({ ScoreLightGreen: '40' }, 'must go up');
      bad({ NotASetting: '1' }, 'Unknown setting');
      bad(null, 'No settings');
      bad(['x'], 'No settings');
      bad({ ScoreRed: '33', Currency: 'xx' }, 'three-letter');
      assert(getSettingsForm_(owner).map(function (f) { return f.key + '=' + f.value; }).join('|') === before, 'a rejected save changed something');
    });

    check('a setting missing from the sheet is added when saved', function () {
      // Rename the row instead of deleting it, so the Settings tab ends up exactly as it was.
      var target = readRowsFresh_('Settings').filter(function (r) { return r.Key === 'MaxWaypoints'; })[0];
      var keyCell = sheet_('Settings').getRange(target._row, 1);
      keyCell.setValue('ZZTEST_MaxWaypoints'); cacheClear_('Settings');
      try {
        assert(settingsForClient_().maxWaypoints === 9, 'the built-in default should apply when the row is missing');
        saveSettings_(owner, { MaxWaypoints: '8' });
        var added = readRowsFresh_('Settings').filter(function (r) { return r.Key === 'MaxWaypoints'; });
        assert(added.length === 1 && String(added[0].Value) === '8' && settingsForClient_().maxWaypoints === 8, 'row not added');
        sheet_('Settings').deleteRow(added[0]._row);
      } finally {
        sheet_('Settings').getRange(target._row, 1).setValue('MaxWaypoints'); cacheClear_('Settings');
      }
      assert(readRowsFresh_('Settings').filter(function (r) { return r.Key === 'MaxWaypoints'; }).length === 1, 'the original row should be back');
    });
  } finally {
    try {
      if (savedSettings) {
        var restore = {};
        Object.keys(savedSettings).forEach(function (k) { restore[k] = savedSettings[k]; });
        saveSettings_(owner, restore);
      }
    } catch (e) { results.push('WARN  settings restore failed: ' + e.message + ' (check the Settings tab by hand)'); }
    if (unstub) unstub();
    try { deleteRowsWhere_('Seed', 'City', [SEEDCITY]); cacheClear_('Seed'); } catch (e) { results.push('WARN  seed cleanup failed: ' + e.message); }
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Runs the real public functions as YOU. Looks up no pins (the CSV carries coordinates) and changes no setting. */
function runPhase6PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' p6 public ' + new Date().getTime() });
    tripId = trip.tripId;
    var res = importCsv(tripId, 'Name,Category,Lat,Lng\nSmoke A,Pub,55.95,-3.19\nSmoke B,Restaurant,55.951,-3.191');
    if (res.added !== 2 || res.geocoded !== 0) throw new Error('importCsv returned ' + JSON.stringify(res));
    var again = importCsv(tripId, 'Name,Category,Lat,Lng\nSmoke A,Pub,55.95,-3.19');
    if (again.duplicates !== 1 || again.added !== 0) throw new Error('a repeat should be a duplicate: ' + JSON.stringify(again));
    var m = geocodeMissing(tripId);
    if (m.tried !== 0 || m.remaining !== 0) throw new Error('geocodeMissing should have nothing to do: ' + JSON.stringify(m));
    if (!Array.isArray(getSeedCities())) throw new Error('getSeedCities should return a list');
    var form = getSettingsForm();
    if (form.length !== 17) throw new Error('getSettingsForm returned ' + form.length + ' fields');
    var cur = {}; form.forEach(function (f) { cur[f.key] = f.value; });
    var saved = saveSettings({ ScoreRed: cur.ScoreRed });
    if (!saved.settings || String(saved.settings.scoreRed) !== String(Number(cur.ScoreRed))) throw new Error('saveSettings did not echo the value');
    var added = addMember(tripId, 'smoke.' + new Date().getTime() + '@example.com', 'Smoke');
    var removed = removeMember(tripId, added.email);
    if (removed.removed !== added.email) throw new Error('removeMember returned ' + JSON.stringify(removed));
    Logger.log('Phase 6 public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}

/**
 * One-off tidy-up: deletes rows in the Routes tab whose trip no longer exists. Earlier test runs left a few
 * behind, because cleanupTestData_ did not clear that tab. Real trips are never touched.
 */
function removeOrphanRoutes() {
  var trips = {};
  readRowsFresh_('Trips').forEach(function (t) { trips[t.TripID] = true; });
  var orphans = readRowsFresh_('Routes').filter(function (r) { return !trips[r.TripID]; }).map(function (r) { return r._row; });
  withLock_(function () { deleteSheetRows_(sheet_('Routes'), orphans); cacheClear_('Routes'); });
  Logger.log('Removed ' + orphans.length + ' orphaned route row(s).');
  return orphans.length;
}

// ===========================================================================
// PHASE 7 TESTS. Run runPhase7Tests() and runPhase7PublicSmokeTest().
// They use a stand-in for the walking lookup, so no Maps quota is spent.
// ===========================================================================

function stubWalker_(fn) { var orig = fetchWalk_; fetchWalk_ = fn; return function () { fetchWalk_ = orig; }; }

function runPhase7Tests() {
  var results = [], tripIds = [];
  var stamp = String(new Date().getTime());
  var owner = 'owner7.' + stamp + '@example.com';
  var mate = 'mate7.' + stamp + '@example.com';
  var stranger = 'stranger7.' + stamp + '@example.com';
  var other = 'other7.' + stamp + '@example.com';
  var tripA = null, tripB = null;
  var T0 = '2026-01-10T17:00:00.000Z', T1 = '2026-01-10T18:00:00.000Z', T2 = '2026-01-10T18:10:00.000Z',
      T3 = '2026-01-10T18:20:00.000Z', T4 = '2026-01-10T18:30:00.000Z';

  function check(name, fn) {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '  ->  ' + (e && e.message ? e.message : e)); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function expectError(fn, contains) {
    var threw = false;
    try { fn(); } catch (e) {
      threw = true;
      if (contains && String(e.message).indexOf(contains) < 0) throw new Error('Wrong error: "' + e.message + '"');
    }
    if (!threw) throw new Error('Expected an error but none was thrown');
  }
  function pt(n) { var v = 1 + (Number(stamp) % 100000) / 1e6 + n / 1000; return { lat: v, lng: v }; } // unique, so the cache never hides a lookup
  function ci(tripId, email, type, value, ts) {
    appendRow_('CheckIns', { CheckInID: newId_(), TripID: tripId, UserEmail: email, PlaceID: '', Type: type, Value: value, Timestamp: ts });
    cacheClear_('CheckIns');
  }
  function priceRow(tripId, placeId, email, price) {
    appendRow_('Ratings', { RatingID: newId_(), PlaceID: placeId, TripID: tripId, UserEmail: email, VisitTimestamp: T0,
      ScoresJSON: '{}', PersonScore: '', WouldReturn: '', PintPrice: price, Notes: '', CreatedAt: T0 });
    cacheClear_('Ratings');
  }

  try {
    initSpreadsheet();
    tripA = createTrip_(owner, { city: TEST_PREFIX + ' P7 A ' + stamp, displayName: 'Olive' });
    tripB = createTrip_(other, { city: TEST_PREFIX + ' P7 B ' + stamp });
    tripIds.push(tripA.tripId, tripB.tripId);
    addMember_(owner, tripA.tripId, mate, 'Matt');

    check('exact times come back in order, rounded, and repeat lookups come from the cache', function () {
      var calls = 0;
      var undo = stubWalker_(function () { calls++; return { ok: true, sec: 630, m: 812.6 }; });
      try {
        var legs = [{ from: pt(1), to: pt(2) }, { from: pt(2), to: pt(3) }];
        var r1 = getExactWalkingTimes_(mate, tripA.tripId, legs);
        assert(calls === 2 && r1.tried === 2 && r1.quotaHit === false, 'first call: ' + JSON.stringify(r1));
        assert(r1.results[0].min === 10.5 && r1.results[0].m === 813, 'rounding: ' + JSON.stringify(r1.results[0]));
        var r2 = getExactWalkingTimes_(owner, tripA.tripId, legs);
        assert(calls === 2 && r2.tried === 0 && r2.results[1].min === 10.5, 'second call should be cached: ' + JSON.stringify(r2));
        assert(getExactWalkingTimes_(owner, tripA.tripId, []).results.length === 0, 'no legs, no results');
      } finally { undo(); }
    });

    check('a leg that cannot be found is null, and the free-limit stops further lookups', function () {
      var n = 0;
      var undo = stubWalker_(function () { n++; return n === 1 ? { ok: true, sec: 60, m: 80 } : (n === 2 ? { ok: false } : { ok: false, quota: true }); });
      try {
        var legs = [1, 2, 3, 4].map(function (i) { return { from: pt(10 + i), to: pt(20 + i) }; });
        var r = getExactWalkingTimes_(owner, tripA.tripId, legs);
        assert(n === 3, 'lookups should stop after the limit, made ' + n);
        assert(r.results[0].min === 1 && r.results[1] === null && r.results[2] === null && r.results[3] === null, 'results: ' + JSON.stringify(r.results));
        assert(r.quotaHit === true && r.tried === 3, 'flags: ' + JSON.stringify(r));
      } finally { undo(); }
    });

    check('exact times validate input and refuse outsiders and other trips', function () {
      var ok = [{ from: pt(30), to: pt(31) }];
      expectError(function () { getExactWalkingTimes_(owner, tripA.tripId, 'x'); }, 'must be a list');
      var big = []; for (var i = 0; i < 26; i++) big.push(ok[0]);
      expectError(function () { getExactWalkingTimes_(owner, tripA.tripId, big); }, 'At most 25');
      expectError(function () { getExactWalkingTimes_(owner, tripA.tripId, [{ from: { lat: 95, lng: 0 }, to: pt(1) }]); }, 'between');
      expectError(function () { getExactWalkingTimes_(owner, tripA.tripId, [{ from: pt(1) }]); }, 'End is missing');
      expectError(function () { getExactWalkingTimes_(owner, tripA.tripId, [{ from: { lat: 1 }, to: pt(2) }]); }, 'needs a latitude');
      expectError(function () { getExactWalkingTimes_(owner, tripA.tripId, [null]); }, 'must be an object');
      expectError(function () { getExactWalkingTimes_(stranger, tripA.tripId, ok); }, 'not a member');
      expectError(function () { getExactWalkingTimes_(owner, tripB.tripId, ok); }, 'not a member');
    });

    var pA, pB, pC;
    check('recap: visited, top rated, biggest split, tallies with undo, and pint prices', function () {
      var base = { tripId: tripA.tripId, category: 'Pub', lat: 55.95, lng: -3.19 };
      pA = savePlace_(owner, Object.assign({}, base, { name: 'Recap A' }));
      pB = savePlace_(owner, Object.assign({}, base, { name: 'Recap B' }));
      pC = savePlace_(owner, Object.assign({}, base, { name: 'Recap C' }));
      savePlace_(owner, { tripId: tripA.tripId, name: 'Recap Ground', category: 'Anchor', lat: 55.94, lng: -3.24 });
      insertRating_(tripA.tripId, pA.placeId, owner, 90, T1);
      insertRating_(tripA.tripId, pA.placeId, mate, 40, T1);
      insertRating_(tripA.tripId, pB.placeId, owner, 80, T1);
      priceRow(tripA.tripId, pA.placeId, owner, 4.5);     // earlier than the scored rows, so scores are unaffected
      priceRow(tripA.tripId, pB.placeId, owner, 6.2);
      ci(tripA.tripId, owner, 'PINT', '1', T1); ci(tripA.tripId, owner, 'PINT', '1', T2); ci(tripA.tripId, owner, 'PINT', '-1', T3);
      ci(tripA.tripId, owner, 'WHISKY', '1', T3); ci(tripA.tripId, owner, 'FOOD', '1', T4);
      ci(tripA.tripId, mate, 'PINT', '1', T2); ci(tripA.tripId, mate, 'OTHER_DRINK', '1', T3);
      var r = getTripRecap_(mate, tripA.tripId);
      assert(r.visited === 2 && r.totalPlaces === 3 && r.rated === 2, 'counts: ' + JSON.stringify([r.visited, r.totalPlaces, r.rated]));
      assert(r.topRated.length === 2 && r.topRated[0].name === 'Recap B' && r.topRated[0].score === 80 && r.topRated[1].score === 65, 'top rated: ' + JSON.stringify(r.topRated));
      assert(r.biggestSplit && r.biggestSplit.name === 'Recap A' && r.biggestSplit.spread === 50, 'split: ' + JSON.stringify(r.biggestSplit));
      assert(r.group.PINT === 2 && r.group.WHISKY === 1 && r.group.OTHER_DRINK === 1 && r.group.FOOD === 1, 'group: ' + JSON.stringify(r.group));
      var me = r.people.filter(function (p) { return p.name === 'Olive'; })[0], mt = r.people.filter(function (p) { return p.name === 'Matt'; })[0];
      assert(me.PINT === 1 && me.WHISKY === 1 && me.FOOD === 1 && mt.PINT === 1 && mt.OTHER_DRINK === 1, 'people: ' + JSON.stringify(r.people));
      assert(r.cheapestPint.name === 'Recap A' && r.cheapestPint.price === 4.5 && r.dearestPint.name === 'Recap B' && r.dearestPint.price === 6.2, 'pints: ' + JSON.stringify([r.cheapestPint, r.dearestPint]));
    });

    check('recap refuses outsiders, and an empty trip gives an empty recap', function () {
      expectError(function () { getTripRecap_(stranger, tripA.tripId); }, 'not a member');
      expectError(function () { getTripRecap_(owner, tripB.tripId); }, 'not a member');
      var e = getTripRecap_(other, tripB.tripId);
      assert(e.visited === 0 && e.totalPlaces === 0 && e.topRated.length === 0 && e.biggestSplit === null && e.cheapestPint === null, 'empty: ' + JSON.stringify(e));
      assert(e.group.PINT === 0 && e.people.length === 1, 'empty tally: ' + JSON.stringify(e.group));
    });
  } finally {
    try { cleanupTestData_(tripIds); } catch (e) { results.push('WARN  cleanup failed: ' + e.message); }
  }

  var failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  var summary = (results.length - failed) + ' passed, ' + failed + ' failed';
  Logger.log(results.join('\n') + '\n\n' + summary);
  return summary;
}

/** Real public functions as YOU. Makes no Maps lookups (no legs are sent). */
function runPhase7PublicSmokeTest() {
  var tripId = null;
  try {
    var me = currentEmail_();
    var trip = createTrip({ city: TEST_PREFIX + ' p7 public ' + new Date().getTime() });
    tripId = trip.tripId;
    savePlace({ tripId: tripId, name: 'Smoke 1', category: 'Pub', lat: 55.95, lng: -3.19 });
    var w = getExactWalkingTimes(tripId, []);
    if (!w || w.results.length !== 0 || w.quotaHit) throw new Error('getExactWalkingTimes returned ' + JSON.stringify(w));
    var r = getTripRecap(tripId);
    if (r.totalPlaces !== 1 || r.visited !== 0 || r.group.PINT !== 0) throw new Error('getTripRecap returned ' + JSON.stringify(r));
    Logger.log('Phase 7 public smoke test PASSED as ' + me.charAt(0) + '***' + me.slice(me.indexOf('@')));
    return 'PASSED';
  } finally {
    if (tripId) cleanupTestData_([tripId]);
  }
}