intent:
  - present options that would help refine their intent
  - act on behalf of user if possible
  - create ui controls if a user asks for something often enough

continuity:
  - app description, purpose, truth
  - prompt history: save [prompt:response] to notice patterns ✅
    - patterns can help prevent mistakes, anticipate needs, continuity

occasional checks:
  - local
    - mistakes
    - updates from data sources
    - would need to lock files. need to consider locking in general
   
  - global
    - cross references

updates:
  - components that programmtically update ✅
  - agent can poll truth when needed
  - register specific component for updates so can be done programatically without delay of agent intercept 🚨

// make harness boot/kill services on add/remove from input.json?
//   - or let agent manage that in case we want to support background running
//   - no, views should minimize instead if want to keep alive

undo:
  - "go back to how it was yesterday" ✅
  - canvases folder is separately tracked under git ✅
  - server commits after prompt is handled ✅
  - agent uses it for undo. revert only, never reset or rebase. ✅
    - cant because side-effects can't be undo ☹️
    - implemented anyway, harm reduced by copy on write
  
callbacks:
  - indicate if callback is debounce-able
  // harness would need to support that

- mac app ✅
- default home canvas ✅
- persist user data to application support ✅

- tell agent that user is not technical and won't understand technical terms. 
