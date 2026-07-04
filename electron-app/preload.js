const { contextBridge, ipcRenderer } = require('electron');

// The bridge the app-owned chooser page uses to ask the main process to show
// the native Open/Create panels — the Electron analogue of the Swift app's
// `window.webkit.messageHandlers.liquidosMac.postMessage('open' | 'create')`.
// The canvas itself (served from the server) never uses this; it only appears
// on the app-owned data: pages rendered below.
contextBridge.exposeInMainWorld('liquidosNative', {
    open: () => ipcRenderer.send('workspace:open'),
    create: () => ipcRenderer.send('workspace:create'),
});
