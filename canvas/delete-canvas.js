const path = require('path');

const quoteEvent = value => String(value || '').replace(/[\n\r]+/g, ' ').replace(/'/g, "\\'");

// Single source of truth for deleting a canvas: snapshot the canvas as it
// stands, remove the folder, then record the removal — two commits bracketing
// the delete. The "will delete" commit captures the canvas's final state in the
// timeline (otherwise a never-committed canvas would vanish with no recoverable
// snapshot); the "did delete" commit records the removal itself. The in-app
// DELETE /canvases/<name> endpoint requires this and calls deleteCanvas()
// in-process; the agent runs the very same file as a CLI (via
// skills/canvas/scripts/delete-instance.sh). Both paths produce the same pair of
// timeline commits, so canvas deletion behaves identically no matter who
// triggers it. The commit format lives in git-timeline.js (reached through
// persistActivity) — never hand-write it here, or recentEvents() stops parsing
// the event back out of the log.
const deleteCanvas = ({ canvasFiles, persistActivity, workspacePath, name }) => {
    // Commit the canvas's final state before it's gone, so the timeline holds a
    // recoverable snapshot of what's about to be removed.
    persistActivity({
        event: `User will delete canvas with name '${quoteEvent(name)}'`,
        scope: path.join(workspacePath, name),
        prompt: '',
        agentResponse: 'none',
        mode: 'done'
    });
    const deleted = canvasFiles.deleteCanvas(name);
    persistActivity({
        event: `User did delete canvas with name '${quoteEvent(deleted)}'`,
        scope: path.join(workspacePath, deleted),
        prompt: '',
        agentResponse: 'none',
        mode: 'done'
    });
    return deleted;
};

// CLI entry for the agent path. Builds the same canvasFiles + activity/git
// timeline the server builds, but pointed at the workspace passed on the
// command line, then runs the shared deleteCanvas() above.
const runCli = argv => {
    const fs = require('fs');
    const { createCanvasFiles } = require('./files');
    const { createActivityPersistence } = require('./activity-persistence');

    const name = argv[0];
    const workspaceArg = argv[1] || process.env.LIQUIDOS_WORKSPACE || '';

    if (!name || !workspaceArg) {
        console.error('Usage: delete-canvas.js <canvas-name> <workspace.liquidos>');
        process.exit(1);
    }

    const workspacePath = path.resolve(workspaceArg);
    const canvasPath = path.join(workspacePath, name);
    const logServer = (...args) => console.error('[delete-canvas]', ...args);

    const canvasFiles = createCanvasFiles({
        fs,
        workspacePath,
        canvasTemplateRoot: '',
        getCanvasPath: () => canvasPath,
        setCanvasPath: () => {},
        readJson: file => JSON.parse(fs.readFileSync(file, 'utf8'))
    });

    const activityPersistence = createActivityPersistence({
        workspacePath,
        currentCanvasPath: () => canvasPath,
        logServer
    });

    try {
        const deleted = deleteCanvas({
            canvasFiles,
            persistActivity: activityPersistence.persistActivity,
            workspacePath,
            name
        });
        process.stdout.write(JSON.stringify({ canvas: deleted, path: canvasPath }) + '\n');
    } catch (error) {
        console.error('Error:', error.message);
        // 4xx (bad name / missing canvas) is a usage error, not a crash.
        const usage = error.statusCode >= 400 && error.statusCode < 500;
        process.exit(usage ? 2 : 1);
    }
};

if (require.main === module) {
    runCli(process.argv.slice(2));
}

module.exports = { deleteCanvas };
