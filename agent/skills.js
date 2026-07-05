const fs = require('fs');
const path = require('path');

const copySkillsTreeToRoot = (sourceRoot, destinationRoot) => {
    if (!sourceRoot || !destinationRoot || !fs.existsSync(sourceRoot)) {
        return false;
    }

    const skillsRoot = path.join(destinationRoot, 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });

    fs.readdirSync(sourceRoot)
        .filter(name => name !== 'AGENTS.md')
        .forEach(name => {
            fs.cpSync(path.join(sourceRoot, name), path.join(skillsRoot, name), {
                recursive: true
            });
        });

    // Bake the running app's location into the scripts that delegate back to
    // app code, so the runtime agent doesn't have to reverse-engineer where the
    // app lives (lsof the running server, hunt for server.js). sourceRoot is
    // <app>/skills, so the app root is its parent.
    //   - boot-workspace-sandbox.mjs boots a sandbox of the agent's workspace.
    //   - canvas/delete-instance.sh delegates to the server binary's
    //     delete-canvas subcommand so the agent and the DELETE endpoint share
    //     one delete path.
    const appRoot = path.dirname(sourceRoot);
    const scriptsWithAppRoot = [
        path.join(skillsRoot, 'testing', 'scripts', 'boot-workspace-sandbox.mjs'),
        path.join(skillsRoot, 'canvas', 'scripts', 'delete-instance.sh')
    ];
    for (const scriptPath of scriptsWithAppRoot) {
        try {
            if (fs.existsSync(scriptPath)) {
                const src = fs.readFileSync(scriptPath, 'utf8');
                const baked = src.replace('__LIQUIDOS_APP_ROOT__', () => appRoot);
                if (baked !== src) fs.writeFileSync(scriptPath, baked);
            }
        } catch {
            // Best-effort; the scripts carry their own fallbacks.
        }
    }

    return true;
};

module.exports = {
    copySkillsTreeToRoot
};
