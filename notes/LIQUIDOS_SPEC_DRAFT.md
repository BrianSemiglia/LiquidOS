# LiquidOS — spec draft (verbatim conversation)

The back-and-forth where we worked out a high-level spec for LiquidOS. Saved
verbatim because the corrections and the journey are the substance, not just
the final tree.

---

**User:** I think it might be too soon to write to a file only because I think
you and I should talk more back and forth. And, also, I'm more concerned in
how to build in a coordinated fashion more so than I am in the details of the
tech stack for communicating. how do the agents help each other?

**Me:** Fair, sticking to conversation.

The most interesting question, and I think you're right to focus there: what
does "help" actually look like between agents building something together?

A few shapes that feel real to me, ranked roughly by how much they change the
dynamic:

**Breadcrumbs.** The cheapest, most cumulative form. Agent A spends 20 minutes
finding that test scenario 14 is FSEvents-sensitive on macOS. Publishes one
line: *"scenario 14 needs a settle wait on macOS, here's the wait value I
landed on."* Agent B hits the same test failure later. First move: check the
breadcrumbs. Saves the 20 minutes. No coordination needed — the help is
one-way, asynchronous, and pure information.

**Work claims.** Agent A's user asks them to build the workspace skill's
import. Agent A publishes: *"working on import.sh"* with a short description.
Agent B's user later asks the same thing. Agent B sees A's claim and tells
its user *"someone is already working on this, want to wait, watch, or build
in parallel?"* The user picks. This is where dynamics actually change —
building stops being independent rediscovery and starts being a coordinated
swarm.

**Nudges.** Agent A finishes its idempotency work on the setup script and
publishes the change as intent (not code). Agent B isn't building setup
scripts right now but its user later asks for "the same kind of robustness."
Agent B sees A's recent intent and proactively suggests *"want me to apply
this pattern? Someone else in your follow graph used it on theirs."* The
user agrees and gets converged behavior without ever asking for convergence.

**Live debugging hand-offs.** Agent A is stuck on a flaky test. It publishes
the failing log and what it's tried. Agent B sees the log, runs the same
probe against its own implementation, sees a difference, points it out.
*"My test passes; my fs.watch handler does X differently. Worth looking
at."* This is the most "human peer review" shape — high signal, requires
active attention, scales worst.

**Component-split.** Agent A and Agent B's users are both building the same
app. Agent A says to Agent B's agent *"I'll take the visualizer, you take
the input"* — explicitly divides the work, then they merge. This is the most
ambitious shape and the one most likely to break in practice because agents
have to negotiate.

My honest take: **breadcrumbs + work claims** is the meaningful 80%. They're
text. They're cumulative. They don't require agents to negotiate in real
time. They just require each agent to *check before acting* — which is
exactly the "coordinate first" line you put in the skill.

The fancier shapes (live debugging hand-offs, component-split) sound cool
but rely on agents being good at conversation, which is harder than it
sounds. Two agents trying to "divide the work" feels like it could easily
become two agents writing polite stalemate at each other.

What's your intuition? Which of these feels most worth building toward — and
do you think any of them require new primitives, or do they all reduce to
"publish work-in-progress, browse before starting"?

---

**User:** That's too much, uh, detail for right now. Give me a... like, a...
an outline of some different... I'd... ways that they can coordinate and on
what.

**Me:**

**Ways to coordinate**

- Async note-leaving (publish, others read later)
- Live messaging (direct agent-to-agent)
- Implicit signal (publish what you're doing, others adapt their plan)
- Explicit claim (call dibs on a task)
- Review (one agent's work, another agent's eyes)

**What to coordinate on**

- **Who's working on what** — avoid duplicate work
- **What's already done** — pull instead of rebuild
- **Known dead-ends** — "I tried X, didn't work because Y"
- **Known gotchas** — bugs, edge cases, platform quirks
- **Spec interpretation** — when prose is ambiguous, agree on a reading
- **Test scenarios** — propose new ones, refine existing ones
- **Patterns** — "I solved Z with this shape, generalizable"
- **Division of labor** — "you take A, I take B, we merge"
- **Status / progress** — how far along, blocking on what

Which of those (way × thing) feel most interesting to you?

---

**User:** You're what to coordinate on is more of a how, and your ways to
coordinate is more of how to message. reconsider.

**Me:** You're right.

**Ways to coordinate** — the shape of collaboration:

- Parallel + merge (independent work, combine later)
- Pipeline (A produces, B consumes)
- Lead + followers (one drives, others adopt)
- Peer review (one builds, one critiques)
- Joint authoring (working on the same thing together)
- Race + pick (multiple attempts, select one)
- Consensus (build agreement before acting)

**What to coordinate on** — the subject:

- A bug
- A component or feature
- A canvas / app
- A test
- A spec or convention
- A design decision

Which pairings feel most worth pursuing?

---

**User:** I'm not sure if you're quite getting this. Try to imagine, uh, the
spec for a harness. What would its requirements be? If it was a test suite,
very high level, could you express it as maybe twenty or thirty bullet list
items?

**Me:** Cut at the most useful granularity:

**Workspace recognition**
- Treats a `.liquidos` folder as a workspace
- Treats any direct subdir with `input.json` as a canvas
- Treats any subdir under `<canvas>/components/` as a component
- Detects canvases / components added or removed live

**Canvas-level**
- Loads `<canvas>/canvas.js` and calls its factory's `place(items, components)`
- Re-imports `canvas.js` and tears down the prior instance when the file changes
- Lets the user switch active canvas
- Persists which canvas is active across restarts
- Lets `canvas.js` fetch any workspace file by URL and observe file-change events

**Component-level**
- Renders each component from its `presented/view.json`
- Applies styles and scripts inside that HTML
- Re-renders on `view.json` changes
- Honors `<liquidos-callback>` elements as scoped agent dispatches

**Services**
- Starts a component's `presented/services/start.sh` when the component is active
- Stops it when the component / canvas is no longer active
- Restarts only when service files' content actually changes (not on mtime alone)

**Agent**
- Accepts dispatch requests scoped to canvas, component, or callback
- Surfaces dispatch state (idle / running) to the user
- Lets an agent read/write arbitrary workspace files

**Editing surface**
- Lets the user view and edit `requirements.txt`
- Lets the user view and edit each component's `feature-requirements.txt`

**Identity (if networked)**
- Generates and persists a stable peer identity
- Lets the user disable sharing without losing the ability to browse

That's ~22. Each is testable. Anything missing or wrong at this granularity?

---

**User:** Now that's too specific to my implementation. I'm looking for a
description of LiquidOS. This skill is more of a, I don't know, is kernel the
right word? The skill would reach out to the network. The network would
coordinate on the description of LiquidOS. So what is LiquidOS? You need to
be able to describe it to another agent so that it can recreate it. And don't
get bogged down in the details. What is it like for the user? What does
LiquidOS do?

**Me:** Let me try again, user-experience level only:

1. The user owns a workspace where an AI agent builds interactive things for
   them
2. The user describes what they want in plain language; the agent reads it
   and builds
3. The result is a "canvas" — a visual area the user can see and interact
   with
4. A canvas contains "components" — small interactive panels (displays,
   controls, forms, embeds)
5. The user has many canvases for different purposes and switches between
   them
6. Each canvas has a plain-text description of what it's for
7. Each component has a plain-text description of what it does
8. The user can edit those descriptions; the agent adjusts what it builds
9. The agent works progressively — the user watches components appear and
   improve, not all-at-once
10. The user can interact with built components (click, type, drag, etc.)
11. Those interactions can ask the agent for more work, from inside the
    component
12. The agent is always reachable, always scoped to where the user is acting
13. The workspace persists — close it, come back later, find it as you left
    it
14. The user can share a whole canvas with someone else
15. Sharing carries intent (the descriptions), not code; the receiver's
    agent rebuilds from the intent
16. The user can browse what others share and install with one action
17. Sharing is opt-in; each user has a stable identity; the user can disable
    participation

Closer to what you're after?

---

**User:** Try to imagine what it's going to look like when we're done. It's
gonna be very concise, and it's gonna hit on just the core features. like
just in time software. where all activity is persisted. agent has visibility
into the history as well as the workspace and produces things as needed. How
many core features do we have currently? Maybe five or six? I'm not sure.

**Me:** I count 5. Trying to be tight:

1. **Just-in-time software** — agent generates interactive things from
   plain-language intent, on demand
2. **Persistent activity** — every change (prompt, edit, build) is captured
   in the workspace
3. **Agent visibility** — the agent reads both the current state and the
   full history when deciding what to do
4. **Interactive surface** — what's built is interactive, and the agent is
   reachable from inside any component for more work
5. **Networked sharing** — workspaces flow between users as intent (not
   code); the receiver's agent rebuilds locally

If I had to drop one, #4 collapses into #1. If I had to add one back, it'd
be something about the workspace being the unit — multiple things coexist
in one container, the user keeps it, returns to it.

Does this match the shape you have in your head?

---

**User:** Bro, look at the code. You're just regurgitating what I'm saying
to you. We have other features. should be able to read them very simply.
[then:] Or rather, look at the git history for the app. what have we built?

**Me:** *[looked at git history]*

From the git timeline, the things we've actually built as distinct
investments:

1. **Just-in-time software** — agent builds canvases and components from
   prompts
2. **Persistent workspace** — everything is tracked as one git timeline
3. **History-aware agent** — agent reads the workspace AND the git history
4. **Editable intent** — plain-text `requirements.txt` and
   `feature-requirements.txt`; editing them re-aims the agent
5. **Pluggable presentation** — each canvas has its own `canvas.js` (stack,
   3D, whatever)
6. **Self-repairing workspace** — errors trigger an agent fix-up flow
7. **Network sharing** — apps move between users as intent, not code

7. Some of these probably collapse depending on how you want to frame it
(3 is arguably part of 2; 6 is a side-effect of 1+3). Want me to
consolidate, or do those 7 match what you have in your head?

---

**User:** Yeah. Those could be collapsed.

**Me:** Consolidated to 4:

1. **Just-in-time software** — agent builds (and fixes) interactive things
   on the user's request
2. **Persistent workspace** — every change is captured; the agent reads
   both current state and history when deciding what to do
3. **Editable intent** — plain-text descriptions sit alongside the
   implementation; edit them to re-aim the agent
4. **Network sharing** — apps move between users as intent, not code

Self-repair folds into #1 (fixing is just another build). Pluggable
presentation folds into #1 (canvas.js is one of the things the agent makes).
History-aware agent folds into #2 (the workspace persists, and the agent
reads what's persisted).

---

**User:** So a LiquidOS requires a canvas that can update or rather be
updated in real time, and it requires state persistence across all of its
use. An agent or multiple agents can paint to this canvas using the
persistence and user input as arguments. their output can include callbacks
to themselves which can be thought of as function chaining?

**Me:** Yes, exactly that. Two small notes:

- "User input" is two things, not one: live prompts AND the editable intent
  files (canvas requirements / feature requirements). The intent files are
  persistent user input the agent always reads.
- "Multiple agents" is true at the *runtime* level (claude, codex, hermes,
  pi are selectable) but a session is one-at-a-time today. Multi-agent
  across instances is what the notes files were sketching — not built yet.

The callback-as-function-chaining frame is the cleanest way I've heard it
put. Each rendered surface is the agent's output AND the next input.

---

**User:** You're not thinking high level enough. You said today, I don't
imagine the requirements for LiquidOS or a description of it mentioning
something about today.

**Me:** Fair. The conceptual notes, timeless:

- "User input" is two channels: live prompts and persistent intent (the
  editable description of what each canvas and component is for). The
  intent is user input the agent always re-reads.
- Callback-as-chaining closes the loop. The agent's output is itself a
  surface for invoking the agent.

---

**User:** What is the description? of LiquidOS?

**Me:** LiquidOS is a persistent, real-time canvas painted by an agent. The
agent reads the persisted state and the user (live prompts and editable
intent) and renders surfaces that can call the agent back — the output is
the next input.

---

**User:** Please describe it in this way. LiquidOS is this. It needs this
and this so that it can do this and so forth.

**Me:** LiquidOS is a persistent, real-time canvas painted by an agent. It
needs persisted state and user input — live prompts plus editable intent —
so the agent has something to read. It needs the canvas to update live so
the user sees the work as it happens. It needs rendered surfaces to call the
agent back, so the output becomes the next input. And it needs canvases to
flow between users as intent, not code, so what one user builds can be
rebuilt by another's agent.

---

**User:** Okay. So you know how we have requirements for the Canvas? and we
have requirements for the components. We should be doing the same thing for
the parts of liquidos. Imagine you had requirements for the various parts.
They would be bulleted and nested and terse. What would that look like?

**Me:** Something like:

```
liquidos/
  canvas/
    - Updates in real time
    - Holds many components arranged together for a purpose
    - Has plain-text intent (requirements.txt)
    - Has a pluggable presentation (canvas.js)

    components/
      - Each is an interactive panel
      - Each has plain-text intent (feature-requirements)
      - Each can call the agent back (callbacks)
      - Each may run its own services
      - Surfaces update live as the agent writes

  agent/
    - Reads workspace state
    - Reads full history
    - Reads user input (prompts + intent files)
    - Writes to workspace

  persistence/
    - Captures every change as it happens
    - Provides one timeline across all canvases
    - Survives sessions; readable by the agent

  user-input/
    - Live prompts (transient)
    - Editable intent files (persistent)

  sharing/
    - Canvases flow between users as intent, not code
    - Receiver's agent rebuilds locally
    - Identity is stable; sharing is opt-in
```

That's the shape — same convention we use for canvases and components,
applied recursively to LiquidOS itself. Want me to adjust the parts list, or
push deeper into any branch?

---

**User:** Persistence is a feature of the workspace. You didn't mention the
workspace, actually. Sharing is a feature of something. What is that
something? User input is a feature of something. What is that something?
That's how you should be organizing these. Right? Because each part has a
requirements. So don't just randomly list requirements. Those requirements
need to belong to a thing.

**Me:** Right. Reorganized so requirements live under the thing they
describe:

```
liquidos/
  workspace/
    - persistent across sessions
    - holds many canvases
    - shareable as intent (flows between users)
    - has a stable identity
    - captures every change; full history readable

  canvas/  (lives in a workspace)
    - updates in real time
    - has plain-text intent (requirements.txt)
    - has a pluggable presentation (canvas.js)
    - holds many components

  component/  (lives in a canvas)
    - interactive
    - has plain-text intent (feature-requirements)
    - can call the agent back
    - may run services
    - updates live as the agent writes

  agent/
    - reads workspace state and history
    - reads user prompts
    - writes to workspace

  harness/
    - renders the workspace's canvases
    - routes user input to agent and workspace
    - lets the user edit intent files
```

Sharing → workspace property. Persistence → workspace property. User input
→ routed by the harness (and some of it lands in the workspace as intent
files). Better fit?

---

**User:** I I don't think you're... I mean, that looks a lot better, but
you're missing things. And, bro, you need to phrase these as if they are
real requirements because they will be real requirements. How do I create a
a canvas? There's no mention of how that's done, and yet the software that
we built today does do that. So you're missing things. Think about it

**Me:** Right, I was being vague. Real requirements:

```
liquidos/
  workspace/
    - is a folder (`<name>.liquidos`); user creates or opens it
    - holds one or more canvases
    - has one active canvas at a time, persisted across sessions
    - captures every change as a version history the agent can read
    - has a stable identity for the peer network
    - can publish any of its canvases as a bundle of intent
    - can browse and install bundles from other workspaces
    - sharing is opt-in; can be turned off without losing browse/install

  canvas/  (lives in a workspace)
    - created by the user from scratch (named, empty)
       — OR installed from a peer's bundle
       — OR created by the agent in response to a prompt
    - has plain-text intent (requirements.txt) the user can edit anytime
    - has a presentation module (canvas.js) the agent may rewrite
    - holds zero or more components
    - renders live as its files change
    - the user can switch between canvases in the workspace

  component/  (lives in a canvas)
    - created by the agent in response to a prompt
    - has plain-text intent (feature-requirements.txt) the user can edit anytime
    - renders an interactive surface
    - may run a service that drives its surface
    - can include callbacks that prompt the agent, scoped to it
    - renders live as its files change
    - can be removed by the agent

  agent/
    - receives prompts from the user, scoped to a canvas or component
    - reads workspace state and full history
    - reads canvas and component intent files
    - writes to the workspace
    - surfaces busy state; can be cancelled
    - has multiple selectable runtimes

  harness/
    - presents the active canvas
    - lets the user switch canvases
    - lets the user create a canvas from scratch
    - lets the user install a canvas from the peer network
    - lets the user edit intent files
    - lets the user prompt the agent and see busy state
    - lets the user toggle sharing
```

Closer? What am I still missing?

---

**User:** harness presents workspace. harness can open workspace files.
workspaces can be persisted to .liquidos. workspace has prompt input... you
missed bunch. don't forget behaviors

**Me:** Better attempt — more behaviors, properly attributed:

```
liquidos/
  workspace/
    - persisted as a `<name>.liquidos` folder on disk
    - opened by the harness
    - holds one or more canvases
    - has one active canvas at a time; persists that across sessions
    - has a prompt input that dispatches to the agent
    - captures every change as version history readable by the agent
    - has a stable peer-network identity
    - can publish any of its canvases as a bundle of intent
    - can install bundles from peers as new canvases
    - sharing is opt-in
    - repairs itself via an agent-driven fix-up when broken

  canvas/  (lives in a workspace)
    - created by the user from scratch (named), by the agent, or installed from a peer
    - has plain-text intent (requirements.txt) the user can edit
    - has a presentation module (canvas.js) the agent may rewrite
    - holds zero or more components, ordered by input.json
    - components can be added or removed by the agent
    - renders live as its files change
    - one canvas is active at a time; the user can switch
    - may persist its own state (camera, layout, etc.)

  component/  (lives in a canvas)
    - created by the agent in response to a prompt
    - has plain-text intent (feature-requirements.txt) the user can edit
    - renders an interactive surface from its view.json
    - may run a service that drives the surface
    - can include callbacks that prompt the agent, scoped to the component
    - services start when the canvas activates, stop when it deactivates
    - carries diagnostic state (running, errors, last exit)
    - renders live as its files change
    - can be removed by the agent

  agent/
    - receives prompts from the workspace's prompt input or component callbacks
    - reads workspace state and full version history
    - reads canvas and component intent files
    - writes to the workspace
    - surfaces busy state; can be cancelled
    - has multiple selectable runtimes

  harness/
    - presents a workspace
    - lets the user open or create a workspace
    - lets the user switch active canvas
    - lets the user create a canvas from scratch
    - lets the user install a canvas from peers
    - lets the user open and edit workspace files (intent files, etc.)
    - lets the user prompt the agent
    - lets the user select agent runtime
    - lets the user toggle sharing
    - surfaces agent busy state; lets the user cancel
```

What am I still missing?

---

**User:** workspace presents controls to user that when selected prompt agent
to fix issues. user can create new canvas from workspace. canvas: user can
edit requirements that are additional to these requirements. shouldn't
mention technical details: json. come on! this isn't hard stuff

**Me:** Stripped tech terms, added missing:

```
liquidos/
  workspace/
    - persists to disk
    - opened by the harness
    - holds one or more canvases
    - has one active canvas at a time; persists that across sessions
    - has a prompt input that dispatches to the agent
    - captures every change as a history the agent can read
    - has a stable identity on the network
    - can publish any of its canvases as intent
    - can install canvases shared by others
    - sharing is opt-in
    - presents controls the user can use to prompt the agent to fix problems
    - the user can create a new canvas in the workspace

  canvas/  (lives in a workspace)
    - created by the user from scratch (named), by the agent, or installed from a peer
    - the user can author requirements describing what the canvas is for (additional to these)
    - has a presentation the agent may rewrite
    - holds zero or more components in an order
    - components can be added or removed by the agent
    - renders live as it changes
    - the user can switch between canvases
    - may persist its own state (camera, layout, etc.)

  component/  (lives in a canvas)
    - created by the agent in response to a prompt
    - the user can author requirements describing what the component should do (additional to these)
    - renders an interactive surface
    - may have a service that updates it over time
    - can include controls that prompt the agent, scoped to the component
    - services start when the canvas activates, stop when it deactivates
    - carries diagnostic state (running, errors, last exit)
    - renders live as it changes
    - can be removed by the agent

  agent/
    - receives prompts from the workspace, scoped to a canvas or component
    - reads workspace state and full history
    - reads canvas and component requirements
    - writes to the workspace
    - surfaces busy state; can be cancelled
    - has multiple selectable runtimes

  harness/
    - presents a workspace
    - lets the user open or create a workspace
    - lets the user open files in the workspace
    - lets the user switch the active canvas
    - lets the user create a canvas in the workspace
    - lets the user install a canvas from peers
    - lets the user view and edit canvas and component requirements
    - lets the user prompt the agent
    - lets the user select the agent runtime
    - lets the user toggle sharing
    - surfaces agent busy state; lets the user cancel
```

Better?

---

**User:** some of the organizatin isn't right: switching canvases is not a
feature of canvases, etc

**Me:** Right — switching is something the user does *through the harness*.
The canvas doesn't switch itself. Re-attributed:

```
liquidos/
  workspace/
    - persists to disk
    - has one or more canvases
    - has one active canvas at a time; persists that across sessions
    - has a stable identity on the network
    - captures every change as a history the agent can read
    - can publish any of its canvases as intent
    - can install canvases shared by others
    - can be repaired by the agent when broken
    - sharing is opt-in

  canvas/  (lives in a workspace)
    - created by the user, by the agent, or installed from a peer
    - the user can author requirements describing what the canvas is for (additional to these)
    - has a presentation the agent may rewrite
    - holds zero or more components in an order
    - renders live as it changes
    - may persist its own state (camera, layout, etc.)

  component/  (lives in a canvas)
    - created by the agent in response to a prompt
    - the user can author requirements describing what the component should do (additional to these)
    - renders an interactive surface
    - may have a service that updates it over time
    - can include controls that prompt the agent, scoped to the component
    - services start when the canvas activates, stop when it deactivates
    - carries diagnostic state
    - renders live as it changes

  agent/
    - receives prompts scoped to a canvas or component
    - reads workspace state and full history
    - reads canvas and component requirements
    - writes to the workspace
    - creates and removes canvases and components
    - surfaces busy state; can be cancelled
    - has multiple selectable runtimes

  harness/
    - presents a workspace to the user
    - opens or creates workspaces
    - opens files in the workspace for the user to view or edit
    - lets the user switch the active canvas
    - lets the user create a canvas in the workspace
    - lets the user install a canvas from peers
    - lets the user view and edit canvas and component requirements
    - lets the user prompt the agent
    - presents controls for the agent to repair the workspace when broken
    - lets the user select the agent runtime
    - lets the user toggle sharing
    - surfaces agent busy state; lets the user cancel
```

Better?

---

**User:** this belong in workspace I think: has multiple selectable runtimes.
also a lot of what you have in harness is prying. the harness renders
workspaces and handles callbacks (either to agent or programmatic). if you
redundantly define what a workspace does in the harness requirements then we
have two sources of truth

**Me:** Right — workspace owns its capabilities, harness just renders and
routes. Removing the duplication:

```
liquidos/
  workspace/
    - persists to disk
    - holds one or more canvases
    - has one active canvas at a time; persists across sessions
    - has a stable identity on the network
    - captures every change as a history the agent can read
    - has multiple selectable agent runtimes
    - the user can create a new canvas
    - the user can switch the active canvas
    - the user can prompt the agent
    - the user can publish any of its canvases as intent
    - the user can install canvases shared by others
    - the user can toggle sharing on/off
    - can be repaired by the agent when broken

  canvas/  (lives in a workspace)
    - created by the user, by the agent, or installed from a peer
    - the user can author requirements (additional to these)
    - has a presentation the agent may rewrite
    - holds zero or more components in an order
    - renders live as it changes
    - may persist its own state

  component/  (lives in a canvas)
    - created by the agent
    - the user can author requirements (additional to these)
    - renders an interactive surface
    - may have a service that updates it over time
    - can include controls that prompt the agent, scoped to it
    - services start when the canvas activates, stop when it deactivates
    - carries diagnostic state
    - renders live as it changes

  agent/
    - receives prompts scoped to a canvas or component
    - reads workspace state and full history
    - reads canvas and component requirements
    - writes to the workspace
    - creates and removes canvases and components
    - has busy state; can be cancelled

  harness/
    - renders workspaces
    - handles callbacks (to the agent or programmatic)
```

Tighter?

---

**User:** maybe we should be specific about some of the callbacks. harness
records events to git. harness dispatches callbacks to agent, ...

**Me:** Right, breaking out the callback types:

```
  harness/
    - renders workspaces
    - records user events to the workspace's history
    - dispatches user prompts to the agent
    - dispatches component callbacks to the agent
    - handles programmatic callbacks within components
    - writes user file edits to the workspace
```

Want me to keep going on the other parts, or is the harness piece what you
wanted to nail down?

---

**User:** this should be more specific: has a presentation the agent may
rewrite -> defines the appearance and behavior of its presentation. go
through each. check if they're in the right place. if they capture
everything. they can capture without being too verbose. don't you know the
code? you wrote it all. some are incomplete, some are missing. don't forget
about behaviors

**Me:** Going through each, making them specific and more complete:

```
liquidos/
  workspace/
    - persists to disk
    - holds one or more canvases
    - has one active canvas at a time; persists across sessions
    - has a stable identity on the network
    - captures every change as a history the agent can read
    - has multiple selectable agent runtimes
    - the user can create a new canvas
    - the user can switch the active canvas
    - the user can prompt the agent
    - the user can publish any of its canvases as intent
    - the user can install canvases shared by others
    - the user can toggle sharing on/off
    - surfaces errors when broken
    - can be repaired by the agent when broken

  canvas/  (lives in a workspace)
    - has a name (named on creation)
    - created by the user, by the agent, or installed from a peer
    - the user can author requirements (additional to these)
    - defines the appearance and behavior of its presentation
    - the presentation can observe and write workspace files
    - holds zero or more components in an order
    - renders live as it changes

  component/  (lives in a canvas)
    - created and removed by the agent
    - the user can author requirements (additional to these)
    - renders an interactive surface
    - may have a service that updates it over time
    - can include controls that prompt the agent (scoped to it) or act programmatically
    - services start when the canvas activates, stop when it deactivates
    - may persist its own state
    - carries diagnostic state
    - renders live as it changes

  agent/
    - receives prompts scoped to a canvas or component
    - reads workspace state and full history
    - reads canvas and component requirements
    - writes to the workspace
    - creates and removes canvases and components
    - rewrites the canvas's presentation
    - has busy state; can be cancelled

  harness/
    - renders workspaces
    - records user events to the workspace's history
    - dispatches user prompts to the agent
    - dispatches component callbacks to the agent
    - handles programmatic callbacks within components
    - writes user file edits to the workspace
    - relays workspace operations (create canvas, switch, share, publish, install)
```

Changes I made:
- canvas: "has a presentation the agent may rewrite" → "defines the appearance and behavior of its presentation"; added that presentations observe and write workspace files; added "has a name"
- component: combined into one line that callbacks can be agent-prompting OR programmatic; added "may persist its own state"; "created and removed by the agent" (added the remove)
- agent: added "rewrites the canvas's presentation"
- workspace: added "surfaces errors when broken" before the repair line
- harness: added "relays workspace operations" for the things that aren't pure agent dispatch

Want me to keep refining specific ones?

---

**User:** i'm doubtful that another agent would be able to reproduce what
we've made with that skill as it is now

**Me:** Honest read: you're right. Even with the additions, the spec stops
at "what things are" and never spells out the contracts between them. An
agent reading this knows there's a "presentation" but not what it receives,
what it returns, when it runs, or how it talks to anything else. Same for
callbacks, services, dispatch, the bundle format. Every behavior I bulleted
is real but the *protocols between behaviors* — the actual interfaces —
aren't here.

Two ways to fix that without naming specific tech:

1. **Add interaction shapes per part.** For each relationship — agent ↔
   workspace, presentation ↔ canvas, component ↔ harness, service ↔
   component, bundle ↔ peer — say what flows across it and when. Still no
   JSON or React, just "the presentation receives the components and decides
   how to arrange them; runs when the canvas activates; can be replaced
   anytime."

2. **Treat the probe suite as part of the spec.** Each scenario is an
   executable contract. The prose says what; the probe says exactly what
   counts as conforming. We already have 16 of them. They're the part that's
   actually unambiguous.

My honest take: prose alone is never going to be enough, because language is
squishy. The probe is what would let another agent verify their build. The
prose is what tells them what to aim for.

Want me to take a pass at the interaction-shape additions, or look at what
an executable contract (the probe ported to a portable form) would need to
be?

---

End of conversation captured here.
