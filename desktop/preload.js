// What the game page may ask of the desktop app, and nothing more: fullscreen, for its Settings dialog.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  setFullScreen: (on) => ipcRenderer.send('fullscreen:set', !!on),
  isFullScreen: () => ipcRenderer.invoke('fullscreen:get'),
  onFullScreen: (fn) => {
    ipcRenderer.on('fullscreen:changed', (_e, on) => fn(!!on));
  },
});
