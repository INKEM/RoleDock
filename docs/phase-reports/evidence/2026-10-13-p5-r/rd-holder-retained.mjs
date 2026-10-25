import { WorkspaceStore } from '/home/inkem/Personal/RoleDock/packages/core/dist/testing.js';
const store = WorkspaceStore.open({ root: process.argv[2] });
console.log('held');
setInterval(() => { store.getConfig(); global.gc(); }, 10);
