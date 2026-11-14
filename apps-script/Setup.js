/**
 * Setup.gs: the sheet layout and initSpreadsheet().
 *
 * SCHEMA is the contract between the code and the Sheet: column order here
 * must match the tab headers. initSpreadsheet() is safe to run any number of
 * times. It only ADDS missing tabs, headers, Settings keys and Criteria rows.
 * It never overwrites a value someone has edited.
 */

var SCHEMA = {
  Trips: ['TripID', 'City', 'StartDate', 'EndDate', 'Fixture', 'KickoffISO', 'VenueName', 'VenueLat', 'VenueLng',
          'LodgingName', 'LodgingLat', 'LodgingLng', 'CreatedBy', 'CreatedAt'],
  Members: ['TripID', 'Email', 'DisplayName', 'Role', 'AddedAt'],
  // City and AnchorKind were added in Phase 2 (multi-city trips, lodging). They sit at the END so older
  // sheets can be upgraded in place: initSpreadsheet() adds them to an existing Places tab.
  Places: ['PlaceID', 'TripID', 'Name', 'Category', 'Area', 'Address', 'Lat', 'Lng', 'CoordSource', 'CoordConfirmed',
           'GoogleMapsUrl', 'Source', 'DesireToTry', 'LocalTags', 'MatchDayTags', 'HoursNote', 'Notes', 'LastVerified',
           'AddedBy', 'CreatedAt', 'UpdatedAt', 'City', 'AnchorKind'],
  Ratings: ['RatingID', 'PlaceID', 'TripID', 'UserEmail', 'VisitTimestamp', 'ScoresJSON', 'PersonScore', 'WouldReturn',
            'PintPrice', 'Notes', 'CreatedAt'],
  CheckIns: ['CheckInID', 'TripID', 'UserEmail', 'PlaceID', 'Type', 'Value', 'Timestamp', 'Lat', 'Lng'],
  Routes: ['RouteID', 'TripID', 'RouteName', 'StopOrder', 'PlaceID', 'PlannedArrival', 'StopNote', 'Visited',
           'UpdatedBy', 'UpdatedAt'],
  Criteria: ['Category', 'CriterionKey', 'Label', 'Weight', 'Active', 'SortOrder'],
  Settings: ['Key', 'Value'],
  Seed: ['City', 'Name', 'Category', 'Area', 'Lat', 'Lng', 'GoogleMapsUrl', 'LocalTags', 'MatchDayTags', 'HoursNote',
         'Notes', 'LastVerified', 'VerifyFlag']
};

// Columns holding numbers or TRUE/FALSE. Every other column is plain text, so
// ISO dates, IDs and notes are stored exactly as written and a note that
// starts with "=" can never become a formula.
var NUMERIC_COLS = {
  Trips: ['VenueLat', 'VenueLng', 'LodgingLat', 'LodgingLng'],
  Places: ['Lat', 'Lng'],
  Ratings: ['PersonScore', 'PintPrice'],
  CheckIns: ['Lat', 'Lng'],
  Routes: ['StopOrder'],
  Criteria: ['Weight', 'SortOrder'],
  Seed: ['Lat', 'Lng']
};
var BOOL_COLS = {
  Places: ['CoordConfirmed'],
  Routes: ['Visited'],
  Criteria: ['Active']
};

var DEFAULT_SETTINGS = [
  ['ScoreRed', '35'], ['ScoreAmber', '60'], ['ScoreLightGreen', '80'],
  ['SplitThreshold', '30'], ['NearbyDefaultMinutes', '10'], ['RefreshSeconds', '20'],
  ['PacingEnabled', 'false'], ['PacingFoodNudgeDrinks', '4'], ['PacingWindDownHour', '21'],
  ['Currency', 'GBP'], ['WalkMetersPerMinute', '80'], ['DetourFactor', '1.3'],
  ['MatchDayWindowHoursBefore', '6'], ['MatchDayWindowHoursAfter', '4'],
  // From the Phase 0 spike (S4): Google Maps kept 9 waypoints and dropped the rest on iPhone.
  ['MaxWaypoints', '9'],
  // Tag lists live here so they can grow without code changes (spec 5.4).
  ['LocalTags', 'proper_boozer,tourist_trap,whisky_bar_real_list,locals_favourite,hidden_gem,great_guinness'],
  ['MatchDayTags', 'ticket_only,queue_risk,cash_only,away_fans_welcome,shows_live_rugby,good_overflow,closes_early_on_matchday']
];

// [criterion key, label]. Weight 1 and Active TRUE for all (spec 4.4). Anchor has none.
var DEFAULT_CRITERIA = {
  Pub: [['guinness_temp', 'Guinness temperature'], ['guinness_head', 'Guinness head'],
        ['guinness_taste', 'Guinness taste'], ['whiskey_selection', 'Whisky selection'],
        ['ambiance', 'Ambiance'], ['noise', 'Noise comfort'], ['music', 'Music'],
        ['rugby_friendliness', 'Rugby-friendliness'], ['value', 'Value'], ['service', 'Service']],
  Restaurant: [['food', 'Food'], ['service', 'Service'], ['value', 'Value'], ['ambiance', 'Ambiance'],
               ['noise', 'Noise comfort']],
  Cocktails: [['drinks', 'Drinks'], ['ambiance', 'Ambiance'], ['service', 'Service'], ['value', 'Value'],
              ['music', 'Music']],
  Grab_and_Go: [['food', 'Food'], ['speed', 'Speed'], ['value', 'Value'], ['walkability', 'Walkable between pubs']],
  Whisky_Bar: [['whiskey_selection', 'Selection'], ['knowledge', 'Staff knowledge'], ['ambiance', 'Ambiance'],
               ['value', 'Value']],
  Sight: [['worth_the_time', 'Worth the time'], ['crowds', 'Crowd comfort'], ['value', 'Value'],
          ['duration_fit', 'Fits our schedule']],
  Tasting: [['quality', 'Quality'], ['host', 'Host'], ['value', 'Value'], ['worth_the_time', 'Worth the time']]
};

/**
 * Creates any missing tabs and headers, then adds any missing default
 * Settings and Criteria. Returns a report of what it did.
 */
function initSpreadsheet() {
  var ss = ss_();
  var report = { created: [], existing: [], columnsAdded: [], settingsAdded: 0, criteriaAdded: 0 };

  withLock_(function () {
    Object.keys(SCHEMA).forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (sh) {
        report.existing.push(name);
      } else {
        sh = ss.insertSheet(name);
        report.created.push(name);
      }
      var added = ensureHeaders_(sh, name);
      if (added.length) report.columnsAdded.push(name + ': ' + added.join(', '));
      formatColumns_(sh, name);
      sh.setFrozenRows(1);
    });
    report.settingsAdded = addMissingSettings_(ss.getSheetByName('Settings'));
    report.criteriaAdded = addMissingCriteria_(ss.getSheetByName('Criteria'));
    SpreadsheetApp.flush();
  });

  cacheClearAll_();
  Logger.log('initSpreadsheet: ' + JSON.stringify(report));
  return report;
}

/**
 * Writes the header row on a new tab. On an existing tab it verifies the headers.
 * If the tab simply lacks columns that were added at the end in a later phase, it
 * writes those headers (an in-place upgrade). Any other difference is an error, so
 * it can never silently misalign columns. Returns the headers it added.
 */
function ensureHeaders_(sh, name) {
  var headers = SCHEMA[name];
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaed');
    return [];
  }
  var existing = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var firstBad = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(existing[i]) !== headers[i]) { firstBad = i; break; }
  }
  if (firstBad < 0) return [];

  for (var j = firstBad; j < headers.length; j++) {
    if (String(existing[j]) !== '') {
      throw new Error('Tab "' + name + '" has unexpected headers (column ' + (j + 1) + ' is "' + existing[j] +
        '", expected "' + headers[j] + '"). Fix or rename that tab and run initSpreadsheet() again.');
    }
  }
  var added = headers.slice(firstBad);
  sh.getRange(1, firstBad + 1, 1, added.length).setValues([added]).setFontWeight('bold').setBackground('#e8eaed');
  return added;
}

/** Formats every text column as plain text, in as few calls as possible. */
function formatColumns_(sh, name) {
  var headers = SCHEMA[name];
  var skip = (NUMERIC_COLS[name] || []).concat(BOOL_COLS[name] || []);
  var maxRows = sh.getMaxRows();
  var runStart = null;
  for (var i = 0; i <= headers.length; i++) {
    var isText = i < headers.length && skip.indexOf(headers[i]) < 0;
    if (isText && runStart === null) runStart = i;
    if (!isText && runStart !== null) {
      sh.getRange(1, runStart + 1, maxRows, i - runStart).setNumberFormat('@');
      runStart = null;
    }
  }
}

function addMissingSettings_(sh) {
  var last = sh.getLastRow();
  var have = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { have[String(r[0])] = true; });
  }
  var rows = DEFAULT_SETTINGS.filter(function (kv) { return !have[kv[0]]; });
  if (rows.length) sh.getRange(last + 1, 1, rows.length, 2).setValues(rows);
  return rows.length;
}

function addMissingCriteria_(sh) {
  var last = sh.getLastRow();
  var have = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { have[r[0] + '|' + r[1]] = true; });
  }
  var rows = [];
  Object.keys(DEFAULT_CRITERIA).forEach(function (category) {
    DEFAULT_CRITERIA[category].forEach(function (c, i) {
      if (!have[category + '|' + c[0]]) rows.push([category, c[0], c[1], 1, true, (i + 1) * 10]);
    });
  });
  if (rows.length) sh.getRange(last + 1, 1, rows.length, 6).setValues(rows);
  return rows.length;
}