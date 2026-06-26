//
// probe-lqpatch-stream-component-edit.mjs
//
// The user prompts; the agent builds; the thing the user asked for shows up on
// screen and is still there after a reload.
//
// Asserts only what a person looking at the app would see: a unique string,
// rendered as visible text. No app internals, no HTML-structure inspection, no
// disk reads — so the protocol, op names, and where a patch persists can all
// change without touching this test.
//
// Run it:  node run-probe.mjs probe-lqpatch-stream-component-edit.mjs
// run-probe boots the fixture below, hands this function the sandbox + a page,
// and tears everything down afterward. Throw to fail, return to pass.
//

export const fixture = './probe-lqpatch-stream-component-edit.liquidos';
export const agent = 'agent/test/lqpatch-stream-stub-agent.js';

// Is this string visible to a person looking at the page? innerText is the
// rendered, visible text — it skips hidden nodes, <style>, <script>.
const onScreen = (page, text) => page.evaluate(t => visibleText().includes(t), text);

export default async ({ url, page }) => {
  const token = 'TOK_' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const wanted = 'PERSISTED_' + token; // the unique string the agent will render

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (await onScreen(page, wanted)) {
    throw new Error('the string was already on screen before the prompt — the test would prove nothing');
  }

  // Drive the prompt bar, the way the user does.
  const bar = page.getByRole('textbox', { name: 'Prompt' });
  await bar.waitFor({ timeout: 15000 });
  await bar.fill('REPLACE_WITH: ' + token);
  await bar.press('Enter');

  // The agent builds; what the user asked for appears on screen.
  await page.waitForFunction(t => visibleText().includes(t), wanted, { timeout: 30000 }).catch(() => {});
  if (!(await onScreen(page, wanted))) {
    throw new Error(`never saw "${wanted}" in the visible page after the agent ran`);
  }

  // It survives a reload — the build was persisted, not just painted.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(t => visibleText().includes(t), wanted, { timeout: 15000 }).catch(() => {});
  if (!(await onScreen(page, wanted))) {
    throw new Error(`"${wanted}" disappeared on reload — the build was not persisted`);
  }
};
