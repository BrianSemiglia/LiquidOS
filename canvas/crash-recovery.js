//
// crash-recovery.js
//
// When the server dies on an uncaught exception, something in the workspace
// the agent built took the whole process down. The harness does NOT try to
// guess or fix that itself — it can't know what the real problem is. Recovery
// happens in two phases, each one a dispatch to the agent on a normal boot
// (there is no special server mode):
//
//   Phase 1 — make it bootable. A crash leaves a marker; the next boot hands
//     the agent the crash and asks for the smallest, most transitory change
//     that stops it. The committed attempt (RECOVER_EVENT) is what owes Phase 2.
//   Phase 2 — make it permanent. Once Phase 1 has committed, a fresh agent is
//     asked to fix the underlying cause for real (proving it in a sandbox) and
//     undo the transitory change.
//
// Neither phase is component-specific: the harness names no culprit. It records
// the crash and points the agent at the git log, where every prior attempt left
// its reasoning (the commit message and diff are the notes). Phase 2 is owed
// whenever the latest "recover from crash" has not yet been followed by a
// permanent-fix attempt — read straight off that same timeline, no extra state.
//
// The marker is a dotfile so the canvas file walkers (which skip dotted names)
// never treat it as a canvas or surface it in the UI.
//

const fs = require('fs');
const path = require('path');

const MARKER = '.crash-report.json';

const markerPath = workspacePath => path.join(workspacePath, MARKER);

// The events committed for each phase. They are the contract between the two
// phases and the test, and what permanentFixOwed scans the timeline for.
const RECOVER_EVENT = 'LiquidOS did recover from crash';
const FIX_EVENT = 'LiquidOS did attempt a permanent fix';

// Synchronous on purpose: this runs inside the uncaughtException handler with
// the process about to exit, so it must land before the event loop stops.
const writeCrashReport = (workspacePath, report) => {
    try {
        fs.writeFileSync(markerPath(workspacePath), JSON.stringify({
            reason: String(report.reason || ''),
            stack: String(report.stack || '')
        }, null, 2));
    } catch { /* a crash we can't even record is still a crash — just exit */ }
};

const consumeCrashReport = workspacePath => {
    const file = markerPath(workspacePath);
    try {
        const raw = fs.readFileSync(file, 'utf8');
        fs.unlinkSync(file);
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

// Walking the timeline newest-first: a permanent fix is owed when the most
// recent crash recovery has not yet been followed by a permanent-fix attempt.
const permanentFixOwed = events => {
    for (const event of (events || [])) {
        if (event === FIX_EVENT) return false;
        if (event === RECOVER_EVENT) return true;
    }
    return false;
};

// Phase 1. Constant instructions first, then the variable arguments (the error
// and stack) as labeled sections at the end — so the arguments are trivial to
// parse off the end and the instructions are one fixed block to check against.
const crashRepairPrompt = ({ reason, stack }) => `The LiquidOS server just crashed and was restarted. Something in this
workspace took the whole server down.

Right now your only job is to get the server booting again. Make the
smallest, most transitory change that stops the crash — disable or stub
whatever is taking the server down so the rest of the workspace can run.
This is not the real fix: once the server is back up a follow-up will try
to fix it properly. Keep your change minimal and easy to undo.

This may not be your first attempt. Check \`git log\` for previous
"LiquidOS did recover from crash" commits and the diffs they made — that
is where earlier attempts left their reasoning. Read it so you don't
repeat a fix that did not work. If the crash continues the server will
restart and ask you again.

Error:
${reason || '(no message)'}

Stack:
${(stack || '').trim() || '(none)'}`;

// Phase 2. No arguments — the agent reads the timeline for what the transitory
// change was and why, and for any earlier permanent-fix attempts.
const permanentFixPrompt = () => `The LiquidOS server crashed earlier and was made bootable with a minimal,
transitory change — it is running now. Make a permanent fix for the
underlying cause, then undo the transitory change so the workspace is whole
again.

You must do this in a sandbox: a bad fix would crash the live server again,
so reproduce the crash and prove the fix in a sandbox before you touch the
live workspace. See the \`testing\` skill for how to boot a workspace sandbox.
Only once the fix holds in the sandbox: apply it to the live workspace and
undo the transitory change. If you cannot make it safe, leave the transitory
change in place.

Check \`git log\` for the "LiquidOS did recover from crash" commit and its
diff to see what was changed and why, and for any earlier permanent-fix
attempts so you do not repeat one that did not work.`;

module.exports = {
    RECOVER_EVENT,
    FIX_EVENT,
    writeCrashReport,
    consumeCrashReport,
    permanentFixOwed,
    crashRepairPrompt,
    permanentFixPrompt
};
