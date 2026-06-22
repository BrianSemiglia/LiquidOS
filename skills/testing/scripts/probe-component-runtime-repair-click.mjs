//
// probe-component-runtime-repair-click.mjs
//
// Clicking the runtime Repair button on a component whose functions.js
// has thrown dispatches the agent scoped to that component. The stub
// agent rewrites functions.js to a clean mount and rewrites component.html
// with a known DOM marker. The probe asserts the marker "runtime repaired"
// appears on screen AND the runtime Repair button disappears — proof that
// clicking it drove the component back to a healthy state.
//
// Asserts only what a person sees on screen, never internal DOM structure
// or geometry.
//
// Run it:  node run-probe.mjs probe-component-runtime-repair-click.mjs
//

export const fixture = './probe-component-runtime-repair-click.liquidos';
export const agent = 'component-runtime-repair-test';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const onScreen = (text, timeout = 15000) => page.waitForFunction(
        t => document.body.innerText.includes(t), text, { timeout });
    const offScreen = (text, timeout = 10000) => page.waitForFunction(
        t => !document.body.innerText.includes(t), text, { timeout });

    // Wait for the runtime Repair button to surface (component has thrown).
    await onScreen('Repair', 15000).catch(() => {
        throw new Error('"Repair" never appeared — runtime error did not surface the repair affordance');
    });

    // Click it.
    await page.locator('button', { hasText: 'Repair' }).first().click();

    // Agent dispatches and either:
    //   success → writes "runtime repaired" to the screen
    //   failure → writes "contract failed:" to the screen (with the prompt)
    await onScreen('runtime repaired', 10000).catch(async () => {
        // Check whether a contract failure was surfaced instead.
        const screenText = await page.evaluate(() => document.body.innerText);
        if (screenText.includes('contract failed:')) {
            console.error('--- screen text at failure ---');
            console.error(screenText);
            console.error('---');
            throw new Error('agent contract check failed — see screen text above');
        }
        throw new Error('"runtime repaired" never appeared — agent did not complete successfully');
    });
    console.log('  ok  "runtime repaired" appeared on screen');

    // On success, the runtime Repair button must also disappear.
    await offScreen('Repair').catch(() => {
        throw new Error('"Repair" is still on screen after the agent repaired the component');
    });
    console.log('  ok  "Repair" cleared from screen after successful repair');
};
