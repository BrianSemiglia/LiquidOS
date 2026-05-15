# Live Canvas Component State Design

Use this skill when creating or updating Live Canvas components that need clear loading, resolved, empty, or error states.

The skill is portable. All examples needed to understand the patterns are local to this skill under `examples/`.

## Core Contract

1. Create or update the component inside the current canvas.

```txt
Current canvas:
canvases/home/

Create:
components/movie-showtimes/view.json
components/movie-showtimes/truth.json
```

2. Put the component view at `components/<component-name>/view.json`.
3. If the component has durable state, put that state in `components/<component-name>/truth.json`.

```json
// view.json
{
  "name": "Movie Showtimes near Somerville, MA",
  "type": "movie-card",
  "html": "<section><h1>Movie Showtimes near Somerville, MA</h1><p>Searching for theaters and showtimes...</p></section>"
}
```

```json
// truth.json
{
  "title": "Movie Showtimes near Somerville, MA",
  "state": "loading",
  "loadingText": "Searching for theaters and showtimes..."
}
```

4. Add the component path string to the canvas `input.json`.

```json
{
  "components": [
    "components/weather-somerville/view.json",
    "components/shows-somerville/view.json",
    "components/movie-showtimes/view.json"
  ]
}
```

`input.json.components` is always an array of string paths. Do not write inline component objects into `input.json`.

5. When the user is adding a component, create a new sibling component instead of overwriting an existing one.
6. Keep JSON valid and keep embedded HTML/scripts syntactically valid.

## Required Patterns

### Add the component to `input.json`

Create the component file first, then insert its path into the canvas manifest.

```json
{
  "components": [
    "components/weather-somerville.json",
    "components/shows-somerville.json",
    "components/movie-showtimes/view.json"
  ]
}
```

The important part is the insertion into the array. If the path is not in `input.json`, the canvas will not render the component.

### Keep truth and view separate

Treat `truth.json` as the source data and `view.json` as the decorated presentation.

Decorated component in `view.json`:

```json
{
  "name": "Movie Showtimes near Somerville, MA",
  "type": "movie-card",
  "html": "<section><h1>Movie Showtimes near Somerville, MA</h1><p>Searching for theaters and showtimes...</p></section>"
}
```

Raw state in `truth.json`:

```json
{
  "title": "Movie Showtimes near Somerville, MA",
  "state": "loading",
  "loadingText": "Searching for theaters and showtimes..."
}
```

The view should decorate the truth data. Do not make the view the only place where the real state lives.

### Callbacks

If a control should trigger follow-up work, put the prompt text in `truth.json` and mark the control with `data-live-prompt`.
The prompt should say which component needs the context, not just what action to take.

```json
// truth.json
{
  "buttons": [
    {
      "label": "Load more",
      "callbackPrompt": "Search for the next batch of movie theaters for Movie Showtimes near Somerville, MA and update canvases/home/components/movie-showtimes/view.json"
    }
  ]
}
```

```json
// view.json
{
  "html": "<button type=\"button\" data-live-prompt=\"Search for the next batch of movie theaters for Movie Showtimes near Somerville, MA and update canvases/home/components/movie-showtimes/view.json\">Load more</button>"
}
```

### Update in place

If the user is updating an existing surface, edit that component in place. If the user is adding a new thing, keep existing successful components visible and create a new sibling surface.

## Design Contract

The canvas is what the user sees. The component should communicate progress and outcomes directly in the UI.

Treat the component as a live UI surface, not a background crawl. Load lazily: show the first useful shell immediately, then add the next useful piece of UI or data as it becomes available.

Callbacks should be fast. Aim to fulfill each callback or user-visible request within 30 seconds. If that is not possible, keep the current loading state visible, surface the most useful partial result so far, and stop expanding the search unless the user explicitly asked for more.

Show the most useful stable content available, then place loading or error state exactly where the current operation is happening.

When creating or updating a component, keep the same component in place and update it progressively as you learn more. Start with the loading shell, then add resolved content, list items, sections, or details incrementally as soon as you have them.

If the task requires search or synthesis from multiple sources, update the same loading component progressively as results arrive. Prefer small in-place patches over waiting for the whole task to finish before showing anything new. This is especially important for search-like or list-building surfaces: show partial results as they arrive, then refine the same component until it is complete.

Once the requested component is complete enough to satisfy the user, stop. Do not keep exploring unrelated components, re-litigating the design, or doing extra validation unless the user explicitly asked for more refinement.

The motivation is attention: the user should not have to scan the whole view to understand the result of the thing they just did.

## State Rules With Examples

### Entity identity and state stay separate

Use the listing title as the title. Put loading or error state in the relevant content area.

```txt
Tufted Sofa 84” Mitchell Gold + Bob Williams
Loading listing details...
```

Motivation: the title tells the user what object they are viewing; the state tells them what is happening to it.

### Loading belongs where work is pending

If the user clicks a star, replace that star with a spinner. Leave the rest of the card stable.

Motivation: the spinner should answer “what is working?” without adding explanatory text somewhere else.

### One active operation gets one indicator

Refreshing results should put one spinner in the refresh button, not another spinner in the results list.

Motivation: multiple spinners imply multiple operations and create uncertainty.

### Region loading belongs inside the region

Opening a listing detail page can keep the listing title, price, location, image, and source visible while the detail content area loads.

Motivation: stable context keeps the user oriented while the unfinished region is clear.

### Preserve the last successful state

If a refresh fails, keep the previous results visible and show the refresh error locally.

Example:

```txt
Showing results from 10:42 AM
Couldn’t refresh Boston couch listings  [Try again]
```

Motivation: stale useful content is better than an empty error state.

### Recovery controls belong beside the problem

Put `Try again` next to the error it recovers from.

Motivation: related meaning should have related distance. If an action fixes an error, the user should not have to visually connect distant UI elements.

### Use inputs when recovery depends on preference

For no results, show editable search criteria near the no-results message.

```txt
No couches under $500 within 5 miles
Max distance [10 miles]
Max budget [$650]
[Search again]
```

Motivation: the user needs to choose the new criteria; fixed buttons are less useful than direct inputs.

### Show only actions the state can support

During detail loading, do not show `Contact seller` until the contact action is actually available.

Motivation: unavailable actions create false affordances.

### Group actions that target the same thing

`Open listing` and `Contact seller` belong together because both act on the same listing, and if either one is meant to trigger Hermes follow-up, it should be a `data-live-prompt` control with matching callback text.

Motivation: grouped actions make the target obvious and reduce visual wandering.

### Use arrow plus destination for back navigation

Use:

```txt
← Boston couches under $500
```

Not:

```txt
Back to Boston couches under $500
```

Motivation: the arrow already means back, so the variable destination gets the space and emphasis.

### Avoid narrated backend work

Use general truthful progress text:

```txt
Loading listing details...
```

Avoid claiming specific work unless it is actually happening and visible to the user.

Motivation: fake-specific progress text sounds confident but may not correspond to real work.

## Useful Component States

### Initial loading

Show the search context and one loading indicator.

Motivation: empty skeleton cards can preview layout, but they often become dead space before real results exist.

### Results ready

Show real resolved content and normal controls.

Motivation: resolved content should not explain itself; the listings are the answer.

### Refreshing

Keep current results visible and put the spinner on the refresh control.

Motivation: the current results remain useful, and the refresh control is where the user initiated the work.

### Saving

Replace only the clicked save/star control with a spinner.

Motivation: the user is watching the control they clicked; moving feedback elsewhere separates cause from effect.

### No results

Show the failed search context plus editable criteria and a search action.

Motivation: recovery depends on the user's preference.

### Refresh error

Keep prior results, show when they were last updated, and put retry beside the refresh error.

Motivation: the user knows what failed, whether visible data is stale, and how to recover.

### Detail loading

Keep known listing context visible and load only the detail content area.

Motivation: known context should remain stable while unknown details load.

### Detail loaded

Show complete details and group listing actions together.

Motivation: related actions should read as one action group.

### Detail error

Use the arrow destination for context and escape, then show a local retry action near the detail error.

Motivation: the destination label explains where the user came from and gives them a way out.

## Local examples

Study these examples before creating or changing component state behavior:

```txt
examples/boston-couch-search-real/
```

Important files:

```txt
examples/boston-couch-search-real/input.json
examples/boston-couch-search-real/components/01-initial-loading/view.json
examples/boston-couch-search-real/components/02-results-ready/view.json
examples/boston-couch-search-real/components/03-results-refreshing/view.json
examples/boston-couch-search-real/components/04-star-saving/view.json
examples/boston-couch-search-real/components/05-detail-loading/view.json
examples/boston-couch-search-real/components/06-no-results/view.json
examples/boston-couch-search-real/components/07-refresh-error/view.json
examples/boston-couch-search-real/components/08-detail-loaded/view.json
examples/boston-couch-search-real/components/09-detail-error/view.json
```

Use the examples for structure, state placement, callback wiring, and visual proximity.

Do not copy the couch domain unless the user is building a couch search surface. Generalize the patterns.
