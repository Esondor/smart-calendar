import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
bus.setMaxListeners(200);
// tell the open web apps of these users that something changed ("plan", "tasks", "sync", ...)
export const notifyUsers = (uids, what = 'tasks') => [...new Set(uids)].forEach(u => bus.emit('u:' + u, what));
