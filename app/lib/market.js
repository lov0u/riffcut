'use strict'
/**
 * 插件市场（awesome-dsh-plugin 的真实索引）。
 *
 * 为什么自己拉而不是问内核的 plugin_market 工具：那个工具是给 AI 在对话里用的，
 * 一次要走一轮模型 + session/wait（几十秒）。用户点开插件页不该等这个 ——
 * 索引就是一个静态 JSON，直接 HTTP 拿，零延迟。
 *
 * 索引格式是 DSH 官方的 format:1（`@deepseek-ai/dsh-plugin-market-index` 的
 * `parseMarketIndex` 校验用它），当前 6112 个插件，约 4.9MB。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')

const URLS = [
  'https://awesome-dsh-plugin.com/index.json',
  'https://dshmarket.com/index.json',
]
const CACHE = () => path.join(P.HOME, '缓存', 'market.json')
const TTL = 6 * 3600 * 1000       // 6 小时；索引一天才更新几次，没必要每次进页面都拉

function cacheAge() {
  try { return Date.now() - fs.statSync(CACHE()).mtimeMs } catch (e) { return Infinity }
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE(), 'utf8')) } catch (e) { return null }
}

/** 拉索引。返回 (doc, err)；全失败时退回旧缓存，一个都没有就报错。 */
async function fetchIndex(force) {
  if (!force && cacheAge() < TTL) {
    const c = readCache()
    if (c && Array.isArray(c.plugins)) return [c, null]
  }
  let lastErr = ''
  for (const url of URLS) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 40000)
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'RiffCut/1.0' } })
      clearTimeout(timer)
      if (!r.ok) { lastErr = url + ' HTTP ' + r.status; continue }
      const doc = await r.json()
      if (!doc || !Array.isArray(doc.plugins)) { lastErr = url + ' 结构不对'; continue }
      // 原子写：先写临时文件再 rename，中途断网不会留下半个 JSON
      const f = CACHE()
      fs.mkdirSync(path.dirname(f), { recursive: true })
      const tmp = f + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(doc))
      fs.renameSync(tmp, f)
      return [doc, null]
    } catch (e) {
      lastErr = url + ' ' + String((e && e.message) || e)
    }
  }
  const c = readCache()
  if (c && Array.isArray(c.plugins)) return [c, '用缓存（' + lastErr + '）']
  return [null, '拉不到市场索引：' + lastErr]
}

/** 本地化文本：索引里可能是字符串，也可能是 {en, zh} */
function text(v) {
  if (!v) return ''
  if (typeof v === 'string') return v
  return v.zh || v.en || ''
}

/** 一条索引项 → 界面要的行 */
function row(p) {
  const vers = Array.isArray(p.versions) ? p.versions : []
  const v0 = vers[0] || {}
  const src = v0.source || {}
  const nm = String(p.name || '')
  const owner = String((p.title && typeof p.title === 'string' && p.title.includes('/')) ? p.title.split('/')[0] : '')
  const short = nm.includes('/') ? nm.split('/').pop() : nm
  // 安装标识：npm 用 name@version；git 用 git+url#commit
  let spec = ''
  if (src.type === 'npm') spec = nm + '@' + (v0.version || 'latest')
  else if (src.type === 'git') spec = 'git+' + src.url + '#' + (src.commit || 'HEAD')
  return {
    name: nm,
    short: short,
    owner: owner,
    title: text(p.title) || short,
    desc: text(p.description),
    version: v0.version || '',
    versions: vers.length,
    category: (p.metadata && p.metadata.category) || '',
    keywords: (p.metadata && p.metadata.keywords) || [],
    homepage: p.homepage || '',
    repo: (p.repository && p.repository.url) || '',
    spec: spec,
  }
}

/**
 * 市场列表。
 * @param {{query?:string, limit?:number, offset?:number, force?:boolean}} opts
 */
async function list(opts = {}) {
  const [doc, err] = await fetchIndex(!!opts.force)
  if (!doc) return { ok: false, error: err }
  const all = doc.plugins || []
  const q = String(opts.query || '').trim().toLowerCase()
  let hit = all
  if (q) {
    hit = all.filter((p) => {
      const nm = String(p.name || '').toLowerCase()
      if (nm.includes(q)) return true
      if (text(p.description).toLowerCase().includes(q)) return true
      if (text(p.title).toLowerCase().includes(q)) return true
      const kw = (p.metadata && p.metadata.keywords) || []
      return kw.some((k) => String(k).toLowerCase().includes(q))
    })
  }
  const limit = Math.max(1, Math.min(300, Number(opts.limit) || 60))
  const offset = Math.max(0, Number(opts.offset) || 0)
  const page = hit.slice(offset, offset + limit).map(row)
  return {
    ok: true,
    data: {
      title: text(doc.title) || 'DSH 插件市场',
      total: all.length,
      matched: hit.length,
      shown: page.length,
      offset: offset,
      query: q,
      updated: doc.updated || '',
      plugins: page,
      note: err || '',
    },
  }
}

module.exports = { list, fetchIndex, row, text, URLS }
