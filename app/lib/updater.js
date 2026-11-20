'use strict'
/**
 * 在线更新。
 *
 * 设计上刻意不用 electron-updater / Squirrel：那套要签名证书、要 pkg 格式的
 * dmg 差异包，而且它只认 Squirrel 自己的 feed 格式。我们是 ad-hoc 签名的
 * 裸 .app，用户数据还全在 App 同级的「数据」目录里 —— 换掉 .app 本身
 * 就等于换了个程序壳，用户工程/素材/密钥/规则一条都不该动。
 *
 * 流程（每一步都可单独调用，出错不猜）：
 *   1. status()    读本机版本 + 更新配置
 *   2. check()     拉 feed.json，比版本，返回「有没有新版 / 新在哪 / 多大」
 *   3. download()  流式下到 系统/更新/<版本>.zip，边下边报进度
 *   4. install()   校验 sha256 → 解开 → 校验顶层只有一个 .app 且有 riffcut 可执行
 *                  → 旧 App 移到 系统/备份/ → 新 App 就位
 *
 * 安全底线：
 *   · sha256 对不上就删包重下，绝不拿一个来路不明的 zip 覆盖程序
 *   · 解压前先看 zip 里有没有 ../ 之类的穿越路径，有就拒绝
 *   · 旧 App 一定先备份再替换，装坏了能手动移回来
 *   · 只允许 https（file:// 给本地测试用），不跟 http
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const P = require('./paths')
const E = require('./exec')
const DL = require('./download')

/* ── 本机 App 位置 ─────────────────────────────────────
   打包后 process.execPath = .../RiffCut影创.app/Contents/MacOS/riffcut
   从它往上退三层就是 .app。开发态（直接 node 跑）没有 .app，
   这时 appPath() 返回 null，install() 会明确拒绝而不是瞎猜。 */
function appPath() {
  const exe = process.execPath || ''
  const i = exe.indexOf('.app/Contents/MacOS/')
  if (i < 0) return null
  return exe.slice(0, i + 4)
}

function currentVersion() {
  try { return String(require('../package.json').version || '0.0.0') } catch (e) { return '0.0.0' }
}

const UPD_DIR = path.join(P.SYS, '更新')
const CFG_FILE = path.join(P.CFG, '更新.json')

const DEFAULTS = {
  feed_url: '',
  channel: 'stable',
  check_on_start: false,
  auto_download: false,
  require_sha256: true,
  timeout_seconds: 12,
  enabled: true,
}

function cfg() {
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch (e) { raw = {} }
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) out[k] = raw[k]
  }
  return out
}

function saveCfg(patch = {}) {
  const cur = cfg()
  const next = { ...cur }
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] !== undefined) next[k] = patch[k]
  }
  // 保留文件里那些给人看的说明字段（_说明 / _feed格式 …）
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch (e) { raw = {} }
  for (const k of Object.keys(raw)) if (k.startsWith('_')) next[k] = raw[k]
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* ── 版本比较 ─────────────────────────────────────────
   只认 主.次.修订 三段数字，预发布后缀（-rc.1）按「比同号正式版小」处理。
   不引 semver：我们只有自己发的版本号，规则越少越不容易判错。 */
function parseVer(v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/)
  if (!m) return null
  return {
    nums: [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)],
    pre: String(m[4] || ''),
  }
}

function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b)
  if (!A || !B) return 0
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] > B.nums[i] ? 1 : -1
  }
  // 有预发布后缀的算小：0.2.0-rc1 < 0.2.0
  if (A.pre && !B.pre) return -1
  if (!A.pre && B.pre) return 1
  if (A.pre === B.pre) return 0
  return A.pre > B.pre ? 1 : -1
}

/* ── feed ──────────────────────────────────────────── */
function assertUrl(u) {
  const s = String(u || '').trim()
  if (!s) throw new Error('更新地址是空的。到「系统设置 · 在线更新」里填 feed 地址，或直接留空不更新。')
  if (/^file:\/\//i.test(s)) return s          // 本地测试
  if (/^https:\/\//i.test(s)) return s
  if (/^http:\/\//i.test(s)) {
    throw new Error('更新地址必须是 https。http 明文可以被中间人换成任意安装包，不能用来装程序。')
  }
  throw new Error('更新地址只支持 https://（本地测试可用 file://）：' + s)
}

async function readFeed(url, timeoutMs) {
  const u = assertUrl(url)
  if (u.startsWith('file://')) {
    const p = decodeURIComponent(u.replace(/^file:\/\//i, ''))
    const txt = await fsp.readFile(p, 'utf8')
    return JSON.parse(txt)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(u, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'RiffCut/' + currentVersion() + ' (+https://github.com/lov0u/riffcut)',
        'Cache-Control': 'no-cache',
      },
    })
    if (!r.ok) throw new Error('更新清单读不到：HTTP ' + r.status)
    const txt = await r.text()
    try { return JSON.parse(txt) } catch (e) {
      throw new Error('更新清单不是合法 JSON（前 80 字符：' + txt.slice(0, 80).replace(/\s+/g, ' ') + '）')
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ── 状态 ──────────────────────────────────────────── */
function status() {
  const c = cfg()
  const ap = appPath()
  let appVer = ''
  if (ap) {
    try {
      const info = path.join(ap, 'Contents', 'Info.plist')
      const txt = fs.readFileSync(info, 'utf8')
      const m = txt.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
      if (m) appVer = m[1]
    } catch (e) { /* 读不到就用 package.json 的 */ }
  }
  return {
    current: currentVersion(),
    app_version: appVer || currentVersion(),
    app_path: ap || '',
    installable: !!ap,
    channel: c.channel,
    feed_url: c.feed_url,
    enabled: !!c.enabled,
    check_on_start: !!c.check_on_start,
    auto_download: !!c.auto_download,
    require_sha256: !!c.require_sha256,
    dir: UPD_DIR,
    note: ap ? '' : '当前是源码/开发态，没有 .app 可替换。更新功能只在打包后的 App 里生效。',
  }
}

/* ── 检查 ──────────────────────────────────────────── */
async function check(opts = {}) {
  const c = cfg()
  const cur = currentVersion()
  if (!c.enabled && !opts.force) {
    return { ok: true, has_update: false, current: cur, disabled: true, note: '在线更新已关闭' }
  }
  const url = String(opts.feed_url || c.feed_url || '').trim()
  if (!url) {
    return {
      ok: true, has_update: false, current: cur, configured: false,
      note: '还没配更新地址。填了 feed_url 之后这里会显示有没有新版。',
    }
  }
  const feed = await readFeed(url, Math.max(3, Number(c.timeout_seconds) || 12) * 1000)
  const ver = String(feed.version || '').trim()
  if (!ver) throw new Error('更新清单里没有 version 字段，没法判断新不新')
  if (feed.channel && c.channel && String(feed.channel) !== String(c.channel)) {
    return {
      ok: true, has_update: false, current: cur, latest: ver, channel_mismatch: true,
      configured: true,
      note: '清单是「' + feed.channel + '」通道，本机在「' + c.channel + '」通道，跳过',
    }
  }
  const newer = cmpVer(ver, cur) > 0
  return {
    ok: true,
    /* ★ configured 必须显式给 true。
       踩过的坑：前端 doCheck() 里写的是 `if(!r.configured){ setTag('未配置') }`，
       而这里成功时压根不返回这个字段 → undefined 当 falsy 处理 →
       检查明明成功了，状态标签却从「已启用」掉成「未配置」，
       用户以为更新功能坏了。字段要么给全，要么前端别靠它判。 */
    configured: true,
    current: cur,
    latest: ver,
    build: feed.build || 0,
    has_update: newer,
    notes: String(feed.notes || ''),
    url: String(feed.url || ''),
    sha256: String(feed.sha256 || ''),
    size: Number(feed.size || 0),
    min_version: String(feed.min_version || ''),
    forced: !!(feed.min_version && cmpVer(cur, feed.min_version) < 0),
    note: newer ? ('有新版本 ' + ver) : '已经是最新版（' + cur + '）',
  }
}

/* ── 下载 ──────────────────────────────────────────── */
const JOBS = new Map()

function job(id) {
  const j = JOBS.get(id)
  if (!j) return null
  return {
    id,
    state: j.state,
    progress: j.progress,
    done: j.done,
    total: j.total,
    step: j.step,
    error: j.error,
    file: j.file,
    version: j.version,
  }
}

function listJobs() {
  return Array.from(JOBS.keys()).map(job)
}

async function download(opts = {}) {
  const id = 'upd-' + Date.now()
  const c = cfg()
  const chk = opts.feed || await check({ force: true })
  if (!chk.has_update) throw new Error(chk.note || '没有新版本可下')
  const url = assertUrl(chk.url)
  if (!url) throw new Error('更新清单里没有 url 字段')
  if (c.require_sha256 && !chk.sha256) {
    throw new Error('更新清单没给 sha256，而本机要求必须校验。要么让发布方补 sha256，要么在设置里关掉「必须校验」。')
  }

  fs.mkdirSync(UPD_DIR, { recursive: true })
  const dest = path.join(UPD_DIR, 'RiffCut-' + chk.latest + '.zip')

  const j = {
    id, state: 'downloading', progress: 0, done: 0, total: chk.size || 0,
    step: '准备下载', error: '', file: dest, version: chk.latest, ctl: new AbortController(),
  }
  JOBS.set(id, j)

  ;(async () => {
    try {
      /* file:// 走本地拷贝，不进 download.js —— 那个模块只认 http/https，
         给它一个 file:// 会当成 http 请求发出去然后一直挂着。 */
      if (url.startsWith('file://')) {
        const src = decodeURIComponent(url.replace(/^file:\/\//i, ''))
        j.step = '从本地拷贝 ' + path.basename(src)
        j.progress = 30
        await fsp.copyFile(src, dest)
        j.done = j.total = fs.statSync(dest).size
        j.progress = 99
      } else {
        await DL.fetchFile(url, dest, {
          signal: j.ctl.signal,
          onProgress: (d, t) => {
            j.done = d
            if (t) j.total = t
            j.progress = t ? Math.min(99, Math.round((d / t) * 100)) : Math.min(95, Math.round(d / 1048576))
            j.step = '下载中 ' + (d / 1048576).toFixed(1) + ' / ' + (t ? (t / 1048576).toFixed(1) : '?') + ' MB'
          },
        })
      }
      j.step = '校验 sha256'
      j.progress = 99
      const got = await sha256File(dest)
      if (chk.sha256 && got.toLowerCase() !== chk.sha256.toLowerCase()) {
        try { fs.unlinkSync(dest) } catch (e) {}
        throw new Error('下载包的 sha256 对不上（拿到 ' + got.slice(0, 16) + '…，清单写的是 ' +
          String(chk.sha256).slice(0, 16) + '…）。包已删除，没有安装。')
      }
      j.sha256 = got
      j.state = 'done'
      j.progress = 100
      j.step = '已下载并通过校验'
    } catch (e) {
      j.state = 'error'
      j.error = String((e && e.message) || e)
      j.step = '下载失败'
    }
  })()

  return { ok: true, job_id: id, version: chk.latest, file: dest }
}

function cancelDownload(id) {
  const j = JOBS.get(id)
  if (!j) return { ok: false, error: '没有这个任务' }
  try { j.ctl.abort() } catch (e) {}
  j.state = 'error'
  j.error = '已取消'
  j.step = '已取消（半截文件保留，下次接着下）'
  return { ok: true }
}

function sha256File(f) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(f)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

/* ── 安装 ──────────────────────────────────────────── */
async function zipEntries(zip) {
  // unzip -Z1 只列名字，不解压 —— 先用它做路径穿越检查
  const r = await E.run('/usr/bin/unzip', ['-Z1', zip], { timeout: 20000 })
  if (!r || !r.ok) throw new Error('读不了 zip 目录（unzip -Z1 失败）：' + ((r && r.stderr) || ''))
  return String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)
}

async function install(opts = {}) {
  /* opts.target 只给自动化测试用（换一个临时目录当「App」），
     API 层绝不传它 —— 否则渲染进程就能把程序装到任意路径。 */
  const target = String(opts.target || '') || appPath()
  if (!target) throw new Error('当前是源码/开发态，没有 .app 可以替换。请用打包后的 App 测更新。')

  const zip = String(opts.file || '').trim()
  if (!zip || !fs.existsSync(zip)) throw new Error('找不到更新包：' + (zip || '(空)'))

  /* 1) 路径穿越检查 */
  const names = await zipEntries(zip)
  if (!names.length) throw new Error('更新包是空的')
  for (const n of names) {
    if (n.startsWith('/') || n.includes('../') || n.includes('/..')) {
      throw new Error('更新包里有可疑路径（' + n + '），拒绝安装。正常包只应包含一个 .app 目录。')
    }
  }

  /* 2) 解到临时目录
     ★ 不能拿 `unzip -Z1` 的条目名去拼路径：中文名（RiffCut影创.app）
     在 -Z1 里会输出成 RiffCut影?？.app 这种乱码，拼出来的路径根本不存在。
     上面那次 -Z1 只用来做路径穿越检查（乱码不影响判 ../），
     真正的目录名解压后用 readdir 读，那是文件系统给的准确名字。 */
  const stage = path.join(UPD_DIR, 'stage-' + Date.now())
  fs.mkdirSync(stage, { recursive: true })
  const r = await E.runAsync('/usr/bin/unzip', ['-q', '-o', zip, '-d', stage]).promise
  if (!r.ok) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw new Error('解压失败：' + (r.stderr || r.error || ('exit ' + r.code)))
  }

  /* 3) 顶层必须正好一个 .app（用真实目录名判断） */
  const tops = fs.readdirSync(stage).filter((x) => !x.startsWith('__MACOSX') && x !== '.DS_Store')
  const apps = tops.filter((t) => t.endsWith('.app'))
  if (apps.length !== 1) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw new Error('更新包顶层应该正好一个 .app，实际找到 ' + apps.length + ' 个（' +
      (tops.slice(0, 6).join(', ') || '空') + '）')
  }
  const newApp = path.join(stage, apps[0])
  const exe = path.join(newApp, 'Contents', 'MacOS', 'riffcut')
  if (!fs.existsSync(exe)) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw new Error('解出来的包里没有 Contents/MacOS/riffcut 可执行文件，不是我们的 App。')
  }

  /* 4) 旧 App 备份 */
  fs.mkdirSync(P.SYS_BACKUPS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const bak = path.join(P.SYS_BACKUPS, path.basename(target) + '.' + stamp + '.bak')
  try {
    fs.renameSync(target, bak)
  } catch (e) {
    // 跨卷 rename 会 EXDEV，退回 copy + rm
    fs.cpSync(target, bak, { recursive: true, preserveTimestamps: true })
    fs.rmSync(target, { recursive: true, force: true })
  }

  /* 5) 新 App 就位 */
  try {
    fs.renameSync(newApp, target)
  } catch (e) {
    fs.cpSync(newApp, target, { recursive: true, preserveTimestamps: true })
  }
  fs.rmSync(stage, { recursive: true, force: true })

  /* 6) 去掉隔离属性，否则新包会被 Gatekeeper 拦成「已损坏」 */
  try { await E.runAsync('/usr/bin/xattr', ['-cr', target]).promise } catch (e) {}

  return {
    ok: true,
    installed: true,
    app_path: target,
    backup: bak,
    note: '新版本已就位。关掉软件重新打开即生效；要回滚就把 ' + bak + ' 移回 ' + target,
  }
}

module.exports = {
  appPath, currentVersion, status, check, download, install,
  job, listJobs, cancelDownload, cfg, saveCfg, cmpVer, parseVer,
  UPD_DIR, sha256File,
}
