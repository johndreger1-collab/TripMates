/**
 * Auth.gs: who is calling, and are they allowed?
 *
 * Every public function in Data.gs calls currentEmail_() once and passes that
 * email down to an internal function, which then calls requireMember_() or
 * requireOwner_() BEFORE touching any trip data. Passing the email in (rather
 * than reading the session deep inside) is what lets Tests.gs pretend to be
 * several different people.
 *
 * Note: this is a code-level guard, not a hard security boundary. With
 * "Execute as: User accessing the web app", every member needs edit access to
 * the Sheet, so a member could open the Sheet directly. That is fine for a
 * small group of friends.
 */

var MSG_NOT_MEMBER = 'You are not a member of this trip.';

function normEmail_(e) {
  return String(e === null || e === undefined ? '' : e).trim().toLowerCase();
}

/** The signed-in Google account, lower-cased. Throws if Google will not say. */
function currentEmail_() {
  var e = normEmail_(Session.getActiveUser().getEmail());
  if (!e) throw new Error('Could not identify your Google account. Sign in and try again.');
  return e;
}

function findMember_(tripId, email) {
  var rows = readRows_('Members');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].TripID === tripId && normEmail_(rows[i].Email) === email) return rows[i];
  }
  return null;
}

/** Returns the Members row, or throws. The same message is used whether the trip exists or not. */
function requireMember_(email, tripId) {
  if (!tripId || typeof tripId !== 'string') throw new Error('A trip is required.');
  var m = findMember_(tripId, normEmail_(email));
  if (!m) throw new Error(MSG_NOT_MEMBER);
  return m;
}

function requireOwner_(email, tripId) {
  var m = requireMember_(email, tripId);
  if (m.Role !== 'Owner') throw new Error('Only the trip owner can do this.');
  return m;
}/**
 * Auth.gs: who is calling, and are they allowed?
 *
 * Every public function in Data.gs calls currentEmail_() once and passes that
 * email down to an internal function, which then calls requireMember_() or
 * requireOwner_() BEFORE touching any trip data. Passing the email in (rather
 * than reading the session deep inside) is what lets Tests.gs pretend to be
 * several different people.
 *
 * Note: this is a code-level guard, not a hard security boundary. With
 * "Execute as: User accessing the web app", every member needs edit access to
 * the Sheet, so a member could open the Sheet directly. That is fine for a
 * small group of friends.
 */

var MSG_NOT_MEMBER = 'You are not a member of this trip.';

function normEmail_(e) {
  return String(e === null || e === undefined ? '' : e).trim().toLowerCase();
}

/** The signed-in Google account, lower-cased. Throws if Google will not say. */
function currentEmail_() {
  var e = normEmail_(Session.getActiveUser().getEmail());
  if (!e) throw new Error('Could not identify your Google account. Sign in and try again.');
  return e;
}

function findMember_(tripId, email) {
  var rows = readRows_('Members');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].TripID === tripId && normEmail_(rows[i].Email) === email) return rows[i];
  }
  return null;
}

/** Returns the Members row, or throws. The same message is used whether the trip exists or not. */
function requireMember_(email, tripId) {
  if (!tripId || typeof tripId !== 'string') throw new Error('A trip is required.');
  var m = findMember_(tripId, normEmail_(email));
  if (!m) throw new Error(MSG_NOT_MEMBER);
  return m;
}

function requireOwner_(email, tripId) {
  var m = requireMember_(email, tripId);
  if (m.Role !== 'Owner') throw new Error('Only the trip owner can do this.');
  return m;
}

/**
 * For lookups that are not about one particular trip (geocoding, settings).
 * Keeps strangers from spending the shared quota: you must belong to at least one trip.
 */
function requireAnyTrip_(email) {
  email = normEmail_(email);
  var rows = readRows_('Members');
  for (var i = 0; i < rows.length; i++) {
    if (normEmail_(rows[i].Email) === email) return;
  }
  throw new Error('You are not a member of any trip yet.');
}