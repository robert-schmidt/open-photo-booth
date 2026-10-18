const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('booth', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: s => ipcRenderer.invoke('settings:set', s),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  importTemplate: () => ipcRenderer.invoke('templates:import'),
  templateAsset: (id, rel) => ipcRenderer.invoke('template:asset', id, rel),
  savePhoto: (name, data) => ipcRenderer.invoke('photo:save', name, data),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  print: (file, widthIn, heightIn) => ipcRenderer.invoke('print', file, widthIn, heightIn),
  chooseFolder: () => ipcRenderer.invoke('dialog:folder'),
  openFolder: () => ipcRenderer.invoke('shell:open'),
  quit: () => ipcRenderer.invoke('app:quit'),
})
