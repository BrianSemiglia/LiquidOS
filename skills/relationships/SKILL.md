---
name: relationships
description: Create relationships that wire two canvas components together
triggers:
  - User asks to connect or wire two components
  - User asks to make X react to Y between two existing components
  - User asks to add a relationship to a canvas
---

# Relationships

A *relationship* is a small unit of wiring that subscribes to one component's output and forwards data — possibly transformed — into another component's input. It is component-shaped on disk (same `presented/view.json` + `presented/functions.js` layout) but lives under `<canvas>/relationships/<name>/`, not under `<canvas>/components/`, and is **not** listed in `input.json`. The server discovers relationships by scanning the folder and ships them to the harness alongside the regular components. The harness mounts each onto a hidden surface and runs its `connect()` once with a map of every peer.

## Where things live

```
<canvas>/
├── input.json                  user-facing components only
├── components/
│   └── <component>/            visible to the user
└── relationships/
    └── <from>-to-<to>/         invisible; wires <from> → <to>
        └── presented/
            ├── view.html       hidden by default
            ├── view.json       resources point at functions.js
            └── functions.js    implements surface.__io.connect
        ├── diagnostics/
        └── test.js             behavior test, runnable by hand
```

A relationship's `view.html` is `<div hidden></div>` by default. Relationships exist for their `connect()` body, not for rendering.

## Naming convention

If the relationship wires component `foo` to component `bar`, name the folder `foo-to-bar`. The arrow direction matters: `foo-to-bar` *reads from* `foo` and *writes to* `bar`. The convention is purely a readability aid — the harness doesn't parse the name. Use a different name when the wire isn't a simple 1→1 (e.g., a fanout from one keyboard to several instruments).

## The I/O contract

Every component or relationship may attach an I/O handle to its surface during `mount()`:

```js
surface.__io = {
    on(channel, fn) { /* publisher: subscribe — returns unsubscribe */ return () => {} },
    send(channel, payload) { /* acceptor: receive on this channel */ },
    connect(peers) { /* relationships use this; leaves can leave it empty */ },
};
```

- **Publishers** (a keyboard, a slider, a clock) implement `on(channel, fn)` so others can subscribe.
- **Acceptors** (a swatch, a display, an LED strip) implement `send(channel, payload)` so others can drive them.
- **Relationships** implement `connect(peers)`. `peers` is `{ '<local-name>': <io>, ... }` — every visible component and every other relationship in the canvas, keyed by folder basename.

`connect()` runs once per canvas mount, after every component and relationship has finished its async `mount()`. Subsequent loads do not re-invoke `connect()` on already-connected peers.

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

## Driven by `canvas-requirements.txt`

Users don't open a separate UI to add wires. They describe wires in plain language inside `<canvas>/canvas-requirements.txt` — by convention, under a `## Relationships` heading — and the agent reconciles the actual folders under `<canvas>/relationships/` to match.

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

When the user removes a line from the heading, the agent removes the matching folder. When the user edits a line, the agent re-reads the new wording and updates `connect()` accordingly. The text in `canvas-requirements.txt` is the source of truth; `relationships/*/` is the materialized form.

This keeps the wiring inspectable and editable through tooling users already have (the canvas requirements modal) without inventing new UI for it.

## Creating a relationship

Run the scaffold script. It validates that `<from>` and `<to>` exist under the canvas's `components/`, then writes `relationships/<from>-to-<to>/presented/{view.html, view.json, functions.js, feature-requirements.txt}`, a `test.js` stub, and `diagnostics/status.json`.

```sh
bash skills/relationships/scripts/create-relationship.sh <canvas-path> <from> <to>
```

To override the folder name (e.g., for fanout or fan-in patterns), pass `--name <custom>` after the two endpoints.

Then:

1. Read both endpoints' `presented/functions.js` to see which channels they actually publish (`on`) and accept (`send`). The relationship can only wire what's already exposed. If a needed channel isn't there yet, extend the endpoint to expose it.
2. Fill in `connect()` — channel names, payload transform, anything else specific to this wire.
3. Write `feature-requirements.txt` in plain language describing what the wire does ("Pressing a key on the keyboard sets the color picker's color; multiple keys mix into one color").

Editing `functions.js` re-mounts the relationship live: the harness sees the file's mtime change, ships the new view through `/input`, and replaces the mounted surface. The next user interaction reflects the new behavior. No canvas reload needed.

## Stateful relationships

`connect()` runs inside the `mount()` closure, so any state you declare there — counters, buffers, debounce timers, latches, small state machines — lives for the relationship's lifetime and is available to every event flowing through.

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
- **Latch:** remember the most recent value so a late-subscribing acceptor can be hydrated.

Mount-closure state resets on every re-mount (live edits, app restart). If the wire needs state that survives re-mount, write to a file under the relationship's `data/` and reload in `mount()` — the same pattern components and canvas.js use for their own persistence.

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

```js
// pressing the rainbow-keyboard changes the color picker's color
const before = await page.locator('[data-role="hex"]').textContent();
await page.locator('.pk-white[data-midi]').first().dispatchEvent('click');
const after = await page.locator('[data-role="hex"]').textContent();
assert.notStrictEqual(after, before);
```

Run by hand against a live server: `node test.js <port>`. There's no separate testing domain — the test is one file the relationship ships with.

## Removing

1. Delete `<canvas>/relationships/<name>/`. The harness sees the directory disappear and tears down the mounted relationship on the next refresh.
2. Endpoints don't need any changes — their `surface.__io` stays as-is; nothing is subscribed any more.

No `input.json` edit is required; the canvas was never aware of the relationship through that file.

## Relationships are still components on disk

The folder layout, the `mount()` lifecycle, the no-`<script>`-in-`view.html` rule, the cleanup-on-return contract — all the rules in `component/SKILL.md` apply. A relationship is just a component that lives in a different folder, is hidden by default, and implements `connect()`. If a relationship later needs UI (a knob, a visualizer), give its `view.html` real content and unhide it; everything else stays the same.
