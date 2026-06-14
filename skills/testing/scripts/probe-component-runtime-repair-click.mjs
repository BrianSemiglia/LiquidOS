//
// probe-component-runtime-repair-click.mjs
//
// Clicking the runtime Repair button on a component whose functions.js
// has thrown dispatches the agent scoped to that component. The stub
// agent rewrites functions.js to a clean mount and rewrites component.html
// with a known DOM marker. The probe asserts the marker appears AND
// the runtime Repair button disappears — proof that clicking it drove
// the component back to a healthy state.
//
// Run it:  node run-probe.mjs probe-component-runtime-repair-click.mjs
//

export const fixture = 'component-runtime-error.liquidos';
export const agent = 'component-runtime-repair-test';

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the runtime Repair button to surface (component has thrown).
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 15000 }
    );

    // Click it.
    await page.locator('button', { hasText: 'Repair' }).first().click();

    // Agent dispatches → either the success marker appears, or the
    // failure marker surfaces the actual prompt the agent received.
    await page.waitForFunction(
        () => document.querySelector('[data-runtime-repair-marker]')
            || document.querySelector('[data-runtime-repair-failure]'),
        { timeout: 10000 }
    );
    const failure = await page.evaluate(() => {
        const el = document.querySelector('[data-runtime-repair-failure]');
        if (!el) return null;
        return {
            reason: el.querySelector('p')?.textContent || '(no reason)',
            promptReceived: el.querySelector('[data-prompt-received]')?.textContent || '(empty)'
        };
    });
    if (failure) {
        console.error('--- prompt the agent received ---');
        console.error(failure.promptReceived);
        console.error('---');
        throw new Error(failure.reason);
    }

    // On success, the runtime Repair button must also disappear.
    await page.waitForFunction(
        () => !Array.from(document.querySelectorAll('button'))
            .some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0),
        { timeout: 10000 }
    );
};
