// Helpers for the workspace-error snapshot file and the prompt the
// runtime hands the agent when a workspace-level error is detected.
// Detection, dispatch, retry, and commit all live in the regular agent
// job pipeline (server.js processOutputJob → activityPersistence) so
// there is no special-case state machine here.

const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE_ERROR_FILE_REL = path.join('.liquidos', 'workspace-error');

const skillsDiffSince = (workspacePath, sha) => {
    if (!sha) return '';
    const result = spawnSync('git', ['show', '--stat', '--patch', sha, '--', 'skills'], {
        cwd: workspacePath, encoding: 'utf8'
    });
    return result.status === 0 ? (result.stdout || '') : '';
};

const buildWorkspaceFixPrompt = ({ workspacePath, errors, syncedSkillsSha, syncedSkillsParentSha }) => {
    const errorsText = (errors || []).map(e =>
        `  - [${e.check}] ${e.error}`).join('\n') || '  (none recorded)';

    const diff = syncedSkillsSha
        ? skillsDiffSince(workspacePath, syncedSkillsSha).slice(0, 12000)
        : '';

    return [
        'The runtime couldn\'t open this workspace. Edit workspace-level',
        'files so it can start.',
        '',
        'How to think about it:',
        '  - The skills under <workspace>/skills/ describe what the runtime',
        '    currently expects of a workspace.',
        '  - Look at this workspace as it stands. See what doesn\'t match.',
        '  - Change workspace-level files so the runtime can come up.',
        '',
        'Scope:',
        '  - Workspace-level only. Leave individual canvases and component',
        '    content alone; those have their own repair flows.',
        '  - You don\'t need to manage <workspace>/.liquidos/workspace-error',
        '    or commit anything — the runtime handles both after you exit.',
        '',
        'If the fix isn\'t within reach — a runtime bug, an environmental',
        'issue, anything you can\'t address by editing workspace files —',
        'explain why in your final response and stop. The user can retry',
        'or fix it manually.',
        '',
        'Errors the runtime reported:',
        errorsText,
        '',
        syncedSkillsSha
            ? `Most recent skills sync: ${syncedSkillsSha}` +
              (syncedSkillsParentSha ? ` (parent ${syncedSkillsParentSha})` : '')
            : 'No recent skills sync recorded.',
        '',
        diff ? 'Skills diff (most recent sync):\n```\n' + diff + '\n```' : ''
    ].join('\n');
};

module.exports = { buildWorkspaceFixPrompt, WORKSPACE_ERROR_FILE_REL };
