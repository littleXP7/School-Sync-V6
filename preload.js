const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  invoke: (c, d) => ipcRenderer.invoke(c, d),
  on: (c, f) => ipcRenderer.on(c, (_, d) => f(d))
});
