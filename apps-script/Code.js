/**
 * Code.gs: the web app entry point (HtmlService UI, Phases 0-7).
 *
 * doGet serves Index.html, which pulls in Styles, Map, Client, AddPlace, Rate,
 * Live, Route, Home, Tools and Extras through include(). Members are managed in
 * the Trip tab (Phase 6). ?page=phase1 still opens the old Phase 1 check page,
 * kept for testing only.
 *
 * Everything else lives elsewhere: Setup.gs (sheet layout), Auth.gs (who may do
 * what), Data.gs (the data layer), Geo.gs (geocoding and link reading) and
 * Tests.gs (editor-only test suites).
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