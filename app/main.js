// 影创新版 · 主进程
//
// 架构：Electron 窗口 ← IPC → 本进程（Node）← stdio JSON-RPC → DSH 内核
// 只两层，没有 Python 桥。
/* ★ 启动计时。用户双击到能用多久是体验的生死线，必须能一眼看出慢在哪一步。
   RiffCut_DEBUG=1 时每个关键节点往 stderr 打一行毫秒数。 */
const __T0 = Date.now()
const __mark = (n) => {
  if (!process.env.RiffCut_STARTUP_TRACE) return
  process.stderr.write('[boot] ' + String(Date.now() - __T0).padStart(6) + ' ms  ' + n + '\n')
}
__mark('main.js 加载开始')

const Turn = require('./lib/turn')
const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } = require('node:fs')
const { Kernel, KERNEL_DIR } = require('./lib/kernel')
const { buildProfile } = require('./lib/profile')

const ROOT = join(__dirname, '..')
/* ★ 打包后 home 不能放在 app 包里。
   .app 是只读的（而且改了会破签名），客户素材/工程/成片写进去等于写进安装包，
   一换版本全丢。打包后指到 ~/Library/Application Support/影创新版，
   开发时仍用仓库里的 home/（方便调试时直接看文件）。
   判断依据用 app.isPackaged —— 不要用 __dirname 里有没有 .app，那个字符串不可靠。 */
function resolveHome() {
  if (process.env.RiffCut_HOME) return process.env.RiffCut_HOME
  if (app.isPackaged) {
    const { homedir } = require('node:os')
    return join(homedir(), 'Library', 'Application Support', 'RiffCut影创')
  }
  return join(ROOT, 'home')
}
const HOME = resolveHome()
/* ★ 内核状态目录（2026-11-20）：DSH 的 profiles/sessions/storages 不该跟
   业务数据混在 HOME 根下 —— 一个 ls 就分不清哪些是用户的、哪些是内核的。
   见 lib/paths.js 的 KERNEL_HOME。这里保持同一份命名，避免两处不一致。 */
const KERNEL_HOME = join(HOME, '内核')
const KERNEL = process.env.RiffCut_KERNEL || join(ROOT, 'kernel', 'dsh')
const PROFILE = 'velora'
const WIN_W = 1440, WIN_H = 900

// ── 我们自己的页面用私有协议暴露给 DSH 界面里的 iframe ────────────────
// 为什么要自定义协议而不是 file://：DSH 的界面是 http://127.0.0.1:PORT，
// 从 http 页面里 iframe 一个 file:// 会被 Chromium 直接拦掉（跨协议）。
// 私有协议登记成 standard + secure 之后就能正常嵌。
/* ★ 应用名要在 app.whenReady 之前设。
   不设的话 Dock / 菜单栏 / 关于面板都显示 package.json 里的 productName（「影创新版」），
   而用户认的是 RiffCut影创。 */
app.setName('RiffCut影创')

/* ★★ 把 Electron 自己的 userData 挪进子目录（2026-11-20）。
   根目录脏的根因就在这里：app.setName('RiffCut影创') 之后，
   Electron 默认把 userData 定在 ~/Library/Application Support/RiffCut影创，
   而 resolveHome() 也返回同一个路径 —— 两者撞在一起了。

   结果是那一层混了三类完全不该混的东西：
     · Chromium 的：Cache / Code Cache / GPUCache / DawnWebGPUCache /
       GraphiteDawnCache / Local Storage / Session Storage / blob_storage /
       DIPS / Trust Tokens / Network Persistent State / Preferences / SingletonLock…
     · DSH 内核的：profiles/ sessions/ storages/ logs/
     · 我们自己的：客户/ 资源/ 模板库/ 配置/ 系统/ 知识库/ 内置/ 缓存/

   用户点开数据目录看到的第一屏就是二十几个 Chromium 缓存目录，
   AI 拿这个当工作目录 `ls` 一次，看到的第一层也是这些 —— 它当然会去翻，
   这不是它不听话，是环境本身没收拾干净。用户原话（m05899）：
   「不要用一些东西去限制 AI 的能力，如果说哪里有问题，考虑一下是不是
     你的流程设置得不对，而不要去强烈地限制它。」

   所以拆开：Electron 的东西进 <HOME>/运行时/，业务数据留在 <HOME>/ 根，
   内核状态进 <HOME>/内核/。AI 的 cwd 只给业务数据这一层。
   ★ 必须在 whenReady 之前调用，晚了 Chromium 已经开始往旧位置写。 */
const USER_HOME = resolveHome()
const CHROME_DIR = join(USER_HOME, '运行时')
/* ★ 老用户升级时，根目录已经有一批 Chromium 残留（旧版本没设 userData 时写的）。
   只把新位置设过去是不够的 —— 旧的一堆 Cache/GPUCache/Local Storage 会原样留在
   根目录里，用户点开看到的还是那片垃圾。所以先搬再设。

   搬的名单是 Chromium userData 的标准内容，逐项列出来而不是通配 —— 通配很容易
   误伤用户自己放的文件（他可能往数据目录里丢个 .mp4 试试）。
   只搬「根目录有、运行时/ 里还没有」的，一个都不覆盖；
   同盘 renameSync 是原子的，跨盘会自动退回 cp+rm。 */
const CHROME_LEFTOVERS = [
  'Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
  'Local Storage', 'Session Storage', 'Shared Dictionary', 'blob_storage',
  'Extension State', 'Extension Rules', 'Extension Scripts',
  'DIPS', 'DIPS-wal', 'Trust Tokens', 'Trust Tokens-journal',
  'Network Persistent State', 'Preferences', 'Local State',
  'SingletonCookie', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal',
]
function moveChromeLeftovers() {
  const { existsSync, renameSync, cpSync, rmSync } = require('node:fs')
  let n = 0
  for (const name of CHROME_LEFTOVERS) {
    const from = join(USER_HOME, name)
    const to = join(CHROME_DIR, name)
    try {
      if (!existsSync(from) || existsSync(to)) continue
      renameSync(from, to)
      n++
    } catch (e) {
      /* 跨盘时 rename 会 EXDEV，退回复制再删 */
      try {
        cpSync(from, to, { recursive: true })
        rmSync(from, { recursive: true, force: true })
        n++
      } catch (e2) {
        /* 搬不动就算了 —— 留着不影响功能，只是根目录难看一点。
           这里绝不能抛：抛了主进程直接死，用户看到的是「双击没反应」。 */
      }
    }
  }
  if (n) process.stderr.write('[main] 运行时残留已归位: ' + n + ' 项\n')
}

/* ★ 浏览器缓存会无限长（2026-11-20，用户 m06193 明确要求「那个自动清理你做一下」）。
   实测依据：这台机器上 Chrome-headless 攒了 3001 个 scoped_dir 目录、6GB。
   Electron 的 Cache / Code Cache / GPUCache 一个道理 —— 只要在用就一直涨，
   而且从来不会自己收缩。放在数据目录里，用户过几个月发现磁盘少了一个 G。

   策略：启动时看一眼 运行时/ 总共多大，超过上限就整目录删掉重建。
   ★ 删的是整个 运行时/ 而不是里面挑几个目录 —— 里面的东西全是可再生的
     （缓存、窗口位置、Local Storage 里也就几个界面偏好），
     挑着删容易漏（Chromium 的缓存目录名单每个版本都在变），整删最省心。
   ★ 只删 运行时/，绝不碰 内核/ ——那里有历史对话。
   ★ 删失败就当没这回事，继续启动。清缓存永远不该挡住用户用软件。 */
const RUNTIME_LIMIT = 500 * 1024 * 1024   // 500MB

function dirSizeBytes(dir) {
  const { readdirSync, statSync } = require('node:fs')
  const { join: j } = require('node:path')
  let total = 0
  const walk = (p) => {
    let ents
    try { ents = readdirSync(p, { withFileTypes: true }) } catch (e) { return }
    for (const e of ents) {
      const full = j(p, e.name)
      try {
        if (e.isDirectory()) walk(full)
        else if (e.isFile()) total += statSync(full).size
        /* 软链不算：size 是链接本身，跟目标无关，算进来没意义 */
      } catch (e2) { /* 权限不足/文件刚被删，跳过 */ }
    }
  }
  walk(dir)
  return total
}

function pruneRuntimeIfHuge() {
  const { rmSync } = require('node:fs')
  try {
    if (!existsSync(CHROME_DIR)) return
    const size = dirSizeBytes(CHROME_DIR)
    if (size < RUNTIME_LIMIT) return
    const mb = Math.round(size / 1048576)
    /* ★ 先删再建：反过来（先建后删）等于把自己刚建的空目录也删了，
       后面 setPath 会指向一个不存在的路径，Chromium 会自己再建 —— 能用，
       但日志里天天一行 ENOENT，纯噪音。 */
    rmSync(CHROME_DIR, { recursive: true, force: true })
    mkdirSync(CHROME_DIR, { recursive: true })
    process.stderr.write('[main] 运行时缓存 ' + mb + 'MB 超过上限，已清空重建\n')
  } catch (e) {
    process.stderr.write('[main] 清运行时缓存失败（不影响使用）: ' + e.message + '\n')
  }
}

try {
  mkdirSync(CHROME_DIR, { recursive: true })
  moveChromeLeftovers()
  pruneRuntimeIfHuge()
  /* ★ 顺序要紧：prune 必须在 setPath 之前 —— setPath 之后 Chromium 就开始
     往里面写文件了，这时候 rm 会跟它抢同一个目录。 */
  app.setPath('userData', CHROME_DIR)
  app.setPath('sessionData', CHROME_DIR)
} catch (e) {
  process.stderr.write('[main] 设置运行时目录失败，退回默认: ' + e.message + '\n')
}

/* ★ 调试端口开关：只有显式设了 RiffCut_DEBUG_PORT 才开。
   为什么需要它：Electron 的打包产物不认命令行里的 --remote-debugging-port
   （会报 bad option），而排查「界面上点了没反应」「某个按钮不工作」这类问题，
   没有 DevTools 协议就只能靠猜。开着它，外部工具才能读到真实 DOM、真点按钮。
   默认关闭 —— 普通用户跑的时候不留任何监听端口。 */
;(function debugPort() {
  const p = Number(process.env.RiffCut_DEBUG_PORT) || 9333 /* TEST-TEMP */
  if (!p || p < 1024 || p > 65535) return
  try {
    app.commandLine.appendSwitch('remote-debugging-port', String(p))
    app.commandLine.appendSwitch('remote-allow-origins', '*')
    process.stderr.write('[debug] DevTools 端口已开: ' + p + '\n')
  } catch (e) { /* 开不了就算了，不能影响正常启动 */ }
})()

/* ★ 单实例锁：不做这件事的话，用户点两次图标就是两个进程、两个窗口、
   两套内核抢同一个端口。症状是「打开一次启动两个窗口」+ 其中一个永远连不上内核。
   第二个实例直接退出，把焦点还给已经开着的那个窗口。 */
const _single = app.requestSingleInstanceLock()
if (!_single) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'velora', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/**
 * 内核要跑在有界面模式下才有原生 UI 能力：
 * bundles = dsh-base + dsh-web-app → 保留插件市场、设置、插件管理。
 * 我们自己的界面通过 webview 叠在它上面（不是替换）。
 */
function openUiUrl() { return process.env.RiffCut_UI_URL || null }

function startKernel(win) {
  const k = new Kernel({ kernelDir: KERNEL, homeDir: KERNEL_HOME, profile: PROFILE })
  k.on('event', (sid, ev) => {
    if (win.isDestroyed()) return
    // ★ assistant/message 里混着 reasoning 和 tool-call，直接整条转给界面
    //   会让聊天区出现一大段英文思考过程。这里按块拆开，界面各取各的。
    let extra = null
    if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
      extra = Turn.makeTurn(ev.data.message)
    }
    win.webContents.send('kernel:event', { sessionId: sid, event: ev, turn: extra })
  })
  k.on('stderr', (d) => { process.env.RiffCut_DEBUG && process.stderr.write('[core] ' + d) })
  k.on('ready', (info) => {
    if (!win.isDestroyed()) win.webContents.send('kernel:ready', info)
  })
  // 内核自己打印的带 token 地址 —— 唯一能进的地址（裸端口 401）
  // ★ 内核跑起来会打印一个带 token 的 Web UI 地址。我们不再把窗口跳过去 ——
  //   那是 DSH 的界面，跳过去我们自己的前端就全没了（12 个页面一件不剩）。
  //   内核只在后端跑，界面只用于调试时手动打开。
  /* 子智能体通知：内核会发 subagent.started / subagent.finished，但它是通知不是请求，
     内核不提供「列出当前在跑的子智能体」的查询。所以主进程自己记账（lib/agents.js），
     界面到 /api/agents 读。顺手转一份给窗口，正在看这一页的人不用等轮询。 */
  k.on('notify', (method, params) => {
    try {
      const G = require('./lib/agents')
      const sid = (params && (params.sessionId || params.parentSessionId)) || ''
      if (method === 'subagent.started') G.started(sid, params || {})
      else if (method === 'subagent.finished') G.finished(sid, params || {})
      else return
      if (win && !win.isDestroyed()) win.webContents.send('kernel:agents', G.list())
    } catch (e) {
      /* 记账坏了不能影响内核本身 */
      if (process.env.RiffCut_DEBUG) process.stdout.write('[core] 子智能体记账失败: ' + e.message + '\n')
    }
  })
  k.on('web', (url) => {
    kernelUiUrl = url
    if (process.env.RiffCut_DEBUG) process.stdout.write('[core] Web UI（调试用，不加载）: ' + url + '\n')
    if (!win.isDestroyed()) win.webContents.send('kernel:ui', url)
  })
  return k
}

let mainWin = null
let kernel = null
let kernelUiUrl = null

function createWindow() {
  mainWin = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    minWidth: 1024, minHeight: 680,
    show: false,
    /* ★ 用 hidden 不是 hiddenInset：
       hiddenInset 会把三颗系统红绿灯叠到我们自绘的顶栏上，
       而前端 shell.html 里已经自己画了一套 .lights（还绑了最小化/全屏/关闭），
       结果就是「红绿灯重影、位置还歪」。hidden 之后系统不画，
       由前端那套负责；下面再把原生按钮藏掉兜底。 */
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    backgroundColor: '#0E1013',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 原生 DSH 界面是 <webview> 加载内核自己的 Web UI —— 不开这个开关
      // 标签存在但不会工作（点了没反应，控制台也没有明显报错）。
      webviewTag: true,
      // iframe 里也要能拿到 window.riffcut —— 剪辑台面板是 iframe，
      // 不开这个开关它就只有 dom、调不到任何后端能力。
      nodeIntegrationInSubFrames: true,
    },
  })
  // 窗口先显示占位页（避免白屏几秒），内核起来后再 loadURL 跳过去。
  // ★ 界面就是 DSH 自己的 Web UI —— 不复制、不注入、不魔改 DOM。
  //   我们要改的地方（侧栏顶部 + 首页 hero）全部通过官方 client 插件的
  //   slots 注册进去，内核升级时跟着走，不存在「他们改了结构我们就瞎」。
  // 界面是我们自己的完整前端（旧版 12 个页面搬过来的），
  // 用 velora://app/ 走自定义标准协议加载 —— 相对路径和 /api/* 都按正常网页规则工作。
  /* 双保险：hidden 之后个别 macOS 版本仍会残留按钮区，
     setWindowButtonVisibility(false) 直接把它们关掉。 */
  try { mainWin.setWindowButtonVisibility(false) } catch (e) {}
  /* ★ 两步加载：先亮启动页，再把完整界面换上来。
     完整前端是一个 988KB 的 HTML、20 个内联脚本同时初始化、并发几十个 /api ——
     实测要 12 秒才画第一帧。用户双击后对着黑屏等十几秒就是「软件打不开」。
     启动页是 900 字节，几十毫秒就出来，logo 一出现用户心里就踏实了；
     主界面在同一个窗口里随后顶上来。 */
  mainWin.loadFile(join(__dirname, 'renderer', 'boot.html'))
  setTimeout(() => {
    try { if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL('velora://app/') } catch (e) {}
  }, 60)
  /* ★ 不要等 ready-to-show 才显示窗口。
     ready-to-show 要等「首帧可以画出来」，而我们这一整个前端是 16 个页面
     一次性塞进同一个 HTML、各自的初始化脚本同时跑、并发几十个 /api 请求 ——
     实测要 36 秒。用户双击后三十多秒什么都看不到，会以为软件坏了。
     改成 dom-ready 就显示（此时窗口是深色底 + 顶栏，已经有东西了），
     页面内容自己往上填。慢的部分在后台继续跑，不挡着用户看。 */
  mainWin.once('dom-ready', () => { try { mainWin.show() } catch (e) {} })
  // 兜底：万一 dom-ready 没触发（协议层出错），1.2 秒也把窗口亮出来
  setTimeout(() => { try { if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show() } catch (e) {} }, 1200)
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  return mainWin
}

/**
 * 起内核之前先把端口定下来。
 * ★ 必须在 Node 侧挑好写进 port.txt：profile 生成时把这个数字直接写进 YAML。
 *   把「读文件算端口」塞进 cordis 的 !!js 表达式会拿到 [object Object]，
 *   内核直接 ValidationError；写死一个值又会在撞端口时整个起不来。
 */
function pickPort() {
  const P = require('./lib/paths')
  const { createServer } = require('node:net')
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(0))
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => {
        try {
          const dir = join(P.HOME, '配置')
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'port.txt'), String(port), 'utf8')
        } catch {}
        resolve(port)
      })
    })
  })
}

/* 第一次启动（打包版）：把仓库里的 home/ 内容搬进 Application Support。
   为什么要搬：客户素材、模板库、41 条导演技能、9 个剪辑工程都在 home 里，
   不搬过去的话用户打开软件看到的是一个空软件，以为东西全没了。
   只在目标目录不存在或为空时搬，绝不覆盖用户已有的数据。 */
/* 首次启动：把包内自带的初始数据（模板库 / 内置技能 / 配置默认值）铺到 HOME。
   ★ 只搬 Resources/seed-home 里那几样，不搬客户素材、不搬工程、不搬成片。
     那些是用户的东西，第一次装软件别人不该看见我的项目。
   ★ 逐个子目录搬，不整体搬：整体 cpSync 遇到 HOME 里已有同名目录时
     行为取决 force 选项，容易把人家的配置覆盖掉。 */
const SEED_DIRS = ['模板库', '内置', '配置', '系统']
/* ★ AGENTS.md 是内核的系统提示词，躺在 seed-home 根下而不是某个子目录里，
   所以不在上面那个列表里 —— 结果一直没被铺到用户目录，内核从来没读到。
   2026-11-20 实测：用户说「你好」，内核按 DSH 默认的 coding agent 提示词行事，
   去 ls 目录、list_mcp_resources、列能力清单，走了 48 步。
   这里单独补上：只在用户目录没有时铺一次，之后用户改了就不再覆盖。 */
const SEED_FILES = ['AGENTS.md']

/** 把 src 里「dst 还没有」的文件补过去，已存在的一律不覆盖。
 *  只用于初始数据铺底：目的是让升级后新增的默认文件能到位，
 *  绝不能拿包内默认值盖掉用户改过的配置。 */
function fillMissing(src, dst) {
  const { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } = require('node:fs')
  const { join: j } = require('node:path')
  if (!existsSync(dst)) { mkdirSync(dst, { recursive: true }) }
  for (const name of readdirSync(src)) {
    if (name === '.DS_Store') continue
    const s = j(src, name)
    const d = j(dst, name)
    let st
    try { st = statSync(s) } catch (e) { continue }
    if (st.isDirectory()) {
      // 本地模型目录整个跳过：几百 MB，交给 linkBigModels 建软链
      if (name === '本地模型') continue
      fillMissing(s, d)
    } else {
      if (existsSync(d)) continue
      try { copyFileSync(s, d) } catch (e) { /* 单个失败不影响其他 */ }
    }
  }
}

function seedHomeIfEmpty() {
  if (!app.isPackaged) return
  const { existsSync, mkdirSync, cpSync, copyFileSync } = require('node:fs')
  const seedRoot = join(ROOT, 'seed-home')
  if (!existsSync(seedRoot)) return
  mkdirSync(HOME, { recursive: true })
  for (const d of SEED_DIRS) {
    const src = join(seedRoot, d)
    const dst = join(HOME, d)
    if (!existsSync(src)) continue
    /* ★ 「目标已存在就整目录跳过」曾经埋了个坑：
       老用户升级后 HOME/配置 早就有了，于是包内新加的东西永远铺不进去 ——
       典型症状是「五份新协议明明打进了包，界面上却全是文件缺失」。
       改成递归补：只补目标里**不存在**的文件，一个都不覆盖。
       用户改过的配置不动，但新加的文件能进来。 */
    if (existsSync(dst)) {
      try { fillMissing(src, dst) } catch (e) {
        console.error('[main] 补 ' + d + ' 缺失文件失败（不影响启动）: ' + e.message)
      }
      continue
    }
    try {
      /* ★ 排除本地模型：那是几百 MB 的权重（语音识别 241MB、情感配音 1.5GB），
         复制一遍首次启动要卡十几秒、用户磁盘还要多占一份。
         它们只读，交给下面的 linkBigModels 建软链。 */
      cpSync(src, dst, {
        recursive: true,
        filter: (p) => !p.includes(join('系统', '本地模型')),
      })
      console.log('[main] 铺初始数据：' + d)
    } catch (e) {
      console.error('[main] 铺 ' + d + ' 失败（不影响启动）: ' + e.message)
    }
  }
  /* 单文件铺底：AGENTS.md 这类放在 seed-home 根下的产品文件 */
  for (const f of SEED_FILES) syncSeedFile(seedRoot, f)
  linkBigModels(seedRoot)
}

/** 产品文件（AGENTS.md）跟随版本更新，但不碰用户改过的那份。
 *
 *  ★ 为什么不能沿用「存在就跳过」（2026-11-20 实测踩到）：
 *    提示词是我改频率最高的东西，一版改完，用户目录里那份还是上一个版本，
 *    内核读的就是旧提示词 —— 表现是「代码明明改了，软件行为没变」。
 *    同步文件时用 `existsSync(dst) continue` 会把这个坑藏得很深。
 *
 *  ★ 为什么不能无条件覆盖：这是用户唯一能自己调教 AI 的地方。
 *    他把「别叫我老板」写进去，升级一次就没了，他只会觉得这软件不可控。
 *
 *  折中：记住「上一次我们从包里铺进去的那份」的哈希（存在 .seed-state.json）。
 *    - 当前文件和记录一致 → 用户没动过 → 用新版覆盖，并更新记录
 *    - 当前文件和记录不一致 → 用户改过 → 保留原文件，只在日志里说一声
 *    - 没有记录（首次铺 / 老版本升上来）→ 当作「用户没动过」，覆盖并建立记录
 *      这一条是给老用户补票的：他们的文件是旧版本铺的，没有记录，
 *      不覆盖就永远停在旧提示词上。 */
const SEED_STATE = '.seed-state.json'

function readSeedState() {
  const { readFileSync } = require('node:fs')
  try { return JSON.parse(readFileSync(join(HOME, SEED_STATE), 'utf8')) || {} } catch (e) { return {} }
}

function syncSeedFile(seedRoot, name) {
  const { readFileSync, writeFileSync, existsSync, copyFileSync } = require('node:fs')
  const { createHash } = require('node:crypto')
  const src = join(seedRoot, name)
  const dst = join(HOME, name)
  if (!existsSync(src)) return
  const h = (buf) => createHash('sha256').update(buf).digest('hex')
  let srcBuf, srcHash
  try { srcBuf = readFileSync(src); srcHash = h(srcBuf) } catch (e) { return }

  const state = readSeedState()
  const known = state[name] || ''

  if (existsSync(dst)) {
    let curHash
    try { curHash = h(readFileSync(dst)) } catch (e) { return }
    if (curHash === srcHash) {                       /* 已经是新版，无事可做 */
      if (known !== srcHash) { state[name] = srcHash; saveSeedState(state) }
      return
    }
    if (known && curHash !== known) {                /* 用户改过，保留 */
      console.log('[main] ' + name + ' 你改过，保留你的版本（包内有新版未覆盖）')
      return
    }
  }
  try {
    copyFileSync(src, dst)
    state[name] = srcHash
    saveSeedState(state)
    console.log('[main] 铺 ' + name)
  } catch (e) {
    console.error('[main] 铺 ' + name + ' 失败: ' + e.message)
  }
}

function saveSeedState(state) {
  const { writeFileSync } = require('node:fs')
  try { writeFileSync(join(HOME, SEED_STATE), JSON.stringify(state, null, 2) + '\n') } catch (e) { /* 记不下不影响功能 */ }
}

/** 本地模型权重（语音识别 241MB、情感配音 1.5GB）不要复制进用户数据目录。
 *  ★ 复制 241MB 会让第一次启动卡十几秒，而且换版本时又得再复制一次。
 *    这些文件是只读的，直接软链到安装包里的那份就行 —— 读起来一样，
 *    启动是毫秒级。软链的目标在 .app 内部，打包时已经在包里，不会失效。 */
function linkBigModels(seedRoot) {
  const { existsSync, mkdirSync, symlinkSync, lstatSync, unlinkSync } = require('node:fs')
  const srcLM = join(seedRoot, '系统', '本地模型')
  if (!existsSync(srcLM)) return
  const dstLM = join(HOME, '系统', '本地模型')
  const walk = (from, to) => {
    let ents = []
    try { ents = require('node:fs').readdirSync(from, { withFileTypes: true }) } catch (e) { return }
    for (const e of ents) {
      const a = join(from, e.name), b = join(to, e.name)
      if (e.isDirectory()) {
        mkdirSync(b, { recursive: true })
        walk(a, b)
      } else if (e.isFile()) {
        const st = lstatSync(b, { throwIfNoEntry: false })
        /* ★ 软链存在但目标没了（客户把 app 从下载目录拖到 /Applications、
           或者换了新版本），必须重建 —— 只判「是不是软链」就 continue 的话，
           旧链会一直指着不存在的位置，界面上就是「Ming 引擎不在」。 */
        if (st && st.isSymbolicLink()) {
          let ok = false
          try { ok = existsSync(b) } catch (e) { ok = false }
          if (ok) continue
          try { unlinkSync(b) } catch (e) {}
        } else if (existsSync(b)) continue
        try {
          mkdirSync(join(to), { recursive: true })
          /* 用启动时算出来的绝对路径。
             seedRoot 是 process.resourcesPath 推出来的，所以「客户把 app 拖到
             /Applications」这种挪动，下次启动会重新算出正确位置；
             配合上面那段自愈（旧链断了就 unlink 重建），挪多少次都对。
             相对链在这里不成立：Application Support 与安装包之间没有固定层级。 */
          symlinkSync(require("node:fs").realpathSync(a), b)
        } catch (err) {}
      }
    }
  }
  try {
    mkdirSync(dstLM, { recursive: true })
    walk(srcLM, dstLM)
    /* ★ 断链自愈：包内没有权重（轻量版）时，walk 一个文件都不会碰，
       于是用户目录里指向「上一版包内权重」的软链会一直断着 ——
       界面上就是「这台机器缺东西 · 缺 asr」，而且点重装也修不好，
       因为 localmodels 看到目录存在就以为装好了。
       这里主动扫一遍：凡是软链但目标不存在的，直接删掉，
       让 localmodels 的状态判定回到「没装」，用户可以重新点下载。 */
    let broken = 0
    const sweep = (dir) => {
      let ents = []
      try { ents = require('node:fs').readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
      for (const e of ents) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { sweep(p); continue }
        let st = null
        try { st = lstatSync(p, { throwIfNoEntry: false }) } catch (err) { st = null }
        if (!st || !st.isSymbolicLink()) continue
        let ok = false
        try { ok = existsSync(p) } catch (err) { ok = false }
        if (!ok) { try { unlinkSync(p); broken++ } catch (err) {} }
      }
    }
    sweep(dstLM)
    if (broken) console.log('[main] 清理了 ' + broken + ' 个失效的模型软链（包内没有权重，请到语音工作室重新下载）')
    console.log('[main] 本地模型已软链到安装包（不占用户磁盘）')
  } catch (e) {
    console.error('[main] 软链本地模型失败（不影响启动）: ' + e.message)
  }
}

app.whenReady().then(async () => {
  __mark('whenReady 触发')
  seedHomeIfEmpty()
  __mark('初始数据就绪')
  // velora://studio/ → app/renderer/studio.html
  // velora://app/  → 我们自己的完整前端（app/ui/src 构建出来的 ui.html）
  // 以及它的 /api/*（由 lib/uiserver.js 翻译成 lib/ 各模块）。
  // 与上面 studio 那套并存：studio 是简化七屏，app 是旧版 12 个页面的完整前端。
  const uiHandler = require('./lib/uiserver').handler({
    root: join(__dirname, 'renderer'),
    homePage: 'ui.html',
  })
  protocol.handle('velora', (req) => {
    let rel = 'studio.html'
    try {
      const _u0 = new URL(req.url)
      if (_u0.host === 'app') return uiHandler(req)
    } catch {}
    try {
      const u = new URL(req.url)
      if (u.host === 'studio' || u.host === '') {
        rel = u.pathname === '/' || u.pathname === '' ? 'studio.html' : u.pathname.replace(/^\/+/, '')
      } else {
        rel = u.pathname.replace(/^\/+/, '') || 'studio.html'
      }
    } catch {}
    // 防穿越：只允许 renderer 目录下的文件
    const safe = rel.replace(/\.\./g, '')
    // 模板缩略图单独走一条：velora://studio/thumbs/<名字>.png
    // 不这样做的话 studio.html 拿不到预览图 —— 它是 velora:// 源，
    // 直接引用 home/模板库/thumbs 下的本地文件会被跨源拦掉。
    if (safe.startsWith('thumbs/')) {
      try {
        const T = require('./lib/templates')
        const f = join(T.thumbsRoot(), safe.slice('thumbs/'.length))
        if (!existsSync(f)) return new Response('no thumb', { status: 404 })
        return net.fetch(pathToFileURL(f).toString())
      } catch {
        return new Response('no thumbs', { status: 404 })
      }
    }
    // 剪辑台要拿工程里的素材（assets/xxx.mp4）：iframe 是 velora:// 源，
    // 直接引用 file:// 绝对路径会被跨源拦掉，所以也走这条路。
    //   velora://proj/<工程名>/assets/<文件名>  →  <工程目录>/assets/<文件名>
    //   velora://proj/<工程名>/out/<文件名>     →  <工程目录>/out/<文件名>（预览片）
    // 预览片落在 产出/预览（不是工程目录），单独开一条
    //   velora://out/<文件名>  →  <客户>/产出/预览/<文件名>
    //   velora://lib/<文件名>  →  <客户>/产出/图片/<文件名>（素材库缩略图）
    if (safe.startsWith('out/') || safe.startsWith('lib/')) {
      try {
        const C = require('./lib/core')
        const isOut = safe.startsWith('out/')
        const fname = decodeURIComponent(safe.slice(isOut ? 4 : 4)).replace(/\.\./g, '')
        const dir = isOut ? C.custPaths().previews : C.custPaths().images
        const f = join(dir, fname)
        if (!existsSync(f)) return new Response('no media: ' + fname, { status: 404 })
        return net.fetch(pathToFileURL(f).toString())
      } catch (e) {
        return new Response('media error: ' + String(e && e.message), { status: 404 })
      }
    }
    if (safe.startsWith('proj/')) {
      try {
        const TL = require('./lib/timeline')
        const parts = safe.slice('proj/'.length).split('/')
        const pname = decodeURIComponent(parts.shift() || '')
        const rest = parts.map(decodeURIComponent).join('/').replace(/\.\./g, '')
        const f = join(TL.projDir(pname), rest)
        if (!existsSync(f)) return new Response('no media: ' + rest, { status: 404 })
        return net.fetch(pathToFileURL(f).toString())
      } catch (e) {
        return new Response('proj error: ' + String(e && e.message), { status: 404 })
      }
    }
    const file = join(__dirname, 'renderer', safe)
    if (!existsSync(file)) return new Response('not found: ' + safe, { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  __mark('协议就绪')
  await pickPort()
  __mark('端口选好')
  const win = createWindow()
  __mark('窗口创建')
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

  // 开机自启内核 —— 用户打开软件就该能用，不该先点一下「启动」。
  // 失败也不卡死：把错误送到界面，用户可以点重试。
  try {
    const prof = buildProfile({ kernelDir: KERNEL, homeDir: KERNEL_HOME, workDir: HOME, profile: PROFILE })
    kernel = startKernel(win)
    /* cwd 给 HOME（业务数据），homeDir 给 KERNEL_HOME（内核状态）——
       这两个以前都是 HOME，于是内核把 profiles/sessions 写进用户数据根目录，
       跟 客户/资源/模板库 并排躺着。AI 的 cwd 也跟着变成那一片混合区。 */
    await kernel.start({
      provider: prof.provider, model: prof.model,
      cwd: HOME, env: prof.env,
    })
    __mark('内核就绪')
    // 把主进程这个内核交给对话层认领 —— 内核全进程只能有一个，
    // 两边各起一个会抢同一个端口，后起的 code=1 退出。
    try { require('./lib/kernelchat').adopt(kernel) } catch (e) { /* 对话层坏了不影响内核 */ }
  } catch (err) {
    const msg = String((err && err.message) || err)
    process.stderr.write('[core] 启动失败: ' + msg + '\n')
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript(
        'document.getElementById("m") && (document.getElementById("m").textContent = ' + JSON.stringify('内核启动失败：' + msg) + ')'
      ).catch(() => {})
    }
  }
})

/* 前端自绘红绿灯的窗口控制。
   ★ 原生按钮已经被隐藏（hidden + setWindowButtonVisibility(false)），
     如果这里不接，用户就没有任何办法最小化/关闭窗口 —— 那比不画还糟。 */
ipcMain.handle('win:action', (e, act) => {
  const w = BrowserWindow.fromWebContents(e.sender) || mainWin
  if (!w || w.isDestroyed()) return false
  if (act === 'close') w.close()
  else if (act === 'min') w.minimize()
  else if (act === 'max') { w.isMaximized() ? w.unmaximize() : w.maximize() }
  else return false
  return true
})

/* 一键重启：装插件/改 bundle 后内核只在启动时读一次 profile，必须重启整个 App。
   relaunch 要在 exit 之前调；先让 IPC 回一句 ok，再延时退出，
   否则渲染进程还没收到回应就被杀掉，界面会卡在「重启中」。 */
ipcMain.handle('app:restart', () => {
  try { if (kernel) kernel.stop() } catch (e) {}
  setTimeout(() => {
    try { app.relaunch() } catch (e) { /* 开发模式下可能不支持，退出即可 */ }
    app.exit(0)
  }, 300)
  return { ok: true }
})

app.on('window-all-closed', () => {
  if (kernel) kernel.stop()
  app.quit()
})

// ── IPC ────────────────────────────────────────────────────────────────
// ── 剪辑台的专用 IPC ────────────────────────────────────────────────────
// 为什么不用 tools:call：剪辑台每拖一下片段就要存盘（几十毫秒一次），
// 走工具层要过授权判定、要拼人读文本、还要 JSON 来回转，卡手。
// 这五个通道直接对 timeline.js，出入都是结构化数据。
ipcMain.handle('tl:list', () => {
  try { return { ok: true, items: require('./lib/timeline').listProjects() } }
  catch (e) { return { ok: false, error: String(e && e.message) } }
})

ipcMain.handle('tl:load', (_e, name) => {
  try {
    const T = require('./lib/timeline')
    const d = T.load(name)
    // 顺手把素材池一起给出去 —— 剪辑台左侧要列出可拖的素材
    let assets = []
    try { assets = T.assets(name) || [] } catch {}
    return { ok: true, doc: d, assets }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
})

ipcMain.handle('tl:save', (_e, name, doc) => {
  try {
    // 只认结构化字段，别把界面上的临时态（选中、缩放）写进工程文件
    const T = require('./lib/timeline')
    const clean = {
      name: doc.name, width: doc.width, height: doc.height, fps: doc.fps,
      duration: doc.duration, tracks: doc.tracks,
    }
    if (doc.plan) clean.plan = doc.plan
    return { ok: true, doc: T.save(name, clean) }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
})

ipcMain.handle('tl:import', (_e, name, srcPath) => {
  try {
    const T = require('./lib/timeline')
    const r = T.importAsset(name, srcPath)
    return { ok: true, asset: r, assets: T.assets(name) }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
})

ipcMain.handle('tl:preview', async (_e, name) => {
  // 出预览 → 返回一条 velora://proj/ 的地址，界面直接丢进 <video>
  try {
    const R = require('./lib/render')
    const r = await R.renderProject(name, { final: false })
    if (!r || r.ok === false) return { ok: false, error: String((r && r.error) || '渲染失败') }
    const file = String(r.path || '')
    const base = file.split('/').pop()
    return { ok: true, url: 'velora://out/' + encodeURIComponent(base), path: file, ms: r.ms }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
})

ipcMain.handle('app:info', () => {
  let tools = 0, templates = 0, skills = 0
  try { tools = Object.keys(require('./lib/tools').REGISTRY).length } catch {}
  try { templates = require('./lib/templates').catalog().length } catch {}
  try { skills = require('./lib/skills').listSkills().length } catch {}
  return {
    root: ROOT, home: HOME, kernel: KERNEL, version: app.getVersion(),
    kernelProbe: Kernel.probe(KERNEL),
    // 数字都从真实数据来 —— 界面上不许写死「456 个模板 / 125 个工具」这种
    // 看起来像事实、实际会随版本飘的数
    tools, templates, skills,
    level: (() => { try { return require('./lib/core').levelOf() } catch { return '建议' } })(),
    scope: (() => { try { return require('./lib/core').scopeOf() } catch { return '影创' } })(),
  }
})

/* 复制代码到系统剪贴板。渲染进程是 velora:// 自定义协议 + sandbox，
   navigator.clipboard 需要安全上下文和用户手势、execCommand 也常被拒；
   主进程 clipboard 模块直接写系统剪贴板，最可靠。 */
ipcMain.handle('app:copyText', async (_e, text) => {
  try {
    const { clipboard } = require('electron')
    clipboard.writeText(String(text == null ? '' : text))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

/* 打开外链（注册页 / 控制台）。
   为什么单独做一个 IPC：渲染进程是 velora:// 自定义协议 + sandbox，
   直接 window.open 会被 setWindowOpenHandler 里的 deny 拦掉；
   这里只放行 http/https，避免 file:// 或自定义协议被当成外链打开。 */
ipcMain.handle('app:openExternal', async (_e, url) => {
  try {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只允许 http/https 链接' }
    await shell.openExternal(u)
    return { ok: true, url: u }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

/* 反馈：直接唤起系统邮件客户端，把版本/系统信息预先填进正文。
   为什么不用网页表单：本机软件没有服务端，收反馈最省事的就是邮件；
   预填诊断信息是为了省掉「你用的什么版本」这一轮来回。 */
ipcMain.handle('feedback:mail', async (_e, opts = {}) => {
  try {
    const FEEDBACK_TO = 'China@cyanweb.cn'
    const ver = app.getVersion()
    const os = require('os')
    const kind = String(opts.kind || '反馈')
    const subject = `[RiffCut 影创 ${kind}] v${ver} · ${os.platform()} ${os.arch()}`
    const body = [
      '请描述你遇到的问题或建议（越具体越好）：',
      '',
      '',
      '',
      '────────────────────',
      '以下信息请保留，方便定位问题：',
      `软件版本：${ver}`,
      `系统版本：${os.platform()} ${os.release()} (${os.arch()})`,
      `Electron：${process.versions.electron || '-'}`,
      `Node：${process.versions.node || '-'}`,
      `内核：${KERNEL}`,
      `数据目录：${HOME}`,
    ].join('\n')
    const url = 'mailto:' + FEEDBACK_TO +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body)
    await shell.openExternal(url)
    return { ok: true, to: FEEDBACK_TO }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

ipcMain.handle('kernel:start', async (_e, opts = {}) => {
  if (kernel && kernel.ready) return { ok: true, already: true }
  try {
    const prof = buildProfile({ kernelDir: KERNEL, homeDir: KERNEL_HOME, workDir: HOME, profile: PROFILE })
    kernel = startKernel(BrowserWindow.getAllWindows()[0])
    const info = await kernel.start({
      provider: opts.provider || prof.provider,
      model: opts.model || prof.model,
      cwd: opts.cwd || HOME,
      env: prof.env,
    })
    return { ok: true, info, provider: prof.provider, model: prof.model }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

ipcMain.handle('kernel:prompt', async (_e, { sessionId, text, cwd }) => {
  if (!kernel || !kernel.ready) return { ok: false, error: '内核没起' }
  try {
    if (cwd) await kernel.setCwd(sessionId, cwd).catch(() => {})
    const r = await kernel.prompt(sessionId, text)
    return { ok: true, messageId: r?.messageId }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) }
  }
})

ipcMain.handle('kernel:wait', async (_e, { sessionId, timeout }) => {
  if (!kernel || !kernel.ready) return { ok: false, error: '内核没起' }
  try { const r = await kernel.wait(sessionId, timeout || 0); return { ok: true, r } }
  catch (err) { return { ok: false, error: String(err && err.message || err) } }
})

ipcMain.handle('kernel:model', async (_e, { sessionId, provider, model }) => {
  // 换模型：内核支持按会话切换
  try { const r = await kernel.call('session/model/set', { sessionId, provider, model }); return { ok: true, r } }
  catch (err) { return { ok: false, error: String(err && err.message || err) } }
})

// ── 通用工具通道：界面调工具的唯一入口 ────────────────────────────────
// 为什么不做成一堆细粒度 IPC：42 个工具、每个参数都不一样，一个个写
// handler 既冗长又和 lib/tools.js 的注册表脱钩（改了注册表忘了改 IPC，
// 界面就报「不支持」）。这里直接透传给 tools.call，注册表是唯一真相。
//
// 权限在 lib/tools.js 的 allowed() 里判（LEVELS 四档 + mutates 特例），
// 界面点击和 AI 调用走同一套判定 —— 不存在「界面能点、AI 不能做」的缝。
ipcMain.handle('tools:call', async (_e, { name, args, customer } = {}) => {
  try {
    const T = require('./lib/tools')
    const C = require('./lib/core')
    const tool = T.REGISTRY[name]
    if (!tool) return { ok: false, error: '没有这个工具：' + name }
    const cust = customer || C.currentCustomer()
    if (!T.allowed(tool, cust)) {
      return {
        ok: false, denied: true,
        error: `当前授权档「${C.levelOf()}」不允许用「${tool.name}」。` +
               `到设置里把档位调到「${tool.level}」或更高。`,
      }
    }
    // tools.call 自己就返回 {ok, text} / {ok:false, error}，不要再包一层
    // （包了界面上就得写 r.data.ok，很容易漏判、把失败当成功显示）
    return await T.call(name, args || {}, cust)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})

// 工具清单：给界面画按钮/开关用，也顺手让「能力」面板显示真实数字
ipcMain.handle('tools:list', async () => {
  try {
    const T = require('./lib/tools')
    const C = require('./lib/core')
    const cust = C.currentCustomer()
    const items = Object.values(T.REGISTRY).map(t => ({
      name: t.name,
      desc: String(t.desc || '').split('\n')[0].slice(0, 80),
      level: t.level,
      mutates: t.mutates || 'read',
      allowed: T.allowed(t, cust),
    }))
    return { ok: true, items, total: items.length, level: C.levelOf(), scope: C.scopeOf() }
  } catch (e) { return { ok: false, error: String(e.message || e), items: [] } }
})

// ── 权限与范围（AI 的授权档 / 可见目录）──────────────────────────────
ipcMain.handle('app:perm', async (_e, p = {}) => {
  try {
    const C = require('./lib/core')
    const out = { ok: true, level: C.levelOf(), scope: C.scopeOf() }
    if (p.level) out.level = C.setLevel(String(p.level))
    if (p.scope) out.scope = C.setScope(String(p.scope))
    return out
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})

// ── 素材：模板与技能 ───────────────────────────────────────────────────
ipcMain.handle('assets:templates', async (_e, q = {}) => {
  try {
    const T = require('./lib/templates')
    const all = T.catalog()
    let items = all
    if (q.cat) items = items.filter(x => x.cat === String(q.cat))
    if (q.q) items = T.search(items, String(q.q))
    const lim = Math.max(1, Number(q.limit) || 400)
    return {
      ok: true, total: items.length, source: '模板库',
      items: items.slice(0, lim).map(x => ({
        name: x.name, title: x.title || x.name, cat: x.cat, kind: x.kind,
        duration: x.duration, thumb: x.hasThumb ? ('/tplthumb/' + x.name + '.png') : '',
        desc: String(x.desc || '').slice(0, 120),
      })),
    }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})

ipcMain.handle('assets:skills', async () => {
  try {
    const S = require('./lib/skills')
    const items = S.listSkills().map(s => ({ name: s.title || s.id, id: s.id, desc: String(s.whenToUse || s.summary || '') }))
    return { ok: true, items, total: items.length }
  } catch (e) { return { ok: false, error: String(e.message || e), items: [] } }
})

// ── 原生 DSH 界面（webview 里加载内核自己的 Web UI）──────────────────
ipcMain.handle('native:open', async () => ({ ok: true }))

ipcMain.handle('native:info', async () => {
  // 内核的 web-app bundle 会在 port.txt 那个端口起界面；带 token 走一次换 cookie
  try {
    const P = require('./lib/paths')
    const portFile = join(P.HOME, '配置', 'port.txt')
    if (!existsSync(portFile)) return { ok: false, url: '' }
    const port = String(readFileSync(portFile, 'utf8')).trim()
    if (!port) return { ok: false, url: '' }
    return { ok: true, url: `http://127.0.0.1:${port}/` }
  } catch { return { ok: false, url: '' } }
})

// ── 打开路径 ───────────────────────────────────────────────────────────
ipcMain.handle('sys:open', async (_e, p) => {
  try {
    const P = require('./lib/paths')
    const T = require('./lib/tools')
    const r = T.resolveUserPath(p, null)
    if (!r.ok) return { ok: false, error: r.error }
    await shell.openPath(r.abs)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})

/* 选文件夹（原生对话框）。Electron 里 window.webkit 不存在，旧 WKWebView 通道
   的 folder.postMessage 永远不触发——以前「添加工作区」只能走 webkitdirectory，
   拿到的是相对路径、加不进去。这里给一条真能拿绝对路径的通道。 */
ipcMain.handle('sys:pickFolder', async (_e, opts = {}) => {
  try {
    const w = BrowserWindow.fromWebContents(_e.sender) || mainWin
    const r = await dialog.showOpenDialog(w, {
      title: opts.title || '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true }
    return { ok: true, path: r.filePaths[0] }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})

/* 拖拽进来的 File 取绝对路径。Electron 32+ 移除了 File.path，
   必须用 webUtils.getPathForFile（主进程侧调用）。 */
ipcMain.handle('sys:pathForFile', async (_e, file) => {
  try {
    const { webUtils } = require('electron')
    const p = webUtils.getPathForFile(file)
    return { ok: !!p, path: p || '' }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})
