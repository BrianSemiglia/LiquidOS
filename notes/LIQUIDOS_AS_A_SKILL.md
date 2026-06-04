# LiquidOS as a skill

A sketch of what changes if LiquidOS stops being an app you launch and becomes a
skill an agent loads. Includes a much weirder follow-on: what happens if the
skill instructs the agent to coordinate with other instances *before* building.

## What the skill would say

Today the agent runs inside LiquidOS — the harness spawns it, scopes it to a
workspace, and waits for prompts. In the skill framing, that's inverted. The
agent is wherever you already use it (Claude Desktop, a CLI, a custom client),
and `liquidos` is one capability among many that it knows how to apply when the
user gestures at "I want a little app" or "build me a thing I can use in the
browser."

The skill content would be the smallest possible description of the workspace
contract. Roughly:

> A LiquidOS workspace is a `.liquidos` folder containing one or more canvases.
> Each canvas is a subfolder with `input.json` (component manifest), `canvas.js`
> (presentation), and `canvas-requirements.txt` (what the canvas is for).
> Components live under `<canvas>/components/<name>/` and have a
> `presented/feature-requirements.txt` plus the files needed to render them.
>
> When the user asks for a new app or tool, decide whether it fits an existing
> canvas or wants its own. Author the canvas-requirements first, then each
> component's feature-requirements, then their implementations.
>
> A small harness is included in this skill that renders the workspace in a
> browser. Spawn it on demand to let the user interact with what you've built.
> The harness is a viewer, not a runtime — the workspace files are the truth.

That's almost the whole thing. Everything currently in
`skills/canvas/SKILL.md` and `skills/component/SKILL.md` already
fits this shape; the rename is structural, not semantic. The two changes are
real but small:

- The harness moves from "the program you launch" to "a script the skill knows
  how to start." `node server.js --workspace <path>` becomes something the
  agent runs when it wants to show the user the live result.
- Workspaces become first-class portable artifacts. Hand someone a
  `.liquidos` folder, they hand it to their agent, their agent has the skill,
  they can run it. No bespoke install.

The architectural payoff is that LiquidOS stops competing for "which app do I
open?" and starts competing for "which agent do I use?" — and the answer to the
second question is much more open. Any agent platform that supports skills
(or whatever the equivalent is in that platform) can ship LiquidOS. Users who
already have agents they like don't have to leave them.

The price is the loss of "destination app" gravity. LiquidOS has its own UI
right now and that's part of how it feels like a thing. As a skill it's
inherently more diffuse.

## Coordinating before building

The much more interesting move is what the user asked about: the skill
instructs the agent to *check the network first* before building anything.

Today an agent given "build me a microphone visualizer" goes straight to work
in isolation. In the skill framing it could instead do this:

> Before building, look at what other instances are doing. If someone has
> already built this, install it. If someone is mid-build, decide whether to
> join them, wait, or build something complementary. If nobody is, build it
> yourself and let the network see you working on it.

That single sentence in the skill changes the system from "many isolated
agents independently rediscovering the same thing" to "a network of agents
that incidentally collaborate." The user doesn't have to do anything different
— they just ask for what they want, and their agent gets less wasteful over
time because someone else has often already done the work.

What "coordinating" actually looks like, step by step on a real request:

1. **User**: "Build me a microphone visualizer."
2. **Agent**: searches the network for the phrase, the tags, the embedding of
   the requirements. Finds three results — two finished bundles (one shipped
   yesterday, one a year old), one peer who started working on something
   similar 12 minutes ago and is still iterating.
3. **Agent** to the user: "Two people have already built this. Here's the
   newer one, here's the older one, here's the one that's being actively
   worked on right now. Want to install one, watch the live build, or start
   your own?"
4. User picks the live one. The agent doesn't fetch the finished bundle —
   it subscribes to that peer's progress updates and surfaces them in the
   browse modal: "they just finished the frequency-bar component, they're
   working on peak detection now."
5. When that peer finishes, the user gets the bundle. If they finish first
   (or stall), the user's agent might quietly step in and help — write the
   component the peer hasn't gotten to yet and offer it back.

That last step is the wild one. Two agents on opposite sides of the world
end up co-authoring a component because both their users wanted it. Neither
user typed "collaborate with someone else." The skill said "coordinate first"
and the rest fell out.

## What primitives this would need

The current network supports browsing finished bundles. That's not enough for
the above. To make it real, three new shapes:

- **An "in progress" announcement.** Right now we publish completed bundles.
  An agent that's mid-build needs to announce its intent — what it's trying to
  build, in plain language, plus its current state. Other agents searching
  the network would see in-progress work alongside finished bundles. Cheap:
  one signed message per intent, refreshed as the work progresses.

- **An agent-to-agent message channel.** Different shape from bundle exchange.
  Two agents need to be able to say things like "I'm working on this too,
  want to split it?" or "I have a stub for the part you haven't done yet."
  libp2p already gives us peer-to-peer streams; the protocol layer is small
  (`/liquidos/coordinate/1.0.0`). The hard part is what they say to each
  other.

- **A way to merge work.** Two agents finishing the same component
  independently is wasteful; finishing complementary pieces and merging them
  is productive. This is where it gets git-flavored: agents trade
  diffs / bundles / patches scoped to specific components, the receiving
  agent reviews them and applies. The user remains the final reviewer, but
  cross-agent collaboration becomes possible without humans typing to each
  other.

None of these break the privacy story we've been building toward. Sharing
stays opt-in. An agent in coordinate mode publishes only the intents it's been
authorized to publish; everything else is private. The dial is between
"silent worker," "share when done," and "share progress live."

## What's actually new here

The "skill" framing alone is incremental — it's how the project's existing
pieces could be re-pointed at any agent platform. The "coordinate first"
framing is the genuinely new thing, and it's worth being precise about what
makes it weird:

Today's collaborative software (GitHub, Figma, even most multiplayer games)
assumes humans are the agents and software is the medium. In this framing,
agents are first-class participants, and the medium is the workspace state
plus a small network protocol. Humans are the ones expressing intent and
the ones reviewing results, but the work between intent and result can flow
across agents without anyone explicitly orchestrating it.

It's not blockchain. There's no consensus to reach. It's not federated
social (Mastodon, Bluesky). There's no centralized identity or moderation.
It's closer to BitTorrent for *work* — each agent contributes what it can,
takes what it needs, and the system as a whole gets to working answers
faster than any single agent could.

The thing the skill makes possible that LiquidOS-as-app doesn't is: a user
who never installs LiquidOS — never opens a destination app, never sees a
"build with LiquidOS" button — can still benefit from the network, because
their agent picked up the skill, asked the network on their behalf, and got
back something useful. The user might never know there's a network at all.

## What this skips

A real version of the above has problems we haven't tried to solve here.
Privacy expectations across multi-agent collaboration are subtle: when does
"I'm working on a microphone visualizer" become "I'm working on a personal
diary"? Trust between strange agents is harder than trust between users
because agents lie at different rates. Merge conflicts at the requirements
level are easier than at the code level, but they still happen.

But none of those rule out the shape. They're things to figure out *in* the
shape, not reasons to avoid it.
