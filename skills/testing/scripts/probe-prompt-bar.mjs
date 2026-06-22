//
// probe-prompt-bar.mjs
//
// User types into the bottom prompt bar and submits → harness fires the
// globalSubmitCallback with the canvas-scoped prompt → server queue
// dispatches the agent → test agent edits index.json to add the pre-
// staged probe-built component → harness re-renders → probe observes
// the [data-canvas-build-marker] in the DOM.
//
// Run it:  node run-probe.mjs probe-prompt-bar.mjs
//

export const fixture = './probe-prompt-bar.liquidos';
export const agent = 'prompt-bar-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
  page.on('pageerror', err => console.log('[page error]', err.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#global-text', { timeout: 20000 });
  await sleep(1500);

  if (await page.locator('[data-canvas-build-marker]').count() !== 0) {
    throw new Error('marker existed before prompt-bar submit');
  }

  // Type into the prompt bar and submit the form.
  await page.locator('#global-text').fill('Add the probe-built component please.');
  // Form submission goes through liquidos-callback's 'submit' listener.
  await page.locator('#global-prompt button[type="submit"]').dispatchEvent('click');
  // dispatchEvent on a submit button doesn't trigger form submission in
  // every browser/jsdom combo; requestSubmit on the form is the reliable path.
  await page.evaluate(() => document.getElementById('global-prompt').requestSubmit());

  try {
    await page.waitForSelector('[data-canvas-build-marker]', { timeout: 10000 });
    const markerText = (await page.locator('[data-canvas-build-marker]').textContent() || '').trim();
    console.log('observed marker:', markerText);
    if (markerText !== 'BUILT') {
      throw new Error('marker text was not "BUILT"');
    }
  } catch (e) {
    throw new Error('probe-built component never surfaced after prompt-bar submit');
  }
};
