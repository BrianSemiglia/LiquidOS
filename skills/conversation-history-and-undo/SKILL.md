# Conversation History, Memory and undo

LiquidOS tracks activities to git at `.liquidos/` of the <scope>. The history includes user prompts, agent responses, system events, file changes and the surrounding diffs.

Use Git history as read-only context to help answer what happened, why something changed, how a component evolved, or what the user previously asked for. Search Git history before guessing about previous activity or recent file changes.

## Restoring Context

When restoring context, walk back one commit at a time until a commit seems unrelated to the newest prompt. If the first walk back seems unrelated you can also try searching.

## Undoing Changes

If a user asks the agent to undo something or go back, use `git revert` to restore the desired previous state. Revert is the only history-mutating command the agent is allowed to use.
