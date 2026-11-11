/**
 * Code.gs: the web app entry point.
 *
 * The app is served at the normal URL. Add ?page=phase1 to open the Phase 1 check
 * page, which is still the way to add members until the Trip tools arrive in Phase 6.
 *
 * Everything else lives elsewhere: Setup.gs (sheet layout), Auth.gs (who may do
 * what), Data.gs (the data layer) and Geo.gs (geocoding and link reading).
 */

function doGet(e) {
  var page = e && e.parameter && e.parameter.page;
  var isCheck = page === 'phase1';
  return HtmlService.createTemplateFromFile(isCheck ? 'Phase1Check' : 'Index')
    .evaluate()
    .setTitle(isCheck ? 'Rugby Trip: member check' : 'Rugby Trip')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** Lets Index.html pull in Styles, Map, Client and AddPlace as raw text. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}