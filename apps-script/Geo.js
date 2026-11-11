/**
 * Geo.gs: turning a name, address or pasted link into coordinates. Free only:
 * it uses Apps Script's built-in Maps service (no key) and UrlFetchApp.
 *
 * Both public functions need the caller to belong to at least one trip, so
 * outsiders cannot spend the shared daily quota.
 */

var GEO = {
  CACHE_SECONDS: 21600, // geocode answers are cached for 6 hours
  BIAS_DEGREES: 0.25,   // search box around the trip's area, about 25 km each way
  MAX_REDIRECTS: 6
};

var BROWSER_UA_ = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ===========================================================================
// Public API (callable from the browser)
// ===========================================================================

/** query: text. near (optional): {lat, lng} to prefer results in that area. */
function geocodePlace(query, near) {
  requireAnyTrip_(currentEmail_());
  return geocodePlace_(query, near);
}

function resolveMapsLink(url) {
  requireAnyTrip_(currentEmail_());
  return resolveMapsLink_(url);
}

// ===========================================================================
// Geocoding
// ===========================================================================

function geoCacheKey_(query, near) {
  var raw = query.toLowerCase() + '|' + (near ? near.lat.toFixed(1) + ',' + near.lng.toFixed(1) : '');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return 'geo:' + Utilities.base64Encode(digest);
}

function cleanNear_(near) {
  if (!near || typeof near !== 'object') return null;
  var lat = Number(near.lat), lng = Number(near.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: lat, lng: lng };
}

/** Never throws: always returns {ok:true,...} or {ok:false,error}. */
function geocodePlace_(query, near) {
  try {
    var q = cleanText_(query, 200, 'Search');
    if (!q) return { ok: false, error: 'Type a name or address to look up.' };
    near = cleanNear_(near);

    var key = geoCacheKey_(q, near);
    var cache = CacheService.getScriptCache();
    var hit = cache.get(key);
    if (hit) {
      var cached = JSON.parse(hit);
      cached.cached = true;
      return cached;
    }

    var geocoder = Maps.newGeocoder();
    if (near) {
      var d = GEO.BIAS_DEGREES;
      geocoder.setBounds(near.lat - d, near.lng - d, near.lat + d, near.lng + d);
    }
    var res = geocoder.geocode(q);
    if (res.status !== 'OK' || !res.results || !res.results.length) {
      return { ok: false, query: q, error: 'No match found. Try adding the area or city, or drop a pin on the map instead.' };
    }
    var r = res.results[0];
    var exact = r.geometry.location_type === 'ROOFTOP' && !r.partial_match;
    var out = {
      ok: true,
      query: q,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formatted: r.formatted_address,
      locationType: r.geometry.location_type,
      partialMatch: !!r.partial_match,
      matchNote: exact ? 'Exact match.' : 'Approximate match. Check the pin and drag it if needed.'
    };
    try { cache.put(key, JSON.stringify(out), GEO.CACHE_SECONDS); } catch (e) { /* optional */ }
    return out;
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (/too many times|quota|limit/i.test(msg)) {
      return { ok: false, error: 'The free daily lookup limit has been reached. Drop a pin on the map instead, or try again tomorrow.' };
    }
    return { ok: false, error: 'Lookup failed: ' + msg };
  }
}

// ===========================================================================
// Reading a pasted Google Maps link
// ===========================================================================

/**
 * Accepts a full Maps URL or a short link (maps.app.goo.gl). Coordinates are taken from:
 *   1. !3d<lat>!4d<lng>  the place pin itself (most accurate)
 *   2. @<lat>,<lng>      the map centre
 *   3. q= / query= / ll= / destination= <lat>,<lng>
 * Short links are followed one redirect at a time, only to Google-owned hosts.
 * Phase 0 showed that short links for places usually end at an ID-only page with
 * no coordinates; then we return needsFullLink instead of guessing a location.
 */
function resolveMapsLink_(url) {
  try {
    var start = cleanText_(url, 2000, 'Link');
    if (!/^https:\/\//i.test(start)) {
      return { ok: false, error: 'Paste the full link, starting with https://' };
    }
    var isShort = isShortHost_(start);
    var current = start;
    var nameHint = '';

    for (var hops = 0; hops <= GEO.MAX_REDIRECTS; hops++) {
      if (!isGoogleHost_(current)) {
        return { ok: false, error: 'That is not a Google Maps link.', hops: hops };
      }
      nameHint = nameFromMapsUrl_(current) || nameHint;
      var parsed = parseMapsUrl_(current);
      if (parsed) {
        parsed.ok = true;
        parsed.hops = hops;
        parsed.url = start;
        return parsed;
      }
      var resp = UrlFetchApp.fetch(current, {
        followRedirects: false,
        muteHttpExceptions: true,
        headers: { 'User-Agent': BROWSER_UA_, 'Accept-Language': 'en-GB,en;q=0.9' }
      });
      var code = resp.getResponseCode();
      var headers = resp.getAllHeaders();
      var loc = headers['Location'] || headers['location'];
      if (Array.isArray(loc)) loc = loc[0];
      if (code >= 300 && code < 400 && loc) {
        if (loc.charAt(0) === '/') loc = 'https://' + hostOf_(current) + loc;
        current = loc;
        continue;
      }
      break; // a normal page: stop, there is nothing more to follow
    }
    return noCoordinates_(start, isShort, nameHint);
  } catch (e) {
    return { ok: false, error: 'Could not read that link: ' + String(e && e.message ? e.message : e) };
  }
}

function noCoordinates_(url, isShort, nameHint) {
  return {
    ok: false,
    needsFullLink: true,
    isShort: isShort,
    url: url,
    nameHint: nameHint || '',
    error: isShort
      ? 'Google short links usually do not contain the location, so I cannot read a pin from this one. ' +
        'I will keep the link so "View in Google Maps" still works. Place the pin with Search or by tapping the map. ' +
        'Tip: a link copied from the address bar of Google Maps in a desktop browser works.'
      : 'That link does not contain a location. Try Search, or tap the map.'
  };
}

function hostOf_(u) {
  var m = String(u).match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isShortHost_(u) {
  var h = hostOf_(u);
  return h === 'maps.app.goo.gl' || h === 'goo.gl' || h === 'g.co';
}

/** Only Google-owned hosts are ever fetched, so this cannot be pointed at arbitrary sites. */
function isGoogleHost_(u) {
  var h = hostOf_(u);
  return isShortHost_(u) || /(^|\.)google\.(com|co\.uk|[a-z]{2,3})$/.test(h);
}

function parseMapsUrl_(u) {
  var decoded = u;
  try { decoded = decodeURIComponent(u); } catch (e) { /* keep raw */ }
  var num = '(-?\\d+(?:\\.\\d+)?)';
  var m, method;

  if ((m = decoded.match(new RegExp('!3d' + num + '!4d' + num)))) {
    method = 'place pin';
  } else if ((m = decoded.match(new RegExp('@' + num + ',' + num)))) {
    method = 'map centre';
  } else if ((m = decoded.match(new RegExp('[?&](?:q|query|ll|destination)=' + num + ',' + num)))) {
    method = 'link parameter';
  }
  if (!m) return null;

  var lat = parseFloat(m[1]);
  var lng = parseFloat(m[2]);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { name: nameFromMapsUrl_(u), lat: lat, lng: lng, method: method };
}

function nameFromMapsUrl_(u) {
  var pm = String(u).match(/\/maps\/place\/([^\/@?]+)/);
  if (!pm) return '';
  var raw = pm[1].replace(/\+/g, ' ');
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}