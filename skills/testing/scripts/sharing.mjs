// Sharing is gated app-wide by window.__SHARING_ENABLED (set in index.html).
// When it's off, the app hides every sharing affordance, so a sharing probe has
// nothing to exercise. Such probes call this right after loading the app and
// return early (a pass) when it reports disabled — so they light up again on
// their own the moment sharing is switched back on, without being deleted.
export const sharingDisabled = (page) =>
  page.evaluate(() => window.__SHARING_ENABLED === false);
