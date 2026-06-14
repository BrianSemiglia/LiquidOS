//
// probe-requirements-modal.mjs
//
// Verifies the requirements modal:
//   1. Opens with the live component visible AND the requirements editor
//      visible side-by-side, both inside an overlay attached to body.
//   2. Survives a workspace-file event (state-driven canvas re-place). The
//      fixture's canvas.js caches lastItems and re-places on every SSE
//      workspace-file event — exactly the gadgets 3D canvas pattern. If
//      the harness lets the canvas's cached lastItems still reference the
//      real item, the canvas yanks it back into its tree and strands the
//      overlay on body with no .item inside (the user-reported bug).
//   3. Survives a component.html change on the modal'd component (the file-edit
//      race that triggers mountComponentFunctions during render).
//   4. ESC closes — overlay gone, placeholder gone, item returned to #app.
//
// Run it:  node run-probe.mjs probe-requirements-modal.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = 'requirements-modal.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const snapshot = page => page.evaluate(() => {
  const overlay = document.querySelector('.requirements-overlay');
  const placeholder = document.querySelector('.requirements-placeholder');
  const item = overlay?.querySelector('.item');
  const meas = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return { w: r.width, h: r.height, display: s.display, visibility: s.visibility, opacity: s.opacity };
  };
  return {
    overlayOnBody: !!(overlay && overlay.parentElement === document.body),
    overlayHasItem: !!item,
    placeholderInApp: !!(placeholder && placeholder.closest('#app')),
    front: meas(item?.querySelector('.component-front')),
    back: meas(item?.querySelector('.component-back')),
    textarea: meas(item?.querySelector('[data-feature-requirements]')),
    surface: meas(item?.querySelector('.surface'))
  };
});

const isVisible = m => m && m.display !== 'none' && m.visibility !== 'hidden' && +m.opacity > 0.1 && m.w > 0 && m.h > 0;

export default async ({ url, workspace, page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.item[data-component-path*="widget"]', { timeout: 20000 });
  await sleep(800);

  // --- 1. Open the modal ---
  await page.locator('.item[data-component-path*="widget"] [data-component-flip]')
    .first().evaluate(el => el.click());
  await sleep(500);
  const opened = await snapshot(page);
  console.log('after open:', opened);
  if (!opened.overlayOnBody)    throw new Error('overlay not attached to body');
  if (!opened.overlayHasItem)   throw new Error('overlay has no .item inside');
  if (!opened.placeholderInApp) throw new Error('placeholder not in #app');
  if (!isVisible(opened.front))    throw new Error('component-front not visible: ' + JSON.stringify(opened.front));
  if (!isVisible(opened.back))     throw new Error('component-back not visible: ' + JSON.stringify(opened.back));
  if (!isVisible(opened.surface))  throw new Error('surface not visible: ' + JSON.stringify(opened.surface));
  if (!isVisible(opened.textarea)) throw new Error('requirements textarea not visible: ' + JSON.stringify(opened.textarea));

  // --- 1b. Requirements input behavior: Loading clears after fetch, and
  //         the recover button label depends on the file's state — Repair
  //         when missing/corrupt, Generate when present-but-empty. The
  //         widget fixture has no requirements file, so this iteration
  //         expects Repair.
  await page.waitForFunction(
    () => {
      const loading = document.querySelector('.requirements-overlay [data-feature-loading]');
      return loading && loading.hidden === true;
    },
    { timeout: 5000 }
  ).catch(() => { throw new Error('component Loading… did not hide after fetch'); });
  let componentRecoverVisible = await page.evaluate(() => {
    const cb = document.querySelector('.requirements-overlay [data-feature-recover-callback]');
    return cb && !cb.hidden;
  });
  if (!componentRecoverVisible) throw new Error('component recover callback did not surface for missing requirements');
  let componentRecoverText = await page.evaluate(() => {
    const btn = document.querySelector('.requirements-overlay [data-feature-recover]');
    return btn ? (btn.textContent || '').trim() : '';
  });
  if (componentRecoverText !== 'Repair') {
    throw new Error('component recover button text is "' + componentRecoverText + '", expected "Repair" (file missing)');
  }
  // --- 1c. Now create an empty requirements file and reopen the
  //         modal. Same UI surface, but the label flips to Generate
  //         because the file is present-but-empty (different repair
  //         path: write from implementation, not find/restore).
  const featurePath = path.join(workspace, 'home/components/widget/feature-requirements.txt');
  fs.mkdirSync(path.dirname(featurePath), { recursive: true });
  fs.writeFileSync(featurePath, '');
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.locator('.item[data-component-path*="widget"] [data-component-flip]')
    .first().evaluate(el => el.click());
  await page.waitForFunction(
    () => {
      const cb = document.querySelector('.requirements-overlay [data-feature-recover-callback]');
      return cb && !cb.hidden;
    },
    { timeout: 5000 }
  );
  componentRecoverText = await page.evaluate(() => {
    const btn = document.querySelector('.requirements-overlay [data-feature-recover]');
    return btn ? (btn.textContent || '').trim() : '';
  });
  if (componentRecoverText !== 'Generate') {
    throw new Error('component recover button text is "' + componentRecoverText + '", expected "Generate" (file present but empty)');
  }
  // Restore the missing case for the remainder of the test (preserves the
  // original scenarios that test overlay survival under canvas state churn).
  fs.unlinkSync(featurePath);

  // --- 2. State-driven re-place via workspace-file SSE ---
  //     The fixture's canvas.js subscribes to workspace-file events and
  //     re-places using its cached lastItems. If lastItems still holds
  //     the real item (not the placeholder), the canvas yanks the item
  //     out of the overlay — the stranded-blur bug.
  const stateJson = path.join(workspace, 'home/components/widget/state.json');
  fs.writeFileSync(stateJson, JSON.stringify({ tick: 1 }));
  await sleep(800);
  const afterState = await snapshot(page);
  console.log('after state-driven re-place:', afterState);
  if (!afterState.overlayHasItem) throw new Error('STATE-UPDATE BUG: item escaped the overlay during canvas re-place');
  if (!afterState.placeholderInApp) throw new Error('placeholder lost during canvas re-place');

  // --- 3. component.html change on the modal'd component ---
  //     Triggers updateComponentItem → mountComponentFunctions →
  //     destroyComponentFunctions in the render path. The fix moved the
  //     modal-close out of destroyComponentFunctions so a benign re-mount
  //     no longer closes the modal.
  const componentHtml = path.join(workspace, 'home/components/widget/component.html');
  const html = fs.readFileSync(componentHtml, 'utf8');
  fs.writeFileSync(componentHtml, html.replace('</liquidos-component>', '<!-- race ' + Date.now() + ' -->\n</liquidos-component>'));
  await sleep(1500);
  const afterEdit = await snapshot(page);
  console.log('after component.html edit:', afterEdit);
  if (!afterEdit.overlayHasItem) throw new Error('COMPONENT-EDIT BUG: item escaped the overlay during component re-mount');
  if (!afterEdit.placeholderInApp) throw new Error('placeholder lost during component re-mount');

  // --- 4. ESC closes cleanly ---
  await page.keyboard.press('Escape');
  await sleep(300);
  const closed = await page.evaluate(() => ({
    overlayGone: !document.querySelector('.requirements-overlay'),
    placeholderGone: !document.querySelector('.requirements-placeholder'),
    itemBackInApp: !!document.querySelector('#app .item[data-component-path*="widget"]')
  }));
  console.log('after ESC:', closed);
  if (!closed.overlayGone)     throw new Error('overlay still on body after ESC');
  if (!closed.placeholderGone) throw new Error('placeholder still in #app after ESC');
  if (!closed.itemBackInApp)   throw new Error('item did not return to #app after ESC');

  // --- 5. Canvas requirements modal mirrors the same input behavior.
  //         Startup bootstrap no longer materializes an empty
  //         feature-requirements.txt — only canvas creation does. So the
  //         fixture's home canvas starts with the file missing → Repair.
  //         Write an empty file to flip to Generate.
  const canvasFeaturePath = path.join(workspace, 'home/feature-requirements.txt');
  await page.locator('#canvas-info').dispatchEvent('click');
  await page.waitForSelector('#canvas-requirements-textarea', { state: 'visible', timeout: 5000 });
  await page.waitForFunction(
    () => {
      const loading = document.getElementById('canvas-requirements-loading');
      return loading && loading.hidden === true;
    },
    { timeout: 5000 }
  ).catch(() => { throw new Error('canvas Loading… did not hide after fetch'); });
  const canvasRecoverVisible = await page.evaluate(() => {
    const cb = document.getElementById('canvas-requirements-recover-callback');
    return cb && !cb.hidden;
  });
  if (!canvasRecoverVisible) throw new Error('canvas recover callback did not surface for missing requirements');
  let canvasRecoverText = await page.evaluate(() => {
    const btn = document.querySelector('#canvas-requirements-recover-callback button');
    return btn ? (btn.textContent || '').trim() : '';
  });
  if (canvasRecoverText !== 'Repair') {
    throw new Error('canvas recover button text is "' + canvasRecoverText + '", expected "Repair" (file missing)');
  }
  fs.writeFileSync(canvasFeaturePath, '');
  await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
  await sleep(300);
  await page.locator('#canvas-info').dispatchEvent('click');
  await page.waitForFunction(
    () => {
      const cb = document.getElementById('canvas-requirements-recover-callback');
      return cb && !cb.hidden;
    },
    { timeout: 5000 }
  );
  canvasRecoverText = await page.evaluate(() => {
    const btn = document.querySelector('#canvas-requirements-recover-callback button');
    return btn ? (btn.textContent || '').trim() : '';
  });
  if (canvasRecoverText !== 'Generate') {
    throw new Error('canvas recover button text is "' + canvasRecoverText + '", expected "Generate" (file present but empty)');
  }
  fs.unlinkSync(canvasFeaturePath);
};
