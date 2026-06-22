//
// probe-agent-activity-waveform.mjs
//
// The prompt bar shows a waveform of the agent's output next to the activity
// label: while the agent streams, the canvas beside the badge paints spikes
// that scroll right-to-left; when the turn ends and things go idle, the row
// collapses away again.
//
// A waveform has no text to read, so this probe asserts what a person would
// actually see on the canvas: the activity row becomes visible during a turn,
// and the canvas paints pixels (a spike taller than its flat baseline) while
// output streams — then goes away when idle. It drives the app the way a user
// does: type into the prompt bar and submit.
//
// Run it:  node run-probe.mjs probe-agent-activity-waveform.mjs
//

export const fixture = './probe-agent-activity-waveform.liquidos';
export const agent = 'lqpatch-stream-stub';

// Tallest run of painted (non-transparent) pixels in any column of the
// waveform canvas — i.e. the height of the biggest spike currently drawn.
const peakSpike = (page) => page.evaluate(() => {
  const c = document.getElementById('agent-activity-viz');
  if (!c || !c.width || !c.height) return { painted: false, peak: 0, w: c ? c.width : 0 };
  const ctx = c.getContext('2d');
  const { width, height } = c;
  const d = ctx.getImageData(0, 0, width, height).data;
  let peak = 0;
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      if (d[(y * width + x) * 4 + 3] > 0) run++;
    }
    if (run > peak) peak = run;
  }
  return { painted: peak > 0, peak, w: width };
});

// The row shows/hides by animating its height + opacity (not display), so
// "visible" means it has settled open: opaque and taller than its collapsed 0.
const rowVisible = (page) => page.evaluate(() => {
  const row = document.getElementById('agent-activity-row');
  if (!row) return false;
  const cs = getComputedStyle(row);
  return parseFloat(cs.opacity) > 0.5 && parseFloat(cs.height) > 6;
});

export default async ({ url, page }) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#global-text', { timeout: 15000 });

  // Before any turn, the activity row (and its waveform) is collapsed away.
  if (await rowVisible(page)) {
    throw new Error('activity row was already visible before any agent output');
  }

  // Drive the prompt bar the way the user does. The stub streams a mix of
  // prose and ops over /agent/stream — exactly the output the waveform draws.
  const token = 'TOK_' + Math.random().toString(36).slice(2, 10).toUpperCase();
  await page.locator('#global-text').fill('REPLACE_WITH: ' + token);
  await page.evaluate(() => document.getElementById('global-prompt').requestSubmit());

  // While the agent streams, poll the canvas and remember the biggest spike we
  // ever caught, plus whether the row was visible at that moment.
  let bestPeak = 0;
  let sawVisible = false;
  for (let i = 0; i < 80; i++) {
    if (await rowVisible(page)) sawVisible = true;
    const { peak } = await peakSpike(page);
    if (peak > bestPeak) bestPeak = peak;
    await page.waitForTimeout(20);
  }

  if (!sawVisible) {
    throw new Error('the activity row never became visible while the agent streamed output');
  }
  // A flat baseline is ~1px tall; a real output spike is several px. Require a
  // clear spike so we know output volume drove the height, not just the line.
  if (bestPeak < 4) {
    throw new Error(`waveform never spiked while the agent streamed (tallest run = ${bestPeak}px)`);
  }

  // After the turn goes idle, the row collapses away again (height animates
  // back to ~0 and it fades out).
  await page.waitForFunction(() => {
    const row = document.getElementById('agent-activity-row');
    if (!row) return false;
    const cs = getComputedStyle(row);
    return parseFloat(cs.opacity) < 0.5 || parseFloat(cs.height) <= 6;
  }, null, { timeout: 8000 }).catch(() => {});
  if (await rowVisible(page)) {
    throw new Error('activity row stayed visible after the turn went idle');
  }
};
