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

    // Bake the running app's location into the sandbox-boot script so the
    // runtime agent can boot a sandbox of its workspace without knowing where
    // the app lives. sourceRoot is <app>/skills, so the app root is its
    // parent. Without this the agent has to reverse-engineer the path (lsof
    // the running server, hunt for server.js) before it can run a UI test.
    const appRoot = path.dirname(sourceRoot);
    const bootScript = path.join(skillsRoot, 'testing', 'scripts', 'boot-workspace-sandbox.mjs');
    try {
        if (fs.existsSync(bootScript)) {
            const src = fs.readFileSync(bootScript, 'utf8');
            const baked = src.replace('__LIQUIDOS_APP_ROOT__', () => appRoot);
            if (baked !== src) fs.writeFileSync(bootScript, baked);
        }
    } catch {
        // Best-effort; the agent can still pass --app explicitly.
    }

    return true;
};

module.exports = {
    copySkillsTreeToRoot
};
