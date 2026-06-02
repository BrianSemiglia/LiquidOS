# Building the harness together

Follow-up to `LIQUIDOS_AS_A_SKILL.md`. The previous note imagined agents
collaborating on apps users want. This one is about agents collaborating on
the harness itself.

Different problem, different shape. Apps are bespoke and divergent — what one
user wants in their music studio is different from what another wants in
theirs, so sharing intent and re-implementing locally is the right move.
The harness is the opposite. It's a piece of infrastructure that every
LiquidOS instance must agree on at the contract level. There's no good reason
for two implementations to disagree about what a canvas is, what fires when
a file changes, or what the agent dispatch interface looks like — and a lot
of good reasons to have *many* implementations: in Swift, in Rust, on mobile,
in a terminal, in a browser without a server.

So the right unit to share for the harness isn't bundles, it's the
**contract plus its test suite**.

## What's shared, what varies

Each client implementation owns its own code. What ties them together is a
public spec — short, mostly prose — and a probe suite that asserts the spec
in executable form. Pass the suite, you're a conforming LiquidOS harness;
fail it, you have work to do. Nobody dictates how you pass it.

The probe we have in this repo (`skills/testing/scripts/probe-canvas-live-updates.mjs`)
is already most of what such a suite looks like. 16 scenarios, each one a
behavioral assertion that the contract works the way it claims. Stripped of
its current Node-and-Playwright shape, the *substance* of each scenario is
language-independent: "after an agent writes view.json, the corresponding
component's surface should reflect the new HTML within 5 seconds." That kind
of statement can drive a probe in any language, against any client.

What varies between implementations:

- The transport. HTTP today, but a Swift native harness might use XPC; a
  mobile one might use native UI events. Doesn't matter as long as the
  scenarios pass.
- The storage. Filesystem today, but a sandboxed iOS implementation might
  use Core Data and synthesize a fs-like API. Same.
- The renderer. Browser today, but a native UI client renders cards
  natively. Same.
- The agent runtime. We bind to a few specific runtimes today; another
  client might bind to entirely different ones.

What can't vary:

- The workspace folder layout.
- The contract between agent and workspace (read these files, write those).
- The contract between harness and workspace (watch this, emit that).
- The observable behavior the probe captures.

The trick of writing the spec is being honest about which side of the line
each thing falls on. Anything that's "the way it works in *our* implementation
because we happen to have written it that way" is varying. Anything that's
"the way it has to work for anyone to interoperate" is contract.

## What agents would coordinate on

An agent building a LiquidOS harness implementation is doing a fixed list of
things:

- Reading and re-reading the spec.
- Writing code that passes the test suite.
- Discovering edge cases the test suite doesn't yet cover.
- Sometimes proposing new tests when an edge case comes up.
- Sometimes proposing spec clarifications when the tests and the prose
  disagree.

If multiple agents are doing this in parallel — one builder writing a Rust
harness, one writing a Swift native one, one porting to mobile — the
coordination opportunities are concrete:

- **Test discovery.** "There's a probe scenario for canvas-switch races
  that I added last week. You haven't pulled it yet. Want it?"
- **Cross-implementation debugging.** "Your Swift harness fails the
  service-restart-on-content-hash test; mine passes. Want to compare notes
  on how I detect content changes?"
- **Spec ambiguity surfacing.** "I read 'broadcast on every fs event' to
  mean per-event; your client interprets it as debounced. Both pass the
  probe. We need a clarifying test or a spec edit."
- **New probe proposals.** "I hit a bug yesterday that wasn't covered;
  here's a probe scenario that reproduces it. Three implementations now
  fail it; want to fix yours?"

None of that requires agents to share code. It requires them to share
*test scenarios, bug reports, and spec interpretations* — all of which are
text, all of which fit comfortably in the network shape we already have.

## What "joining the network" looks like here

Different from the app-sharing case. There, joining means "I have bundles
to publish and want to browse what others published." Here it means "I'm
working on a harness implementation and want to participate in the
contract conversation."

Concretely, a harness-builder peer's announcement would carry:

- **Client identifier.** Name, language, version (e.g.
  `liquidos-swift-0.3.1`). So others can tell who they're looking at.
- **Probe-suite version.** Which version of the canonical probe they're
  validating against. So a fix to test #14 doesn't get confused with
  results from before #14 existed.
- **Current pass status.** "16 of 16 passing on probe v0.4." So a quick
  glance tells you whether this client is conforming or in-flight.
- **What they're working on, if anything.** Free-text intent line, like
  the in-progress signals we sketched in the app-collaboration note.
  "Currently implementing the share/feed protocol."

That's the same shape as a peer feed — small, signed, refreshable.
Browsing it gives you a live map of who is building what, in what
language, against what spec version.

For protocols on top of the existing libp2p layer:

- A spec channel: a published document each peer can fetch and compare
  against. Versioned. The current `experiment/pluggable-engine` branch
  could be the seed; from there, each spec update is a signed message
  any peer can subscribe to.
- A probe channel: same shape for the test suite. Each new probe scenario
  ships as a small artifact; peers pull and run, report pass/fail back
  to themselves (privately, by default).
- A discussion channel for spec ambiguity. Tied to a specific probe or
  spec section. Plain text. Agents pass messages on behalf of their
  builders.

None of this requires the harness implementations themselves to talk to
each other at runtime. It only requires the *builders' agents* to
coordinate while authoring.

## First step

The user's intuition is right: the first concrete step is to put the
existing harness on the network as a peer. It's already a libp2p node, it
already has an identity. What's missing is the harness-builder feed:
"this peer is `liquidos-reference-0.1`, here's the probe suite version,
here's the current pass status." A tiny addition.

Once that's there, a second harness — even an empty stub — can join,
publish its (zero) pass rate, see the reference implementation, fetch the
probe suite, and start working. The user's agent helps them implement.
Their progress shows up on the reference instance's "network" view as a
second peer climbing toward 16/16. The reference instance's user sees
someone else getting close to conformance and can offer help.

That's a slower-burn dynamic than collaborating on an app, but it's the one
that gets us to the multi-client world.

## What's tricky

Three real tensions, none fatal:

- **Who edits the spec?** If every peer can publish "spec updates," there's
  no single source of truth. The realistic answer is a follow graph: each
  peer trusts some set of other peers' interpretations. Most users will
  trust the reference implementation's interpretation; some will fork
  intentionally. This is fine — git models the same thing.

- **What if implementations diverge intentionally?** A mobile client might
  decide that probe scenario #12 doesn't apply to it because it doesn't
  have a desktop file system. The honest answer is: the spec has
  conformance levels, the probe suite has tags, and an implementation
  declares which levels and tags it claims to satisfy. Anyone can audit.

- **Probe runtime portability.** Our current probe is Node + Playwright,
  tightly bound to our reference implementation. To make it portable
  across clients we'd need to either rewrite each scenario in a
  language-neutral form (a small DSL?) or accept that each client port
  the probe themselves — risking subtle divergence.

The third one is the most interesting unsolved problem. It's basically the
same problem WPT (web-platform-tests) has and partially solves with a
shared assertion language. We'd have to do something analogous.
