const path = require('path');

const quoteEvent = value => String(value || '').replace(/[\n\r]+/g, ' ').replace(/'/g, "\\'");

// Single source of truth for deleting a canvas: remove the folder, then record
// the deletion into the workspace git timeline. The in-app DELETE
// /canvases/<name> endpoint requires this and calls deleteCanvas() in-process;
// the agent runs the very same file as a CLI (via
// skills/canvas/scripts/delete-instance.sh). Both paths remove the same folder
// and write the same timeline commit, so canvas deletion behaves identically no
// matter who triggers it. The commit format lives in git-timeline.js (reached
// through persistActivity) — never hand-write it here, or recentEvents() stops
// parsing the event back out of the log.
const deleteCanvas = ({ canvasFiles, persistActivity, workspacePath, name }) => {
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
