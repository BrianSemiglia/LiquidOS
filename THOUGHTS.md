intent:
  - present options that would help refine their intent
  - act on behalf of user if possible
  - create ui controls if a user asks for something often enough

continuity:
  - app description, purpose
  - prompt history: save [prompt:respone] to notice patterns
    - patterns can help prevent mistakes, anticipate needs, continuity

occasional checks:
  - local
    - mistakes
    - updates from data sources
   
  - global
    - cross references

updates:
  - register specific component for updates so can be done programatically without delay of agent intercept

undo:
  - "go back to how it was yesterday"
  - use automerge to version control
  
// make harness boot/kill services on add/remove from input.json?
//   - or let agent manage that in case we want to support background running
//   - no, views should minimize instead if want to keep alive

callbacks:
  - indicate if callback is debounce-able
  // harness would need to support that
