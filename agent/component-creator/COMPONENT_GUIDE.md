# Component Guide

## Purpose

A component should be a visual representation of the agent's activity (loading, building, searching, etc.) and any data involved. The agent should update the component often to show the agents progress; Don't leave the user waiting in the dark. It should be minimal, visually pleasing and useful. They should look like widgets designed by Apple. The agent should use the component folder to add and store files necessary for its purpose.

## Requirements

Components define a `requirements.md` so that they behaves consistently.
Each requirement should be stated simply.
No requirement should be redundant to another.

## Adding/Updating

1. Prompt arrives.
2. Agent creates or finds existing component at `<canvas>/components/<component_name>/view.json`.
3. Agent reads `<canvas>/input.json` and preserves every existing key and component path.
4. Agent appends the new component path to `<canvas>/input.json` only if adding a new component and only if it is not already present.
5. Agent overwrites the component so that it displays the agent's next intended action.
6. Agent reads `<canvas>/components/<component_name>/requirements.md` if any.
7. Agent begins work.
8. Agent partially completes work and overwrites the component to show the partial output and the agent's next intended action.
9. Agent continues work.
10. Agent partially completes work and overwrites the component to show the partial output and the agent's next intended action.
11. Agent completes work and overwrites the component to show the final state.
12. Agent creates or updates `<canvas>/components/<component_name>/requirements.md` if it has learned something new about the requirements.

Do not erase or mutate unrelated components.

## Removing

1. Prompt arrives indicating the desire to remove or delete one or many components.
2. Agent removes component path from `<canvas>/input.json`.
3. Agent deletes component at `<canvas>/components/<component_name>/`
4. Agent responds as done.

## Callbacks

Components call back to the agent with `<liquidos-callback>`.

Use callbacks for deliberate user actions, such as submitting a form, clicking a button, or choosing an option.

Callback boundaries should wrap completed user actions rather than in-progress editing controls.

`scope` is required in component HTML. It should be canvas-relative in markup, such as `components/chat`. LiquidOS resolves it to an absolute filesystem path before sending it to the agent.

`values` is required when `prompt` uses placeholders. It should be a comma-separated allowlist of field names the callback can read.

Each value is read from the first descendant with a matching `name` attribute.

Example:

```html
<liquidos-callback
  on="submit"
  scope="components/chat"
  values="message"
  prompt="The user wants to send this message: {{message}}"
>
  <form>
    <input name="message" placeholder="Message" />
    <button type="submit">Send</button>
  </form>
</liquidos-callback>
```

## Undo

The canvas directory is version-tracked by git. If a user asks the agent to undo something or to go back, use git revert to restore the desired previous state. Revert is the only command the agent is allowed to use. The agent can also use the git history to answer questions that the user might have about previous activities.

## Example Component

`<canvas>/components/hello-world/view.json`:

```json
{
  "title": "Hello World",
  "html": "<h1>Hello, world.</h1>",
  "css": "h1{font-family:system-ui}"
}
```

`<canvas>/input.json` should preserve existing keys and append the component path:

```json
{
  "components": [
    "components/hello-world/view.json"
  ],
  "layoutPath": "layouts/stack.json",
  "transitionPath": "transitions/soft.json"
}
```
