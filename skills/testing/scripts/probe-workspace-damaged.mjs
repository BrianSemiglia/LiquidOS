//
// probe-workspace-damaged.mjs
//
// Workspace is already broken when the server boots — index.json is
// invalid JSON. The user shouldn't land on a dead UI: the canvas-level
// Repair card surfaces just like it does when the file is corrupted
// mid-session (probe-canvas-damaged).
//
// This is the boot-time counterpart to probe-canvas-damaged, the path
// the workspace-migration overlay used to handle. Adding the assertion
// here so we can rip the migration flow out without losing coverage of
// "server boots into a broken workspace → user sees a way out."
//
// Run it:  node run-probe.mjs probe-workspace-damaged.mjs
//

export const fixture = './probe-workspace-damaged.liquidos';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // A Repair button must appear on first paint — same affordance the
    // user gets when a canvas breaks mid-session.
    await page.waitForFunction(
        t => visibleText().includes(t), 'Repair', { timeout: 10000 }
    ).catch(() => {
        throw new Error('"Repair" never appeared on screen — damaged workspace did not surface the repair affordance');
    });
};
