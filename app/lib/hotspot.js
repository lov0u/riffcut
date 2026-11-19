'use strict'
/**
 * 热点雷达 —— 回答「今天该拍什么」。剪得再好，选题错了白干。
 *
 * 数据来源全部是**公开公益接口**，无需 key、无需登录：
 *   · 备源 xxapi  https://v2.xxapi.cn/api/<平台>hot
 *   · 主源 60s    https://60s.viki.moe/v2/<平台>
 *
 * 为什么默认先打备源：2026-11-15 实测，60s 的 6 个平台端点里 **5 个返回
 * `error code: 1015`**（Cloudflare 限流），只有 /v2/weibo 还活着；xxapi 的 4 个
 * 端点全部正常。所以顺序是 xxapi 优先、60s 兜底 —— 这跟网上教程写的相反，
 * 因为那些是半年前的结论，源已经变了。
 *
 * 三条必须做对的：
 *  1. **结构不统一**。各平台返回天差地别，每个平台必须有自己的解析分支。
 *  2. **只读，不碰平台官网**。weibo.com / douyin.com / zhihu.com / tophub.today
 *     对非浏览器流量一律反爬（登录页/验证码/403）。代码里没有任何一处指向它们。
 *  3. **不编数据**。全部源都失败时返回 ok:false 并说清原因，绝不返回示例数据
 *     冒充真实热搜 —— 模型拿到假热搜会当真去写选题。
 */

const C = require('./core')

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// 备源：4 个平台，2026-11-15 实测全通
const XXAPI = {
  weibo: 'https://v2.xxapi.cn/api/weibohot',
  douyin: 'https://v2.xxapi.cn/api/douyinhot',
  bilibili: 'https://v2.xxapi.cn/api/bilibilihot',
  baidu: 'https://v2.xxapi.cn/api/baiduhot',
}

// 主源：路径必须带 /v2/，少一段就是 404
const SIXTY = {
  weibo: 'https://60s.viki.moe/v2/weibo',
  douyin: 'https://60s.viki.moe/v2/douyin',
  zhihu: 'https://60s.viki.moe/v2/zhihu',
  toutiao: 'https://60s.viki.moe/v2/toutiao',
  rednote: 'https://60s.viki.moe/v2/rednote',
  baidu: 'https://60s.viki.moe/v2/baidu/hot',
}

const PLATFORM_LABEL = {
  weibo: '微博', douyin: '抖音', zhihu: '知乎', toutiao: '头条',
  rednote: '小红书', bilibili: 'B站', baidu: '百度',
}

const CACHE_TTL = 300          // 热搜 5 分钟内不重复打，省得被限流
const TIMEOUT = 12000
const _cached = new Map()

async function _getJson(url) {
  // ★ 必须写 globalThis.fetch：本模块自己导出了一个 fetch(platform)，
  // 直接写 fetch(...) 会调到自己身上 —— 症状是每个源都报「HTTP undefined」，
  // 因为拿一个 URL 当平台名去查 PLATFORM_LABEL 查不到，返回的对象没有 status。
  const r = await globalThis.fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*' },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const txt = await r.text()
  // CF 拦截会返回纯文本 "error code: 1015"，不是 JSON，JSON.parse 会直接抛
  if (!/^[\s]*[[{]/.test(txt)) throw new Error((txt.trim().slice(0, 80) || '非 JSON 响应'))
  return JSON.parse(txt)
}

/** 热度可能是 1162961 / "1500000" / "150万" / "12.3w"。统一成整数，认不出返回 0。 */
function toInt(v) {
  if (typeof v === 'number') return Math.trunc(v)
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/,/g, '')
  if (!s) return 0
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(万|w|亿|kw)?/)
  if (!m) return 0
  let n = parseFloat(m[1])
  const unit = m[2] || ''
  if (unit === '万' || unit === 'w') n *= 1e4
  else if (unit === '亿') n *= 1e8
  else if (unit === 'kw') n *= 1e3
  return Math.trunc(n)
}

function _norm(title, hot, url, rank) {
  return { title: String(title == null ? '' : title).trim(), hot: toInt(hot), url: String(url || ''), rank: Number(rank) || 0 }
}

// ── 每个源一套解析：结构差异太大，不能合并 ──
function parseXxapi(platform, d) {
  if (![200, '200', 0, '0'].includes(d.code)) throw new Error(String(d.msg || '接口返回非 200').slice(0, 80))
  const data = d.data
  if (!Array.isArray(data)) throw new Error('data 不是列表')
  const out = []
  data.forEach((it, i) => {
    const n = i + 1
    if (typeof it === 'string') {
      out.push(_norm(it, 0, '', n))          // B站：纯字符串数组
    } else if (it && typeof it === 'object') {
      if (platform === 'douyin') {           // 抖音：word / hot_value / position
        out.push(_norm(it.word, it.hot_value, '', it.position || n))
      } else {                               // 微博 / 百度：title / hot / url
        out.push(_norm(it.title, it.hot, it.url, it.index || n))
      }
    }
  })
  return out.filter(x => x.title)
}

function parse60s(platform, d) {
  let data = d.data
  if (data && !Array.isArray(data) && typeof data === 'object') data = data.data
  if (!Array.isArray(data)) throw new Error('data 不是列表')
  const out = []
  data.forEach((it, i) => {
    const n = i + 1
    if (typeof it === 'string') out.push(_norm(it, 0, '', n))
    else if (it && typeof it === 'object') {
      out.push(_norm(it.title || it.word || it.name, it.hot_value || it.hot || it.heat,
        it.url || it.link, it.index || it.rank || n))
    }
  })
  return out.filter(x => x.title)
}

/**
 * 抓一个平台的实时热搜。返回 {ok, platform, items, source, at}。
 * ok:false 时 items 为空、error 说明为什么 —— **不返回任何示例数据**。
 */
async function fetch(platform = 'weibo', limit = 20, useCache = true) {
  let p = String(platform || 'weibo').trim().toLowerCase()
  if (['小红', 'xiaohongshu', 'xhs'].includes(p)) p = 'rednote'
  if (['b站', 'bilibili'].includes(p)) p = 'bilibili'
  if (!PLATFORM_LABEL[p]) {
    return { ok: false, platform: p, items: [], error: `不认识这个平台（支持：${Object.keys(PLATFORM_LABEL).join(' / ')}）` }
  }
  limit = Math.max(1, Math.min(50, Number(limit) || 20))
  const ck = `${p}|${limit}`
  if (useCache) {
    const hit = _cached.get(ck)
    if (hit && Date.now() - hit.ts < CACHE_TTL * 1000) return { ...hit.val, cached: true }
  }

  const tried = []
  // 先备源（实测活），再主源（实测多数已挂）
  if (XXAPI[p]) {
    try {
      const items = parseXxapi(p, await _getJson(XXAPI[p]))
      if (items.length) return _done(p, items, limit, 'xxapi', ck)
      tried.push('xxapi：解析出 0 条')
    } catch (e) { tried.push('xxapi：' + String(e.message || e)) }
  }
  if (SIXTY[p]) {
    try {
      const items = parse60s(p, await _getJson(SIXTY[p]))
      if (items.length) return _done(p, items, limit, '60s', ck)
      tried.push('60s：解析出 0 条')
    } catch (e) { tried.push('60s：' + String(e.message || e)) }
  }
  return {
    ok: false, platform: p, items: [],
    error: tried.join('；') || '这个平台没有可用数据源',
    hint: '可以换个平台查，或者直接把热搜截图发给用户让他自己贴文字',
  }
}

function _done(p, items, limit, source, ck) {
  const val = {
    ok: true, platform: p, label: PLATFORM_LABEL[p] || p,
    items: items.slice(0, limit), source,
    at: new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16),
  }
  _cached.set(ck, { ts: Date.now(), val })
  return val
}

/** 多平台合并榜单。 */
async function board(platforms = null, limit = 10) {
  let list = platforms
  if (!list) list = ['weibo', 'douyin', 'bilibili', 'baidu']
  if (typeof list === 'string') list = list.split(/[,，\s]+/).filter(Boolean)
  const boards = {}
  let okAny = false
  await Promise.all(list.map(async p => {
    const r = await fetch(p, limit)
    boards[p] = r
    if (r.ok) okAny = true
  }))
  return { ok: okAny, boards, note: okAny ? '' : '所有平台都没拿到数据，别自己编热搜' }
}

/** 给界面/工具看的平台清单：哪些源可用。 */
function platforms() {
  return Object.entries(PLATFORM_LABEL).map(([key, label]) => ({
    key, label,
    sources: [['xxapi', !!XXAPI[key]], ['60s', !!SIXTY[key]]].filter(x => x[1]).map(x => x[0]),
    reliable: !!XXAPI[key],
  }))
}

/**
 * 按赛道关键词筛。中文不做分词 —— 直接子串命中。
 * 宁可多留几条让模型自己挑，也别因为分错词把相关热点漏掉。
 */
function match(items, keywords) {
  let kws = keywords
  if (typeof kws === 'string') kws = kws.split(/[,，、\s]+/).filter(Boolean)
  if (!Array.isArray(kws) || !kws.length) return Array.isArray(items) ? items.slice() : []
  const out = []
  for (const it of items || []) {
    const t = it.title || ''
    const hits = kws.filter(k => t.includes(k))
    if (hits.length) out.push({ ...it, matched: hits })
  }
  return out
}

function human(n) {
  n = Number(n) || 0
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
  return String(n)
}

/** 给模型看的一行行文本，比原始 JSON 省 token。 */
async function brief(platform = 'weibo', limit = 10, keywords = '') {
  const r = await fetch(platform, limit)
  if (!r.ok) return '热点没抓到：' + r.error
  const items = keywords ? match(r.items, keywords) : r.items
  if (!items.length) return `${r.label || platform} 热搜 ${r.items.length} 条，没有跟「${keywords}」相关的。`
  const lines = [`${r.label || platform} 实时热搜（${r.at}，来源 ${r.source}）`]
  for (const it of items.slice(0, Math.max(1, Number(limit) || 10))) {
    const hot = it.hot || 0
    lines.push(`${String(it.rank || 0).padStart(2, ' ')}. ${it.title}`
      + (hot ? `  [热度 ${human(hot)}]` : '')
      + (it.matched ? `  ← ${it.matched.join('/')}` : ''))
  }
  return lines.join('\n')
}

// ── 选题建议：把热搜变成能拍的题目 ──
const ANGLE_RULES = [
  ['科技', '拆开讲：这个技术到底改变了哪一步，普通人什么时候能用上'],
  ['数码', '对比法：上一代 / 隔壁家 / 你自己的真实体验，三选二'],
  ['AI', '现场试：当着镜头让它干一件具体事，成功失败都留着'],
  ['价格', '算账：把钱摊到每天，或者跟另一笔开销换着比'],
  ['争议', '两边都摆：先说反方最有道理的一句，再给正方'],
  ['首次', '见证式：把「第一次」的时刻从头拍到尾，别剪掉过程中的卡壳'],
]

/** 从热搜里挑几条，给出「怎么切」的角度。纯规则，不调模型。 */
function topicIdeas(items, keywords = '', n = 3) {
  const pool = keywords ? match(items, keywords) : (Array.isArray(items) ? items.slice() : [])
  if (!pool.length) return []
  return pool.slice(0, Math.max(1, Number(n) || 3)).map(it => {
    const t = it.title || ''
    let angle = ''
    for (const [kw, a] of ANGLE_RULES) if (t.includes(kw)) { angle = a; break }
    if (!angle) angle = '补一层现场：别人在转述，你去拍一个具体的场景或一个具体的人'
    return {
      title: t, hot: it.hot, rank: it.rank, angle,
      format: (it.hot || 0) > 500000 ? '竖屏短视频' : '图文或短口播',
    }
  })
}

/** 离线自检：不打网络，只验证纯计算部分。 */
function selftest() {
  const errs = []
  const cases = [[1162961, 1162961], ['1500000', 1500000], ['150万', 1500000],
    ['12.3万', 123000], ['1.2亿', 120000000], ['', 0], [null, 0], ['abc', 0]]
  for (const [raw, want] of cases) {
    const got = toInt(raw)
    if (got !== want) errs.push(`toInt(${JSON.stringify(raw)}) = ${got}，应为 ${want}`)
  }
  try {
    const a = parseXxapi('weibo', { code: 200, data: [{ title: '微博话题', hot: '150万', url: 'u1', index: 1 }] })
    if (!(a[0] && a[0].title === '微博话题' && a[0].hot === 1500000)) errs.push('微博解析错：' + JSON.stringify(a))
    const b = parseXxapi('douyin', { code: 200, data: [{ word: '抖音话题', hot_value: 12028085, position: 1 }] })
    if (!(b[0] && b[0].title === '抖音话题' && b[0].hot === 12028085)) errs.push('抖音解析错：' + JSON.stringify(b))
    const c = parseXxapi('bilibili', { code: 200, data: ['B站纯字符串', '第二条'] })
    if (!(c.length === 2 && c[0].title === 'B站纯字符串')) errs.push('B站解析错：' + JSON.stringify(c))
    const d = parse60s('weibo', { code: 200, data: [{ title: '60s话题', hot_value: 99, link: 'L' }] })
    if (!(d[0] && d[0].title === '60s话题' && d[0].url === 'L')) errs.push('60s 解析错：' + JSON.stringify(d))
  } catch (e) { errs.push('解析归一化失败：' + e.message) }
  const hit = match([{ title: 'AI 手机发布' }, { title: '足球比赛' }], 'AI,数码')
  if (hit.length !== 1) errs.push('match 筛选错误：' + JSON.stringify(hit))
  return { ok: !errs.length, errors: errs, cases: cases.length }
}

module.exports = {
  PLATFORM_LABEL, XXAPI, SIXTY, ANGLE_RULES,
  fetch, board, platforms, match, brief, topicIdeas, toInt, selftest, human,
  parseXxapi, parse60s,
}
