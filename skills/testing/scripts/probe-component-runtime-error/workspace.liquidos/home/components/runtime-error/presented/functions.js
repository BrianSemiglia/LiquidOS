// Schedules a throw on the next tick so it lands AFTER mount() returns
// and reaches the harness via window.onerror. The thrown error's stack
// contains this file's URL, which is what the harness's runtime listener
// uses to attribute the error back to this component.
export const mount = (surface) => {
    setTimeout(() => {
        throw new Error('SIMULATED_RUNTIME_ERROR_FOR_TEST');
    }, 150);
    return () => {};
};
