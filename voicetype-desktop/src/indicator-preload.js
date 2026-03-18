const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voicetype', {
  setSoap: (on) => ipcRenderer.send('soap-toggle', on),
  setSkill: (idx) => ipcRenderer.send('skill-select', idx),
  pushToTalkStart: () => ipcRenderer.send('push-to-talk-start'),
  pushToTalkStop: () => ipcRenderer.send('push-to-talk-stop')
});
