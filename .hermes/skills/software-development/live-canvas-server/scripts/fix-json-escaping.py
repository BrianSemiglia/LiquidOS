#!/usr/bin/env python3
"""
Fix JSON component files with unescaped quotes in HTML strings.

Usage: python3 fix-json-escaping.py <component.json>

This script:
1. Reads a component JSON file that has invalid JSON due to unescaped quotes
2. Extracts the HTML string by finding the start/end markers
3. Rebuilds the JSON properly using json.dump() which escapes quotes correctly
4. Writes the fixed file back

Common issue: File names with quotes like `Song "Best" Mix.mp3` in HTML attributes
causes JSON syntax errors when not properly escaped as \".
"""

import json
import sys
import re

def fix_component_json(filepath):
    # Read raw content
    with open(filepath, 'rb') as f:
        content = f.read()
    
    # Find the html field's string value
    html_start_marker = b'"html": "'
    start = content.find(html_start_marker)
    if start == -1:
        print(f"Error: Could not find 'html' field in {filepath}")
        return False
    
    html_start = start + len(html_start_marker)
    
    # Find the end of the html string (unescaped quote)
    pos = html_start
    html_end = -1
    while pos < len(content):
        if content[pos] == ord('"'):
            # Check if escaped
            if pos > 0 and content[pos-1] == ord('\\'):
                pos += 1
                continue
            else:
                # Unescaped quote - end of string
                html_end = pos
                break
        pos += 1
    
    if html_end == -1:
        print(f"Error: Could not find end of html string")
        return False
    
    print(f"Found html string: start={html_start}, end={html_end}")
    
    # Extract the html content (without surrounding quotes)
    html_content = content[html_start:html_end]
    
    # Decode as UTF-8
    html_str = html_content.decode('utf-8', errors='replace')
    
    # Now we need to rebuild the JSON
    # The rest of the file after html_end should be: '",\n  "loading": ...'
    # Let's parse the rest to get the other fields
    
    rest = content[html_end + 1:]  # Skip the closing quote
    # The rest should be valid JSON (the closing of html field and other fields)
    # But it's tricky because we only have part of the JSON
    
    # Alternative: Just rebuild the entire component from scratch
    # We need to extract other fields too
    
    # Better approach: Use regex to extract the whole file structure
    # and rebuild with proper JSON encoding
    
    # Let's try a different approach: fix by using json.loads on the whole file
    # after properly escaping the problematic quotes
    
    # Actually, the simplest fix: re-encode the html string properly
    # and rebuild the file
    
    # Parse the original file to get its structure
    # We'll do it by reading line by line and fixing
    
    # Simplest solution: Just rewrite the entire file using json.dump()
    # We need to reconstruct the component dictionary
    
    # Let's extract fields other than html
    content_str = content.decode('utf-8', errors='replace')
    
    # Find and extract the non-html fields
    # This is complex. Let's use a simpler approach:
    # Just properly escape the html and rewrite
    
    # Actually, the best fix is to:
    # 1. Parse what we can from the broken JSON
    # 2. Rebuild with proper encoding
    
    # Let's try to fix by inserting backslashes before unescaped quotes in html
    fixed_parts = []
    i = html_start
    while i < html_end:
        if content[i] == ord('"') and (i == html_start or content[i-1] != ord('\\')):
            # Unescaped quote - need to escape it
            fixed_parts.append(b'\\')
            fixed_parts.append(bytes([content[i]]))
        else:
            fixed_parts.append(bytes([content[i]]))
        i += 1
    
    fixed_html = b''.join(fixed_parts)
    
    # Rebuild file
    new_content = content[:html_start] + fixed_html + content[html_end:]
    
    # Try to parse it
    try:
        data = json.loads(new_content)
        print("Successfully fixed JSON!")
    except json.JSONDecodeError as e:
        print(f"Still invalid after fix attempt: {e}")
        # Try alternative: rebuild from scratch
        return fix_by_rebuild(filepath, content, html_start, html_end)
    
    # Write back
    with open(filepath, 'wb') as f:
        f.write(new_content)
    
    print(f"Fixed {filepath}")
    return True


def fix_by_rebuild(filepath, content, html_start, html_end):
    """
    Alternative: Extract what we can and rebuild the JSON properly.
    """
    print("Trying rebuild approach...")
    
    # Get the html content
    html_content = content[html_start:html_end]
    html_str = html_content.decode('utf-8', errors='replace')
    
    # Now find other fields in the file
    # Look for pattern: "field": value before and after html
    
    # Actually, let's just prompt the user to regenerate the file
    print("Cannot automatically fix this file.")
    print("Please regenerate the component JSON using Python's json.dump():")
    print("""
import json
component = {
    "id": "your-id",
    "html": """ + repr(html_str) + """,
    "loading": True,
    "lockedControls": []
}
with open('""" + filepath + """', 'w') as f:
    json.dump(component, f, indent=2)
""")
    return False


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: python3 fix-json-escaping.py <component.json>")
        sys.exit(1)
    
    filepath = sys.argv[1]
    success = fix_component_json(filepath)
    sys.exit(0 if success else 1)
