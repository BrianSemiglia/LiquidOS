//
// probe-debug-output
//
// The debug rail (#debug-output) shows the agent's raw output as it works.
// When you prompt the agent, the lines it prints to stdout stream live into
// that rail — not only on the next snapshot fetch, but while the turn runs.
//
// This probe drives the app the way a user does: open the debug rail, type a
// prompt carrying a known token, submit, and assert the agent's output line
// (carrying that token) becomes visible in the rail during the turn. It guards
// the prompt-to-stdout-to-debug-rail wire — the live `debug-line` feed — which
// no other probe covers (the waveform probe watches the pixel canvas instead).
//
// Run it:  node run-probe.mjs probe-debug-output
//

export const fixture = './workspace.liquidos';
export const agent = './agent.js';

// Visible text of the debug rail's output pane.
const debugText = (page) => page.evaluate(() => {
  const pre = document.getElementById('debug-output');
  return pre ? pre.textContent : '';
});

export default async ({ url, page }) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByRole('textbox', { name: 'Prompt' }).waitFor({ timeout: 15000 });

  // Open the debug rail so its output is on screen.
  await page.evaluate(() => window.liquidos.setDebugOpen(true));

  const token = 'TOK_' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const marker = 'DEBUG_LINE: ' + token;

  // The token is fresh each run, so it cannot already be showing.
  if ((await debugText(page)).includes(marker)) {
    throw new Error('the debug rail already showed the token before any prompt');
  }

  // Drive the prompt bar the way the user does. The stub prints a few stdout
  // lines, one carrying the token, over the same feed the debug rail reads.
  const bar = page.getByRole('textbox', { name: 'Prompt' });
  await bar.fill('REPLACE_WITH: ' + token);
  await bar.press('Enter');

  // The agent's output line must appear in the rail while the turn streams —
  // via the live feed, without any reload of the page or the debug snapshot.
  await page.waitForFunction((needle) => {
    const pre = document.getElementById('debug-output');
    return !!pre && pre.textContent.includes(needle);
  }, marker, { timeout: 8000 }).catch(() => {});

  if (!(await debugText(page)).includes(marker)) {
    throw new Error('the agent streamed output but it never appeared in the debug rail');
  }
};
