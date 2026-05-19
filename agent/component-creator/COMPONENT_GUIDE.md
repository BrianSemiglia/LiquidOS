# Component Guide

// TODO: agent can create temporary components to show activity, if scope is zero or many components
// TODO: canvas - layout, transition, style
// TODO: copy on write ✅
// TODO: revert just component, not whole timeline
// TODO: feeding back to the user: what part is the agent changing? show indicator there ✅
// TODO: the user cannot see the agent's text output. only components. if the agent has a question show a component with a way for the user to answer. ✅
// TODO: serve files so HTML can read/edit

## Canvas Writing

The agent may make changes to the canvas/desktop.
The agent can create components that can change the canvas/desktop.

## Feeding Back to the User

The user does not see the agent's text output.
They see a desktop of components and a prompt field.
The agent has the potential to be busy for minutes so it's important to communicate to the user what progress is being made.
The agent should show its activity in the part of the scope that it is updating (eg Updating items shows spinner in place of items)
Showing activity is also a means of locking parts of the scope that are being changed so that state changes aren't badly overwritten by agent output.
If the agent has a question, it should show a component with a way for the user to answer.

## Writing

The agent can write to anywhere in the working directory but nowhere else without the user's consent.
If the user asks the agent to change something outside, the agent will copy the resource to the workspace before mutating.
If the user asks the agent to change something outside that can't be copied, the agent will request the user's consent and optionally explain any danger.

## Purpose

A component should be a visual representation of the agent's activity (loading, building, searching, etc.) and any data involved. 
The agent should update the component often to show the agent's progress; the agent should not leave the user waiting in the dark. 
The component should be minimal, visually pleasing and useful. 
Components should look like widgets designed by Apple. 
The agent should use the component folder to add and store files necessary for its purpose.

## Anatomy

<canvas>/components/<component-name>/
  view
  truth
  functions
  feature-requirements.md

## Views

Component views should be built to listen-to/render a source of truth (function, disk, network, etc) so they stay synchronized.
This allows for the agent to simply make changes to the truth in order to update the view.
Maintaining user data is important. Use git revert to undo mistakes.

## Truth

Truth should be some storage (json, sql, etc) of any user data and/or view/service state.
If the shape of data changes, the agent should migrate the truth, view, service.

## Feature Requirements

Components define a `feature-requirements.md` so that they behaves consistently.
Each requirement should be stated simply.
No requirement should be redundant to another.
Requirements are not for technical details.

## Adding/Updating

1. Prompt arrives.
2. Agent creates or finds existing component at `<canvas>/components/<component_name>/view.json`.
3. Agent reads `<canvas>/input.json` and preserves every existing key and component path.
4. Agent appends the new component path to `<canvas>/input.json` only if adding a new component and only if it is not already present.
5. Agent overwrites the component so that it displays the agent's next intended action so that the user is informed.
6. Agent reads `<canvas>/components/<component_name>/requirements.md` if any.
7. Agent begins work.
8. Agent partially completes work and overwrites the component to show the partial output and the agent's next intended action so that the user is informed.
9. Agent continues work.
10. Agent partially completes work and overwrites the component to show the partial output and the agent's next intended action so that the user is informed.
11. Agent completes work and overwrites the component to show the final state so that the user is informed.
12. Agent creates or updates `<canvas>/components/<component_name>/requirements.md` if it has learned something new about the requirements.

Do not erase or mutate unrelated components!

## Removing

1. Prompt arrives indicating the desire to remove or delete one or many components.
2. Agent removes component path from `<canvas>/input.json`.
3. Agent deletes component at `<canvas>/components/<component_name>/` (skip this if user asked to hide component).
4. Agent responds as done.

## Callbacks

For functionality that can be achieved programmatically and is expected to finish quickly, use Programmtic Callbacks. 
For functionality that would benefit from the dynamism or intelligence of an agent, or if the building of something can be deferred until interacted with use Prompt Callbacks.

### Programmtic Callbacks

Example:

view.json
```{
  "html": "<section><input type=\"text\" value=\"Foo\"><button>Run</button><output></output></section>"
}```

functions.js
```export const mount = root => {
  const foo = value =>
    root.querySelector("output").textContent = value

  root.querySelector("button").addEventListener("click", () =>
    foo(root.querySelector("input").value)
  )

  return {
    destroy() {}
  }
}```


### Prompt Callbacks

`<liquidos-callback>`
Custom HTML element used to declare an agent callback action

`prompt`
The action performed and/or the user's intent

`values` 
Required when `prompt` uses placeholders. 
It should be a comma-separated allowlist of field names the callback can read.

`scope` 
The path of the thing calling back. 
It should be canvas-relative in markup, such as `components/chat`. 
LiquidOS resolves it to an absolute filesystem path before sending it to the agent.

Example:

```html
<liquidos-callback
  on="submit"
  scope="components/chat"
  values="message"
  prompt="User wants to send this message: {{message}}"
>
  <form>
    <input name="message" placeholder="Message" />
    <button type="submit">Send</button>
  </form>
</liquidos-callback>
```

## Undo

The canvas directory is version-tracked by git. Use the git history to get more context if needed. If a user asks the agent to undo something or to go back, use git revert to restore the desired previous state. Revert is the only command the agent is allowed to use. The agent can also use the git history to answer questions that the user might have about previous activities.

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
