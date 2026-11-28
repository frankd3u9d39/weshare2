import { contextBridge, ipcRenderer } from 'electron';

// The print screen's only link to the rest of Weshare: read the job, list printers, print.
contextBridge.exposeInMainWorld('weshareprint', {
  getJob: () => ipcRenderer.invoke('print:get-job'),
  getPrinters: () => ipcRenderer.invoke('print:printers'),
  print: (options: unknown) => ipcRenderer.invoke('print:run', options),
  close: () => ipcRenderer.invoke('print:close'),
  onUpdate: (callback: (job: unknown) => void) => {
    ipcRenderer.on('print:job-updated', (_event, job) => callback(job));
  }
});
