// Workspace migration runner.
//
// When sync-skills.js detects a skills delta, it commits the new skills and
// drops a marker at .liquidos/migration-pending containing the commit SHA.
// This module reads that marker, asks the active runtime to migrate the
// workspace, and trusts the agent to clear the marker when it's done.
//
// The validation strategy is option (2) from the design conversation: we
// don't ship a parallel validator. The runtime that opens the workspace
// IS the validator — if migration succeeded the workspace loads and the
// component diagnostics come back clean; if it didn't, those diagnostics
// surface the failure through the existing UI.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PENDING_MARKER_REL = path.join('.liquidos', 'migration-pending');

const readMarker = workspacePath => {
    const markerPath = path.join(workspacePath, PENDING_MARKER_REL);
    if (!fs.existsSync(markerPath)) return null;
    try { return fs.readFileSync(markerPath, 'utf8').trim(); }
    catch { return null; }
};

const skillsDiff = (workspacePath, sha) => {
    const result = spawnSync('git', ['show', '--stat', '--patch', sha, '--', 'skills'], {
        cwd: workspacePath, encoding: 'utf8'
    });
    return result.status === 0 ? (result.stdout || '') : '';
};

const buildMigrationPrompt = ({ workspacePath, sha, parentSha }) => {
    // Truncate the diff conservatively; large structural changes still produce
    // small diffs, and the full picture is on disk for the agent to read.
    const diff = skillsDiff(workspacePath, sha).slice(0, 12000);

    return [
        'Workspace skills were just updated by the runtime, and the workspace',
        'contents may no longer match what the new skills describe. Your job',
        'is to bring the workspace into alignment, in one pass.',
        '',
        'Procedure:',
        '  1. Read the skills under <workspace>/skills/ to understand the',
        '     current target shape (file layout, input.json schema, canvas.js',
        '     contract, state file naming, etc.).',
        '  2. Look at the workspace as it stands now. Compare to the target.',
        '  3. Write <workspace>/.liquidos/migrate.sh — a shell script that',
        '     transforms the workspace from where it is to where the skills',
        `     say it should be. Cover everything that's drifted, not just`,
        '     individual files. Make the script idempotent (safe to re-run).',
        '  4. Run the script. If it fails partway, fix and re-run.',
        '  5. Commit the resulting workspace changes (excluding .liquidos/) with',
        '     a message starting "workspace: migrated for skills".',
        '  6. Delete the file <workspace>/.liquidos/migration-pending. That is',
        '     the signal the runtime watches for to know the migration completed.',
        '',
        `The skills commit that triggered this is ${sha}.`,
        `The prior commit (workspace's previous skill state) is ${parentSha || '(none — fresh workspace)'}.`,
        '',
        'Skills diff:',
        '```',
        diff || '(no diff available)',
        '```'
    ].join('\n');
};

const runMigration = async ({
    workspacePath,
    activeRuntime,
    logServer
}) => {
    const sha = readMarker(workspacePath);
    if (!sha) return { skipped: 'no-marker' };

    const parentResult = spawnSync('git', ['rev-parse', '--verify', sha + '~1'], {
        cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    const parentSha = parentResult.status === 0 ? (parentResult.stdout || '').trim() : null;

    const prompt = buildMigrationPrompt({ workspacePath, sha, parentSha });

    logServer('migration', 'agent invoked', { sha, parentSha });

    let response = '';
    let error = null;
    try {
        response = await activeRuntime.run(activeRuntime.preparePrompt(prompt), {
            workingDirectory: workspacePath,
            canvasPath: workspacePath,
            inputPath: null,
            outputPath: null,
            job: { id: 'migration-' + sha.slice(0, 8), event: 'Runtime did request migration' }
        });
    } catch (e) {
        error = e.message;
    }

    const stillPending = fs.existsSync(path.join(workspacePath, PENDING_MARKER_REL));

    logServer('migration', error ? 'agent failed' : 'agent returned', {
        markerCleared: !stillPending,
        error,
        responsePreview: String(response || '').slice(0, 300)
    });

    return {
        ran: true,
        markerCleared: !stillPending,
        error,
        response
    };
};

module.exports = { runMigration, buildMigrationPrompt, PENDING_MARKER_REL };
