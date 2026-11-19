// 素材库：扫描、入库、缩略图、清晰度、去重、自动标签、内部索引。
// 索引一律写软件内部 客户/<客户>/缓存/索引/，绝不写进用户选的素材文件夹（那边只读）。
const { join, basename, extname, dirname, normalize } = require('node:path')
const { existsSync, statSync, readdirSync } = require('node:fs')
const { createHash } = require('node:crypto')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

const INDEX_NAME = 'RiffCut-素材索引.json'
const md5 = s => createHash('md5').update(String(s)).digest('hex')

function kindOf(ext) {
  ext = String(ext).toLowerCase()
  if (P.VIDEO_EXT.has(ext)) return '视频'
  if (P.IMAGE_EXT.has(ext)) return '图片'
  if (P.AUDIO_EXT.has(ext)) return '音频'
  return ''
}

/** ffprobe 真实读取时长/分辨率/帧率/编码。 */
async function probeMedia(file) {
  const p = await E.probe(file)
  if (!p) return {}
  const info = {}
  if (p.duration) info.duration = Math.round(p.duration * 100) / 100
  if (p.width) { info.width = p.width; info.height = p.height }
  if (p.fps) info.fps = Math.round(p.fps * 100) / 100
  if (p.vcodec) info.vcodec = p.vcodec
  if (p.acodec) info.acodec = p.acodec
  if (p.raw && (p.raw.streams || []).some(s => s.codec_type === 'subtitle')) info.has_subtitle = true
  return info
}

/** 灰度原始像素，用于清晰度评分与感知哈希。 */
async function gray(file, kind, size = '32x32') {
  const args = ['-hide_banner', '-loglevel', 'error']
  if (kind === '视频') args.push('-ss', '1')
  if (kind === '图片') args.push('-loop', '1')
  args.push('-i', file, '-frames:v', '1', '-vf', `scale=${size},format=gray`, '-f', 'rawvideo', 'pipe:1')
  const r = await E.run(P.FFMPEG, args, { timeout: 25000, encoding: 'buffer' })
  return r.ok && Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0)
}

/** 灰度方差 → 清晰度评分（0~100）。真实计算，不用图像库。 */
function sharpness(buf) {
  if (!buf || buf.length < 64) return 0
  const vals = Array.from(buf.subarray(0, 1024))
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const varSum = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length
  return Math.min(100, Math.round((varSum / 12.0) * 10) / 10)
}

/** 差异哈希 → 64bit，用于相似镜头去重。 */
function dhash(buf, w = 9, h = 8) {
  if (!buf || buf.length < w * h) return ''
  const bits = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits.push(buf[y * w + x] > buf[y * w + x + 1] ? '1' : '0')
    }
  }
  return BigInt('0b' + bits.join('')).toString(16).padStart(16, '0')
}

function hamming(a, b) {
  if (!a || !b) return 99
  try {
    let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0
    while (x) { n += Number(x & 1n); x >>= 1n }
    return n
  } catch { return 99 }
}

/** 自动打标签：文件名关键词 + 真实元数据。 */
function autoTags(name, info, kind) {
  const tags = [kind]
  const rules = [
    ['产品', ['产品', 'product', '特写', 'detail']],
    ['人物', ['人', '采访', '口播', 'portrait']],
    ['风景', ['山', '海', '空镜', '景', 'landscape', 'sky']],
    ['城市', ['城', '楼', '街', 'city']],
    ['科技', ['科技', '数据', '3d', 'tech', '抽象']],
    ['室内', ['室内', '办公', '空间', 'interior']],
    ['片头', ['开场', '片头', 'intro']],
    ['片尾', ['片尾', '结尾', 'outro']],
    ['配乐', ['bgm', '配乐', 'music']],
  ]
  const low = String(name).toLowerCase()
  for (const [tag, keys] of rules) if (keys.some(k => low.includes(k))) tags.push(tag)
  if (info.width) tags.push(`${info.width}x${info.height}`)
  if (info.duration) tags.push(`${Math.round(info.duration)}秒`)
  if (info.has_subtitle) tags.push('内嵌字幕')
  return [...new Set(tags)]
}

/** 抽一帧做缩略图；音频生成波形图。 */
async function thumb(file, kind, out) {
  let args
  if (kind === '音频') {
    args = ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-filter_complex', 'showwavespic=s=320x120:colors=0x1B8B7E', '-frames:v', '1', '-y', out]
  } else {
    args = ['-hide_banner', '-loglevel', 'error']
    if (kind === '视频') args.push('-ss', '1')
    if (kind === '图片') args.push('-loop', '1')
    args.push('-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', out)
  }
  const r = await E.run(P.FFMPEG, args, { timeout: 30000 })
  return r.ok && existsSync(out)
}

// ── 索引（软件内部，不进用户文件夹）───────────────────
function indexPath(root, customer) {
  const key = md5(normalize(String(root).replace(/^~/, require('node:os').homedir()))).slice(0, 16)
  const d = C.custPaths(customer).index
  P.ensureDir(d)
  return join(d, key + '.json')
}

function readIndex(root, customer) {
  const p = indexPath(root, customer)
  if (!existsSync(p)) return null
  const j = P.readJson(p, null)
  return j && j.velora_index === 1 ? j : null
}

const IDX_KEYS = ['path', 'name', 'kind', 'ai_desc', 'ai_score', 'ai_tags', 'ai_pick',
  'ai_start', 'ai_end', 'ai_model', 'ai_quality', 'ai_timeline', 'ai_use_for',
  'ai_best', 'ai_frames', 'ai_step']

function writeIndex(root, model, items, merge = false, customer) {
  const p = indexPath(root, customer)
  const cur = {}
  if (merge) {
    for (const it of (readIndex(root, customer) || {}).items || []) {
      if (it.path) {
        const rec = {}
        for (const k of IDX_KEYS) if (k in it) rec[k] = it[k]
        cur[it.path] = rec
      }
    }
  }
  for (const it of items) {
    if (!it.path) continue
    const rec = {}
    for (const k of IDX_KEYS) if (k in it) rec[k] = it[k]
    cur[it.path] = rec
  }
  const merged = Object.values(cur)
  const data = {
    velora_index: 1, root: String(root), folder: basename(root),
    customer: C.custPaths(customer).customer, created: P.now(),
    model, count: merged.length, items: merged,
  }
  P.writeJson(p, data)
  return p
}

function applyIndex(items, idx) {
  const byPath = new Map()
  for (const i of (idx && idx.items) || []) if (i.path) byPath.set(i.path, i)
  let applied = 0
  for (const it of items) {
    const rec = byPath.get(it.path)
    if (!rec) continue
    for (const k of IDX_KEYS) if (k in rec && k !== 'path') it[k] = rec[k]
    applied++
  }
  return applied
}

function indexMissing(items, idx) {
  const analyzable = items.filter(i => (i.kind === '视频' || i.kind === '图片') && !i.duplicate && !i.is_ending)
  const known = new Set(((idx && idx.items) || []).map(i => i.path).filter(Boolean))
  return [analyzable.length, analyzable.filter(i => !known.has(i.path)).length]
}

// ── 扫描 ──────────────────────────────────────────────
function walk(root, out, depth = 0) {
  if (depth > 6) return out
  let ents
  try { ents = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const full = join(root, e.name)
    if (e.isDirectory()) {
      if (/^(RiffCut归类|节点_modules|\.)/.test(e.name)) continue
      walk(full, out, depth + 1)
    } else if (e.isFile()) {
      const k = kindOf(extname(e.name))
      if (k) out.push({ full, kind: k })
    }
  }
  return out
}

/**
 * 真实扫描素材文件夹：ffprobe 元数据 + 缩略图 + 清晰度 + 去重。
 * 增量模式只处理新文件，已有条目原样带过。
 */
async function scanFolder(root, customer, opts = {}) {
  const incremental = !!opts.incremental
  const old = incremental ? library(customer) : null
  const oldByFull = new Map(((old && old.items) || []).map(i => [i.full, i]))
  const files = walk(root, [])
  const items = []
  const hashes = []
  const thumbsDir = C.custPaths(customer).thumbs
  P.ensureDir(thumbsDir)

  for (const f of files) {
    const name = basename(f.full)
    const prev = oldByFull.get(f.full)
    if (prev) { items.push(prev); if (prev.hash) hashes.push(prev.hash); continue }
    let st
    try { st = statSync(f.full) } catch { continue }
    const info = (f.kind === '视频' || f.kind === '音频') ? await probeMedia(f.full) : {}
    if (f.kind === '图片') {
      const pi = await E.probe(f.full)
      if (pi && pi.width) { info.width = pi.width; info.height = pi.height }
    }
    const id = md5(f.full).slice(0, 12)
    const thumbName = md5(f.full) + '.jpg'
    const thumbAbs = join(thumbsDir, thumbName)
    try { await thumb(f.full, f.kind, thumbAbs) } catch {}

    let sharp = 0, hash = '', dup = false
    if (f.kind === '视频' || f.kind === '图片') {
      const g = await gray(f.full, f.kind)
      sharp = sharpness(g)
      hash = dhash(g)
      if (hash) {
        // 阈值 <=2：UI 截图这类同尺寸画面 hamming 常在 3~6，<=3 会误杀。
        dup = hashes.some(h => hamming(h, hash) <= 2)
        hashes.push(hash)
      }
    }
    items.push({
      id, full: f.full, name, kind: f.kind,
      size: st.size,
      date: new Date(st.mtime).toISOString().slice(0, 10),
      ...info,
      sharpness: sharp, hash, blurry: (sharp < 12 && f.kind === '视频'), duplicate: dup,
      is_ending: /片尾|结尾|outro/i.test(name),
      thumb: existsSync(thumbAbs) ? '缩略图/' + thumbName : '',
      tags: autoTags(name, info, f.kind),
    })
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)))

  const idx = readIndex(root, customer)
  if (idx) applyIndex(items, idx)

  const lib = P.load('library', {}) || {}
  const cust = C.custPaths(customer).customer
  lib[cust] = {
    root: String(root), items, scanned: P.now(),
    suite: false,
    stats: statsOf(items),
  }
  P.save('library', lib)
  C.history('扫描素材', `${items.length} 个 · ${root}`)
  const [analyzable, missing] = indexMissing(items, idx)
  return { root: String(root), count: items.length, items, stats: lib[cust].stats, analyzable, missing }
}

function statsOf(items) {
  return {
    '视频': items.filter(i => i.kind === '视频').length,
    '图片': items.filter(i => i.kind === '图片').length,
    '音频': items.filter(i => i.kind === '音频').length,
    '废片': items.filter(i => i.blurry || i.duplicate).length,
    '片尾': items.filter(i => i.is_ending).length,
    '总数': items.length,
  }
}

// ── 素材库读写 ────────────────────────────────────────
function library(customer) {
  const lib = P.load('library', {}) || {}
  const cust = C.custPaths(customer).customer
  const d = { root: '', items: [], stats: {}, scanned: '', ...(lib[cust] || {}) }
  // ★ 素材登记表里存的是绝对路径。工程搬过家之后（旧 /影创 → 新 /影创新版），
  //   这些路径指向的文件已经不在可访问范围里 —— 界面照样列出它们，
  //   点了「加进时间线」才报「不在能访问的范围里」，看起来像 bug 其实是脏数据。
  //   这里把路径不在当前根下的条目剔掉，并如实报出剔了几个。
  d.root = C.custPaths(customer).root
  if (!Array.isArray(d.items)) d.items = []
  const before = d.items.length
  d.items = d.items.filter((it) => {
    const full = String((it && (it.full || it.abs)) || '')
    return !full || full.startsWith(d.root + '/')
  })
  d.stale = before - d.items.length
  return d
}

function updateAsset(customer, assetId, patch) {
  const lib = P.load('library', {}) || {}
  const cust = C.custPaths(customer).customer
  const d = lib[cust]
  if (!d) throw new Error('这个客户还没有素材，请先扫描文件夹')
  for (const it of d.items) {
    if (it.id === assetId) {
      Object.assign(it, patch)
      P.save('library', lib)
      C.history('修改素材', `${it.name} → ${JSON.stringify(patch).slice(0, 80)}`)
      return it
    }
  }
  throw new Error('找不到这个素材')
}

/**
 * 把文件登记进素材库。幂等：按绝对路径查重，同名但更大时更新元数据。
 */
async function ingest(paths, customer, tags) {
  if (!paths) return { ok: true, added: 0, skipped: 0, items: [] }
  if (typeof paths === 'string') paths = [paths]
  const cust = C.custPaths(customer).customer
  const lib = P.load('library', {}) || {}
  const d = lib[cust] || { root: C.custPaths(customer).root, items: [], stats: {}, scanned: '' }
  const items = [...(d.items || [])]
  const byFull = new Map(items.map(i => [String(i.full || ''), i]))
  const thumbsDir = C.custPaths(customer).thumbs
  P.ensureDir(thumbsDir)
  let added = 0, skipped = 0
  const touched = []

  for (const raw of paths) {
    const full = String(raw).replace(/^~/, require('node:os').homedir())
    let st
    try { st = statSync(full) } catch { skipped++; continue }
    if (!st.isFile()) { skipped++; continue }
    const ext = extname(full).toLowerCase()
    const kind = kindOf(ext)
    if (!kind) { skipped++; continue }
    const old = byFull.get(full)
    if (old && old.size === st.size) { skipped++; continue }
    const info = (kind === '视频' || kind === '音频') ? await probeMedia(full) : {}
    if (kind === '图片') {
      const pi = await E.probe(full)
      if (pi && pi.width) { info.width = pi.width; info.height = pi.height }
    }
    const thumbName = md5(full) + '.jpg'
    const thumbAbs = join(thumbsDir, thumbName)
    try { await thumb(full, kind, thumbAbs) } catch {}
    const name = basename(full)
    const item = {
      id: md5(full).slice(0, 12), full, name, kind,
      size: st.size,
      date: new Date(st.mtime).toISOString().slice(0, 10),
      ...info,
      sharpness: 0, blurry: false, duplicate: false,
      is_ending: /片尾|结尾|outro/i.test(name),
      thumb: existsSync(thumbAbs) ? '缩略图/' + thumbName : '',
      tags: [...new Set([...(tags || []), ...autoTags(name, info, kind)])],
    }
    if (old) Object.assign(old, item)
    else { items.push(item); byFull.set(full, item) }
    touched.push(old || item)
    added++
  }

  if (!touched.length) return { ok: true, added: 0, skipped, items: [] }
  d.items = items
  d.stats = statsOf(items)
  lib[cust] = d
  P.save('library', lib)
  C.history('素材入库', `${touched.length} 个 · ${touched.slice(0, 3).map(i => basename(i.full)).join(', ')}`)
  return { ok: true, added, skipped, items: touched }
}

/** 自动归类：默认「复制」到归类目录，绝不动原始素材。 */
function organize(customer, mode = 'date') {
  const d = library(customer)
  if (!d.root) throw new Error('请先扫描素材文件夹')
  const dest = join(d.root, 'RiffCut归类-' + mode)
  P.ensureDir(dest)
  const { copyFileSync } = require('node:fs')
  const plan = []
  let copied = 0
  for (const it of d.items) {
    let key = mode === 'date' ? (it.date || '未知日期') : ((it.tags || [])[1] || '其他')
    key = String(key).replace(/[/\\:]/g, '-')
    const sub = join(dest, key)
    P.ensureDir(sub)
    if (existsSync(it.full)) {
      const target = join(sub, basename(it.full))
      if (!existsSync(target)) { try { copyFileSync(it.full, target); copied++ } catch {} }
      plan.push({ from: it.full, to: target })
    }
  }
  C.history('素材归类', `${mode} · 复制 ${copied} 个文件（原文件未改动）`)
  return { dest, copied, plan: plan.slice(0, 50), note: '原素材保持原位，归类目录里是副本' }
}

/** 成片首帧封面：没有就现抽一帧。 */
async function ensureCover(video) {
  if (!video || !existsSync(video)) return ''
  const c = video.replace(/(\.[^.]+)$/, '-封面.jpg')
  if (existsSync(c) && statSync(c).size > 1000) return basename(c)
  for (const seek of [['-ss', '0.3'], []]) {
    const args = ['-hide_banner', '-loglevel', 'error', ...seek, '-i', video,
      '-frames:v', '1', '-vf', 'scale=480:-2:flags=lanczos', '-q:v', '3', '-y', c]
    const r = await E.run(P.FFMPEG, args, { timeout: 30000 })
    if (r.ok && existsSync(c) && statSync(c).size > 1000) return basename(c)
  }
  return ''
}


/**
 * 一张极小的纯色 PNG（base64）。给「测试视觉模型能不能读图」用 ——
 * 测连接必须真发一张图：只发文字的话，一个不支持图片输入的模型也会正常回话，
 * 用户以为配好了，到真要用图的时候才发现读不了。
 * 8x8 纯红，手写 PNG 头 + zlib 压缩的像素数据，不依赖任何库。
 */
function tinyPng(rgb = [220, 40, 40]) {
  const zlib = require('zlib')
  const w = 8, h = 8
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3)
    raw[off] = 0
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0]
      raw[off + 2 + x * 3] = rgb[1]
      raw[off + 3 + x * 3] = rgb[2]
    }
  }
  const idat = zlib.deflateSync(raw)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}

let _crcTable = null
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      _crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}


/** 按感知哈希分组：同一张图的不同尺寸/轻微改动归到同一组。 */
function dedupeGroups(items) {
  const list = Array.isArray(items) ? items : ((items && items.items) || [])
  const groups = []
  for (const it of list) {
    const h = it && (it.phash || it.hash)
    if (!h) continue
    let hit = null
    for (const g of groups) {
      if (hamming(g.hash, h) <= 2) { hit = g; break }
    }
    if (hit) hit.items.push(it)
    else groups.push({ hash: h, items: [it] })
  }
  return groups.filter((g) => g.items.length > 1)
}

/** 统计：按类型数、按大小、重复组。给界面和工具共用。 */
function statsOf(items) {
  const list = Array.isArray(items) ? items : ((items && items.items) || [])
  const by = { 视频: 0, 图片: 0, 音频: 0, 废片: 0, 片尾: 0 }
  let bytes = 0
  for (const it of list) {
    const k = it.kind || it.type || ''
    if (k in by) by[k]++
    else if (k) by[k] = (by[k] || 0) + 1
    bytes += Number(it.size) || 0
  }
  by.总数 = list.length
  by.占用MB = Math.round(bytes / 1024 / 1024)
  const dup = dedupeGroups(list)
  if (dup.length) by.重复组 = dup.length
  return by
}

module.exports = {
  tinyPng, crc32,
  INDEX_NAME, kindOf, probeMedia, gray, sharpness, dhash, hamming, autoTags, thumb,
  indexPath, readIndex, writeIndex, applyIndex, indexMissing,
  scanFolder, statsOf, library, updateAsset, ingest, organize, ensureCover, walk,
  dedupeGroups,
}
