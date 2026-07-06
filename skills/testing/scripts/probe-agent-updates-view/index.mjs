//
// probe-agent-updates-view
//
// The agent updates a component's view by writing the file the view
// renders from. A sequence of successive writes is each visible on
// screen, not just the final state. The path here is the canonical
// file write — the same thing `op="writeFile"` / `op="streamFile"`
// lqpatch markers land on disk. We exercise it directly through the
// harness's /workspace PUT endpoint, the same surface the agent's
// tools use.
//
// The probe writes three successive component.html values and asserts
// the rendered DOM is observed at each step (not just the last). If the
// view update path swallows intermediate states, the assertion for
// the missed step will fail.
//
// Run it:  node run-probe.mjs probe-agent-updates-view
//

export const fixture = './workspace.liquidos';
export const agent = 'agent/none-agent.js';

const expect = (label, predicate, detail) => {
    if (predicate) { console.log('  ok  ' + label); return; }
    throw new Error('FAIL: ' + label + (detail ? ' — ' + detail : ''));
};

export default async ({ url, page }) => {
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Baseline: the fixture renders SURVIVED_THE_SWAP from its initial component.html.
    await page.waitForFunction(() =>
        document.querySelector('[data-marker]')?.textContent?.includes('SURVIVED_THE_SWAP'),
        undefined, { timeout: 10000 });

    // Step through three successive component.html writes, the way the agent
    // would emit op="writeFile" three times in a row. We go through the
    // /workspace PUT endpoint so the file watcher + SSE + render path
    // fires the same way it does in production.
    const writeView = async (marker) => {
        const body =
            '<liquidos-component path="components/target">\n' +
            '    <liquidos-file path="components/target/service-a.js" run></liquidos-file>\n' +
            '    <p data-marker>' + marker + '</p>\n' +
            '</liquidos-component>\n';
        const r = await fetch(url + '/workspace/home/components/target/component.html', {
            method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body
        });
        if (r.status !== 200) throw new Error('PUT failed with ' + r.status);
    };

    for (const marker of ['AGENT_STEP_1', 'AGENT_STEP_2', 'AGENT_STEP_3']) {
        await writeView(marker);
        await page.waitForFunction(
            m => document.querySelector('[data-marker]')?.textContent?.includes(m),
            marker, { timeout: 5000 });
        const seen = await page.evaluate(() =>
            document.querySelector('[data-marker]')?.textContent || '');
        expect('view shows ' + marker, seen.includes(marker),
            'live DOM marker text: ' + JSON.stringify(seen));
    }
};
