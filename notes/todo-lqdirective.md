# TODO: `<lqdirective>` fast path

A draft fast-path for the runtime agent — component callbacks (chat-style
inputs, "plan a night" buttons, etc.) wrap their prompt in
`<lqdirective>…</lqdirective>` so the agent skips the full LiquidOS protocol
(history-and-undo restore, opening activity badge, full `<lqpatch>` flow)
and follows ONLY the instructions inside the directive.

Was prototyped in `skills/AGENTS.md` during the morph/persist work. Pulled out
into this file so it doesn't ride along on unrelated commits. Decide
whether/where to land it before re-adding to the runtime system prompt.

Proposed addition at the top of `skills/AGENTS.md`:

> ## Prompt directive (fast path)
>
> If the prompt contains a `<lqdirective>…</lqdirective>` block, follow ONLY
> the instructions inside that block and ignore the rest of this file. No
> history-and-undo restore, no opening activity badge, no other `<lqpatch>`
> protocol unless the directive itself asks for them. The directive's
> author — typically a component callback like a chat — has already decided
> what the response should look like; just do that.
>
> End-of-turn done marker is still required: the very last thing you emit
> must be `<lqpatch target="#agent-activity" op="replace"></lqpatch>` to
> signal the turn is finished. Then stop.
>
> Everything below applies only when no directive is present.

## Open questions

- Should the done-marker requirement live in the directive itself instead of
  in the system prompt? Otherwise the agent needs to remember a rule the
  directive author can't see.
- Is `<lqdirective>` the right tag name, or does it want a namespace prefix
  (like `lq:directive`) to keep it visually distinct from the agent's own
  `<lqpatch>` output?
- What does the prompt builder do with a directive that asks for tool use
  the fast path explicitly forbids? (Today: the LLM resolves it however
  it chooses — no enforcement.)
- Should there be a probe that exercises a callback's directive end-to-end
  (component callback fires → agent receives directive → agent emits the
  directive's `<lqpatch>` markers → DOM updates)?
