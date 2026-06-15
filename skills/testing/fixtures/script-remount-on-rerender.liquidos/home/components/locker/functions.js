// The markup ships a placeholder status; running the behavior is what
// produces the live status string. That string is the visible,
// process-produced result a probe looks for — nothing private.
export const mount = (surface) => {
    const status = surface.querySelector('.status');
    if (status) status.textContent = 'behavior connected';
};
