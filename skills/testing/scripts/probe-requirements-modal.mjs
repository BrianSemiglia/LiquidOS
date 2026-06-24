//
// probe-requirements-modal.mjs
//
// The requirements modal: open it on a component and the component's content
// plus its requirements editor are on screen; it stays on screen across a
// state-driven canvas re-place and a component.html edit (the file-edit races
// that used to strand or close it); ESC closes it; and the recover affordance
// reads "Repair" when the requirements file is missing, "Generate" when it's
// present but empty — for both a component and the canvas.
//
// Asserts only visible text — the recover label coming and going, the
// component's content — never the overlay/placeholder elements or their
// geometry. (Driving the app still clicks real affordances; the assertions
// read the screen.)
//
// Run it:  node run-probe.mjs probe-requirements-modal.mjs
//

import fs from 'node:fs';
import path from 'node:path';

export const fixture = './probe-requirements-modal.liquidos';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async ({ url, workspace, page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  const onScreen = (text, timeout = 6000) => page.waitForFunction(
    t => document.body.innerText.includes(t), text, { timeout });
  const offScreen = (text, timeout = 6000) => page.waitForFunction(
    t => !document.body.innerText.includes(t), text, { timeout });
  const visible = (text) => page.evaluate(t => document.body.innerText.includes(t), text);

  // The component's own rendered content — a unique visible string.
  const WIDGET = 'A component with some content to render inside the requirements modal';
  const openModal = () => page.getByRole('button', { name: 'Edit Widget requirements' }).dispatchEvent('click');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await onScreen(WIDGET, 20000);   // the component renders on the canvas
  await sleep(800);

  // --- 1. Open the modal: the component's content stays on screen and the
  //        recover affordance shows. The widget fixture has no requirements
  //        file, so the label reads "Repair".
  await openModal();
  await onScreen('Repair').catch(() => {
    throw new Error('"Repair" recover affordance did not appear when the modal opened (requirements file missing)');
  });
  if (!(await visible(WIDGET))) throw new Error('the component content is not visible in the open modal');

  // --- 1b. An empty requirements file flips the label to "Generate" (present
  //         but empty → write-from-implementation, not find/restore).
  const featurePath = path.join(workspace, 'home/components/widget/feature-requirements.txt');
  fs.mkdirSync(path.dirname(featurePath), { recursive: true });
  fs.writeFileSync(featurePath, '');
  await page.keyboard.press('Escape');
  await offScreen('Repair').catch(() => {});
  await openModal();
  await onScreen('Generate').catch(() => {
    throw new Error('"Generate" did not appear for a present-but-empty requirements file');
  });
  // Restore the missing case for the survival scenarios below.
  fs.unlinkSync(featurePath);
  await page.keyboard.press('Escape');
  await offScreen('Generate').catch(() => {});
  await openModal();
  await onScreen('Repair');

  // --- 2. The modal survives a state-driven canvas re-place. The fixture's
  //        canvas.js re-places its cached items on every workspace-file event
  //        (the gadgets 3D pattern); the modal must stay on screen — the
  //        stranded-overlay bug blanked it.
  fs.writeFileSync(path.join(workspace, 'home/components/widget/state.json'), JSON.stringify({ tick: 1 }));
  await sleep(800);
  if (!(await visible('Repair')) || !(await visible(WIDGET))) {
    throw new Error('the modal was lost during a state-driven canvas re-place');
  }

  // --- 3. The modal survives a component.html edit (a benign re-mount).
  const componentHtml = path.join(workspace, 'home/components/widget/component.html');
  const html = fs.readFileSync(componentHtml, 'utf8');
  fs.writeFileSync(componentHtml, html.replace('</liquidos-component>', '<!-- race ' + Date.now() + ' -->\n</liquidos-component>'));
  await sleep(1500);
  if (!(await visible('Repair')) || !(await visible(WIDGET))) {
    throw new Error('the modal was lost during a component.html re-mount');
  }

  // --- 4. ESC closes it: the recover affordance is gone.
  await page.keyboard.press('Escape');
  await offScreen('Repair').catch(() => {
    throw new Error('the modal did not close on ESC ("Repair" still on screen)');
  });

  // --- 5. The canvas requirements modal mirrors the same label behavior.
  await page.getByRole('button', { name: 'Edit canvas requirements' }).dispatchEvent('click');
  await onScreen('Repair').catch(() => {
    throw new Error('canvas recover affordance did not read "Repair" (file missing)');
  });
  fs.writeFileSync(path.join(workspace, 'home/feature-requirements.txt'), '');
  await page.locator('#canvas-requirements-cancel').dispatchEvent('click');
  await offScreen('Repair').catch(() => {});
  await page.getByRole('button', { name: 'Edit canvas requirements' }).dispatchEvent('click');
  await onScreen('Generate').catch(() => {
    throw new Error('canvas recover affordance did not flip to "Generate" for an empty file');
  });
  fs.unlinkSync(path.join(workspace, 'home/feature-requirements.txt'));
};
