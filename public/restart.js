// A page remembers the server's start id; when a reconnect delivers a different one, the server restarted and the page
// should reload (new code, fresh state). Unknown ids (older server, first snapshot) never count as a restart, so a short
// network blip with the same server does not reload.
export const restarted = (before, now) => typeof before === 'string' && typeof now === 'string' && before !== now;
