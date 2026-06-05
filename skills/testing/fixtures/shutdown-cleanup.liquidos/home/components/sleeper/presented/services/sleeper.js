// Long-lived child of start.sh. The shutdown probe captures this PID
// (and start.sh's PID) before quitting the launcher, then asserts both
// are gone after SIGTERM has propagated through the chain.
setInterval(() => {}, 60000);
