//
// probe-service-lifecycle-on-canvas-switch.mjs
//
// Requirement: a component's run-mode service runs only while ITS canvas is
// the active one. Switch to another canvas and that canvas's services start;
// the canvas you left has its services torn down. (server.js swaps a single
// activeCanvasRuntime on switch: stop() the old, start() the new.)
//
// Mostly asserted through the view. Each canvas has a "ticker" whose service
// stamps a unique INSTANCE id (its PID plus a nonce) and an ever-advancing
// STEP into the rendered output:
//   - the OTHER canvas's ticker advances after switching to it  -> its
//     service started;
//   - returning to HOME shows a DIFFERENT instance id than before -> the home
//     service was respawned fresh (it had not kept running unchanged).
//
// One thing the view cannot show is whether the canvas you LEFT had its
// service killed, versus leaked into the background — a respawn-on-return
// would mask a leak. The service stamps its PID into that same visible text,
// so we read the exact PID through the view and ask the OS the one question
// the screen can't answer: after switching away, is it gone? That's the only
// non-view assertion here.
//
// Sibling coverage this does NOT duplicate: probe-service-reaping (services
// don't outlive the SERVER), probe-cross-canvas-job-persistence (canvas
// switch + job queue, no services), probe-service-reload-keeps-component-
// visible (service restart on file change, no canvas switch).
//
// Run it:  node run-probe.mjs probe-service-lifecycle-on-canvas-switch.mjs
//

export const fixture = './probe-service-lifecycle-on-canvas-switch.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The visible ticker text looks like "HOME_INSTANCE <pid>-<nonce> STEP <n>".
const tickerText = (page) =>
    page.evaluate(() => document.querySelector('[data-ticker]')?.textContent || '');

const instanceOf = (text, prefix) => {
    const m = new RegExp(prefix + '_INSTANCE (\\S+) STEP').exec(text || '');
    return m ? m[1] : null;
};
const pidOf = (text, prefix) => {
    const m = new RegExp(prefix + '_INSTANCE (\\d+)-\\d+ STEP').exec(text || '');
    return m ? Number(m[1]) : null;
};

// Signal 0 delivers nothing — it just probes for the process's existence.
// Throws (ESRCH) once the service is gone. Same-user processes, so no EPERM.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const switchToCanvas = async (page, name) => {
    await page.locator('#canvas-overview-toggle').dispatchEvent('click');
    const card = `.canvas-grid-card[data-canvas="${name}"]`;
    await page.waitForSelector(card, { timeout: 10000 });
    await page.locator(card).dispatchEvent('click');
};

// Wait until the named canvas's ticker is visibly advancing (STEP >= 2), which
// proves its service is actually running, not just its initial static markup.
const waitForAdvancing = (page, prefix, timeout = 15000) =>
    page.waitForFunction(
        (p) => {
            const t = document.querySelector('[data-ticker]')?.textContent || '';
            const m = new RegExp(p + '_INSTANCE \\S+ STEP (\\d+)').exec(t);
            return !!m && Number(m[1]) >= 2;
        },
        prefix,
        { timeout }
    );

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#canvas-overview-toggle', { timeout: 20000 });

    // --- home: its service is running -------------------------------------
    await waitForAdvancing(page, 'HOME');
    const homeText = await tickerText(page);
    const homeInstance1 = instanceOf(homeText, 'HOME');
    const homePid = pidOf(homeText, 'HOME');
    if (!homeInstance1 || !homePid) throw new Error('could not read home ticker instance/PID');
    console.log('home service running, instance:', homeInstance1);

    // --- switch to other: ITS service starts (view) -----------------------
    await switchToCanvas(page, 'other');
    await waitForAdvancing(page, 'OTHER');
    console.log('switched to other; its service is running');

    // --- the one OS check: home's service is reaped, not leaked -----------
    let deadline = Date.now() + 10000;
    while (alive(homePid) && Date.now() < deadline) await sleep(250);
    if (alive(homePid)) {
        throw new Error('home service PID ' + homePid + ' still alive after switching away — leaked, not reaped');
    }
    console.log('home service reaped after switching away:', homePid);

    // --- back to home: a FRESH instance proves it respawned (view) --------
    await switchToCanvas(page, 'home');
    await page.waitForFunction(
        (was) => {
            const t = document.querySelector('[data-ticker]')?.textContent || '';
            const m = /HOME_INSTANCE (\S+) STEP \d+/.exec(t);
            return !!m && m[1] !== was;
        },
        homeInstance1,
        { timeout: 15000 }
    );
    console.log('back on home; service respawned as new instance:', instanceOf(await tickerText(page), 'HOME'));
};
