---
name: history-and-undo
description: Restore LiquidOS context from git history and undo changes safely
---

# Conversation History, Memory and Undo

LiquidOS tracks activities to git at `.liquidos/` of the <scope>. The history includes user prompts, agent responses, system events, file changes and the surrounding diffs. You can bookmark things with hash-tags in your ourput to make them easier to find later.

Use the Git history as read-only context to help answer what happened, why something changed, how a component evolved, or what the user previously asked for. Search the Git history before guessing about previous activity or recent file changes.
Do not write to Git history. Read Git history only, except when the user asks to undo something; then use `git revert`. Do not run `git commit`.

## Restoring Context

Walk back one commit at a time until a commit seems unrelated to the latest user prompt.
If the first walk back seems unrelated, you can also try searching by other predicates. 
Once you have loaded enough context, simply continue the conversation as if it was there to being with.
Always use beginning and end tags when walking back:

```text
[[LIQUIDOS_RESTORE_CONTEXT_BEGIN]]
git show --format=fuller --stat HEAD
git show --format=fuller --stat HEAD~1
git show --format=fuller --stat HEAD~2
[[LIQUIDOS_RESTORE_CONTEXT_END]]
```

## Undoing Changes

If the user ask for simple undo, just call `git revert` without much inspection or review. 
If a user asks for a more advanced undo, inspect and review.
Revert is the only history-mutating command the agent is allowed to use.
