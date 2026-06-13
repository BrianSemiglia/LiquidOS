//
// probe-component-repair.mjs
//
// User opens a flip-back whose feature-requirements.txt is empty,
// clicks the Repair button → agent dispatched → agent writes the
// requirements file. User closes the flip-back and reopens it; the
// harness re-fetches the file and the textarea now shows the agent's
// content. Probe asserts on that textarea value (UI surface).
//
// Run it:  node run-probe.mjs probe-component-repair.mjs
//

export const fixture = 'component-repair.liquidos';
export const agent = 'component-repair-test';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[page error]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-probe]', { timeout: 20000 });
    await sleep(1500);

    // Open the flip-back. Textarea loads (empty); Repair surfaces.
    await page.locator('[data-component-flip]').first().dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const cb = document.querySelector('[data-feature-recover-callback]');
            return cb && !cb.hidden;
        },
        { timeout: 5000 }
    );

    // Click Repair → dispatched.
    await page.locator('[data-feature-recover]').dispatchEvent('click');
    // Give the agent time to write the file.
    await sleep(500);

    // Close (returns to front via the Cancel button).
    await page.locator('[data-feature-cancel]').dispatchEvent('click');
    await sleep(300);
    // Reopen — harness re-fetches via /component/<path>/features so the
    // textarea now reflects the agent's write.
    await page.locator('[data-component-flip]').first().dispatchEvent('click');
    await page.waitForFunction(
        () => {
            const ta = document.querySelector('[data-feature-requirements]');
            return ta && ta.value && ta.value.includes('REPAIRED_BY_TEST_AGENT');
        },
        { timeout: 5000 }
    );

    const textareaValue = await page.locator('[data-feature-requirements]').inputValue();
    console.log('textarea after Repair:', textareaValue.trim());
};
