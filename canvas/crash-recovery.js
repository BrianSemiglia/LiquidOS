//
// crash-recovery.js
//
// When the server dies on an uncaught exception, something in the workspace
// the agent built took the whole process down. The harness does NOT try to
// guess or fix that itself — it can't know what the real problem is. It only
// does two things: on the way down it records what crashed, and on the way
// back up it hands that to the agent and lets the agent decide what to do —
// fix the offending code, or disable whatever it judges unsafe.
//
// The recovery is not component-specific: the harness names no culprit. It
// hands the agent the crash and points it at the git log, where every prior
// recovery attempt left its reasoning (the commit message and diff are the
// notes). The agent reads that history to see what has already been tried and
// what still needs handling, then acts.
//
// The loop is the safety net: the app restarts the server (it owns the
// server's lifecycle), boots it in --recovery mode to let the agent repair,
// and if the agent's change didn't actually stop the crash the whole thing
// happens again — the agent reading its own previous commits each time.
//
// The marker is a dotfile so the canvas file walkers (which skip dotted names)
// never treat it as a canvas or surface it in the UI.
//

const fs = require('fs');
const path = require('path');

const MARKER = '.crash-report.json';

const markerPath = workspacePath => path.join(workspacePath, MARKER);

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

// Constant instructions first, then the variable arguments as labeled sections
// at the end — so the arguments (here the error and stack) are trivial to parse
// off the end and the instructions are one fixed block to check against.
const crashRepairPrompt = ({ reason, stack }) => [
    'The LiquidOS server just crashed and was restarted. Something in this',
    'workspace took the whole server down.',
    '',
    'Minimal, transitory changes were made to allow the server to boot again —',
    'just enough to keep the rest of the workspace running, not a real fix. Now',
    'try to fix the underlying issues that caused the crash, if you can. If you',
    'fix one, undo the transitory change that worked around it; if you cannot',
    'fix it safely, leave the transitory change in place so the workspace keeps',
    'booting.',
    '',
    'This may not be your first attempt. Check `git log` for previous',
    '"LiquidOS did recover from crash" commits and the diffs they made — that',
    "is where earlier attempts left their reasoning. Read it so you don't",
    'repeat a fix that did not work and so you can see what still needs',
    'handling. If the crash continues the server will restart and ask again.',
    '',
    'Error:',
    reason || '(no message)',
    '',
    'Stack:',
    (stack || '').trim() || '(none)'
].join('\n');

module.exports = {
    writeCrashReport,
    consumeCrashReport,
    crashRepairPrompt
};
