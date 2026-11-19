'use strict'
/**
 * 把能力开成本机 HTTP API —— 让别的软件（剪映插件、脚本、另一个 AI）也能用。
 *
 * 几条设计上的硬决定：
 *  · **默认只绑 127.0.0.1**：绑 0.0.0.0 等于把「能读写你整台机器文件」的接口
 *    挂到局域网上，同一个 WiFi 下谁都能调。要给外面用得自己显式改 host。
 *  · **默认关着**：开一个端口就要担一份风险，用户没说要就一直关着。
 *  · **key 第一次读配置就生成好**：不给「没配 key 就裸奔」的机会。
 *  · **写操作默认只出提案**：`/v1/call` 遇到会动的工具（渲染、删除、发布），
 *    不直接执行，先落一条提案等用户点头。auto_approve 才直接执行。
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const crypto = require('node:crypto')
const P = require('./paths')
const C = require('./core')

const DEFAULT_PORT = 8787
const CFG = path.join(P.HOME, '配置', '开放接口.json')

let _srv = null
let _actualPort = 0

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch { return {} }
}

function writeCfg(d) {
  fs.mkdirSync(path.dirname(CFG), { recursive: true })
  fs.writeFileSync(CFG, JSON.stringify(d, null, 2), 'utf8')
  return d
}

/** 读配置。第一次读就把 key 生成好落盘。 */
function config() {
  const d = readCfg()
  let dirty = false
  if (!d.key) { d.key = 'vk-' + crypto.randomBytes(22).toString('base64url'); dirty = true }
  const defaults = [['enabled', false], ['host', '127.0.0.1'], ['port', DEFAULT_PORT], ['auto_approve', false], ['note', '']]
  for (const [k, v] of defaults) {
    if (!(k in d)) { d[k] = v; dirty = true }
  }
  if (dirty) writeCfg(d)
  return d
}

function setConfig(kw = {}) {
  const d = config()
  for (const k of ['enabled', 'host', 'port', 'auto_approve', 'note']) {
    if (k in kw && kw[k] !== undefined && kw[k] !== '') d[k] = kw[k]
  }
  if ('port' in kw) {
    const n = Number(d.port)
    if (!Number.isFinite(n) || n < 1 || n > 65535) throw new Error('端口要是 1~65535 的数字，比如 8787')
    d.port = n
  }
  return writeCfg(d)
}

function rotateKey() {
  const d = config()
  d.key = 'vk-' + crypto.randomBytes(22).toString('base64url')
  return writeCfg(d)
}

function status() {
  const d = config()
  return {
    running: !!_srv,
    port: _srv ? _actualPort : null,
    want_port: d.port,
    host: d.host,
    enabled: !!d.enabled,
    auto_approve: !!d.auto_approve,
    key_hint: String(d.key || '').slice(0, 10) + '…',
    url: _srv ? `http://${d.host}:${_actualPort}/v1` : '',
    note: d.note || '',
  }
}

const text = (res, code, body, type = 'application/json; charset=utf-8') => {
  const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(s)
}

function authorized(req, d) {
  const h = String(req.headers.authorization || '')
  const m = h.match(/^Bearer\s+(.+)$/i)
  const given = m ? m[1].trim() : ''
  const want = String(d.key || '')
  if (!want || !given) return false
  // 定长比较，别让时序差泄露 key
  const a = Buffer.from(given), b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function body(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw new Error('请求体太大')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch { throw new Error('请求体不是合法 JSON') }
}

/** OpenAPI 描述。别的软件拿它就能自动知道有哪些能力、参数怎么填。 */
function spec(d) {
  const T = require('./tools')
  const names = Object.keys(T.REGISTRY)
  const paths = {
    '/v1/health': { get: { summary: '活着吗', operationId: 'health', responses: { 200: { description: 'ok' } } } },
    '/v1/tools': { get: { summary: '全部能力清单（含参数说明）', operationId: 'tools', responses: { 200: { description: 'ok' } } } },
    '/v1/call': {
      post: {
        summary: '调一个工具', operationId: 'call',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' }, customer: { type: 'string' } }, required: ['name'] } } } },
        responses: { 200: { description: 'ok' } },
      },
    },
    '/v1/agent': {
      post: {
        summary: '派一整段活给 AI 导演（异步，返回任务 id）', operationId: 'agent',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, customer: { type: 'string' } }, required: ['text'] } } } },
        responses: { 200: { description: 'ok' } },
      },
    },
    '/v1/tasks': { get: { summary: '任务列表', operationId: 'tasks', responses: { 200: { description: 'ok' } } } },
  }
  // 每个工具一条 /v1/tools/<name>
  const tpaths = {}
  for (const n of names) {
    tpaths[`/v1/tools/${n}`] = { get: { summary: String(T.REGISTRY[n].desc || '').slice(0, 90), operationId: 'tool_' + n.replace(/[^a-zA-Z0-9_]/g, '_'), responses: { 200: { description: 'ok' } } } }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'RiffCut 影创 · 本机能力接口', version: '1.0.0', description: `本机 ${names.length} 个能力。默认只绑 127.0.0.1。` },
    servers: [{ url: `http://${d.host}:${_actualPort || d.port}/v1` }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: { ...paths, ...tpaths },
  }
}

async function handle(req, res) {
  const d = config()
  const u = new URL(req.url, 'http://x')
  const p = u.pathname.replace(/\/+$/, '') || '/'

  // 文档不鉴权（内容只是能力名，不含数据），其余全要 key
  if (p === '/v1/openapi.json') return text(res, 200, spec(d))
  if (!authorized(req, d)) return text(res, 401, { ok: false, error: '要带 Authorization: Bearer <key>' })

  const T = require('./tools')
  const Tasks = require('./tasks')

  try {
    if (p === '/v1/health') {
      return text(res, 200, { ok: true, name: 'RiffCut 影创', tools: Object.keys(T.REGISTRY).length, at: new Date().toISOString() })
    }
    if (p === '/v1/tools') {
      const cust = u.searchParams.get('customer') || C.currentCustomer()
      const items = Object.entries(T.REGISTRY).map(([name, t]) => ({
        name, desc: t.desc, level: t.level, mutates: t.mutates || '', args: t.args || {},
        allowed: T.allowed(t, cust),
      }))
      return text(res, 200, { ok: true, total: items.length, level: C.levelOf(cust), scope: C.scopeOf(cust), tools: items })
    }
    if (p.startsWith('/v1/tools/')) {
      const name = decodeURIComponent(p.slice('/v1/tools/'.length))
      const t = T.REGISTRY[name]
      if (!t) return text(res, 404, { ok: false, error: '没有这个能力：' + name })
      return text(res, 200, { ok: true, name, desc: t.desc, level: t.level, mutates: t.mutates || '', args: t.args || {} })
    }
    if (p === '/v1/call' && req.method === 'POST') {
      const b = await body(req)
      const name = String(b.name || '')
      if (!name) return text(res, 400, { ok: false, error: '要给 name' })
      const t = T.REGISTRY[name]
      if (!t) return text(res, 404, { ok: false, error: '没有这个能力：' + name })
      const cust = String(b.customer || C.currentCustomer())
      if (!T.allowed(t, cust)) {
        return text(res, 403, { ok: false, error: `当前授权档「${C.levelOf(cust)}」不允许用「${name}」` })
      }
      // 写操作默认只出提案
      const writes = ['write', 'render', 'self'].includes(String(t.mutates || ''))
      if (writes && !d.auto_approve) {
        return text(res, 202, {
          ok: false, pending: true,
          error: `「${name}」会动文件，开放接口默认不直接执行。`,
          how: '要到设置里打开「自动执行写操作」，或者在本机界面里手动点。',
        })
      }
      const r = await T.call(name, b.args || {}, cust)
      return text(res, 200, r)
    }
    if (p === '/v1/agent' && req.method === 'POST') {
      const b = await body(req)
      const prompt = String(b.text || '').trim()
      if (!prompt) return text(res, 400, { ok: false, error: '要给 text' })
      const job = await Tasks.submit('开放接口：' + prompt.slice(0, 24), async () => {
        const K = require('./kernel')
        const k = new K.Kernel()
        try {
          await k.start({ cwd: P.HOME })
          const sid = 'api-' + Date.now()
          const text2 = await k.prompt(sid, prompt)
          return { ok: true, text: text2 }
        } finally { try { k.stop() } catch {} }
      }, { source: 'openapi' })
      return text(res, 202, { ok: true, task: job && (job.id || job.tid), note: '异步跑着，用 /v1/tasks 查进度。' })
    }
    if (p === '/v1/tasks') {
      const all = Tasks.list ? Tasks.list() : []
      return text(res, 200, { ok: true, total: all.length, tasks: all.slice(-40).reverse() })
    }
    return text(res, 404, { ok: false, error: '没有这个路径：' + p })
  } catch (e) {
    return text(res, 500, { ok: false, error: String(e && e.message || e) })
  }
}

/** 起服务。port=0 时由系统分配（测试用）。 */
function start(opts = {}) {
  return new Promise((resolve, reject) => {
    const d = config()
    if (_srv) return resolve(status())
    const srv = http.createServer((req, res) => { handle(req, res) })
    srv.on('error', (e) => { _srv = null; reject(e) })
    srv.listen(Number(opts.port ?? d.port), opts.host || d.host, () => {
      _srv = srv
      _actualPort = srv.address().port
      resolve(status())
    })
  })
}

function stop() {
  return new Promise((resolve) => {
    if (!_srv) return resolve({ ok: true, running: false })
    const s = _srv
    _srv = null
    _actualPort = 0
    s.close(() => resolve({ ok: true, running: false }))
  })
}

/** 按配置决定起还是停。 */
async function applyNow() {
  const d = config()
  if (!d.enabled) return stop()
  try { return await start() } catch (e) { return { ok: false, error: String(e.message || e) } }
}

module.exports = { DEFAULT_PORT, CFG, config, setConfig, rotateKey, status, spec, start, stop, applyNow, authorized }
