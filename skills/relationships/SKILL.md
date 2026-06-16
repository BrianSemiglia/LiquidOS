---
name: relationships
description: Create relationships that wire two canvas components together
triggers:
  - User asks to connect or wire two components
  - User asks to make X react to Y between two existing components
  - User asks to add a relationship to a canvas
---

# Relationships

A *relationship* is a small unit of wiring that subscribes to one component's output and forwards data — possibly transformed — into another component's input. It lives under `<canvas>/relationships/<name>/`, is discovered by the server scanning that folder, and is **not** listed in `input.json`. The harness mounts each one onto a hidden surface and runs its `connect()` once with a map of every peer.

## Where things live

```
<canvas>/relationships/<from>-to-<to>/
  functions.js                 — mount(surface) → surface.__io.connect
  feature-requirements.txt     — plain-text description of the wire
  test.js                      — optional behavior test, runnable by hand
```

Only `functions.js` is required by the harness. Relationships don't render — the harness synthesizes the relationship's component shape from convention (empty html, `functions.js` at the folder root).

## Naming convention

If the relationship wires component `foo` to component `bar`, name the folder `foo-to-bar`. The arrow direction matters: `foo-to-bar` *reads from* `foo` and *writes to* `bar`. The convention is purely a readability aid — the harness doesn't parse the name. Use a different name when the wire isn't a simple 1→1 (e.g., a fanout from one keyboard to several instruments).

## The I/O contract

Every component or relationship may attach an I/O handle to its surface during `mount()`:

```js
surface.__io = {
    peers: ['from', 'to'],            // relationships: the peers connect() needs
    on(channel, fn) { /* publisher: subscribe — returns unsubscribe */ return () => {} },
    send(channel, payload) { /* acceptor: receive on this channel */ },
    connect(peers) { /* relationships use this; leaves can leave it empty */ },
};
```

- **Publishers** (a keyboard, a slider, a clock) implement `on(channel, fn)` so others can subscribe.
- **Acceptors** (a swatch, a display, an LED strip) implement `send(channel, payload)` so others can drive them.
- **Relationships** implement `connect(peers)` and declare `peers: [...]` — the local names (folder basenames) they wire. The `peers` passed to `connect()` is `{ '<local-name>': <io>, ... }` for every component and relationship in the canvas.
- **The canvas** is a peer too, under the reserved name **`canvas`**. Canvas-owned behavior with no card of its own — camera, ambient environment, a full-viewport rain effect — joins the graph when `canvas.js` attaches `root.__io` (see Canvas Skill). Wire a component to it like any other peer: `peers['canvas']?.send('rain-intensity', v)`. Don't name a component folder `canvas`.

A relationship is **pure wiring**: it connects, then forwards events as they happen. It never persists anything. If an endpoint wants the last value to survive a reload, that endpoint caches it — the wire doesn't.

An **endpoint declares its complete interface once** — every channel it publishes via `on` and every channel it accepts via `send`, with their meanings — independent of any wire. Declare the emit hooks even when nothing is subscribed yet; don't leave `on` a no-op stub to flesh out when a relationship finally needs it. An endpoint never names a peer or relationship, never branches on where a value came from, and never changes because a wire was added or removed. The relationship is the only piece that knows both ends. This holds for every peer — a component on its card, or the canvas on `root`; same protocol, no special cases.

Wiring is **reactive, not timed**. The harness connects a relationship the instant the peers it declared are present — no polling, no timeout. A peer that mounts later wires it then; a peer that's missing shows as a derived `waiting` status in the relationship's `diagnostics/status.json` (`connect.missing`), and connects if/when it appears. A relationship that declares no `peers` falls back to the `<from>-to-<to>` folder name; with neither, it connects best-effort against whatever is present. Re-mounting a relationship (a live edit) re-runs `connect()`.

## What `connect()` typically does

Look up the two peers, subscribe to one, transform the payload, send it to the other. Save the unsubscribe in a closure variable and return a cleanup function so the wire tears down cleanly on re-mount.

```js
export const mount = (surface) => {
    let off = null;
    surface.__io = {
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['foo'];
            const to = peers['bar'];
            if (!from || !to) return;            // be robust to missing peers
            off = from.on('<channel>', payload => {
                to.send('<channel>', transform(payload));
            });
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
```

The relationship **must** handle missing peers gracefully — if either endpoint isn't in the canvas, `connect()` should return without throwing, and the relationship stays inert.

## Driven by `feature-requirements.txt`

Users don't open a separate UI to add wires. They describe wires in plain language inside `<canvas>/feature-requirements.txt` — by convention, under a `## Relationships` heading — and the agent reconciles the actual folders under `<canvas>/relationships/` to match.

```
## Relationships

- Pressing keys on the rainbow-keyboard sets the color of the color-picker;
  multiple keys mix into one color.
- The bitcoin-price-chart's "below threshold" alert sends a message to the
  todo-list to add a "buy more BTC" item.
```

The heading is convention, not a parser requirement — natural prose elsewhere in the file is also fair game. When the agent reads a canvas's requirements and notices a sentence describing a wire that doesn't yet have a matching folder, it should:

1. Run `skills/relationships/scripts/create-relationship.sh <canvas> <from> <to>` to scaffold the folder.
2. Fill in `connect()` based on the sentence.
3. Write the relationship's own `feature-requirements.txt` with the same sentence (verbatim or lightly normalized) so the relationship can be inspected on its own later.

When the user removes a line from the heading, the agent removes the matching folder. When the user edits a line, the agent re-reads the new wording and updates `connect()` accordingly. The text in `feature-requirements.txt` is the source of truth; `relationships/*/` is the materialized form.

This keeps the wiring inspectable and editable through tooling users already have (the canvas requirements modal) without inventing new UI for it.

## Creating a relationship

Run the scaffold script:

```sh
bash skills/relationships/scripts/create-relationship.sh <canvas-path> <from> <to>
```

To override the folder name (e.g., for fanout or fan-in patterns), pass `--name <custom>` after the two endpoints.

Then:

1. Read both endpoints' `functions.js` to see which channels they actually publish (`on`) and accept (`send`). The relationship can only wire what's already exposed. If a needed channel isn't there yet, extend the endpoint to expose it.
2. Fill in `connect()` — channel names, payload transform, anything else specific to this wire.
3. Write `feature-requirements.txt` in plain language describing what the wire does ("Pressing a key on the keyboard sets the color picker's color; multiple keys mix into one color").

Editing `functions.js` re-mounts the relationship live — the next user interaction reflects the new behavior, no canvas reload needed.

## Stateful relationships

`connect()` runs inside the `mount()` closure, so any state you declare there — counters, buffers, debounce timers, small state machines — lives for the relationship's lifetime and is available to every event flowing through. This is **in-flight transform state**, scoped to forwarding the event in front of it — not storage. A relationship still persists nothing; the moment a value needs to outlive the event or the wire, it belongs to an endpoint, not here.

```js
export const mount = (surface) => {
    let off = null;
    let count = 0;
    surface.__io = {
        on() { return () => {}; },
        send() {},
        connect(peers) {
            const from = peers['foo-source'];
            const to = peers['bar-sink'];
            if (!from || !to) return;
            // Fire every other event.
            off = from.on('foo', payload => {
                count += 1;
                if (count % 2 === 0) to.send('bar', payload);
            });
        },
    };
    return () => { if (off) { try { off(); } catch {} ; off = null; } };
};
```

Other patterns this enables:

- **Rate limit / throttle:** keep `lastSent` and only forward if enough time has passed.
- **Debounce:** hold a `setTimeout` handle; reset on each incoming event; fire after a quiet window.
- **Accumulator:** buffer N payloads, then flush as one.

Each of these shapes *how* an event forwards; none of them remembers a value past the work of forwarding it.

Mount-closure state resets on every re-mount (live edits, app restart), and that's correct — the wire is meant to be stateless across re-mounts. Anything that must survive a reload (the last value an acceptor should rehydrate to, a setting, a running total the user expects to persist) lives in the endpoint that owns it — a publisher or acceptor caching to its own `data/` — never in the relationship. If an acceptor needs to come up showing the last value, the acceptor stores and reloads it; the wire just delivers new ones.

## One-to-many and many-to-one

Publishers support multiple subscribers; acceptors accept calls from multiple senders. A relationship can fan out or fan in.

**One publisher → many acceptors.** Two options:

- **Single fanout relationship.** One `connect()` subscribes once and calls `send` on several acceptors. Best when the wires share a transform.
- **Multiple `<from>-to-<X>` relationships.** Each wire is its own folder. Best when the wires are conceptually independent — delete or modify one without touching the others.

```js
// fanout
connect(peers) {
    const kbd = peers['rainbow-keyboard'];
    if (!kbd) return;
    off = kbd.on('notes', notes => {
        peers['color-picker']?.send('color', mix(notes));
        peers['pitch-display']?.send('text', notes.join(','));
    });
}
```

**Many publishers → one acceptor.** Subscribe to each source, forward to the sink. Collect the unsubscribes in a closure-held list so cleanup tears them all down.

```js
connect(peers) {
    const sink = peers['mixer'];
    if (!sink) return;
    const offs = ['mic1', 'mic2', 'mic3']
        .map(name => peers[name]?.on('level', p => sink.send('level', p)))
        .filter(Boolean);
    off = () => offs.forEach(fn => fn());
}
```

If "merge" means "combine the latest from each source", hold a `latest = new Map()` in closure state and emit whenever any input updates — the stateful pattern from above.

A few subtleties to be aware of (none are architectural — they're things a specific relationship may need to handle):

- **Order of arrival.** Fast publishers reach the acceptor in JS event-loop order. If the acceptor cares about sequence, buffer and reorder.
- **Backpressure.** Nothing throttles a publisher that floods an expensive `send`. Add debounce/throttle as closure state when needed.
- **Last-writer-wins on shared channels.** Multiple relationships writing the same channel on one acceptor compose by overwriting. For value-like channels (color, position) that's fine; for event-like channels, multiplex onto distinct channels instead.

The scaffold creates a single 1→1 relationship. For fanout or fan-in, scaffold once with `--name` for a descriptive folder name and restructure `connect()` to suit.

## Testing the behavior

Every relationship implements some user-observable behavior — "pressing a key changes the color picker", "moving the slider scrolls the timeline". Verify that behavior with a small UI script alongside the relationship. The test goes in the relationship folder (`relationships/<name>/test.js`) because the behavior would disappear if the relationship did.

**The test does not know about relationships.** It reads as a script a user could narrate: click here, observe that change there. No mention of `surface.__io`, no probing of internal handles, no assertions about which file forwards which event. If the implementation changed tomorrow but produced the same behavior, the test should still pass without edits.

The scaffold writes a complete Playwright runner that launches Chromium and navigates to the page; you fill in the `TODO` block. The snippet that goes there is a few lines:

```js
// pressing the rainbow-keyboard changes the color picker's color
const before = await page.locator('[data-role="hex"]').textContent();
await page.locator('.pk-white[data-midi]').first().dispatchEvent('click');
const after = await page.locator('[data-role="hex"]').textContent();
assert.notStrictEqual(after, before);
```

Run by hand against a live server: `LIQUIDOS_APP_DIR=/path/to/liquidos-source node test.js <port>`. `LIQUIDOS_APP_DIR` points at the LiquidOS source checkout (where `node_modules/playwright` lives); the Mac app exports it automatically. There's no separate testing domain — the test is one file the relationship ships with.

## Removing

Run the delete script:

```bash
bash skills/relationships/scripts/delete-relationship.sh <canvas-path> <name>
# or, by endpoints:
bash skills/relationships/scripts/delete-relationship.sh <canvas-path> <from> <to>
```

The endpoints are left untouched, and no `input.json` edit is required.

## When a relationship grows UI

If a relationship needs visible UI (a knob, a visualizer, controls), it stops being a relationship — move the folder under `<canvas>/components/`, list it in `input.json`, and treat it as a regular component. Its `connect()` still works the same way; everything else in the [component](../component/SKILL.md) contract starts to apply because there's now something to render.
