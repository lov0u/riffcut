// 渲染进程的唯一对外面：window.riffcut
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('riffcut', {
  info: () => ipcRenderer.invoke('app:info'),

  // 内核
  start: (opts) => ipcRenderer.invoke('kernel:start', opts || {}),
  prompt: (p) => ipcRenderer.invoke('kernel:prompt', p),
  wait: (p) => ipcRenderer.invoke('kernel:wait', p),
  setModel: (p) => ipcRenderer.invoke('kernel:model', p),
  onEvent: (cb) => ipcRenderer.on('kernel:event', (_e, d) => cb(d)),
  onReady: (cb) => ipcRenderer.on('kernel:ready', (_e, d) => cb(d)),

  // 素材
  templates: (q) => ipcRenderer.invoke('assets:templates', q || {}),
  skills: () => ipcRenderer.invoke('assets:skills'),

  // 原生 DSH 界面
  openNative: () => ipcRenderer.invoke('native:open'),
  nativeInfo: () => ipcRenderer.invoke('native:info'),

  // 权限与范围
  setPerm: (p) => ipcRenderer.invoke('app:perm', p || {}),

  // 工具：studio.html 里所有操作都走这一条（和 AI 同一套注册表 + 同一套
  // 权限判定，不会出现界面能点、AI 不能做的缝）
  call: (name, args, customer) => ipcRenderer.invoke('tools:call', { name, args, customer }),
  tools: () => ipcRenderer.invoke('tools:list'),

  // 剪辑台。为什么单开一组而不是全走 call('edit_timeline')：
  // 拖一下片段就要存盘（几十毫秒一次），走工具层要过授权判定、拼人读文本、
  // JSON 来回转，卡手。这五条直接对 timeline.js，出入都是结构化数据。
  tlList: () => ipcRenderer.invoke('tl:list'),
  tlLoad: (name) => ipcRenderer.invoke('tl:load', name),
  tlSave: (name, doc) => ipcRenderer.invoke('tl:save', name, doc),
  tlImport: (name, srcPath) => ipcRenderer.invoke('tl:import', name, srcPath),
  tlPreview: (name) => ipcRenderer.invoke('tl:preview', name),

  // 系统
  openPath: (p) => ipcRenderer.invoke('sys:open', p),
  // 反馈：唤起系统邮件客户端，预填版本与系统信息
  feedbackMail: (opts) => ipcRenderer.invoke('feedback:mail', opts || {}),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', String(url || '')),
  // 复制代码到剪贴板：走主进程 clipboard，渲染进程 sandbox + velora:// 协议下
  // navigator.clipboard / execCommand 都不可靠，主进程写系统剪贴板最稳
  copyText: (text) => ipcRenderer.invoke('app:copyText', String(text == null ? '' : text)),
  // 选文件夹（原生对话框，返回绝对路径）——添加工作区/拖入素材用
  pickFolder: (opts) => ipcRenderer.invoke('sys:pickFolder', opts || {}),
  // 拖拽的 File 取绝对路径（Electron 32+ 用 webUtils，File.path 已移除）
  pathForFile: (file) => ipcRenderer.invoke('sys:pathForFile', file),
  // 一键重启（装插件/改 bundle 后生效必须重启）
  restart: () => ipcRenderer.invoke('app:restart'),

  /* 窗口控制：前端自绘的红绿灯用它（原生按钮已用 setWindowButtonVisibility 隐藏）。
     旧版走 window.webkit.messageHandlers —— 那是 WKWebView 的通道，
     Electron 里不存在，所以之前点红绿灯只弹「系统能力待接入」。 */
  winAction: (act) => ipcRenderer.invoke('win:action', String(act || '')),
})
