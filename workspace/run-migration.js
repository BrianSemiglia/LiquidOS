// Workspace-fix runner.
//
// The runtime writes .liquidos/workspace-error when its startup detects a
// workspace-level problem it can't load past (see collectWorkspaceErrors in
// server.js). This module reads that marker, asks the active runtime to
// repair the workspace, and trusts the agent to clear the marker when done.
//
// The marker is a JSON document with an `errors` array describing what
// failed, plus optional context (e.g., the SHA of the most recent skills
// sync). The agent uses both the marker and the workspace's current skills
// to decide how to fix things — and is explicitly allowed to refuse if the
// problem is outside what skills + workspace state can repair.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE_FIX_MARKER_REL = path.join('.liquidos', 'workspace-error');

const readMarker = workspacePath => {
    const markerPath = path.join(workspacePath, WORKSPACE_FIX_MARKER_REL);
    if (!fs.existsSync(markerPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    } catch {
        return { errors: [{ check: 'marker-read', error: 'marker file was unreadable' }] };
    }
};

const skillsDiffSince = (workspacePath, sha) => {
    if (!sha) return '';
    const result = spawnSync('git', ['show', '--stat', '--patch', sha, '--', 'skills'], {
        cwd: workspacePath, encoding: 'utf8'
    });
    return result.status === 0 ? (result.stdout || '') : '';
};

const buildWorkspaceFixPrompt = ({ workspacePath, marker }) => {
    const errors = (marker.errors || []).map(e =>
        `  - [${e.check}] ${e.error}`).join('\n') || '  (none recorded)';

    const diff = marker.syncedSkillsSha
        ? skillsDiffSince(workspacePath, marker.syncedSkillsSha).slice(0, 12000)
        : '';

    return [
        'The runtime tried to open this workspace and hit workspace-level',
        'errors. It might be a migration issue (the runtime\'s expectations',
        'moved and the workspace hasn\'t caught up) or it might be something',
        'else. Investigate and fix it if you can.',
        '',
        'Procedure:',
        '  1. Read the errors below and the current skills under',
        '     <workspace>/skills/. The skills describe the runtime\'s current',
        '     expectations for workspace shape.',
        '  2. Look at the workspace as it stands now. Compare to the target.',
        '  3. If the problem is within your authority — workspace-level shape',
        '     drift, a renamed top-level file, a missing canvas selection,',
        `     a workspace-shaped invariant the runtime now needs — then:`,
        '       a. Write <workspace>/.liquidos/migrate.sh making the workspace',
        '          match the skills (idempotent; safe to re-run).',
        '       b. Run it. Fix and re-run if it fails partway.',
        '       c. Commit the resulting workspace changes (excluding .liquidos/)',
        '          with a message starting "workspace: migrated for skills".',
        '       d. Delete <workspace>/.liquidos/workspace-error. That is the',
        '          signal the runtime watches for to know the fix is done.',
        '  4. If the problem is OUTSIDE your authority — a runtime bug, an',
        '     environmental issue (permissions, disk), or anything that',
        '     reading skills + editing workspace files can\'t address — leave',
        '     the marker in place and explain in your final response why this',
        '     is out of scope. The user will see your reasoning and can decide',
        '     whether to retry or fix the underlying issue manually.',
        '',
        'Things you should NOT touch from here: individual canvas content or',
        'component content. Canvas and component issues have their own repair',
        'flows (the broken card shows a Repair button). This step is scoped',
        'to workspace-level concerns only.',
        '',
        'Errors the runtime reported:',
        errors,
        '',
        marker.syncedSkillsSha
            ? `Most recent skills sync: ${marker.syncedSkillsSha}` +
              (marker.syncedSkillsParentSha ? ` (parent ${marker.syncedSkillsParentSha})` : '')
            : 'No recent skills sync recorded.',
        '',
        diff ? 'Skills diff (most recent sync):\n```\n' + diff + '\n```' : ''
    ].join('\n');
};

const runMigration = async ({
    workspacePath,
    activeRuntime,
    logServer
}) => {
    const marker = readMarker(workspacePath);
    if (!marker) return { skipped: 'no-marker' };

    const prompt = buildWorkspaceFixPrompt({ workspacePath, marker });

    logServer('migration', 'agent invoked', {
        errors: marker.errors,
        skillsSha: marker.syncedSkillsSha || null
    });

    let response = '';
    let error = null;
    try {
        response = await activeRuntime.run(activeRuntime.preparePrompt(prompt), {
            workingDirectory: workspacePath,
            canvasPath: workspacePath,
            inputPath: null,
            outputPath: null,
            job: { id: 'workspace-fix-' + Date.now(), event: 'Runtime did request workspace fix' }
        });
    } catch (e) {
        error = e.message;
    }

    const stillPending = fs.existsSync(path.join(workspacePath, WORKSPACE_FIX_MARKER_REL));

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

module.exports = { runMigration, buildWorkspaceFixPrompt, WORKSPACE_FIX_MARKER_REL };
