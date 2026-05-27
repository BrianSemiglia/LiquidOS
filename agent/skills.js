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

    return true;
};

module.exports = {
    copySkillsTreeToRoot
};
