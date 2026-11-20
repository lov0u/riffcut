/**
 * 用量 / 依赖 / 客户 / 分析 四个查询接口（/api/usage /api/deps /api/customers /api/analytics）。
 *
 * 共同的铁律：**查不到就说查不到，不返回示例数字**。
 * 用量和发布归因是最容易被编造的两块 —— 编出来的「本月涨粉 1200」会直接误导选题。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const C = require('./core')
const P = require('./paths')

// ── 用量 ────────────────────────────────────────────────
const PERIODS = ['today', '24h', '7d', '30d']

/**
 * 时间字段解析成毫秒。
 *
 * ★ 盘上有两种写法，必须都认：
 *   · 数字时间戳（毫秒）
 *   · 字符串 "2026-11-19 19:58:40"（P.now() 产出的格式，实际用的就是它）
 * 以前只写 `Number(when)`：字符串一律 NaN → within() 直接返回 false →
 * 「模型使用量」不管哪个时间段都是 0 次调用、0 token、趋势图空白。
 * 用量一条没丢，纯粹是把时间当数字读了。
 */
function tsOf(when) {
  if (when == null || when === '') return 0
  if (typeof when === 'number') return Number.isFinite(when) ? when : 0
  const s = String(when).trim()
  if (/^\d+$/.test(s)) return Number(s)
  // "2026-11-19 19:58:40" / "2026-11-19T19:58:40" / ISO —— Safari 不认带空格的，先换成 T
  const t = Date.parse(s.replace(' ', 'T'))
  if (Number.isFinite(t)) return t
  const t2 = Date.parse(s)
  return Number.isFinite(t2) ? t2 : 0
}

function within(when, period) {
  const t = tsOf(when)
  if (!t) return false
  const now = Date.now()
  if (period === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0)
    return t >= d.getTime()
  }
  const span = period === '24h' ? 24 * 3600e3 : period === '7d' ? 7 * 86400e3 : 30 * 86400e3
  return now - t <= span
}

function usage(d = {}) {
  const act = String(d.action || 'summary')
  if (act === 'clear') {
    /* ★ 以前这里调 `C.saveUsage([])` —— core.js 根本没有这个函数（导出里没有），
       所以「清零」一直没真生效，只是改了个不存在的钩子。现在直接落盘。 */
    const all0 = C.usageRecent(100000) || []
    const n = all0.length
    try { P.save('usage', []) } catch (e) { /* 落盘失败也要如实报 */ }
    try { P.save('usage_totals', { calls: 0, chars: 0, amount: 0 }) } catch (e) {}
    try { fs.writeFileSync(path.join(P.HOME, '配置', '调用明细.json'), '[]') } catch (e) {}
    return { cleared: n }
  }
  let period = String(d.period || 'today')
  if (!PERIODS.includes(period)) period = 'today'
  const all = C.usageRecent(100000) || []
  const hit = all.filter((r) => within(r.at || r.time || r.ts, period))
  const tot = { calls: hit.length, in: 0, out: 0, cached: 0 }
  const byModel = {}
  let okN = 0, failedN = 0, msSum = 0, msN = 0, estN = 0

  /* ★ 前端（live.js 的用量卡片）读的是 requests / success_rate / estimated /
     failed / cache_hit_rate / avg_duration_ms / lifetime 等字段，
     而这里以前只返回 calls / in / out / cached。
     症状就是「输入 TOKENS 44K、输出 2.7K，但总请求 0、成功率 0%」——
     数字有、次数没有，看着像统计坏了。其实是我们两边字段名各说各话。
     现在把前端要的一次给全，字段名保持兼容（calls 与 requests 同值）。 */
  for (const r of hit) {
    const i = Number(r.in || 0), o = Number(r.out || 0), c = Number(r.cached || 0)
    tot.in += i; tot.out += o; tot.cached += c
    if (r.ok === false) failedN++; else okN++
    const ms = Number(r.ms || 0)
    if (ms > 0) { msSum += ms; msN++ }
    if (r.estimated) estN++
    const k = r.model || r.model_id || '未知'
    byModel[k] = byModel[k] || { calls: 0, in: 0, out: 0 }
    byModel[k].calls++; byModel[k].in += i; byModel[k].out += o
  }

  const calls = hit.length
  const successRate = calls ? Math.round((okN / calls) * 1000) / 10 : 0
  const cacheRate = tot.in ? Math.round((tot.cached / tot.in) * 1000) / 10 : 0
  const avgMs = msN ? Math.round(msSum / msN) : 0

  /* ★ 2026-11-20 修：前端读的字段这里一半没给，界面上就出现
     「累计 0 次调用」但下面明明写着 746 次总请求这种自相矛盾。
     逐个对上：
       · lifetime / lifetime_in / lifetime_out —— 前端「累计 N 次调用」，
         原来压根没算，恒取 0。这里从**全部明细**累加（不受时间段过滤）。
       · by_model[].name —— 前端读 r.name，这里以前给的是 r.model，全是 undefined。
       · by_supplier —— 整个字段没返回过，前端那张表永远显示「还没有成功调用」。
       · chart —— 没有，Token 趋势条永远空白。
       · cache_hit —— 没有，概览写「本地缓存命中 0 次」。
     注意：不再读 `调用累计.json`。那个文件是另一套模块写的、字段名完全不同
     （requests / total_calls / by_model.calls），跟明细数组对不上，两套一起用
     只会互相打脸。唯一事实源就是明细数组本身。 */
  const byModelRows = {}
  const bySupplierRows = {}
  let lifeIn = 0, lifeOut = 0
  for (const r of all) {
    const i = Number(r.in || 0), o = Number(r.out || 0)
    lifeIn += i; lifeOut += o
    const t = tsOf(r.at || r.time || r.ts || r.epoch)
    const nm = r.model || r.model_id || '未知'
    const sp = r.supplier || r.vendor || ''
    const bump = (bag, key, isOk) => {
      if (!key) return
      const row = bag[key] || (bag[key] = { requests: 0, in: 0, out: 0, last: 0, ok: 0 })
      row.requests++; row.in += i; row.out += o
      if (isOk) row.ok++
      if (t > row.last) row.last = t
    }
    bump(byModelRows, nm, r.ok !== false)
    bump(bySupplierRows, sp, r.ok !== false)
  }
  const toRows = (bag) => Object.entries(bag)
    .map(([name, v]) => ({ name, model: name, requests: v.requests, calls: v.requests,
      in: v.in, out: v.out, ok: v.ok,
      /* uClock 要的是「秒」，明细里是毫秒 —— 不除 1000 会显示成 1970 年 */
      last: v.last ? Math.round(v.last / 1000) : 0 }))
    .sort((a, b) => b.requests - a.requests)

  /* Token 趋势：按当前时间段等分 12 桶，桶里累加 in+out。
     前端 uChart 读 b.label 与 b.tokens。 */
  const chart = (() => {
    const N = 12
    const now = Date.now()
    const span = period === 'today' ? (now - new Date().setHours(0, 0, 0, 0))
      : period === '24h' ? 24 * 3600e3
        : period === '7d' ? 7 * 86400e3 : 30 * 86400e3
    const start = period === 'today' ? new Date().setHours(0, 0, 0, 0) : now - span
    const step = span / N
    const buckets = []
    for (let k = 0; k < N; k++) {
      const t0 = start + step * k
      const dt = new Date(t0)
      const label = period === 'today' || period === '24h'
        ? ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2)
        : (dt.getMonth() + 1) + '/' + dt.getDate()
      buckets.push({ label, tokens: 0, requests: 0 })
    }
    for (const r of hit) {
      const t = tsOf(r.at || r.time || r.ts || r.epoch)
      if (!t) continue
      let idx = Math.floor((t - start) / step)
      if (idx < 0) idx = 0
      if (idx >= N) idx = N - 1
      buckets[idx].tokens += Number(r.in || 0) + Number(r.out || 0)
      buckets[idx].requests++
    }
    return buckets
  })()

  return {
    period,
    stats: {
      ...tot,
      requests: calls,                 // ← 前端「总请求」
      ok: okN,
      failed: failedN,
      success_rate: successRate,
      estimated: estN,
      cache_hit_rate: cacheRate,
      avg_duration_ms: avgMs,
      tokens: tot.in + tot.out,
      /* 累计（全部明细，不按时间段过滤） */
      lifetime: all.length,
      lifetime_in: lifeIn,
      lifetime_out: lifeOut,
      /* 本地缓存命中次数（明细里 cache_hit 为真的条数） */
      cache_hit: all.filter((r) => r.cache_hit).length,
      by_model: toRows(byModelRows),
      by_supplier: toRows(bySupplierRows),
      chart,
    },
    recent: all.slice(-(Math.max(1, Math.min(200, Number(d.limit) || 10)))).reverse(),
    path: path.join(P.HOME, '配置', '调用明细.json'),
    note: all.length ? '' : '还没有调用记录。在首页聊天、测试模型连接之后这里才会有数。',
  }
}

// ── 依赖体检 ────────────────────────────────────────────
async function deps(d = {}) {
  const R = require('./render')
  /* ★ render.ready() 是 async（它要起一次 hyperframes 探版本）。
     当同步用会拿到 Promise 对象，于是 ok 全是 undefined、每一项都判成「缺」——
     依赖体检页会满屏红，说 ffmpeg 没装，其实装得好好的。 */
  const r = await R.ready()
  const caps = [
    { key: 'ffmpeg', label: '视频编解码', ok: !!(r.ok && r.ffmpeg), need: 'tools/ffmpeg', have: r.ffmpeg || '', note: r.ok ? '' : 'ffmpeg 跑不起来，出片全废' },
    { key: 'ffprobe', label: '读媒体信息', ok: !!(r.ok && r.ffprobe), need: 'tools/ffprobe', have: r.ffprobe || '', note: '' },
    { key: 'libx264', label: 'H.264 编码', ok: !!r.libx264, need: 'ffmpeg 带 libx264', have: r.libx264 ? '有' : '没有', note: r.libx264 ? '' : '没有 libx264 就出不了通用 mp4（旧版一直出不了片就是这个原因）' },
    { key: 'videotoolbox', label: '硬件编码', ok: !!r.hardware, need: 'ffmpeg 带 videotoolbox', have: r.hardware ? '有' : '没有', note: r.hardware ? '' : '没有硬编会慢，但不影响能不能出片' },
    { key: 'hyperframes', label: '渲染引擎', ok: !!r.ok, need: 'node_modules/hyperframes', have: r.hyperframes || '', note: r.ok ? '' : '渲染引擎没装好' },
    { key: 'chrome', label: '浏览器内核', ok: true, need: 'Electron 自带', have: 'Electron', note: '' },
  ]
  try {
    const A = require('./asr'); const s = A.status()
    caps.push({ key: 'asr', label: '语音识别', ok: !!s.ready, need: 'SenseVoice 权重', have: s.ready ? '就绪' : '没装', note: s.ready ? '' : '没装就只能读内嵌字幕轨' })
  } catch (e) { caps.push({ key: 'asr', label: '语音识别', ok: false, need: 'SenseVoice', have: '加载失败', note: e.message }) }
  const miss = caps.filter((c) => !c.ok)
  const want = String(d.capability || '').trim()
  return {
    caps, ok: miss.length === 0, missing: miss.map((c) => c.key),
    brief: miss.length ? '缺 ' + miss.map((c) => c.label).join('、') : '这台机器上要用的能力都在',
    one: want ? (caps.find((c) => c.key === want) || null) : null,
  }
}

// ── 客户 ────────────────────────────────────────────────
function dirSize(dir) {
  let n = 0
  if (!fs.existsSync(dir)) return 0
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    try {
      const st = fs.statSync(p)
      n += st.isDirectory() ? dirSize(p) : st.size
    } catch (e) {}
  }
  return n
}

function customers(d = {}) {
  const act = String(d.action || 'list')
  const base = path.join(P.HOME, '客户')
  const names = fs.existsSync(base) ? fs.readdirSync(base).filter((f) => {
    try { return fs.statSync(path.join(base, f)).isDirectory() } catch (e) { return false }
  }) : []
  if (act === 'list') {
    return names.map((name) => {
      const cp = C.custPaths(name)
      const works = (() => { try { return require('./timeline').listProjects(name).length } catch (e) { return 0 } })()
      return {
        name, root: cp.root,
        images: fs.existsSync(cp.images) ? fs.readdirSync(cp.images).length : 0,
        videos: fs.existsSync(cp.videos) ? fs.readdirSync(cp.videos).length : 0,
        projects: works,
        bytes: dirSize(cp.root),
        current: name === C.currentCustomer(),
      }
    })
  }
  if (act === 'size') {
    const name = String(d.name || '')
    if (!names.includes(name)) throw new Error('没有这个客户：' + name)
    return { name, bytes: dirSize(C.custPaths(name).root), folder: C.custPaths(name).root }
  }
  if (act === 'delete') {
    const name = String(d.name || d.id || '')
    if (!names.includes(name)) throw new Error('没有这个客户：' + name)
    if (name === C.currentCustomer()) throw new Error('不能删正在用的客户，先切到别的客户')
    const dir = C.custPaths(name).root
    if (d.purge) {
      /* 真删：先改名再留 3 天，用户后悔还能捞回来 */
      const bak = dir + '.废-' + Date.now().toString(36)
      fs.renameSync(dir, bak)
      return { name, purged: true, backup: bak, note: '没直接删，改成 ' + path.basename(bak) + ' 了，确认不要了再手动清' }
    }
    return { name, purged: false, note: '只从列表里去掉，文件还在：' + dir }
  }
  throw new Error('不认识的 action：' + act)
}

// ── 发布归因 ────────────────────────────────────────────
function analytics(d = {}) {
  const act = String(d.action || 'report')
  const PB = require('./publish')
  let recs = []
  try {
    const f = path.join(P.HOME, '配置', '发布记录.json')
    if (fs.existsSync(f)) recs = JSON.parse(fs.readFileSync(f, 'utf8')) || []
  } catch (e) { recs = [] }
  if (d.platform) recs = recs.filter((r) => r.platform === d.platform)
  const ok = recs.length >= 3
  const base = {
    total: recs.length,
    platforms: Object.entries(recs.reduce((m, r) => { m[r.platform] = (m[r.platform] || 0) + 1; return m }, {}))
      .map(([k, n]) => ({ platform: k, name: (PB.platforms().find((p) => p.key === k) || {}).name || k, n })),
    note: ok ? '' : '发布记录只有 ' + recs.length + ' 条。样本少于 3 条不下结论 —— 免得把偶然当成规律。',
  }
  if (act === 'report' || act === 'brief') return { ...base, recent: recs.slice(-20).reverse(), enough: ok }
  if (act === 'by_time') {
    const m = {}
    for (const r of recs) {
      const h = r.at ? new Date(r.at).getHours() : null
      if (h === null) continue
      m[h] = m[h] || { hour: h, n: 0 }
      m[h].n++
    }
    return { ...base, buckets: Object.values(m).sort((a, b) => a.hour - b.hour) }
  }
  if (act === 'by_format') {
    const m = {}
    for (const r of recs) { const k = r.aspect || '未知'; m[k] = (m[k] || 0) + 1 }
    return { ...base, buckets: Object.entries(m).map(([k, n]) => ({ aspect: k, n })) }
  }
  if (act === 'by_tags') {
    const m = {}
    for (const r of recs) for (const t of (r.tags || [])) m[t] = (m[t] || 0) + 1
    return { ...base, buckets: Object.entries(m).map(([k, n]) => ({ tag: k, n })).sort((a, b) => b.n - a.n).slice(0, Math.max(1, Number(d.top) || 8)) }
  }
  return base
}

/** 把「在 Finder 里显示」统一收在一处：只认软件自己数据目录里的路径 */
function reveal(d = {}) {
  const p = String(d.path || '').trim() || C.custPaths(C.currentCustomer()).videos
  const root = P.HOME
  const abs = path.resolve(p)
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error('只能定位软件数据目录里的文件')
  }
  if (!fs.existsSync(abs)) throw new Error('这个地方不存在：' + abs)
  try { require('electron').shell.showItemInFolder(abs) } catch (e) {}
  return { path: abs }
}

/** 多版本：同一份方案出 N 个不同开头的版本，交给用户挑 */
function multiversion(d = {}) {
  const n = Math.max(2, Math.min(5, Number(d.count) || 3))
  return {
    count: n,
    requirement: String(d.requirement || ''),
    steps: [
      '1. 先用 hook_check 给 ' + n + ' 个不同开头打分，只留 7 分以上的',
      '2. 每个开头各排一次 v1，主体段原样复用（不要重排，重排等于做 ' + n + ' 条新片）',
      '3. 渲成 ' + n + ' 个预览，用 swap_hook 只换开头、主体不重编码',
      '4. 把 ' + n + ' 条并排给用户看，挑一条再出正式成片',
    ],
    note: '这条路只在用户明确要 A/B 时才走 —— 每次都出 ' + n + ' 条预览会让「出片」变慢 ' + n + ' 倍。',
  }
}

module.exports = { usage, deps, customers, analytics, reveal, multiversion, PERIODS }
