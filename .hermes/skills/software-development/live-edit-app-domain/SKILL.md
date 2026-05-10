---
name: live-edit-app-domain
description: Canvas rules, AGENT_PROMPT, component model, user-only-sees-canvas rule, and output schema standards for the live-edit project.
---

# Live Edit App Domain Skill

## Core Rules
- Canvas rules
- AGENT_PROMPT conventions
- Component model
- User-only-sees-canvas rule

## AGENT_PROMPT Conventions

The AGENT_PROMPT is defined in server.js (line ~44) as a joined array of instruction strings passed via `--agent-prompt` CLI arg.

**Key design decisions:**
- **No loading state writes**: Do NOT instruct the agent to write intermediate "loading" states to component JSON. The agent should process and write final results directly. Loading state instructions were removed (2026-05-08) to simplify the agent workflow.
- **Two-phase instruction pattern** (if needed): If you DO want multi-phase behavior, use explicit phase separation. But prefer single-phase (process → write result) for speed.
- **Keep it fast**: Instructions emphasize speed and simple solutions unless task is complex. The prompt drives UI responsiveness.

**What to include:**
- Scope rules (component vs canvas scoped requests)
- File editing permissions and restrictions
- JSON validity requirements
- User-facing labeling rules (avoid meta words like "realize", "materialize", "agent")
- The "user ONLY sees the canvas" rule

**What to exclude:**
- Loading state management (removed)
- Overly complex multi-phase workflows
- Instructions that slow down simple tasks

## Output Schema Standards (2026-05-08 Update)
Current `output.json` schema for live-edit app (consolidated):
- Removed redundant fields: `request` (duplicate of `prompt`), `response`, `inputPath`, `componentPath`, `canvasPath`
- `scope` field now holds full target path:
  - Canvas jobs: `scope: <CANVAS_PATH>` (e.g., `~/Documents/workspace/live-edit/canvases/test-canvas`)
  - Component jobs: `scope: <COMPONENT_PATH>` (component's file path)
- `isCanvasPrompt` logic: `!Object.hasOwn(body, 'target') && !Object.hasOwn(body, 'componentIndex')` (canvas prompts lack `target`/`componentIndex` fields)

## Workflow Rule
When modifying live-edit schema, avoid unrelated UI changes (e.g., right-click context menus) unless explicitly requested. Focus on scope-related modifications first per user preference.
