// Workspace-fix runner.
//
// The runtime writes .liquidos/workspace-error when its startup detects a
// workspace-level problem it can't load past (see collectWorkspaceErrors in
// server.js). This module reads that workspace-error file, asks the active
// runtime to repair the workspace, and trusts the agent to delete the file
// when done.
//
// The workspace-error file is a JSON document with an `errors` array
// describing what failed, plus optional context (e.g., the SHA of the most
// recent skills sync). The agent uses both the file and the workspace's
// current skills to decide how to fix things — and is explicitly allowed to
// refuse if the problem is outside what skills + workspace state can
// repair.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE_ERROR_FILE_REL = path.join('.liquidos', 'workspace-error');

const readWorkspaceErrorFile = workspacePath => {
    const errorFilePath = path.join(workspacePath, WORKSPACE_ERROR_FILE_REL);
    if (!fs.existsSync(errorFilePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(errorFilePath, 'utf8'));
    } catch {
        return { errors: [{ check: 'workspace-error-file-read', error: 'workspace-error file was unreadable' }] };
    }
};

const skillsDiffSince = (workspacePath, sha) => {
    if (!sha) return '';
    const result = spawnSync('git', ['show', '--stat', '--patch', sha, '--', 'skills'], {
        cwd: workspacePath, encoding: 'utf8'
    });
    return result.status === 0 ? (result.stdout || '') : '';
};

const buildWorkspaceFixPrompt = ({ workspacePath, errorFile }) => {
    const errors = (errorFile.errors || []).map(e =>
        `  - [${e.check}] ${e.error}`).join('\n') || '  (none recorded)';

    const diff = errorFile.syncedSkillsSha
        ? skillsDiffSince(workspacePath, errorFile.syncedSkillsSha).slice(0, 12000)
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
        '     the workspace-error file in place and explain in your final',
        '     response why this is out of scope. The user will see your',
        '     reasoning and can decide whether to retry or fix the underlying',
        '     issue manually.',
        '',
        'Things you should NOT touch from here: individual canvas content or',
        'component content. Canvas and component issues have their own repair',
        'flows (the broken card shows a Repair button). This step is scoped',
        'to workspace-level concerns only.',
        '',
        'Errors the runtime reported:',
        errors,
        '',
        errorFile.syncedSkillsSha
            ? `Most recent skills sync: ${errorFile.syncedSkillsSha}` +
              (errorFile.syncedSkillsParentSha ? ` (parent ${errorFile.syncedSkillsParentSha})` : '')
            : 'No recent skills sync recorded.',
        '',
        diff ? 'Skills diff (most recent sync):\n```\n' + diff + '\n```' : ''
    ].join('\n');
};

const runMigration = async ({
    workspacePath,
    activeRuntime,
    logServer,
    systemPromptPath = null
}) => {
    const errorFile = readWorkspaceErrorFile(workspacePath);
    if (!errorFile) return { skipped: 'no-workspace-error-file' };

    const prompt = buildWorkspaceFixPrompt({ workspacePath, errorFile });

    logServer('migration', 'agent invoked', {
        errors: errorFile.errors,
        skillsSha: errorFile.syncedSkillsSha || null,
        systemPromptPath
    });

    let response = '';
    let error = null;
    try {
        response = await activeRuntime.run(activeRuntime.preparePrompt(prompt), {
            workingDirectory: workspacePath,
            canvasPath: workspacePath,
            inputPath: null,
            outputPath: null,
            // Threading the same systemPromptPath that queued component jobs
            // use so the migration agent gets the standard runtime context
            // (AGENTS.md). Without it, the agent operates without the
            // baseline rules other agent jobs see.
            systemPromptPath,
            job: { id: 'workspace-fix-' + Date.now(), event: 'Runtime did request workspace fix' }
        });
    } catch (e) {
        error = e.message;
    }

    const stillPresent = fs.existsSync(path.join(workspacePath, WORKSPACE_ERROR_FILE_REL));

    logServer('migration', error ? 'agent failed' : 'agent returned', {
        errorFileCleared: !stillPresent,
        error,
        responsePreview: String(response || '').slice(0, 300)
    });

    return {
        ran: true,
        errorFileCleared: !stillPresent,
        error,
        response
    };
};

module.exports = { runMigration, buildWorkspaceFixPrompt, WORKSPACE_ERROR_FILE_REL };
