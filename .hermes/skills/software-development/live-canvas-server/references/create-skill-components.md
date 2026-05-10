# Create Skill Components Script

Python script to scan all SKILL.md files and create component JSONs for a hermes-skills canvas.

## Usage

```bash
python3 /tmp/create_skill_components.py
```

## Script: /tmp/create_skill_components.py

```python
#!/usr/bin/env python3
import json
import os
import re

# Find all SKILL.md files
skill_dir = os.path.expanduser('~/.hermes/skills')
components_dir = '~/Documents/workspace/live-edit/canvases/hermes-skills/components'

os.makedirs(components_dir, exist_ok=True)

# Find all SKILL.md files
skill_files = []
for root, dirs, files in os.walk(skill_dir):
    for file in files:
        if file == 'SKILL.md':
            skill_files.append(os.path.join(root, file))

print(f"Found {len(skill_files)} skills")

# Create component JSONs
component_paths = []
for skill_file in sorted(skill_files):
    # Read SKILL.md to extract frontmatter
    with open(skill_file, 'r') as f:
        content = f.read()
    
    # Extract name and description from YAML frontmatter
    name = os.path.basename(os.path.dirname(skill_file))
    description = ""
    
    # Parse YAML frontmatter
    if content.startswith('---'):
        match = re.search(r'---\n(.*?)\n---', content, re.DOTALL)
        if match:
            frontmatter = match.group(1)
            # Extract name
            name_match = re.search(r'^name:\s*(.+)$', frontmatter, re.MULTILINE)
            if name_match:
                name = name_match.group(1).strip()
            # Extract description
            desc_match = re.search(r'^description:\s*(.+)$', frontmatter, re.MULTILINE)
            if desc_match:
                description = desc_match.group(1).strip()
    
    # Create component JSON
    component = {
        "file": skill_file,
        "type": "text/markdown",
        "html": f'<div class="skill-component" style="border:1px solid #ccc; padding:10px; margin:5px; border-radius:5px;"><h3>{name}</h3><p style="font-size:0.9em; color:#666;">{description[:100]}...</p><p style="font-size:0.8em; color:#999;">{skill_file}</p></div>'
    }
    
    # Save component JSON
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', name)
    component_filename = f"{safe_name}.component.json"
    component_path = os.path.join(components_dir, component_filename)
    
    with open(component_path, 'w') as f:
        json.dump(component, f, indent=2)
    
    component_paths.append(component_path)

# Write input.json
input_json_path = '~/Documents/workspace/live-edit/canvases/hermes-skills/input.json'
input_data = {"components": component_paths}
with open(input_json_path, 'w') as f:
    json.dump(input_data, f, indent=2)

print(f"Created {len(component_paths)} component JSONs")
print(f"input.json updated at: {input_json_path}")
```

## Key Points

1. **All component file paths must exist** - The server watches all `file` fields, so they must point to real files
2. **Run with python3** (not .venv/bin/python which may not exist)
3. **Creates 103 skill components** from ~/.hermes/skills/
4. **Updates input.json** with all component paths

## Verification

After running, verify the server starts without ENOENT errors:

```bash
cd ~/Documents/workspace/live-edit
node server.js --input canvases/hermes-skills/input.json --output canvases/hermes-skills/output.json --port 3004
```
