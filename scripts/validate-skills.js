const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

const readSkillFiles = () =>
    fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .flatMap(entry => {
            const fullPath = path.join(SKILLS_DIR, entry.name);

            if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'AGENTS.md') {
                return [fullPath];
            }

            if (entry.isDirectory()) {
                const skillPath = path.join(fullPath, 'SKILL.md');
                return fs.existsSync(skillPath) ? [skillPath] : [];
            }

            return [];
        });

const parseFrontmatter = text => {
    if (!text.startsWith('---\n')) {
        return null;
    }

    const endIndex = text.indexOf('\n---\n', 4);
    if (endIndex === -1) {
        return null;
    }

    const block = text.slice(4, endIndex);
    const fields = Object.fromEntries(
        block
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
                return match ? [match[1], match[2]] : null;
            })
            .filter(Boolean)
    );

    return fields;
};

const expectedNameFor = filePath => {
    const relative = path.relative(SKILLS_DIR, filePath);
    if (relative.endsWith('SKILL.md')) {
        return path.basename(path.dirname(filePath));
    }

    return path.basename(filePath, '.md');
};

const problems = [];

for (const filePath of readSkillFiles()) {
    const text = fs.readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(text);

    if (!frontmatter) {
        problems.push(`${path.relative(ROOT, filePath)}: missing YAML frontmatter`);
        continue;
    }

    if (!frontmatter.name) {
        problems.push(`${path.relative(ROOT, filePath)}: missing name`);
    }

    if (!frontmatter.description) {
        problems.push(`${path.relative(ROOT, filePath)}: missing description`);
    }

    const expectedName = expectedNameFor(filePath);
    if (frontmatter.name && frontmatter.name !== expectedName) {
        problems.push(`${path.relative(ROOT, filePath)}: name "${frontmatter.name}" does not match "${expectedName}"`);
    }
}

if (problems.length > 0) {
    console.error('Skill validation failed:');
    for (const problem of problems) {
        console.error('- ' + problem);
    }
    process.exit(1);
}

console.log('Skill validation passed for ' + readSkillFiles().length + ' files.');
