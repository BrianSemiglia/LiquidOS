//
// probe-component-diagnostics.mjs
//
// Feature: when a component's script fails to load (syntax error,
// missing export, etc.), the user sees the component is broken — the
// Repair button surfaces, the same way a thrown error would surface it.
// The harness doesn't need a separate "mount-error" presentation; load
// failure and runtime throw are the same broken-component story from
// the user's perspective.
//
// Run it:  node run-probe.mjs probe-component-diagnostics.mjs
//

export const fixture = 'component-diagnostics.liquidos';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-broken]', { timeout: 20000 });

    // Repair button surfaces — same affordance the user sees for any
    // broken component. Reads "Repair", hover reveals it.
    await page.waitForFunction(
        () => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.some(b => (b.textContent || '').trim() === 'Repair'
                && b.getBoundingClientRect().width > 0);
        },
        { timeout: 10000 }
    );
};
