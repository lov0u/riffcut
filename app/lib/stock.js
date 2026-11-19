'use strict'
/**
 * 公开素材库 —— 没素材也能出片的关键一步：先把画面弄到手，再排分镜。
 *
 * 只用能商用的：CC0 / CC BY / 公有领域。署名原作者即可商用（CC BY），
 * 或者压根不用署名（CC0 / PD）。**不用 CC BY-NC / ND 的**——
 * 用户拿这些片子去做商单是常态，NC 那一条会让他整个作品不能用。
 *
 * 两个数据源，都免 key：
 *  · Wikimedia Commons —— 视频多，许可清楚，有转码档
 *  · Openverse —— 聚合多个图库，补图片
 *
 * ★ 为什么要挑转码档而不是原始文件：原始常是 100MB+ 的 4K webm，
 *   Wikimedia 会按 IP 限流（429），转码版小一个数量级，能稳定拿到。
 *
 * ★ 为什么抓片段要两段式：公开素材有两个常见毛病 ——
 *   ① 片头是标题卡（实测搜 ocean waves 抓到 1916 年默片，前十几秒全是字幕卡）
 *   ② 网络 seek 不稳（webm 的 cue 常在文件尾，ffmpeg 跳不动就报 File ended prematurely）
 *   所以先网络 seek 试一次 → 量一下画面动没动 → 没动就下到本地用帧差找准位置再截。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const E = require('./exec')
const C = require('./core')

const TIMEOUT = 25_000
const MAX_FETCH = 200 * 1024 * 1024
const UA = 'RiffCut/1.0 (video editing; +https://riffcut.local)'
const LEAD_IN = 1.2

/** 只认这些许可。NC（非商用）/ ND（禁改）一律不要。 */
function licenseOk(name) {
  const s = String(name || '').toLowerCase()
  if (!s) return false
  if (/nc|non-?commercial|nd|no-?deriv/.test(s)) return false
  return /cc0|public domain|pd-|cc-?by|attribution|cc by/.test(s)
}

const cleanHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()

/** 从 derivatives 里挑一档：够用、又别太大。720p 优先。 */
function bestDerivative(vi, wantH = 720) {
  const ds = (vi && vi.derivatives) || []
  if (!ds.length) return ''
  const vids = ds.filter((d) => /video|webm|mp4/i.test(String(d.type || d.src || '')))
  const list = vids.length ? vids : ds
  // 按高度排序，挑「不低于 wantH 的最小那档」；都不够就用最高的
  const withH = list.map((d) => ({ d, h: Number(d.height) || 0 })).filter((x) => x.h > 0)
  if (withH.length) {
    withH.sort((a, b) => a.h - b.h)
    const fit = withH.find((x) => x.h >= wantH) || withH[withH.length - 1]
    return fit.d.src || ''
  }
  return list[0].src || ''
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** Wikimedia Commons：不用 key，视频多，许可清楚。 */
async function searchCommons(query, kind = 'video', limit = 8) {
  const want = kind === 'video' ? 'filetype:video' : 'filetype:bitmap'
  const q = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: `${want} ${query}`, gsrnamespace: '6',
    gsrlimit: String(Math.max(1, Math.min(30, limit * 3))),
    prop: kind === 'video' ? 'videoinfo' : 'imageinfo',
    viprop: 'url|size|mime|derivatives|extmetadata',
    iiprop: 'url|size|mime|extmetadata',
  })
  let j
  try { j = await getJson('https://commons.wikimedia.org/w/api.php?' + q) } catch { return [] }
  const out = []
  for (const v of Object.values((j.query || {}).pages || {})) {
    const ii = ((kind === 'video' ? v.videoinfo : v.imageinfo) || [{}])[0]
    const md = ii.extmetadata || {}
    const mime = String(ii.mime || '')
    if (kind === 'video' && !mime.startsWith('video/')) continue
    if (kind !== 'video' && !mime.startsWith('image/')) continue
    const lic = cleanHtml((md.LicenseShortName || {}).value)
    if (!licenseOk(lic)) continue
    const pick = kind === 'video' ? bestDerivative(ii) : ''
    out.push({
      title: String(v.title || '').replace('File:', ''),
      url: pick || String(ii.url || '').split('?')[0],
      page: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(v.title || '')),
      mime, width: Number(ii.width) || 0, height: Number(ii.height) || 0,
      bytes: Number(ii.size) || 0, license: lic,
      artist: cleanHtml((md.Artist || {}).value).slice(0, 80),
      source: 'Wikimedia Commons',
    })
    if (out.length >= limit) break
  }
  return out
}

/** Openverse：聚合多个图库，免 key。视频覆盖不如 Commons，主要补图片。 */
async function searchOpenverse(query, kind = 'image', limit = 8) {
  const ep = kind === 'video' ? 'video' : 'images'
  const q = new URLSearchParams({ q: query, page_size: String(Math.max(1, Math.min(20, limit))) })
  let j
  try { j = await getJson(`https://api.openverse.org/v1/${ep}/?${q}`) } catch { return [] }
  const out = []
  for (const r of j.results || []) {
    const lic = `${r.license || ''} ${r.license_version || ''}`.trim()
    if (!licenseOk(lic)) continue
    out.push({
      title: String(r.title || '').slice(0, 80),
      url: String(r.url || ''),
      page: String(r.foreign_landing_url || r.detail_url || ''),
      mime: String(r.filetype ? `image/${r.filetype}` : ''),
      width: Number(r.width) || 0, height: Number(r.height) || 0, bytes: 0,
      license: lic, artist: String(r.creator || '').slice(0, 80), source: 'Openverse',
    })
    if (out.length >= limit) break
  }
  return out
}

/** 两边都搜，去重合并。视频优先 Commons，图片优先 Openverse。 */
async function search(query, kind = 'video', limit = 8) {
  const prim = kind === 'video' ? searchCommons(query, kind, limit) : searchOpenverse(query, kind, limit)
  const sec = kind === 'video' ? searchOpenverse(query, kind, limit) : searchCommons(query, kind, limit)
  const [a, b] = await Promise.all([prim, sec])
  const seen = new Set(), out = []
  for (const x of [...a, ...b]) {
    if (!x.url || seen.has(x.url)) continue
    seen.add(x.url)
    out.push(x)
    if (out.length >= limit) break
  }
  return out
}

/** 量「画面动没动」：抽几帧算亮度，看差分。返回最大差分。 */
async function motionStart(file, limit = 6, threshold = 2.5) {
  const r = await E.run(P.FFMPEG, ['-v', 'error', '-t', String(limit), '-i', file,
    '-vf', 'fps=2,scale=64:36,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', timeout: 60_000 })
  if (!r.ok || !r.stdout || r.stdout.length < 64 * 36 * 2) return 0
  const fsz = 64 * 36
  const n = Math.floor(r.stdout.length / fsz)
  let best = 0
  for (let i = 1; i < n; i++) {
    let diff = 0
    for (let j = 0; j < fsz; j++) diff += Math.abs(r.stdout[i * fsz + j] - r.stdout[(i - 1) * fsz + j])
    best = Math.max(best, diff / fsz)
  }
  return best
}

/**
 * 从网络地址取一段，转成本机能剪的 mp4。
 * 返回 {ok, path, from, ms, notes}。
 */
async function grab(url, out, opts = {}) {
  const dur = Math.max(0.5, Number(opts.dur) || 3)
  const w = Number(opts.width) || 1920
  const h = Number(opts.height) || 1080
  const fps = Number(opts.fps) || 30
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${fps}`
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const t0 = Date.now()
  const notes = []

  const cut = async (src, at) => {
    const net = /^https?:/.test(String(src))
    const head = ['-hide_banner', '-loglevel', 'error', '-y']
    if (net) head.push('-user_agent', UA) // 本地文件加这个会报 Option user_agent not found
    return E.run(P.FFMPEG, [...head, '-ss', String(Math.max(0, at)), '-t', String(dur), '-i', String(src),
      '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-t', String(dur), out], { timeout: 300_000 })
  }
  const ok = () => fs.existsSync(out) && fs.statSync(out).size >= 4096

  // 第一段：网络直接 seek。快，但拿到的不一定是正片。
  const start = Number(opts.start) || 0
  const r1 = await cut(url, start + LEAD_IN)
  if (r1.ok && ok()) {
    const m = await motionStart(out, Math.min(6, dur))
    if (m > 2.5) {
      const p = await E.probe(out)
      return { ok: true, path: out, from: start + LEAD_IN, ms: Date.now() - t0, notes, probe: p }
    }
    notes.push(`网络直接取到的那段画面几乎不动（帧差 ${m.toFixed(1)}），可能是标题卡，换下本地精确定位`)
  } else {
    notes.push('网络 seek 失败（webm 的索引常在文件尾），下到本地再截')
  }

  // 第二段：下到本地（转码版小），用帧差找起点
  const tmp = path.join(P.ROOT, 'runtime', 'stock-' + Date.now() + path.extname(new URL(url).pathname || '.mp4'))
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  const dl = await E.run('/usr/bin/curl', ['-sL', '--max-time', '180', '-A', UA, '-o', tmp, url], { timeout: 200_000 })
  if (!dl.ok || !fs.existsSync(tmp) || fs.statSync(tmp).size < 4096) {
    try { fs.unlinkSync(tmp) } catch {}
    return { ok: false, error: '下载失败：' + String(dl.stderr || '').slice(0, 100), notes }
  }
  // 找第一个「画面开始动」的位置
  let at = 0
  const scan = await motionStart(tmp, 15)
  if (scan > 2.5) {
    // 逐秒试，找到第一处帧差够大的
    for (let t = 0; t < 15; t += 1) {
      const rr = await cut(tmp, t)
      if (rr.ok && ok()) {
        const m = await motionStart(out, Math.min(4, dur))
        if (m > threshold) { at = t; break }
      }
    }
    notes.push(`本地从第 ${at} 秒起画面在动`)
  }
  const r2 = await cut(tmp, at)
  try { fs.unlinkSync(tmp) } catch {}
  if (!r2.ok || !ok()) return { ok: false, error: '截取失败：' + String(r2.stderr || '').slice(0, 100), notes }
  return { ok: true, path: out, from: at, ms: Date.now() - t0, notes, probe: await E.probe(out) }
}

/**
 * 中文 → 英文。先用一张常用词表（覆盖视频素材里 90% 的说法），
 * 表里没有就调模型翻一次（慢但准）。
 *
 * 为什么不直接每次都调模型：翻译要一秒多，而素材搜索本身就是几百毫秒的事，
 * 为了翻一个「海浪」等一秒多不划算。词表能覆盖的时候就别调。
 */
const ZH_EN = {
  城市: 'city', 夜景: 'night', 夜景城市: 'city night', 城市夜景: 'city night',
  海浪: 'ocean waves', 海: 'sea', 沙滩: 'beach', 礁石: 'rocks', 海边: 'coast',
  森林: 'forest', 树林: 'woods', 航拍: 'aerial', 山: 'mountain', 山脉: 'mountains',
  雪: 'snow', 雪山: 'snow mountain', 雨: 'rain', 雨夜: 'rainy night',
  云: 'clouds', 云海: 'sea of clouds', 日出: 'sunrise', 日落: 'sunset', 黄昏: 'dusk',
  星空: 'starry sky', 银河: 'milky way', 夜晚: 'night', 白天: 'daytime',
  街道: 'street', 马路: 'road', 车流: 'traffic', 地铁: 'subway', 火车: 'train',
  机场: 'airport', 飞机: 'airplane', 港口: 'harbor', 码头: 'dock',
  办公室: 'office', 会议: 'meeting', 电脑: 'computer', 键盘: 'keyboard',
  咖啡: 'coffee', 咖啡厅: 'cafe', 餐厅: 'restaurant', 厨房: 'kitchen',
  人: 'people', 人群: 'crowd', 走路: 'walking', 跑步: 'running', 运动: 'sport',
  工厂: 'factory', 机器: 'machine', 机械: 'machinery', 生产: 'production',
  实验室: 'laboratory', 科技: 'technology', 数据: 'data', 屏幕: 'screen',
  灯泡: 'light bulb', 光: 'light', 影子: 'shadow', 烟: 'smoke', 火: 'fire',
  水: 'water', 河流: 'river', 瀑布: 'waterfall', 湖: 'lake', 冰: 'ice',
  花: 'flowers', 树: 'tree', 叶子: 'leaves', 草地: 'grass field',
  狗: 'dog', 猫: 'cat', 鸟: 'birds', 鱼: 'fish',
  建筑: 'architecture', 大楼: 'skyscraper', 桥: 'bridge', 电视塔: 'tower',
  中国: 'china', 北京: 'beijing', 上海: 'shanghai', 深圳: 'shenzhen',
  慢动作: 'slow motion', 时间流逝: 'timelapse', 延时: 'timelapse',
}

async function autoEnglish(query) {
  const q = String(query || '').trim()
  if (!q) return ''
  if (!/[\u4e00-\u9fff]/.test(q)) return q
  // 词表优先：整串命中最好，否则把能认出来的词拼起来
  if (ZH_EN[q]) return ZH_EN[q]
  const parts = []
  let rest = q
  for (const k of Object.keys(ZH_EN).sort((a, b) => b.length - a.length)) {
    if (rest.includes(k)) {
      parts.push(ZH_EN[k])
      rest = rest.split(k).join(' ')
    }
  }
  if (parts.length) return [...new Set(parts)].join(' ')
  // 兜底才调模型
  try {
    const M = require('./models')
    const r = await M.chat(M.chatModelId(), [
      { role: 'system', content: '把用户给的中文画面描述翻成适合素材库搜索的英文关键词，只回英文词组，不要解释。' },
      { role: 'user', content: q },
    ], { maxTokens: 40 })
    const t = String((r && (r.text || r.content)) || '').trim().replace(/[^A-Za-z0-9 ]/g, ' ')
    return t.split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
  } catch { return '' }
}

const slug = (s, n = 18) => String(s || '').replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, n) || 'stock'

/** 搜索并成人读清单。 */
async function searchText(query, kind = 'video', limit = 8) {
  let items = await search(query, kind, limit)

  // ★ 中文几乎搜不到东西：Wikimedia Commons 和 Openverse 都是英文站，
  //   它们的索引里没有「城市夜景」这种词，只有 "city night"。
  //   实测「城市夜景」→ 0 条、「city night」→ 3 条。
  //   所以中文查不到时自动换英文再试一次，而不是让用户自己猜。
  let triedEn = ''
  if (!items.length && /[\u4e00-\u9fff]/.test(query)) {
    const en = await autoEnglish(query)
    if (en && en !== query) {
      triedEn = en
      items = await search(en, kind, limit)
    }
  }

  if (!items.length) {
    const L = [`「${query}」没搜到能商用的${kind === 'video' ? '视频' : '图片'}。`]
    if (triedEn) L.push(`自动换成英文「${triedEn}」也没搜到。`)
    if (/[\u4e00-\u9fff]/.test(query)) {
      L.push('', '这两个素材库都是英文站，中文关键词基本搜不到东西 —— 换英文再试：')
      L.push('  城市夜景 → city night')
      L.push('  海浪拍礁 → ocean waves rocks')
      L.push('  森林航拍 → forest aerial')
    } else {
      L.push('', '可能是关键词太抽象 —— 写具体的东西（city night / ocean waves / forest aerial），别写 technology 这种。')
    }
    return L.join('\n')
  }
  const L = [`【公开素材】「${query}」找到 ${items.length} 条（只用 CC0 / CC BY / 公有领域，都可商用）`, '']
  items.forEach((x, i) => {
    L.push(`${i + 1}. ${x.title}`)
    L.push(`   ${x.width}×${x.height} · ${x.license} · ${x.artist || '作者未署'} · ${x.source}`)
    L.push(`   ${x.url}`)
  })
  L.push('', '要下载就用 stock_fetch，会自动转成能剪的 mp4 并把作者和许可写进「素材来源.json」。')
  return L.join('\n')
}

/** 按一组关键词抓片段进素材库。 */
async function fetchToLibrary(queries, opts = {}, customer) {
  const list = Array.isArray(queries) ? queries : String(queries || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  if (!list.length) return { ok: false, error: '要给一组关键词' }
  const per = Number(opts.per) || 1
  const seconds = Number(opts.seconds) || 2.5
  const outDir = C.custPaths(customer).images
  fs.mkdirSync(outDir, { recursive: true })
  const creditFile = path.join(outDir, '素材来源.json')
  let credits = {}
  try { credits = JSON.parse(fs.readFileSync(creditFile, 'utf8')) } catch {}
  const got = [], failed = []
  for (const q of list) {
    const items = await search(q, 'video', Math.max(1, per * 3))
    for (let i = 0; i < Math.min(per, items.length); i++) {
      const it = items[i]
      const out = path.join(outDir, `${slug(q)}-${i + 1}-${P.stamp()}.mp4`)
      const r = await grab(it.url, out, { dur: seconds, width: opts.width, height: opts.height })
      if (r.ok) {
        got.push({ query: q, path: out, ...it, from: r.from, notes: r.notes })
        credits[path.basename(out)] = { 标题: it.title, 作者: it.artist, 许可: it.license, 来源页: it.page, 下载时间: new Date().toISOString().slice(0, 16) }
      } else failed.push({ query: q, title: it.title, error: r.error })
    }
  }
  try { fs.writeFileSync(creditFile, JSON.stringify(credits, null, 2), 'utf8') } catch {}
  return { ok: got.length > 0, got, failed, creditFile }
}

module.exports = { ZH_EN, autoEnglish, licenseOk, cleanHtml, bestDerivative, searchCommons, searchOpenverse, search, motionStart, grab, searchText, fetchToLibrary, slug }
