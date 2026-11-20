// 路径与目录：全项目唯一真源。
// 旧软件每个模块各自拼路径，出现「同一份东西两处写法」——这里只此一处。
const { join, dirname, resolve } = require('node:path')
const { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync, unlinkSync } = require('node:fs')
const os = require('node:os')

const ROOT = process.env.RiffCut_ROOT || join(__dirname, '..', '..')
/* 与 main.js 的 resolveHome 保持一致：打包后指 Application Support。
   ★ 这里不能 require('electron') —— lib/ 下的模块也会被纯 Node 脚本调用
     （冒烟测试、验证脚本），那些场景没有 electron 运行时会直接抛。
     所以用 app.asar / Resources/app 这类路径特征来判断，虽然不如 isPackaged 干净，
     但它在主进程里都会先被 main.js 设好的 RiffCut_HOME 覆盖掉，实际很少走到这两行。 */
function defaultHome() {
  if (process.env.RiffCut_HOME) return process.env.RiffCut_HOME
  if (__dirname.includes('Resources/app') || __dirname.includes('app.asar')) {
    const { homedir } = require('node:os')
    return join(homedir(), 'Library', 'Application Support', 'RiffCut影创')
  }
  return join(ROOT, 'home')
}
const HOME = defaultHome()

/* ★★ 数据根目录分三层（2026-11-20，用户 m05899 要求「根目录你要做一个」）。
   以前这三类东西全挤在 HOME 一层，点开数据目录第一屏是二十几个 Chromium
   缓存目录（Cache / Code Cache / GPUCache / DawnWebGPUCache / Local Storage /
   Session Storage / DIPS / Trust Tokens / Network Persistent State…），
   中间夹着 DSH 内核的 profiles/sessions/storages，业务数据反而被埋在最下面。
   AI 的工作目录就挂在这一层，`ls` 一次看到的就是这堆垃圾 —— 它当然会去翻。
   这不是它不听话，是环境没收拾。

   拆成：
     HOME/            业务数据（客户、资源、模板库、配置、系统、知识库、内置、缓存）
     HOME/内核/        DSH 内核自己的状态（profiles、sessions、storages、logs）
     HOME/运行时/      Electron/Chromium 的 userData（由 main.js 的 setPath 指过去）

   AI 的 cwd 给 HOME —— 第一层全是人话，没有一个缓存目录。 */
const KERNEL_HOME = process.env.RiffCut_KERNEL_HOME || join(HOME, '内核')
const RUNTIME = process.env.RiffCut_RUNTIME || join(HOME, '运行时')

/* 一次性迁移旧布局：把 HOME 根下这四个内核目录搬进 HOME/内核/。
   不搬的话老用户升级后会话历史全丢（内核按 DSH_HOME 找 sessions），
   界面上「历史对话」会突然全空，看起来像数据被删了。
   ★ 用 renameSync 而不是 cp+rm：同一文件系统上是原子的、瞬间完成，
     不需要遍历 151M 的 profiles（里面主要是 node_modules 软链）。
   ★ 只在「新位置还没有、旧位置有」时才搬，重复执行无副作用。 */
function migrateKernelHome() {
  const legacy = ['profiles', 'sessions', 'storages', 'logs']
  let moved = 0
  for (const name of legacy) {
    const from = join(HOME, name)
    const to = join(KERNEL_HOME, name)
    try {
      if (existsSync(to)) continue
      if (!existsSync(from)) continue
      ensureDir(KERNEL_HOME)
      renameSync(from, to)
      moved++
      console.log('[paths] 内核目录已迁移: ' + name + ' → 内核/' + name)
    } catch (e) {
      /* 搬不动（跨盘、权限）就留着，内核会在新位置重建 —— 只是历史读不到，
         不至于让软件起不来。这里绝不能抛，模块加载期抛异常 = 双击没反应。 */
      console.error('[paths] 迁移 ' + name + ' 失败（将使用新目录，旧数据保留在原处）: ' + e.message)
    }
  }
  return moved
}

const CFG = join(HOME, '配置')
const RES = join(HOME, '资源')
const SYS = join(HOME, '系统')
const KB = join(HOME, '知识库')
const LOG = join(SYS, '日志')
const CUS = join(HOME, '客户')

const RES_SKILLS = join(RES, '技能')
const RES_TEMPLATES = join(HOME, '模板库')   // 旧布局：数据/模板库/{registry,thumbs}，不在 资源/ 下
const RES_PRESETS = join(RES, '模板')
const RES_BRAND = join(RES, '品牌库')
const RES_ENDINGS = join(RES, '片尾')
const RES_MUSIC = join(RES, '音乐')
const RES_LEGAL = join(RES, '法律')

const SYSMODELS = join(SYS, '本地模型')
const SYS_BACKUPS = join(SYS, '备份')

/* ffmpeg/ffprobe 的定位顺序：
   ① 环境变量显式指定（RiffCut_FFMPEG / RiffCut_FFPROBE）
   ② 随包自带的 tools/ffmpeg（正式发行版走这条）
   ③ 系统安装的（brew install ffmpeg）—— 源码仓库里不带二进制，
      因为带 --enable-nonfree 的构建不可分发，详见 NOTICE.md 第 3 节。
   找不到就返回 tools/ 下的路径，让上层报「缺 ffmpeg」并给出安装提示。 */
function findBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar]
  const bundled = join(ROOT, 'tools', name)
  if (existsSync(bundled)) return bundled
  for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const c = join(p, name)
    if (existsSync(c)) return c
  }
  return bundled
}
const FFMPEG = findBin('ffmpeg', 'RiffCut_FFMPEG')
const FFPROBE = findBin('ffprobe', 'RiffCut_FFPROBE')

const DEFAULT_CUSTOMER = '影创'

// 静态键表
const BASE = {
  models: join(CFG, '模型.json'),
  customers: join(CFG, '客户.json'),
  settings: join(CFG, '设置.json'),
  ui: join(CFG, '界面.json'),
  library: join(CFG, '素材库.json'),
  history: join(CFG, '历史.json'),
  costs: join(CFG, '费用.json'),
  usage: join(CFG, '调用明细.json'),
  usage_totals: join(CFG, '调用累计.json'),
  conversations: join(CFG, '对话.json'),
  last_plan: join(CFG, '最近方案.json'),
  tasks: join(CFG, '任务.json'),
  skill_sources: join(CFG, '技能扫描来源.json'),
  voice_models: join(CFG, '语音模型.json'),
  consent: join(CFG, '授权同意.json'),
  captions: join(CFG, '字幕文案.json'),
  rules: join(CFG, '导演规则.json'),
  experience: join(CFG, '经验库.json'),
  skills: RES_SKILLS,
  templates: RES_TEMPLATES,
  templates_registry: join(RES_TEMPLATES, 'registry'),
  templates_thumbs: join(RES_TEMPLATES, 'thumbs'),
  presets: RES_PRESETS,
  director_skills: join(CFG, '导演技能'),
  experiences: join(CFG, '经验库'),
  brand: RES_BRAND,
  endings: RES_ENDINGS,
  music: RES_MUSIC,
  legal: RES_LEGAL,
  local_models: SYSMODELS,
  knowledge: KB,
  backups: SYS_BACKUPS,
  logs: LOG,
  config_dir: CFG,
  resources: RES,
  system_dir: SYS,
  customers_dir: CUS,
  home: HOME,
  kernel_home: KERNEL_HOME,
  runtime_dir: RUNTIME,
  root: ROOT,
}

// 随「当前客户」动态解析的键 —— 绝不混在一起
const CUST_KEYS = new Set([
  'output', 'images', 'videos', 'voice', 'voices', 'thumbs',
  'cache', 'projects', 'versions', 'index', 'work', 'brandkits', 'previews',
])

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.mts', '.mxf', '.wmv', '.flv'])
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.tif', '.tiff', '.gif', '.bmp', '.raw'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.aiff', '.ogg'])
const MEDIA_EXT = new Set([...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT])

/* ★ 坏软链接会让 mkdirSync 抛 ENOENT，而这个异常发生在模块加载期 ——
   整个进程直接死掉，窗口连创建的机会都没有。
   症状：双击图标毫无反应，日志里只有一句 ENOENT，看不出是软链的问题。
   踩过：home/系统/本地模型 是指向旧版数据目录的软链，旧目录被删后
   这个链就成了地雷 —— 它被一路复制进安装包，装上就崩。
   所以：先看是不是软链、目标还在不在，不在就把链删掉重建真目录。 */
function ensureDir(p) {
  try {
    if (existsSync(p)) return p
    const st = lstatSync(p, { throwIfNoEntry: false })
    if (st && st.isSymbolicLink()) {
      // 软链存在但目标没了：existsSync 返回 false，直接 mkdirSync 必报 ENOENT
      try { unlinkSync(p) } catch (e) {}
    }
  } catch (e) {}
  mkdirSync(p, { recursive: true })
  return p
}

/**
 * 名字入参的统一防线。
 *
 * 为什么需要：一个对象传进来，String() 会给 "[object Object]"，slug 之后变成
 * "object-Object" —— 一个语法上完全合法的目录名。于是软件安安静静地在
 * /客户/ 下面建了一整套目录（产出/工程/缓存/品牌套件/缩略图/音色），
 * 谁也不会立刻发现，等到有人翻文件夹才知道。
 *
 * 同类隐患：undefined → "undefined"、数组 → "a,b"、NaN → "NaN"，
 * 全都是「看起来能用」的名字。这类错必须当场喊出来。
 */
function assertName(v, where = "名字") {
  if (v === undefined || v === null || v === "") return ""
  if (typeof v !== "string") {
    let show = ""
    try { show = JSON.stringify(v) } catch (e) { show = String(v) }
    throw new TypeError(where + "只接受字符串，收到的是 " + typeof v + "：" + String(show).slice(0, 120))
  }
  if (/^(undefined|null|NaN|\[object )/.test(v)) {
    throw new TypeError(where + "收到了一个看起来像对象被 String() 过的值：「" + v.slice(0, 60) + "」。查一下调用处是不是把对象传进来了。")
  }
  return v.trim()
}

function slug(name) {
  assertName(name, "slug 的入参")
  const s = String(name || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '')
  return s || DEFAULT_CUSTOMER
}

// ── 客户 ─────────────────────────────────────────────
function currentCustomer() {
  try {
    const s = readJson(BASE.settings, {})
    return String(s.customer || DEFAULT_CUSTOMER).trim() || DEFAULT_CUSTOMER
  } catch {
    return DEFAULT_CUSTOMER
  }
}

const _custCache = new Map()

function customerRoot(name) {
  const cust = String(name || currentCustomer()).trim() || DEFAULT_CUSTOMER
  return join(CUS, slug(cust))
}

/** 当前客户的全部目录，一次建齐。生成内容严格隔离在 客户/<客户>/ 内。 */
function custPaths(name) {
  const cust = String(name || currentCustomer()).trim() || DEFAULT_CUSTOMER
  const key = slug(cust)
  const hit = _custCache.get(key)
  if (hit) return hit
  const base = customerRoot(cust)
  const d = {
    customer: cust,
    root: base,
    images: join(base, '产出', '图片'),
    videos: join(base, '产出', '视频'),
    output: join(base, '产出', '视频'),
    previews: join(base, '产出', '预览'),
    voice: join(base, '产出', '配音'),
    voices: join(base, '音色'),
    thumbs: join(base, '缩略图'),
    cache: join(base, '缓存'),
    work: join(base, '缓存', '工作'),
    index: join(base, '缓存', '索引'),
    projects: join(base, '工程'),
    versions: join(base, '工程', '版本'),
    brandkits: join(base, '品牌套件'),
  }
  /* ★ 只建目录，不建「客户名」。
     d.customer 是字符串「影创」—— 早期写成 Object.values(d) 全量 ensureDir，
     把客户名也当成路径传进了 mkdir。开发时 cwd 是 app/，mkdir('影创') 居然成功了
     （于是在 app/ 里悄悄建了个叫影创的空目录，谁也没发现）；
     打包后 cwd 是 /，没有写权限 → ENOENT，界面顶上直接红条、整页空白。
     按键名排除，比靠 typeof 猜安全。 */
  for (const k of Object.keys(d)) {
    if (k === 'customer') continue
    const v = d[k]
    if (typeof v === 'string') ensureDir(v)
  }
  _custCache.set(key, d)
  return d
}

/** 统一取路：静态键直取，客户键动态解析。 */
function P(key, customer) {
  if (CUST_KEYS.has(key)) return custPaths(customer)[key]
  const v = BASE[key]
  if (v === undefined) throw new Error('没有这个路径键：' + key)
  return v
}

// ── JSON 读写（原子 + 唯一临时名）─────────────────────
const _SECRET = new Set(['models', 'voice_models', 'settings'])

function readJson(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return def === undefined ? null : def }
}

function writeJson(path, data) {
  ensureDir(dirname(path))
  const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
  return path
}

function load(name, def) {
  const f = BASE[name]
  if (typeof f === 'string' && f.endsWith('.json')) return readJson(f, def)
  return def
}

function save(name, data) {
  const f = BASE[name]
  if (typeof f !== 'string') throw new Error('不是配置文件：' + name)
  ensureDir(dirname(f))
  const tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  if (_SECRET.has(name)) { try { chmodSync(tmp, 0o600) } catch {} }
  renameSync(tmp, f)
  if (_SECRET.has(name)) { try { chmodSync(f, 0o600) } catch {} }
  return data
}

// ── 时间 ─────────────────────────────────────────────
function pad(n) { return n < 10 ? '0' + n : String(n) }
function now() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
let _seq = 0
function stamp() {
  // 带毫秒 + 自增序号：同一毫秒里连做三个（批量出字幕/配音/海报）也不会互相覆盖。
  // 光有毫秒不够 —— 实测同一毫秒内三次调用全撞在一起，三个预设写到同一个文件。
  const d = new Date()
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  _seq = (_seq + 1) % 1000
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${ms}${String(_seq).padStart(3, '0')}`
}

const NAMES = { VIDEO_EXT, IMAGE_EXT, AUDIO_EXT, MEDIA_EXT, DEFAULT_CUSTOMER, CUST_KEYS }

/* ★ 建目录绝不许把进程搞死：这里是模块加载期，
   一个目录失败（权限、坏软链、磁盘满）不该让整个软件起不来。
   记一行日志，继续往下走 —— 真正需要那个目录的功能自己会报错。 */
function initDirs() {
  /* 先迁移再建目录：顺序反了的话 ensureDir(KERNEL_HOME) 会先把 内核/ 建出来，
     renameSync 到已存在的目标会失败（或者变成 内核/sessions/sessions 套娃）。 */
  try { migrateKernelHome() } catch (e) { console.error('[paths] 内核目录迁移失败: ' + e.message) }
  for (const k of ['skills', 'templates', 'brand', 'endings', 'legal', 'music', 'local_models', 'backups', 'logs', 'knowledge', 'config_dir', 'resources', 'system_dir', 'customers_dir', 'kernel_home', 'runtime_dir']) {
    /* ★ 逐个 try/catch：这里是模块加载期，任何一个目录建不出来都不该让
       整个软件起不来。坏软链、权限、磁盘满都会在这里炸 —— 一旦炸出去，
       窗口连创建的机会都没有，用户看到的就是「双击没反应」。 */
    try { ensureDir(BASE[k]) } catch (e) { console.error('[paths] 建目录失败 ' + k + ': ' + e.message) }
  }
  try { custPaths() } catch (e) { console.error('[paths] 客户目录初始化失败: ' + e.message) }
  /* 根目录说明书：只写一次，用户改过就不再覆盖。见 lib/readme-home.js
     放在 initDirs 最后 —— 它要引用上面已经算好的 KERNEL_HOME / RUNTIME。 */
  try {
    const made = require('./readme-home').ensureReadme({ HOME, KERNEL_HOME, RUNTIME })
    if (made) console.log('[paths] 已写根目录说明 README.md')
  } catch (e) { console.error('[paths] 写说明失败: ' + e.message) }
}
initDirs()

module.exports = { assertName,
  ROOT, HOME, CFG, RES, SYS, KB, LOG, CUS, FFMPEG, FFPROBE, KERNEL_HOME, RUNTIME,
  RES_SKILLS, RES_TEMPLATES, RES_BRAND, RES_ENDINGS, RES_MUSIC, RES_LEGAL, RES_PRESETS,
  SYSMODELS, SYS_BACKUPS, DEFAULT_CUSTOMER,
  BASE, CUST_KEYS, VIDEO_EXT, IMAGE_EXT, AUDIO_EXT, MEDIA_EXT,
  ensureDir, slug, currentCustomer, customerRoot, custPaths, P,
  readJson, writeJson, load, save, now, stamp, pad,
}
