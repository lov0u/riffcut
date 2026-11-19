// 核心层：客户、工作区、设置、历史、费用、用量。
// 与路径层分开：paths.js 只回答「文件在哪」，这里回答「现在是什么状态」。
const { join, basename, isAbsolute, resolve } = require('node:path')
const { existsSync, statSync, readdirSync } = require('node:fs')
const P = require('./paths')

const DEFAULT_SETTINGS = {
  customer: P.DEFAULT_CUSTOMER,
  workspace: '',
  workspaces: [],
  theme: 'light',
  dsh_kernel: true,
  agent_level: '建议',
  agent_scope: '影创',
  first_run: true,
  version: 1,
}

const LEVELS = ['只读', '建议', '可整理', '完全托管']
const LEVEL_ORDER = { 只读: 0, 建议: 1, 可整理: 2, 完全托管: 3 }
const SCOPE_LEVELS = ['标准', '影创', '本机']
const SCOPE_ORDER = { 标准: 0, 影创: 1, 本机: 2 }

function settings() {
  const s = { ...DEFAULT_SETTINGS, ...(P.load('settings', {}) || {}) }
  s.ffmpeg = P.FFMPEG
  // output 是惰性 getter —— 直接赋值会触发 custPaths→workspaceRoot→settings 的无限环
  Object.defineProperty(s, 'output', {
    enumerable: true,
    get() { return custPaths(s.customer).videos },
  })
  return s
}

function saveSettings(s) {
  P.save('settings', s)
  _custCache.clear()
  _wsCache = null
  return s
}

// ── 客户 ──────────────────────────────────────────────
const _custCache = new Map()

function currentCustomer() {
  return String(settings().customer || P.DEFAULT_CUSTOMER).trim() || P.DEFAULT_CUSTOMER
}

/** 当前工作区根目录；没选就是 null。路径不在了当没设，绝不把产出写到消失的地方。 */
let _wsCache = null
function workspaceRoot() {
  // 直接读盘，不经过 settings()：settings() 里要算 output，算 output 又要问工作区
  const raw = P.load('settings', {}) || {}
  const wid = String(raw.workspace || '').trim()
  if (!wid) return null
  const hit = workspaces().find(x => x.id === wid)
  if (!hit) return null
  let st
  try { st = statSync(hit.path) } catch { return null }
  if (!st.isDirectory()) return null
  return hit.path
}

function workspaces() {
  const d = P.load('settings', {}) || {}
  const lst = d.workspaces
  if (!Array.isArray(lst)) return []
  const out = []
  for (const x of lst) {
    if (!x || typeof x !== 'object') continue
    const path = String(x.path || '').trim()
    if (!path) continue
    out.push({
      id: String(x.id || P.slug(path)),
      path,
      name: String(x.name || basename(path) || path),
      created: x.created || '',
    })
  }
  return out
}

function workspaceAdd(path) {
  const p = resolve(String(path).replace(/^~/, require('node:os').homedir()))
  let st
  try { st = statSync(p) } catch { throw new Error('这个路径不是可用的文件夹：' + path) }
  if (!st.isDirectory()) throw new Error('这个路径不是可用的文件夹：' + path)
  const d = settings()
  const lst = workspaces()
  const wid = P.slug(p)
  if (!lst.some(x => x.path === p)) {
    lst.push({ id: wid, path: p, name: basename(p) || p, created: P.now() })
  }
  d.workspaces = lst
  d.workspace = wid
  saveSettings(d)
  return { id: wid, path: p, name: basename(p) || p }
}

function workspacePick(wid) {
  const d = settings()
  wid = String(wid || '').trim()
  if (!wid) { d.workspace = ''; saveSettings(d); return null }
  const hit = workspaces().find(x => x.id === wid || x.path === wid)
  if (!hit) throw new Error('没有这个工作区：' + wid)
  d.workspace = hit.id
  saveSettings(d)
  return hit
}

function workspaceForget(wid) {
  const d = settings()
  const lst = workspaces().filter(x => x.id !== wid && x.path !== wid)
  d.workspaces = lst
  if (d.workspace === wid) d.workspace = ''
  saveSettings(d)
  return lst
}

/**
 * 客户的全部目录。选了工作区时，工作区目录整体顶替 客户/<客户>/ 这一层 ——
 * 用户选的就是「这个文件夹归这个项目用」，产出直接落在它下面。
 */
function custPaths(name) {
  /* ★ 只接受字符串。传对象进来会被 String() 变成 "[object Object]"，
     再经 slug 变成 "object-Object" —— 一个语法上合法的垃圾目录名，
     于是软件安安静静地在 /客户/object-Object 下面建了一整套目录，
     谁也不会立刻发现。这种错必须当场喊出来，不能靠事后排查。 */
  if (name && typeof name !== "string") {
    throw new TypeError("custPaths 只接受客户名字符串，收到的是 " + typeof name + "：" + JSON.stringify(name))
  }
  const cust = String(name || currentCustomer()).trim() || P.DEFAULT_CUSTOMER
  const ws = workspaceRoot()
  const key = ws ? 'ws:' + ws : P.slug(cust)
  const hit = _custCache.get(key)
  if (hit) return hit
  const base = ws || join(P.CUS, P.slug(cust))
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
  /* 同 paths.js：d.customer 是客户名字符串，不是路径，不能拿去 mkdir。 */
  for (const k of Object.keys(d)) {
    if (k === 'customer') continue
    const v = d[k]
    if (typeof v === 'string') P.ensureDir(v)
  }
  _custCache.set(key, d)
  return d
}

/** 统一取路：客户键走 custPaths（受工作区影响），静态键走 paths.BASE。 */
function path(key, customer) {
  if (P.CUST_KEYS.has(key)) return custPaths(customer)[key]
  return P.P(key, customer)
}

// ── 历史 ──────────────────────────────────────────────
const HISTORY_MAX = 400

function history(action, detail = '') {
  try {
    const d = P.load('history', { items: [] }) || { items: [] }
    const items = Array.isArray(d.items) ? d.items : []
    items.push({ t: P.now(), action: String(action || ''), detail: String(detail || '').slice(0, 400) })
    while (items.length > HISTORY_MAX) items.shift()
    P.save('history', { items })
  } catch {}
}

// ── 费用与用量 ────────────────────────────────────────
const PRICE = {
  'agnes-2.5-flash': { in: 0, out: 0 },
  auto: { in: 0, out: 0 },
}

function cost(model, promptChars = 0, completionChars = 0, ok = true) {
  const p = PRICE[model] || { in: 0, out: 0 }
  const c = {
    t: P.now(), model, ok,
    prompt: promptChars, completion: completionChars,
    amount: ((promptChars / 4) * p.in + (completionChars / 4) * p.out),
  }
  return c
}

function recordUsage(rec) {
  try {
    /* 统一写纯数组。以前写 {items:[...]}，而 models.js 写的是纯数组 ——
       两种格式混着写，谁后写谁把对方的记录整片覆盖掉：
       用户聊了 700 多条明细，界面上一直显示 0 次调用。这里读写都归一成数组。 */
    const d = P.load('usage', [])
    const items = Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : [])
    items.push({ ...rec, t: rec.t || P.now() })
    while (items.length > 2000) items.shift()
    P.save('usage', items)
    const tot = P.load('usage_totals', { calls: 0, chars: 0, amount: 0 }) || { calls: 0, chars: 0, amount: 0 }
    tot.calls = (tot.calls || 0) + 1
    tot.chars = (tot.chars || 0) + (rec.prompt || 0) + (rec.completion || 0)
    tot.amount = (tot.amount || 0) + (rec.amount || 0)
    P.save('usage_totals', tot)
  } catch {}
}

/**
 * 读调用明细。
 *
 * ★ 这个文件有两种历史格式，必须都认：
 *   · `[...]`            —— lib/models.js 的 recordUsage 写的（一直在用）
 *   · `{ items: [...] }` —— 本文件 recordUsage 写的
 *   以前这里只认 `{items}`，而盘上绝大多数是纯数组 →
 *   items 恒为空数组 → 「模型使用量」永远 0 次调用、0 token、趋势图空白。
 *   用量其实一条没丢（盘上 771 条），纯粹是读错了形状。
 */
function usageRecent(limit = 20) {
  const d = P.load('usage', [])
  let items = []
  if (Array.isArray(d)) items = d
  else if (d && Array.isArray(d.items)) items = d.items
  return items.slice(-limit).reverse()
}

function usageTotals() {
  return P.load('usage_totals', { calls: 0, chars: 0, amount: 0 }) || { calls: 0, chars: 0, amount: 0 }
}

// ── 通知（只写历史，界面自己拉）────────────────────────
function notify(title, msg) {
  history('通知', `${title}：${msg}`)
}

// ── 工具档位 ──────────────────────────────────────────
function levelOf(customer) {
  const s = settings()
  const v = String(s.agent_level || '建议').trim()
  return LEVELS.includes(v) ? v : '建议'
}

function scopeOf(customer) {
  const s = settings()
  const v = String(s.agent_scope || '影创').trim()
  return SCOPE_LEVELS.includes(v) ? v : '影创'
}

function setLevel(v) {
  if (!LEVELS.includes(v)) throw new Error('没有这个权限档：' + v)
  const s = settings(); s.agent_level = v; saveSettings(s); return v
}

function setScope(v) {
  if (!SCOPE_LEVELS.includes(v)) throw new Error('没有这个范围档：' + v)
  const s = settings(); s.agent_scope = v; saveSettings(s); return v
}

/** 范围允许的根目录。只给「看得见」的目录，不放开整个家目录。 */
function scopeRoots(customer) {
  const sc = scopeOf(customer)
  const c = custPaths(customer)
  if (sc === '标准') return [{ label: '客户目录', path: c.root }]
  if (sc === '影创') return [
    { label: '客户目录', path: c.root },
    { label: '素材目录', path: P.RES },
    { label: '模板库', path: P.RES_TEMPLATES },
    { label: '技能库', path: P.RES_SKILLS },
  ]
  return [
    { label: '客户目录', path: c.root },
    { label: '素材目录', path: P.RES },
    { label: '模板库', path: P.RES_TEMPLATES },
    { label: '技能库', path: P.RES_SKILLS },
    { label: '本机素材', path: join(require('node:os').homedir(), 'Movies') },
  ]
}

module.exports = {
  DEFAULT_SETTINGS, LEVELS, LEVEL_ORDER, SCOPE_LEVELS, SCOPE_ORDER,
  settings, saveSettings, currentCustomer,
  workspaces, workspaceAdd, workspacePick, workspaceForget, workspaceRoot,
  custPaths, path,
  history, cost, recordUsage, usageRecent, usageTotals, notify,
  levelOf, scopeOf, setLevel, setScope, scopeRoots,
}
