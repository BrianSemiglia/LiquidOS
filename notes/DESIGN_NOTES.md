# Design Notes — Canvas Architecture

Captured from a conversation on 2026-05-29. Companion to `THOUGHTS.md`.

The big picture you described: a **live canvas** an **AI agent authors at runtime**
(no recompile), with **isolated components** that **know the least possible about the
harness**, while still allowing the agent to **read across components** and modify one
in reaction to another.

---

## 1. Component isolation options

"Isolation" is not one thing — it spans several independent axes:

- style (CSS leak in/out)
- DOM encapsulation (can the host `querySelector` in)
- JS / global scope
- security / trust boundary (untrusted code)
- crash / fault isolation

Different techniques cover different subsets. They are **not mutually exclusive** —
you can mix per axis or per-component-class (e.g. trusted built-ins in Shadow DOM,
agent-authored arbitrary ones in sandboxed iframes).

The menu, roughly weakest → strongest isolation:

| Option | Isolates | Component still just HTML? | Harness coupling |
| --- | --- | --- | --- |
| **Today** (string into shared DOM) | nothing (conventions only) | yes | implicit, high (CSS/JS collide) |
| **CSS `@scope` / build-time scoping** | style only | yes | ~none |
| **Declarative Shadow DOM** (`<template shadowrootmode>`) | style + DOM | yes | ~none |
| **Custom Element + Shadow DOM** | style + DOM + lifecycle | no (ships JS) | medium (element contract) |
| **iframe `srcdoc`** (inline HTML) | style + DOM + JS + crash | yes (a tiny HTML doc) | small, explicit `postMessage` protocol |
| **Sandboxed / cross-origin iframe** | all of the above + trust | yes | small, explicit `postMessage` protocol |
| **Separate WKWebViews** (native) | full process-ish | yes | heavy |

Clarification: **"Web Components" is the umbrella**, not a peer of Shadow DOM. WC =
Custom Elements + Shadow DOM + `<template>`. Shadow DOM is the part that actually
isolates.

### "Least knowledge of the harness" — the twist

Today components know nothing *explicitly* but are *implicitly* coupled (shared CSS,
dead inline scripts, the bespoke `<liquidos-callback>` element). A real boundary
replaces that implicit mess with one small **standard** contract:

- **Declarative Shadow DOM** → contract is essentially nothing ("I'm an HTML fragment,
  you slot me into a shadow root"). Cheapest fix to the CSS leakage you've been
  namespacing around. Keeps it 100% HTML-first. Caveat: same JS context, no crash
  isolation, inline scripts still don't run.
- **iframe `srcdoc` + minimal postMessage** → small explicit contract (height,
  callbacks, data in). Gets you the full set including **working live JS**, which
  today's model can't do at all. Aligns with the skill's existing "render.js serves
  /view; the view calls back" idea.

The fork: do components need to run their own live JS, or host untrusted code?
If mostly "stop them breaking each other's styles" → declarative Shadow DOM. If
"genuine live mini-apps, possibly untrusted" → sandboxed `srcdoc` iframes.

You're not married to HTML — none of this requires leaving it. The real choice is
**where the boundary is**, not the authoring language.

---

## 2. What's already in the codebase

These were ideas I almost re-pitched before reviewing — they exist:

- **Snapshot + rollback** — `canvas/git-timeline.js` + `canvas/activity-persistence.js`.
  Whole `.liquidos` workspace is one git repo; server commits after every prompt and
  on failure/shutdown; messages encode Event / Scope / Agent Response. Agent undoes
  via `revert` only (never reset / rebase). You already noted the real limit yourself:
  *side-effects can't be reverted* (mitigated by copy-on-write).
- **Job queue with per-component lanes + write-lock + crash recovery** —
  `canvas/output-queue.js`. `output.json` is the queue; `outputJobKey` derives a
  per-component / canvas lane; `withOutputLock` serializes writes; running→pending
  normalization recovers in-flight jobs after a crash. Lane scaffolding exists but
  `dispatchableJobs` currently returns `[]` whenever **any** lane is active, so
  dispatch is effectively **single-flight globally** today — per-lane concurrency is
  a near-term unlock.
- **In-flight UI containment** — `canvas/callback-element.js`. `<liquidos-callback>`
  wraps any control, marks the subtree `inert`, and pulses until the agent responds.
  No per-control special-casing.
- **`output.json` bridge + plugin/watcher pattern** — README documents the contract,
  including loop-safety guidance (suppress self-caused changes) which is literally
  the self-trigger bug class hit during the canvas-component watcher work.
- **Prompt / response history + restore-context blocks** for continuity
  (`activity-persistence.js`).
- **Repair card** when canvas input is damaged (`/input` renders a repair card rather
  than crashing).
- **Multiple agent runtimes** (claude / codex / hermes / pi) behind a common interface.

---

## 3. Genuinely additive ideas

### 3.1 Two loops: reflex vs. deliberation

You have a **deliberation** loop (the agent) and a **reflex** loop (watchers,
`render.js` services, `output.json`). Your 🚨 note in `THOUGHTS.md` — *"register a
specific component for updates so it can be done programmatically without the delay
of the agent intercept"* — is the request to route more changes through the reflex
loop.

Missing piece: a **declarative subscription** per component (e.g. "re-render when
data X changes", "when component Y emits event Z"), read by the harness to wire a
direct **data → view** path. The agent only handles changes that need *judgment*;
anything expressible as a dependency never pays an LLM round-trip. This is the
single highest-leverage open thing. Stays low-coupling because the subscription is
data, not harness API calls.

### 3.2 Concurrency by data layout, not locks

Your note: "need to consider locking in general." `output.json` has a write-lock,
but component data files don't.

Instead of adding mutexes, lean into **single-writer-per-file** (which the per-result
`<slug>.yaml` / `<slug>.image` design already gives you) — parallel writers never
touch the same file, so there's nothing to lock.

Pair it with a clean invariant:

> **The agent writes *source* (data / config). Services own *derived* (`view.html`).**

That alone removes agent-vs-service write conflicts and matches what we ended up
building.

### 3.3 Capabilities to gate what undo can't fix

Your ☹️ note: side-effects can't be reverted. The complement to undo is *prevention*.

A per-component **capability declaration** — network? persistent writes? spawn a
service? talk to component Y? — that the harness enforces *before* the action runs.
Undo handles canvas state; capabilities handle the irreversible stuff.

### 3.4 One manifest for four open items

A small declarative per-component contract:

```
reads: ...           # what data files / components it consumes
subscribes-to: ...   # reflex-loop dependencies (§3.1)
capabilities: ...    # what the harness allows it to do (§3.3)
exposed-controls: ...# user-facing controls (callbacks)
```

This single artifact would simultaneously power:

- **validation** — refuse anything the manifest doesn't declare
- **reflex subscriptions** — §3.1
- **capability enforcement** — §3.3
- **"create a UI control if the user asks often enough"** — agent promotes a
  recurring intent (from saved prompt history) into a declared control in the
  manifest

One artifact, four wins, and the agent can author it because it's data.

### 3.5 Per-lane concurrency

Flipping `dispatchableJobs` from "stop if any lane is active" to true per-lane
concurrency is the near-term unlock for parallel-component work, and pairs naturally
with §3.2's single-writer files.

---

## 4. Dispatch — per-component subagent design

Two things are bundled in the question "dispatch the same component prompt to the
same subagent, possibly canceling the first." Separate them; one is mostly built and
the other is the real design work.

### 4.1 Affinity / routing by component ID — mostly done

`outputJobKey` already derives a per-component lane. Jobs already carry
`componentKey` / `componentPath` / `scope`. What's missing for affinity:

- **Session continuity**: keep a registry `laneKey → { sessionId, currentJobId,
  abort }`, and on the next prompt **resume that session by ID** instead of starting
  a fresh agent. Warm context, no re-reading the component, cheaper.
- You don't need a *live* agent parked per component. A **resumable session keyed by
  ID** gets the same continuity without N idle processes; a live worker only exists
  while something is running.

### 4.2 Cancel vs. queue — the real new decision

Today: a second prompt for the same component *waits* (and dispatch is single-flight
globally anyway). What you described is **latest-wins / preempt**.

- **Replace** (latest-wins) is right for *superseding* intent — user changed their
  mind, or a control fires rapidly. It's literally the task-level version of your
  `THOUGHTS.md` line *"indicate if callback is debounce-able."*
- **Queue** is right for *additive* edits — two valid sequential changes.

The design: **per-lane policy `{ queue | replace }`**, set either by the main agent
when it classifies the prompt or declared on the callback / component manifest.

### 4.3 The hard part: mid-flight side-effects

Routing is easy. Cancellation is hard because killing a subagent mid-way can leave
partial writes, spawned services, or external calls behind — and git can revert
canvas state but not side-effects.

Two things make preemption safe:

- **Source-vs-derived + single-writer invariant** (§3.2): if the subagent only writes
  *source data* and `render.js` derives the view, a canceled job leaves a
  partial-but-still-valid dataset the reflex render can display coherently. No torn
  UI.
- **Auto-revert the lane to its last-good commit** on cancel (you commit per prompt
  already), so canvas state is clean. External side-effects remain — which is exactly
  where the capability gating (§3.3) earns its keep: gate the irreversible stuff
  *before* it runs.

### 4.4 Mental model

The clean mental model is the **actor model**: each component is an actor with a
mailbox; messages serialize to it; a new message either *queues* or *preempts* the
current one. Your lanes are already actor-mailboxes in spirit — you'd be adding
*preemption* + *session identity*.

### 4.5 Open feasibility questions

Worth checking before designing further:

- Do the runtimes in `agent/*-runtime.js` support **resuming a session by ID**?
- Do they support **aborting a run mid-flight** (cooperative cancel)?

Those two hooks are the whole ballgame. Everything else is queue policy on
scaffolding you already have.

---

## 5. Summary of the design rules that emerged

- **Authoring artifact is data, not markup, wherever possible.** Lower blast radius,
  still no recompile (HTML wasn't doing that work for you specifically — *any*
  declarative artifact interpreted at runtime is build-free).
- **Single writer per file.** Concurrency by layout beats locks.
- **Agent writes source; services derive views.** Removes the obvious write conflict.
- **Reflex loop for data dependencies; agent for judgment.** Don't pay an LLM
  round-trip for what a subscription can do.
- **Capabilities for the irreversible stuff** — undo handles state, capabilities
  handle side-effects.
- **Lanes are actors.** Per-component identity, per-lane policy (queue vs replace),
  resumable session by ID.
- **Pick the boundary, not the language.** Shadow DOM and iframes are about where
  isolation is enforced, not whether you keep HTML.
