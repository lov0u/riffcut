'use strict'
/**
 * 工具注册表 —— AI 真正能动手的地方。
 *
 * 设计原则（跟用户定过的三条一致）
 * ──────────────────────────────
 * 1. **现场先算好，不让它瞎逛**：技能库有 41 个也不全塞进提示词。开工自检把
 *    素材真实状态、模型接入、上次产出算好塞进上下文；模型只管决策和动手，
 *    不再一层层 ls 翻目录去猜。工具描述由注册表自动生成，加能力不用改循环。
 * 2. **权限边界内的最高权限**：可读范围由界面选的「访问范围」档决定 ——
 *    标准=客户目录、影创=软件数据目录、本机=整个用户家目录（真正的完全访问）。
 *    走 path.resolve 前缀校验，越界直接拒绝，不给 ../ 和符号链接留缝。
 *    ★ 2026-11-20 修：roots() 以前写死软件数据+客户目录，从不看 scopeOf()，
 *      所以界面点「本机 + 完全托管」存了设置却不生效，AI 读家目录里的文件被拒。
 * 3. **写操作要确认**：write / copy / move 先出「提案」，用户点同意才落地。
 *
 * 刻意不 import engine 一类的大模块，避免循环依赖；需要渲染时由调用方注入。
 */

const path = require('path')
const { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const P = require('./paths')
const C = require('./core')

// 单个工具返回值的字符上限。
// 以前是 2500，而 abilities 的完整清单有 9910 字，于是 91 个工具里 68 个被截掉。
// 模型看到半份清单就断言「本机不支持生成视频、不支持调色」，还把结论写进经验
// 自我固化 —— 这是最昂贵的一种错误：它从此不再尝试那些其实做得到的事。
const OUT_CAP = 9000

const LEVELS = ['只读', '建议', '可整理', '完全托管']
/**
 * 这个客户最近出的一条成片。
 *
 * 为什么不要求用户每次都给路径：他说「给我这条片配字幕」时，
 * 指的就是刚看到的那一条。让他去翻目录复制路径，是把软件的活儿推回给他。
 */
function newestVideo(customer) {
  const fs = require('node:fs')
  const path = require('node:path')
  const dirs = [C.custPaths(customer).videos, C.custPaths(customer).previews].filter(Boolean)
  let best = '', bestT = 0
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) {
      if (!/\.(mp4|mov|m4v)$/i.test(f)) continue
      const full = path.join(d, f)
      const t = fs.statSync(full).mtimeMs
      if (t > bestT) { bestT = t; best = full }
    }
  }
  return best
}

/** 脏值兜底：front matter 是人手能改的，Number('abc') 是 NaN 会让排序全乱。 */
function safeInt(v, d = 0) { const n = parseInt(String(v || '').trim(), 10); return Number.isFinite(n) ? n : d }

const LEVEL_ORDER = { 只读: 0, 建议: 1, 可整理: 2, 完全托管: 3 }

const REGISTRY = {}

/**
 * 注册一个工具。desc / args 就是模型看到的说明书，写得越准它用得越对。
 * level = 该工具最少需要的授权档。
 * danger = 同一工具里哪些 action 要先出提案卡让用户点确认。
 * hints = 进提示词清单时额外带上的关键词（action 名等）—— _brief() 只截 16 字，
 *         多动作工具的动作名会被截掉，模型就不知道该存在哪些 action。
 */
function tool(name, desc, args, opts = {}) {
  const meta = {
    name, desc, args,
    mutates: opts.mutates || 'none',
    level: opts.level || '建议',
    danger: opts.danger || [],
    hints: opts.hints || '',
  }
  REGISTRY[name] = meta
  meta.fn = null
  return (fn) => { meta.fn = fn; return fn }
}

/** 当前授权档。存在设置里，默认「建议」：能读一切、写入要确认。 */
function levelOf(customer) {
  try { return String(C.levelOf(customer) || '建议') } catch { return '建议' }
}

function allowed(t, customer) {
  const lv = levelOf(customer)
  // 出片（mutates=render）只产出成片文件、不改用户素材，所以在「建议」档就放行；
  // 它是用户一句「你做啊」直接等结果的场景，再弹确认卡片等于没做。
  if (t.mutates === 'render' || t.mutates === 'self') {
    return (LEVEL_ORDER[lv] ?? 1) >= LEVEL_ORDER['建议']
  }
  return (LEVEL_ORDER[lv] ?? 1) >= (LEVEL_ORDER[t.level] ?? 1)
}

// 拒绝时不要只说「不许」——要告诉它下一步该怎么做
const HINTS = {
  资源: '软件自带的套件都在「资源」下：技能/、模板/、品牌库/、片尾/、音乐/、法律/。用 ls 资源 或 ls 资源/技能。',
  技能: '技能在「资源/技能」，也可以直接 ls 技能（= 素材目录下的同名文件夹）。',
  模板: '模板在「资源/模板」，出片预设是 资源/模板/出片预设.json。',
}

function denyHint(key) { return HINTS[key] || '' }

// ══════════════════ 路径边界 ══════════════════
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.py', '.js', '.css', '.html', '.htm',
  '.sh', '.yml', '.yaml', '.csv', '.srt', '.ass', '.mjs', '.ts', '.jsx', '.tsx'])
const MEDIA_EXT = P.MEDIA_EXT
const MAX_READ_BYTES = 200000
const MAX_LIST = 400

// 写入白名单子目录（相对数据根）：界面配置区可写，客户目录全可写，
// 但 本地模型/ 这种几个 G 的地方不给它乱动
const WRITE_DENY = ['资源/本地模型', '系统/本地模型', '系统/技能版本', '系统/备份',
  '系统/日志', '缓存', '模板库/registry']

function roots(customer) {
  const out = [{ label: '软件数据', path: P.HOME }]
  try {
    const cp = C.custPaths(customer)
    out.push({ label: '客户目录', path: cp.root })
    out.push({ label: '素材目录', path: cp.images })
  } catch {}
  out.push({ label: '模板库', path: path.join(P.HOME, '模板库') })
  out.push({ label: '技能库', path: path.join(P.RES, '技能') })
  // ★ 2026-11-20 修：访问范围选「本机」时放开整个用户家目录。
  //   以前这一步没有，界面那个「本机 + 完全访问」开关只写了设置、工具层不看，
  //   AI 读家目录里的文件（如 ~/cyanweb素材库/logo/x.svg）被拒，还以为是沙箱拦的。
  //   家目录放最后：软件数据/客户目录等仍在前面，命中时标签更准确。
  const sc = C.scopeOf ? C.scopeOf(customer) : ''
  if (sc === '本机') {
    const home = require('node:os').homedir()
    out.push({ label: '本机（用户目录）', path: home })
  }
  return out.filter(r => r.path && existsSync(r.path))
}

/**
 * 解析一个用户给的路径到真实绝对路径，并校验在允许范围内。
 * 越界返回 {ok:false, error}，不抛 —— 让调用方能给出人话。
 */
function resolveUserPath(p, customer, forWrite = false) {
  const raw = String(p == null ? '' : p).trim()
  if (!raw) return { ok: false, error: '没给路径' }
  let abs
  if (path.isAbsolute(raw)) abs = raw
  else abs = path.join(P.HOME, raw.replace(/^[/\\]+/, ''))
  /* ★ 2026-11-20 修：AI 从 assets 拿到的是文件名，回传给 edit_timeline add 时
     写法五花八门——裸文件名、「图片/xxx.png」相对前缀，甚至幻觉出
     「~/Library/.../RiffCut影创/素材库/图片/xxx.png」这种根本不存在的绝对路径。
     真实文件在客户产出/素材目录。只要文件在给定位置不存在，就按 basename 找真实位置：
     ①先查素材库索引的 full 路径（generate 出图会自动 ingest）；
     ②再遍历可读根目录，连同「产出/图片」「产出/视频」「素材」等常见子目录一起找。
     写操作（forWrite）不走兜底——写必须精确落到指定路径，不能模糊命中别处。
     越界的绝对路径 basename  nowhere 可找 → 保持原值 → 下面白名单校验照样拒绝。 */
  if (!existsSync(abs) && !forWrite) {
    const base = path.basename(raw)
    try {
      const A = require('./assets')
      const items = ((A.library(customer) || {}).items) || []
      const hit = items.find(x => x.name === base || (x.full && path.basename(x.full) === base))
      if (hit && hit.full && existsSync(hit.full)) abs = hit.full
    } catch (e) {}
    if (!existsSync(abs)) {
      const subs = ['', '产出/图片', '产出/视频', '产出/音频', '素材', '图片', '素材库/图片', '素材库/视频']
      for (const r of roots(customer)) {
        let found = false
        for (const sub of subs) {
          for (const cand of [path.join(path.resolve(r.path), sub, base), path.join(path.resolve(r.path), sub, raw)]) {
            if (existsSync(cand) && statSync(cand).isFile()) { abs = cand; found = true; break }
          }
          if (found) break
        }
        if (found) break
      }
    }
  }
  abs = path.resolve(abs)
  const rs = roots(customer)
  const inside = rs.find(r => {
    const rp = path.resolve(r.path)
    return abs === rp || abs.startsWith(rp + path.sep)
  })
  if (!inside) {
    return {
      ok: false,
      error: `「${raw}」不在能访问的范围里。能访问的只有：${rs.map(r => r.label).join('、')}`,
    }
  }
  if (forWrite) {
    const rel = path.relative(P.HOME, abs).split(path.sep).join('/')
    if (WRITE_DENY.some(d => rel === d || rel.startsWith(d + '/'))) {
      return { ok: false, error: `「${rel}」是软件自己管的目录，不给 AI 写。要改配置请用 settings 工具。` }
    }
  }
  return { ok: true, abs, label: inside.label }
}

function humanSize(n) {
  n = Number(n) || 0
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + 'G'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + 'M'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + 'K'
  return n + 'B'
}

function clip(s, cap = OUT_CAP) {
  // ★ 有些工具返回的是对象（template_recipe / template_family 等），原来的
  //   String(s) 会把它们全拍成「[object Object]」，AI 拿到一堆空壳，只能去
  //   瞎猜字段、反复读不存在的文件。对象先 JSON.stringify 成可读文本再截断。
  //   字符串原样保留（绝大多数工具本来就返回拼好的中文文本）。
  let t
  if (typeof s === 'string') t = s
  else if (s != null && typeof s === 'object') {
    try { t = JSON.stringify(s, null, 2) } catch { t = String(s) }
  } else t = String(s == null ? '' : s)
  return t.length <= cap ? t : t.slice(0, cap) + `\n…（已截断，原长 ${t.length} 字）`
}

// ══════════════════ 只读工具 ══════════════════

tool('ls', '列目录。不传 path 就列所有可访问的根。看到不认识的东西就 ls 它。',
  { path: '要列的目录（留空=列所有根）', deep: '是否展开一层子目录（1/0）' },
  { level: '只读' })(async (a, customer) => {
  const p = String(a.path || '').trim()
  if (!p) {
    const lines = ['可访问的根（括号里是绝对路径）：']
    for (const r of roots(customer)) {
      let n = 0
      try { n = readdirSync(r.path).length } catch {}
      lines.push(`- ${r.label}  ${n} 项  (${r.path})`)
    }
    return lines.join('\n')
  }
  const r = resolveUserPath(p, customer)
  if (!r.ok) return '❌ ' + r.error
  if (!existsSync(r.abs)) return `❌ 不存在：${p}`
  const st = statSync(r.abs)
  if (!st.isDirectory()) return `❌ 不是目录：${p}（是文件，用 read）`
  let names
  try { names = readdirSync(r.abs, { withFileTypes: true }) } catch (e) { return '❌ 读不了：' + e.message }
  const showHidden = String(a.hidden || '') === '1'
  const rows = []
  for (const d of names.slice(0, MAX_LIST)) {
    if (!showHidden && d.name.startsWith('.')) continue
    const full = path.join(r.abs, d.name)
    let size = ''
    try { if (d.isFile()) size = humanSize(statSync(full).size) } catch {}
    rows.push(`${d.isDirectory() ? '📁' : '📄'} ${d.name}${size ? '  ' + size : ''}`)
  }
  const more = names.length > MAX_LIST ? `\n…（共 ${names.length} 项，只列了前 ${MAX_LIST}）` : ''
  return `${p}（${r.label}，${names.length} 项）\n` + rows.join('\n') + more
})

tool('read', '读一个文本文件（md/json/txt/代码）。技能、模板、配置、知识库都靠它读。',
  { path: '文件路径', offset: '从第几行开始（留空=从头）', limit: '读多少行（默认 2000）' },
  { level: '只读' })(async (a, customer) => {
  const r = resolveUserPath(a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  if (!existsSync(r.abs)) return `❌ 不存在：${a.path}`
  const st = statSync(r.abs)
  if (st.isDirectory()) return `❌ 这是目录：${a.path}（用 ls）`
  if (st.size > MAX_READ_BYTES) {
    // 大文件只读一段，别把上下文撑爆
    const buf = readFileSync(r.abs).slice(0, MAX_READ_BYTES).toString('utf8')
    return clip(`${a.path}（${humanSize(st.size)}，只读了前 ${humanSize(MAX_READ_BYTES)}）\n\n` + buf)
  }
  const txt = readFileSync(r.abs, 'utf8')
  const lines = txt.split('\n')
  const off = Math.max(0, (Number(a.offset) || 1) - 1)
  const lim = Math.max(1, Number(a.limit) || 2000)
  const slice = lines.slice(off, off + lim)
  const body = slice.map((l, i) => `${off + i + 1}: ${l}`).join('\n')
  const end = off + slice.length
  const footer = end < lines.length
    ? `\n（共 ${lines.length} 行，读到 ${end}。续读用 offset=${end + 1}）`
    : `\n（共 ${lines.length} 行，已到结尾）`
  return clip(`${a.path}（${r.label}）\n${body}${footer}`)
})

tool('grep', '全文搜索，返回命中的文件、行号和那一行。找「哪个技能讲卡点」用它，比 ls 快得多。',
  { q: '要找的文字（正则也支持）', path: '在哪个目录里搜（留空=客户目录）', ext: '只搜这些后缀，逗号分隔（如 md,json）', limit: '最多几条（默认 60）' },
  { level: '只读' })(async (a, customer) => {
  const q = String(a.q || '').trim()
  if (!q) return '❌ 要搜什么？给我 q 参数'
  const base = String(a.path || '').trim() || '客户目录'
  let r
  if (base === '客户目录') {
    try { r = { ok: true, abs: C.custPaths(customer).root, label: '客户目录' } } catch (e) { return '❌ ' + e.message }
  } else r = resolveUserPath(base, customer)
  if (!r.ok) return '❌ ' + r.error
  if (!existsSync(r.abs)) return `❌ 不存在：${base}`
  const wantExt = a.ext ? String(a.ext).split(',').map(x => x.trim().replace(/^\./, '.')).map(x => x.startsWith('.') ? x : '.' + x) : null
  const cap = Math.max(1, Math.min(300, Number(a.limit) || 60))
  let re
  try { re = new RegExp(q, 'i') } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
  const hits = []
  const walk = (dir, depth) => {
    if (hits.length >= cap || depth > 6) return
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const d of ents) {
      if (hits.length >= cap) return
      if (d.name.startsWith('.')) continue
      const full = path.join(dir, d.name)
      if (d.isDirectory()) { walk(full, depth + 1); continue }
      const ext = path.extname(d.name).toLowerCase()
      if (!TEXT_EXT.has(ext)) continue
      if (wantExt && !wantExt.includes(ext)) continue
      let st2
      try { st2 = statSync(full) } catch { continue }
      if (st2.size > 2 * 1024 * 1024) continue
      let txt
      try { txt = readFileSync(full, 'utf8') } catch { continue }
      const ls = txt.split('\n')
      for (let i = 0; i < ls.length; i++) {
        if (re.test(ls[i])) {
          hits.push(`${path.relative(r.abs, full)}:${i + 1}: ${ls[i].trim().slice(0, 160)}`)
          if (hits.length >= cap) return
        }
      }
    }
  }
  walk(r.abs, 0)
  if (!hits.length) return `没找到「${q}」（在 ${base} 下搜的）`
  return clip(`找到 ${hits.length} 处：\n` + hits.join('\n'))
})

tool('probe', '探测素材真实参数：时长、分辨率、帧率、有没有声音。',
  { path: '文件路径', paths: '多个文件，逗号分隔' },
  { level: '只读' })(async (a, customer) => {
  const E = require('./exec')
  let list = []
  if (a.paths) list = String(a.paths).split(',').map(x => x.trim()).filter(Boolean)
  else if (a.path) list = [String(a.path)]
  else return '❌ 给 path 或 paths'
  const out = []
  for (const p of list.slice(0, 20)) {
    const r = resolveUserPath(p, customer)
    if (!r.ok) { out.push(`❌ ${p}：${r.error}`); continue }
    if (!existsSync(r.abs)) { out.push(`❌ ${p}：不存在`); continue }
    const info = await E.probe(r.abs)
    if (!info || !info.ok) { out.push(`❌ ${p}：读不出参数（${(info && info.error) || '未知'}`); continue }
    out.push(`${p}\n  时长 ${info.duration.toFixed(2)}s | ${info.width}x${info.height} | ${info.fps}fps | ${info.vcodec || '—'}${info.hasAudio ? ' + ' + (info.acodec || '音轨') : '（无音轨）'} | ${humanSize(info.size)}`)
  }
  return out.join('\n')
})

module.exports = {
  REGISTRY, tool, LEVELS, LEVEL_ORDER, levelOf, allowed, OUT_CAP,
  roots, resolveUserPath, clip, humanSize, denyHint, TEXT_EXT, MAX_READ_BYTES,
}

// ══════════════════ 探测 / 校验 / 看成片 ══════════════════
tool('probe_media', '报一个文件（或整个文件夹）的真实参数：尺寸、时长、编码、有没有音轨。模型自己拼的路径也能按文件名找回来。',
  { path: '文件或文件夹路径' }, { level: '只读' })(async (a, customer) => {
  const M = require('./media')
  try { return await M.probeMedia(a.path || a.file || a.src, customer) } catch (e) { return '❌ ' + e.message }
})

tool('verify_media', '校验一条片子是不是真的存在、真的能播。对用户说「已生成」之前必须跑这个 —— 不解码的话，一个空壳 mp4 从元数据看也能有「时长」。',
  { path: '要校验的文件路径或文件名' }, { level: '只读' })(async (a, customer) => {
  const M = require('./media')
  return M.verifyReport(await M.verifyMedia(a.path || a.file || a.video, customer))
})

tool('review', '【看成片】把刚剪出来的片子摊开给自己看：结构表（每段几秒到几秒、用的什么素材、怎么接的）+ 图墙（等间隔抽帧拼一张）。'
  + '它能指出哪段太长、哪段画面其实是黑的、哪两段用了同一素材。交片前跑一次。',
  { video: '成片路径（不给就从 project 的产出里取）', project: '工程名', tiles: '图墙最多几格，默认 30', model: '视觉模型 id，留空用绑定的那个' },
  { level: '只读' })(async (a, customer) => {
  const R = require('./review')
  let video = a.video
  if (video) { const r = resolveUserPath(video, customer); if (r.ok) video = r.abs }
  const res = await R.reviewOutput({ video, project: a.project, maxTiles: a.tiles, model: a.model })
  return R.reviewReport(res)
})

tool('look_folder', '【扫一个文件夹，把里面的素材逐个看懂】给一个目录，把每个视频抽一帧、图片直接取，' +
  '\n拼成一张图墙一次性交给视觉模型看，逐条告诉你：画面里是什么、能不能用（能/勉强/不能用）、为什么。' +
  '\n什么时候用：用户丢来一个素材文件夹说「看看这些能用吗」「挑一条能当片头的」——不要一条条 probe，先跑这个。' +
  '\n没有视觉模型时它会明确告诉你没配，别猜画面内容。',
  { path: '要扫的目录（不填用当前客户的素材目录）', limit: '最多看几个，默认 12，上限 24', model: '视觉模型 id，留空用绑定的那个' },
  { level: '只读' })(async (a, customer) => {
  const V = require('./assetsview')
  const d = { customer, limit: Number(a.limit) || 12 }
  if (a.model) d.model = a.model
  if (a.path) {
    const r = resolveUserPath(a.path, customer)
    if (!r.ok) return '❌ ' + r.error
    d.root = r.abs
  }
  let res
  try {
    res = await V.analyze(d)
  } catch (e) {
    return '❌ ' + String((e && e.message) || e)
  }
  const lines = (res.items || []).map((x, i) => `${i + 1}. ${x.file} —— ${x.verdict}`)
  return clip(`目录：${res.root}\n模型：${res.model}\n共 ${res.total} 个文件，看了 ${res.looked} 个，其中不能用 ${res.bad} 个。\n` +
    (res.note ? res.note + '\n' : '') + '\n' + lines.join('\n') +
    ((res.notes && res.notes.length) ? '\n\n备注：\n' + res.notes.join('\n') : ''))
})

/* 2026-11-21 新增：逐镜头读一条视频。
   ★ 和 look_folder / review 的分工（这是三个问法）：
     · look_folder —— 一整个文件夹每条抽 1 帧，「这条大概是什么、能不能用」
     · review      —— 一条成片等间隔抽 30 帧，「结构上哪段太长、哪段黑屏」
     · read_video  —— 按真实镜头边界切段、每镜取中间帧，「第几个镜头出了什么问题」
   等间隔抽帧会漏掉 0.4 秒的闪切，而废片往往就是那一两个短镜头。 */
tool('read_video', '【逐镜头读一条视频】按真实镜头边界把片子切开，每个镜头取中间帧拼成图墙，逐镜回答：画面里是什么、有没有问题、能不能用。'
  + '\n什么时候用：片子已经出来了要验收、或用户问「这条哪里有问题」「第几秒是废的」——不要自己凭结构表猜，跑这个。'
  + '\n特别会查这几类废帧：黑场或纯色、文字乱码笔画崩坏、同一画面重复、跟前后镜头不搭。'
  + '\n镜头数超过上限时它会明确告诉你还有多少个没看，别拿局部结论当整条片子的结论。',
  { video: '视频路径（必填）', maxShots: '最多看几段，默认 16，上限 60（长镜头会自动分段）', model: '视觉模型 id，留空用绑定的那个', threshold: '镜头切分灵敏度，默认 0.12；屏录/PPT 类片子切不出来时给 0.08', longShot: '超过几秒的镜头要分段看，默认 3', fresh: '要重新看一遍（默认同一条片同参数读过就直接给索引里的结论，不重复烧模型）' },
  { level: '只读' })(async (a, customer) => {
  const V = require('./vidlook')
  let video = String(a.video || '').trim()
  if (!video) return '❌ 给 video（视频路径）'
  const rp = resolveUserPath(video, customer)
  if (rp.ok) video = rp.abs
  try {
    const res = await V.readVideo(video, {
      maxShots: a.maxShots, model: a.model, threshold: a.threshold,
      longShot: a.longShot, fresh: !!a.fresh, customer,
    })
    return V.report(res)
  } catch (e) {
    return '❌ ' + String((e && e.message) || e)
  }
})

tool('film_match', '画面台词对位：每张图配的台词是不是同一件事。出片前跑一次 —— 结构全对的片子也可以是「画面挺好但跟念的话没关系」。判不了（没视觉模型/抽不出帧）会如实说判不了，不拦你。',
  { data: '整份方案（JSON 字符串或对象），要有 shots[].caption 与 shots[].asset', project: '工程名（不给 data 就用工程的）', model: '视觉模型 id' },
  { level: '只读' })(async (a, customer) => {
  const I = require('./image')
  const T = require('./timeline')
  let doc = a.data
  if (typeof doc === 'string') { try { doc = JSON.parse(doc) } catch { return '❌ data 不是合法 JSON' } }
  if (!doc && a.project) { const d = T.load(a.project); doc = d.plan || require('./plan').planFromTimeline(d) }
  if (!doc || !Array.isArray(doc.shots)) return '❌ 要给 data（含 shots）或 project'
  const mid = I.findVisionModel(a.model)
  if (!mid) return '这个判不了：没有配视觉模型。结构上对不对可以用 plan_check，但「画面和台词是不是同一件事」得看图。'
  const lines = []
  for (let i = 0; i < doc.shots.length; i++) {
    const sh = doc.shots[i]
    const cap = String(sh.caption || '').trim()
    const asset = String(sh.asset || '').trim()
    if (!cap || !asset) continue
    const r = resolveUserPath(asset, customer)
    const file = r.ok ? r.abs : require('./media').findByName(asset, customer)
    if (!file || !require('node:fs').existsSync(file)) { lines.push(`${i + 1}. 素材找不到，跳过了：${asset}`); continue }
    try {
      const res = await I.reviewImage(file, { shot: cap, model: mid })
      const verdict = (res.report || '').split('\n').find((x) => x.trim()) || ''
      lines.push(`${i + 1}. 台词「${cap.slice(0, 20)}」 ↔ ${require('node:path').basename(asset)}：${verdict.slice(0, 80)}`)
    } catch (e) { lines.push(`${i + 1}. 看不了：${e.message.slice(0, 60)}`) }
  }
  return lines.length ? '【画面台词对位】\n' + lines.join('\n') : '没有可比对的段落（shots 里没有同时有 caption 和 asset 的）。'
})

// ══════════════════ 素材库 ══════════════════
tool('assets', '素材与索引：library 看绑定、scan 重扫目录、ingest 把文件登记进素材库、list 列素材、find 找素材、dedupe 找重复。',
  { action: 'library | scan | ingest | list | find | dedupe | stats', path: 'scan 扫哪个目录 / ingest 的文件（逗号分隔）', q: 'find 的关键词', kind: 'list 只看哪类：视频/图片/音频' },
  { level: '建议', mutates: 'write' })(async (a, customer) => {
  const A = require('./assets')
  const act = String(a.action || 'library')
  if (act === 'library') {
    const cp = C.custPaths(customer)
    const lib = P.load('library', {}) || {}
    return `客户：${customer || C.currentCustomer()}\n素材目录：${cp.images}\n索引：${P.BASE.library}\n已登记：${Object.keys(lib.items || lib || {}).length} 条`
  }
  if (act === 'scan') {
    const dir = String(a.path || '').trim()
    const r = resolveUserPath(dir || C.custPaths(customer).images, customer)
    if (!r.ok) return '❌ ' + r.error
    const res = await A.scanFolder(r.abs, { customer })
    return `扫完：${JSON.stringify(res)}`
  }
  if (act === 'ingest') {
    const list = String(a.path || '').split(',').map(x => x.trim()).filter(Boolean)
    if (!list.length) return '❌ 给 path（可逗号分隔多个）'
    const abs = []
    for (const p of list) { const r = resolveUserPath(p, customer); if (r.ok) abs.push(r.abs) }
    const res = await A.ingest(abs, customer)
    return `登记：${JSON.stringify(res)}`
  }
  if (act === 'list') {
    const lib = A.library(customer)
    const kind = String(a.kind || '').trim()
    let items = (lib && lib.items) || []
    if (kind) items = items.filter(x => x.kind === kind)
    const lines = items.slice(0, 60).map(x => `- ${x.name}  ${x.kind}  ${x.width || ''}x${x.height || ''}  ${x.thumb ? '[缩略图]' : ''}`)
    return clip(`共 ${items.length} 条：\n` + lines.join('\n'))
  }
  if (act === 'find') {
    const lib = A.library(customer)
    const q = String(a.q || '').toLowerCase()
    const hit = ((lib && lib.items) || []).filter(x => String(x.name || '').toLowerCase().includes(q))
    // ★ 条目字段是 full（绝对路径），不是 path —— 原来写 x.path 导致 find 结果全是 undefined，
    //   AI 拿到名字却拿不到路径，传给 add 又落成裸文件名找不到文件。直接给 full。
    return clip(`命中 ${hit.length} 条：\n` + hit.slice(0, 40).map(x => `- ${x.name}  ${x.full || x.path || ''}`).join('\n'))
  }
  if (act === 'dedupe') {
    const lib = A.library(customer)
    const groups = A.dedupeGroups ? A.dedupeGroups(lib) : []
    return groups.length ? clip(`发现 ${groups.length} 组重复：\n` + groups.slice(0, 20).map(g => g.map(x => x.name).join(' ≈ ')).join('\n')) : '没有重复素材'
  }
  if (act === 'stats') {
    // ★ 这里原来写 A.stats(customer)，但 assets.js 导出的是 statsOf(items)，
    // 没有 stats —— 所以这个分支一直静悄悄返回 {}（界面显示「0 个素材」
    // 却查不出原因）。改成给 statsOf 喂真实条目列表。
    const lib = A.library(customer)
    return JSON.stringify(A.statsOf((lib && lib.items) || []), null, 2)
  }
  return `没有这个动作：${act}`
})

// ══════════════════ 模板库 ══════════════════
tool('templates', '搜模板库：448 个现成的动效模板。片头、转场、字幕条、图表、产品展示、3D 场景。★模板是设计参考，不是素材：先用 design_with_template 拆它的编排语法（几秒换一个信息块、怎么错开、用什么缓动），再照语法用你自己的内容去填长片，不要把模板复制多遍铺时间线。',
  { q: '关键词（留空=列全部）', cat: '分类：字幕/下三分之一/转场/片头片尾/图表数据/产品展示/社媒包装/文字动画/背景纹理/动效零件', kind: 'block | component', limit: '几条（默认 30）' },
  { level: '只读' })(async (a) => {
  const T = require('./templates')
  const all = T.catalog()
  let items = all
  if (a.cat) items = items.filter(x => x.cat === String(a.cat))
  if (a.kind) items = items.filter(x => x.kind === String(a.kind))
  if (a.q) items = T.search(items, String(a.q))
  const lim = Math.max(1, Number(a.limit) || 30)
  /* ★ 2026-11-20 修：模板画幅必须显示出来。之前只给名字/分类/时长，
     AI 看不到模板是 1920x1080 横屏，就把它塞进 1080x1920 竖屏工程，
     两边被裁掉——青衣 Cyanweb 片尾那次大字「Cyanweb」被裁成「yanwe」。
     显示画幅后 AI 才能自己判断：横屏模板配横屏工程，或按 contain 完整缩放。 */
  const lines = items.slice(0, lim).map(x => {
    /* component 跟随宿主工程画幅（容器查询），本身不会被裁；只有 block 有固定画幅。
       标清楚，AI 才知道 component 安全、block 要配画幅。 */
    const dim = x.w && x.h ? x.w + 'x' + x.h : (x.kind === 'component' ? '自适应画幅' : '画幅未知')
    // ★ 陷阱标记：有中文内容要避开的模板，直接标出来，AI 列表里一眼能看见
    const trap = x.trap ? `  ⚠️有中文勿用(${x.trap.kind})` : ''
    return `- ${x.name}  [${x.cat}/${x.kind}]  ${dim}  ${x.duration ? x.duration + 's' : ''}  ${x.title || ''}${trap}`
  })
  return clip(`共 ${items.length} 个（全库 ${all.length}）：\n画幅格式=宽x高；block 有固定画幅（横屏 block 塞竖屏工程会被裁，工程画幅要跟着模板走）；component 自适应工程画幅、但多为静态卡片。\n★ 做片尾：用「片头片尾」分类里带 gsap 动效的 block（logo-outro 6s / extruded-logo 5s / glass-hero 5s / glass-shard-title 12s），别用 cta-close 这类静态 component——会被交付闸门判"静止画面"打回。用 dur 参数把 5~6s 裁到要的秒数。\n` + lines.join('\n'))
})

tool('template_vars', '模板里哪些字能改：给模板名，列出它声明了哪些可改项（文字/图片/颜色/数字）与默认值。',
  { name: '模板名', which: 'block | component（默认自动找）' },
  { level: '只读' })(async (a) => {
  const T = require('./templates')
  const name = String(a.name || '').trim()
  if (!name) return '❌ 给 name'
  const vars = T.varsFor(String(a.which || 'auto'), name)
  if (!vars || !vars.length) return `「${name}」没声明可改项，或者模板名不对`
  /* ★ 2026-11-20：这里原来写 v.name，但 varsFor 返回的字段是 id
     （readVars 里 v.id），所以 AI 看到的变量名全是 undefined —— 它根本没法
     照着去改模板文字，只能另外叠一层 addtext，成片就是「英文默认字 + 中文覆盖」。
     改成 v.id，AI 才能拿到 action_line / button_label 这种真变量名。 */
  return clip(`「${name}」可改 ${vars.length} 项：\n` + vars.map(v => `- ${v.id}（${v.type}${v.role ? '/' + v.role : ''}）${v.default != null ? ' 默认：' + JSON.stringify(v.default).slice(0, 60) : ''}`).join('\n') + '\n改法：addtemplate 时传 vars，如 vars={\"' + (vars[0] ? vars[0].id : '变量名') + '\":\"你的文案\"}；这样改的是模板自己的字，不用再叠 addtext。')
})

tool('template_recipe', '拆模板的动画配方：给一个模板名，告诉它到底怎么动的——进场缓动、持续时间、错开多少。',
  { name: '模板名' },
  { level: '只读' })(async (a) => {
  const T = require('./templates')
  return T.recipe(String(a.name || ''))
})

tool('template_family', '找同族模板：给一个模板名，列出跟它同一路数的其它变体。',
  { name: '模板名', limit: '几条（默认 12）' },
  { level: '只读' })(async (a) => {
  const T = require('./templates')
  const fam = T.family(String(a.name || ''), Number(a.limit) || 12)
  return fam.length ? `「${a.name}」同族 ${fam.length} 个：\n` + fam.map(x => `- ${x.name}  ${x.title || ''}`).join('\n') : '没找到同族模板'
})

/* ★ design_with_template —— 用户的核心诉求：
     「模版不是给ai的参考吗? 他不应该根据模版的思路来设计内容吗?」
   对。模板的价值是**一套组织内容的语法**，不是一段可以直接复用的画面。
   所以这个工具做的是：拆语法 → 按语法给长片排版 → AI 照着自己写内容。
   它**不复制模板**，只输出一份一拍一拍的内容规划。 */
tool('design_with_template', '拿一个模板当"设计参考"，拆出它的编排语法（几秒换一个信息块、元素怎么错开、用什么缓动、靠什么属性制造动感），再按这套骨架把你要的长片排成一拍一拍的内容规划。你照规划自己写内容——不要把模板复制多遍。',
  {
    name: '模板名（从 templates 搜到的那个）',
    total: '你的片子要多长（秒）',
    points: '可选：你要讲的几个点，一行一个；不给就生成空槽让你填',
    beats: '可选：指定分几拍；不给就按模板自己的节奏算',
  },
  { level: '只读' })(async (a) => {
  const T = require('./templates')
  const C = T.choreo(String(a.name || ''))
  if (C.error) return C
  const total = Math.max(1, Number(a.total) || 0)
  if (!(total > 0)) return { error: '要给 total（你的片子多长）' }

  const beatLen = Number(a.beats) > 0
    ? Math.round((total / Number(a.beats)) * 10) / 10
    : (C.每拍秒数 > 0 ? C.每拍秒数 : (C.设计时长 || 2.5))
  const n = Math.max(1, Math.round(total / beatLen))

  const pts = String(a.points || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)

  const 主缓动 = (C.缓动[0] || {}).曲线 || 'power3.out'
  const 错开 = (C.拍子[0] || {}).错开 || 0.15
  const 主属性 = (C.变化维度[0] || {}).属性 || 'opacity'

  const plan = []
  for (let i = 0; i < n; i++) {
    const st = Math.round(i * beatLen * 100) / 100
    const en = Math.round(Math.min(total, (i + 1) * beatLen) * 100) / 100
    const isFirst = i === 0
    const isLast = i === n - 1
    const 内容 = pts.length ? pts[i % pts.length] : ''
    plan.push({
      第几拍: i + 1,
      时间: st + 's → ' + en + 's',
      时长: Math.round((en - st) * 100) / 100,
      这一段放什么: 内容 || (isFirst ? '开场钩子：一句话说清这条片子讲什么' : isLast ? '收尾：结论/行动号召' : '第 ' + (i + 1) + ' 个要点（一句一个，别塞两点）'),
      动作建议: isFirst
        ? '主元素先出场（' + 主属性 + ' 从 0 到 1），副元素按 ' + 错开 + ' 秒依次跟上'
        : '先让上一拍的元素退场，再让这一拍的进场；同样 ' + 错开 + ' 秒错开',
      缓动: 主缓动,
    })
  }

  return {
    参考模板: C.模板,
    模板标题: C.标题,
    你学到的语法: {
      节奏: C.排法,
      每拍秒数: C.每拍秒数,
      同拍错开: 错开 + ' 秒',
      主缓动: 主缓动,
      动感来源: C.变化维度.map(x => x.属性 + '（' + x.说明 + '）'),
      拍子结构: C.拍子,
    },
    给你的片子排的版: {
      总长: total + 's',
      分几拍: n,
      一拍时长: beatLen + 's',
      规划: plan,
    },
    怎么落地: [
      '1. 这份规划是骨架，内容是**你自己写的**，不是复制模板画面。',
      '2. 模板最多装一次（' + (C.设计时长 || 5) + ' 秒），放在片头当"视觉定调"，或者干脆不装——语法已经在上面了。',
      '3. 其余每一拍用 edit_timeline 加你自己的片段：文字用 addtext（配 tstyle 定样式），素材用 add。',
      '4. 每拍内的元素要错开 ' + 错开 + ' 秒进场，别一起出现。',
      '5. 缓动统一用 ' + 主缓动 + ' 这一族，风格才连续。',
      '6. 别为了"填满时间"把同一句话拉很长——一拍只讲一件事。',
    ],
    别这么做: '不要把 ' + C.模板 + ' 复制 ' + n + ' 遍铺满 ' + total + ' 秒。观众会看成同一段画面反复，内容一点没增加。',
  }
})

/** 给一个刚装上的模板片段填文字（走与「点画面改字」同一条链路）。 */
async function applySegText(project, clipId, line) {
  try {
    const T = require('./timeline')
    const TPLT = require('./tpltext')
    const fs = require('node:fs')
    const path = require('node:path')
    const parts = String(line).split('|').map(s => s.trim())
    const d = T.load(project)
    const dir = T.projDir(project)
    let clip = null
    for (const tr of d.tracks || []) for (const c of tr.clips || []) if (c.id === clipId) clip = c
    if (!clip) return false
    const srcAbs = path.join(dir, String(clip.src || ''))
    if (!fs.existsSync(srcAbs)) return false
    const list = TPLT.scanFile(srcAbs)
    if (!list.length) return false
    const edits = Object.assign({}, clip.edits || {})
    for (let i = 0; i < parts.length && i < list.length; i++) {
      if (parts[i]) edits[list[i].key] = parts[i]
    }
    if (!Object.keys(edits).length) return false
    const per = 'compositions/' + String(clip.name) + '--' + String(clipId).replace(/[^\w-]/g, '') + '.html'
    TPLT.writeCopyFull(srcAbs, path.join(dir, per), edits, Number(clip.duration) || undefined)
    clip.src = per
    clip.edits = edits
    clip.tplSrc = clip.tplSrc || srcAbs
    T.save(project, d)
    return true
  } catch { return false }
}

// ══════════════════ 视觉库 ══════════════════
tool('transitions', '这台机器上真能渲出来的转场清单。', {}, { level: '只读' })(async () => {
  const L = require('./looks')
  const names = Object.keys(L.TRANSITIONS)
  return `共 ${names.length} 个转场：\n` + names.map(n => `- ${n}  ${JSON.stringify(L.transOf(n))}`).join('\n')
})

tool('camera_moves', '让静止的画面动起来：推近、拉远、快推、左右上下移。', {}, { level: '只读' })(async () => {
  const L = require('./looks')
  return `共 ${Object.keys(L.CAMERA_MOVES).length} 个运镜：\n` + Object.keys(L.CAMERA_MOVES).map(n => `- ${n}  ${L.CAMERA_MOVES[n].desc || ''}`).join('\n')
})

tool('color_looks', '有什么影调、怎么用。基础影调（电影/胶片/黑白…）只改颜色。', {}, { level: '只读' })(async () => {
  const L = require('./looks')
  return `共 ${Object.keys(L.COLOR_LOOKS).length} 种调色：\n` + Object.entries(L.COLOR_LOOKS).map(([n, v]) => `- ${n}  ${v.desc || ''}\n    ${v.vf || ''}`).join('\n')
})

tool('speed_curve', '匀速变速之外的玩法：冲进来卡住、慢慢起再爆发、急刹。', {}, { level: '只读' })(async () => {
  const L = require('./looks')
  return `共 ${Object.keys(L.SPEED_CURVES).length} 条曲线：\n` + Object.entries(L.SPEED_CURVES).map(([n, v]) => `- ${n}  ${JSON.stringify(v)}`).join('\n')
})

tool('look', '审美标准：好看到底是什么——进场多快、退场多快、元素错开多少、缓动用哪个。', {}, { level: '只读' })(async () => {
  const L = require('./looks')
  const names = L.lookNames ? L.lookNames() : Object.keys(L.LOOK_PRESETS)
  return `共 ${names.length} 套影调预设：\n` + names.map(n => `- ${n}\n  ${L.lookPrompt(n)}`).join('\n')
})

// ══════════════════ 时间线 ══════════════════
tool('slides', '做演示稿视频（PPT 视频 / 口播 PPT）。给一份大纲就直接出工程：自动分页、自动配音、自动定时长，每页一张渐变底 + 标题 + 要点。这是最简单的片子类型，别用模板绕。',
  {
    outline: '大纲。每行一条要点，第一行当标题；或每页用 --- 隔开；也认 # 开头的 markdown 标题',
    name: '工程名（不给就按时间戳起）',
    theme: '配色：浅色 | 深色 | 纸感 | 青绿',
    voice: '配音音色（macOS 音色名，不给用设置里的）',
    rate: '语速，默认 175',
    bgm: '配乐：不给就没有；给个情绪词（轻快/大气）或音乐文件路径',
    pages: '已经分好页的 JSON 数组（给了就忽略 outline）：[{kind,title,bullets,note}]，kind 可选 cover/points/quote/section/end',
    voice_on: '要不要配音，默认要；传 0 出不带声音的纯文字版',
  },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const S = require('./slides')
  let pages = null
  if (a.pages) {
    try {
      const v = typeof a.pages === 'string' ? JSON.parse(a.pages) : a.pages
      if (Array.isArray(v)) pages = v.map((x) => S.normalizePage ? S.normalizePage(x) : x)
    } catch (e) { return '❌ pages 不是合法 JSON：' + e.message }
  }
  if (!pages) pages = S.parseOutline(a.outline)
  /* ★ pages 直传时也要过分页。AI 自己分的页往往是「一页塞 20 条」，
     那 20 条会挤成一坨重叠的字 —— 不是「要点多」，是没法看。 */
  else pages = S.splitPages(pages)
  if (!pages.length) return '❌ 大纲是空的。给一行标题起头，下面每行一条要点'
  const r = await S.build({
    customer,
    name: a.name,
    theme: a.theme,
    voice: a.voice,
    rate: a.rate,
    bgm: a.bgm,
    withVoice: !(String(a.voice_on) === '0' || a.voice_on === false),
    pages,
  })
  return clip(S.brief(r) + '\n\n下一步：用 generate 出片（project 传工程名，final=1 出正式成片）')
})

tool('edit_timeline', '剪辑台的时间线。AI 剪片一律先建成可改的多轨时间线，不是直接出成片。' +
  '\n文字样式（addtext 的 tstyle）：46 款成品样式直接套，不要自己拼 CSS。' +
  '先用 text_style 工具列一遍再挑，常见的：solid 纯白 / plate 黑底衬 / glass 毛玻璃 / gold 金渐变 / glowCyan 青光 / hollowW 白中空 / poster 大字报 / vert 竖排。' +
  '\n轨道语义（最常犯的错就在这）：v1 是底层画面，g1 是图形/模板层，t1 是文字层，a1 是音频层。' +
  '模板只有它自己的那几秒，播完之后如果 v1 没有画面垫着，观众看到的是纯黑。' +
  '所以加完模板一定要检查：模板结束到片尾之间，v1 上有没有东西。这是最常见的一种废片。',
  {
    action: 'new | get | save | add | addtext | addtemplate | del | move | trim | split | track | assets | list | delete | render',
    project: '工程名', clip: '片段 id', track: '轨道 v1/g1/t1/a1', at: '开始秒', dur: '时长秒',
    path: '素材路径（add 用）：直接写 assets list/find 返回的文件名就行（如 xxx.png），别自己拼「素材库/图片」这种目录，系统会自动找真实位置', text: '文字（addtext 用）', template: '模板名（addtemplate 用）',
    vars: '模板变量（addtemplate 用）：先用 template_vars 查出可改项，如 {"action_line":"青衣 Cyanweb","button_label":"关注我们"}。改的是模板自己的字，不用再叠 addtext',
    width: '画布宽', height: '画布高', fps: '帧率', data: '整份时间线 JSON（save 用）',
    tstyle: '文字样式 id（addtext 用）：先用 text_style 工具查，如 gold 金渐变 / hollowW 白中空 / glass 毛玻璃 / poster 大字报。不给就是默认黑底衬',
    c2: '副色（addtext 用，仅渐变款吃）：十六进制，如 #FF5E7E。不给则用款式自带的第二档',
    anim: '文字动效（addtext 用）：无/fade 淡入淡出/slideUp 上滑入/slideDown 下滑入/slideLeft 左滑入/slideRight 右滑入/zoomIn 放大入/zoomOut 缩小入/kenburns 缓慢推镜/charIn 逐字弹入/typewriter 打字机',
  },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const T = require('./timeline')
  const act = String(a.action || 'list')
  const name = String(a.project || '').trim()
  if (act === 'list') {
    const ps = T.listProjects()
    return clip(`共 ${ps.length} 个工程：\n` + ps.map(p => `- ${p.name}  ${p.duration}s  ${p.clips} 段  ${p.width}x${p.height}${p.internal ? '（内部）' : ''}`).join('\n'))
  }
  if (!name) return '❌ 给 project'
  if (act === 'new') {
    const d = T.blank(name, Number(a.width) || undefined, Number(a.height) || undefined, Number(a.fps) || undefined, Number(a.dur) || 10)
    T.save(name, d)
    return `✓ 建了工程「${name}」 ${d.width}x${d.height}@${d.fps}`
  }
  if (act === 'get') {
    const d = T.load(name)
    return d ? clip(JSON.stringify(d, null, 1)) : `❌ 没有这个工程：${name}`
  }
  if (act === 'save') {
    let data = a.data
    if (typeof data === 'string') { try { data = JSON.parse(data) } catch (e) { return '❌ data 不是合法 JSON：' + e.message } }
    if (!data) return '❌ 给 data'
    /* ★ 2026-11-20 修：AI 按直觉把 tracks 写成对象 {"v1":[...], "g1":[...]}，
       而时间线内部是数组 [{id:'v1',clips:[...]}]。直接 save 会在 tail() 里
       `for (const t of data.tracks)` 报 object is not iterable。这里做一层兼容：
       对象形式按轨道 id 转成数组，片段字段也归一（asset/at/dur → src/start/out）。 */
    if (data.tracks && !Array.isArray(data.tracks) && typeof data.tracks === 'object') {
      const KIND = { v1: 'video', g1: 'graphics', t1: 'text', a1: 'audio' }
      const NAME = { v1: '主视频', g1: '图形', t1: '字幕', a1: '音频' }
      const arr = []
      for (const id of Object.keys(data.tracks)) {
        const rawClips = data.tracks[id]
        if (!Array.isArray(rawClips)) continue
        const clips = rawClips.map(c => {
          const o = { ...c }
          if (o.asset && !o.src) o.src = o.asset
          if (o.at !== undefined && o.start === undefined) o.start = o.at
          if (o.dur !== undefined) {
            if (o.type === 'text' || o.type === 'template' || id === 't1' || id === 'g1') {
              if (o.duration === undefined) o.duration = o.dur
            } else if (o.out === undefined && o.in === undefined) {
              o.out = (Number(o.start) || 0) + Number(o.dur)
              o.in = Number(o.start) || 0
            }
            delete o.dur
          }
          if (id === 't1' && !o.type) o.type = 'text'
          return o
        })
        arr.push({ id, kind: (data.tracks[id].kind || KIND[id] || 'video'), name: NAME[id] || id, clips })
      }
      data.tracks = arr
    }
    T.save(name, data)
    return `✓ 存了「${name}」，时长 ${T.load(name).duration}s`
  }
  if (act === 'add') {
    const d = T.load(name) || T.blank(name)
    const r = resolveUserPath(a.path, customer)
    if (!r.ok) return '❌ ' + r.error
    // ★ importAsset 返回的是对象 {name, src, kind, size}，不是字符串路径 ——
    //   直接塞进 src 会变成 "[object Object]"，渲出来一片黑而且不报错。
    const imp = T.importAsset(name, r.abs)
    const rel = (imp && imp.src) ? imp.src : String(imp)
    const info = await require('./exec').probe(r.abs)
    // ★ 字段名必须对齐渲染层：src / start / in / out / type。
    //   第一版写的是 path / at / dur / asset，T.save 不报错、文件也生成了，
    //   但渲染层一个字段都读不到 —— 症状是「加片段报成功，出片全黑」。
    //   另外 tracks 是数组，不能 d.tracks['v1']（给数组设字符串键会被 JSON 丢掉）。
    const trackId = ['v1', 'g1', 't1', 'a1'].includes(String(a.track || 'v1')) ? String(a.track || 'v1') : 'v1'
    const tr = T.ensureTrack(d, trackId)
    const isImg = /^image$/.test(info && info.kind) || /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(r.abs)
    const isAud = /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(r.abs)
    const dur = Number(a.dur) || (info && info.duration) || (isImg ? 3 : 3)
    const clipObj = T.mediaClip({
      src: rel,
      type: isImg ? 'image' : isAud ? 'audio' : 'video',
      start: Number(a.at) || 0,
      dur,
      inPoint: Number(a.inPoint || a.in) || 0,
      volume: a.volume === undefined ? undefined : Number(a.volume),
      fit: a.fit || 'cover',
    })
    tr.clips.push(clipObj)
    T.save(name, d)
    const back = T.trackOf(T.load(name), trackId)
    const n = back ? back.clips.length : 0
    return `✓ 加进 ${trackId}：${rel} ${dur.toFixed(2)}s @${clipObj.start}s（${trackId} 现在共 ${n} 段）`
  }
  if (act === 'addtext') {
    const d = T.load(name) || T.blank(name)
    // ★ 文字片段的时长字段是 duration 不是 out，位置是 start 不是 at —— 同样对齐渲染层。
    const tr = T.ensureTrack(d, 't1')
    const clipObj = T.textClip({
      text: a.text,
      start: Number(a.at) || 0,
      dur: Number(a.dur) || 3,
      size: a.size === undefined ? undefined : Number(a.size),
      color: a.color || '#FFFFFF',
      y: a.y === undefined ? 0.84 : Number(a.y),
      align: a.align || 'center',
      anim: a.anim || 'fade',
      height: Number(d.height) || 1920,
      /* 文字样式与副色：AI 说「来个金渐变的标题」时，光改 color 是没用的
         —— 渐变靠的是整套声明串。这里把 tstyle 交给 textClip 去查表。 */
      tstyle: a.tstyle || '',
      c2: a.c2 || '',
    })
    tr.clips.push(clipObj)
    T.save(name, d)
    const back = T.trackOf(T.load(name), 't1')
    return `✓ 字幕：${clipObj.text} ${clipObj.duration}s @${clipObj.start}s（t1 现在共 ${back ? back.clips.length : 0} 段）`
  }
  if (act === 'addtemplate') {
    const R = require('./render')
    /* ★ 2026-11-20 画幅硬兜底：模板库的片头片尾模板全是 1920×1080 横屏，
       竖屏工程（1080×1920）塞进去两边会被裁 —— 青衣 Cyanweb 那次
       "Cyanweb" 被裁成 "yanwe"，黑底半截大字。提示词讲了不一定被读，
       这里在装模板时直接比对工程与模板画幅，不匹配就明确拦下来。 */
    const proj = T.load(name)
    const tplName = String(a.template || '')
    const tpl = require('./templates').catalog().find(x => x.name === tplName)
    if (proj && tpl && proj.width && proj.height && tpl.w && tpl.h) {
      const pLand = Number(proj.width) > Number(proj.height)
      const tLand = Number(tpl.w) > Number(tpl.h)
      if (pLand !== tLand) {
        return `❌ 画幅不匹配：模板「${tplName}」是 ${tpl.w}×${tpl.h}（${tLand ? '横' : '竖'}屏），工程「${name}」是 ${proj.width}×${proj.height}（${pLand ? '横' : '竖'}屏）。硬塞进去画面两边会被裁掉（"Cyanweb" 被裁成 "yanwe" 就是这样）。两种改法：① 把工程画幅改成 ${tpl.w}×${tpl.h} 再装；② 换一个跟工程同画幅的模板。`
      }
    }
    /* ★ 2026-11-20：两类陷阱模板的硬兜底。
       「中文缺字形」类（extruded-logo 等）的文字走 Geist 拉丁字库，中文会渲成 ?? 或空白。
       只要 vars 里带了中文，就直接拦下并给替代方案 —— 不管 AI 读没读提示词。
       KB-254 记了同类 frost 事故：中文标题渲出来是空白。 */
    if (tpl && tpl.trap && tpl.trap.kind === '中文缺字形') {
      let varText = ''
      if (a.vars) {
        try { const vv = typeof a.vars === 'string' ? JSON.parse(a.vars) : a.vars; varText = Object.values(vv || {}).join(' ') } catch (e) { varText = String(a.vars) }
      }
      if (/[\u4e00-\u9fff]/.test(varText)) {
        return `❌ 模板「${tplName}」${tpl.trap.note}。你传的变量里有中文，装进去会渲成 ?? 或空白。有中文内容请换 glass-hero（普通 DOM 文字、中文正常）；纯英文 logo 才用这个。`
      }
    }
    /* ★ 不传 dur 就让模板用自己的设计时长。
       以前这里写的是 `dur: Number(a.dur) || 3` —— 于是每个模板都被切成 3 秒：
       19 秒的动画只播了开头就断，看着像「渲染坏了」，其实是参数把时长钉死了。
       模型调用时基本不会主动给 dur，所以这条默认值等于对所有模板生效。 */
    const opt = { at: Number(a.at) || 0 }
    if (Number(a.dur) > 0) opt.dur = Number(a.dur)
    /* ★ 2026-11-20：模板变量的最后一环。template_vars 能列出 action_line /
       button_label 这些可改项，渲染层 render.js 也支持 opts.vars 写进片段，
       但这里从来没把 AI 传的 vars 接过来 —— 于是模板永远显示英文默认值
       「Make it happen / Start now」，AI 只能再叠一层 addtext，成片就是
       「英文默认字 + 中文覆盖」。现在把 vars 接上（对象或 JSON 字符串都收）。 */
    if (a.vars) {
      let vars = a.vars
      if (typeof vars === 'string') { try { vars = JSON.parse(vars) } catch (e) { return '❌ vars 不是合法 JSON：' + e.message } }
      if (vars && typeof vars === 'object') opt.vars = vars
    }
    const r = await R.addTemplate(name, String(a.template || ''), opt)
    /* ★ 2026-11-20：必须同时看 mounted。
       以前只看 r.ok（恒 true），component 类模板只拷了文件没挂到 g1 时也回「✓ 加了模板」，
       agent 以为成功连调 4 次、白烧几万 token，时间线上却什么都没有。
       现在文件拷进去了但没挂轨 → 明确报错，让 agent 立刻知道并换做法。 */
    if (!r.ok) return '❌ ' + (r.error || '加模板失败')
    if (r.mounted === false) return `❌ 模板「${a.template}」文件已就位，但没能挂到时间线（类型不支持单独成片）。换一个 block/片尾类模板再试`
    return `✓ 加了模板「${a.template}」到 ${a.track || 'g1'}，时长 ${r.clip ? '已排' : '?'} @${opt.at}s`
  }
  if (act === 'del') {
    const d = T.load(name)
    if (!d) return `❌ 没有这个工程：${name}`
    let n = 0
    // ★ tracks 是数组，Object.keys 是 '0','1','2','3'，得按 id 找轨道
    for (const tr of (Array.isArray(d.tracks) ? d.tracks : [])) {
      const before = (tr.clips || []).length
      tr.clips = (tr.clips || []).filter((c) => c.id !== a.clip)
      n += before - tr.clips.length
    }
    T.save(name, d)
    return n ? `✓ 删了 ${n} 段` : `❌ 没找到片段 ${a.clip}`
  }
  if (act === 'delete') { T.del(name); return `✓ 删了工程「${name}」` }
  if (act === 'assets') {
    const as = T.assets(name)
    return clip(`工程「${name}」素材 ${as.length} 个：\n` + as.map(x => `- ${x.name}`).join('\n'))
  }
  if (act === 'render') {
    const R = require('./render')
    const r = await R.renderProject(name, { final: !!a.final })
    return r.ok ? `✓ 出片：${r.path}（${r.duration.toFixed(2)}s，${humanSize(r.size)}，${r.ms}ms）` : '❌ 渲染失败：' + r.error
  }
  /* ★ 2026-11-20：下面四个动作工具描述里一直承诺，代码却没实现 ——
     AI 按描述调 trim/split 时收到「没有这个动作」，工程就卡在半成品。
     用户点破这是集成层问题，这里把它们补齐（不新增依赖，直接操作时间线 JSON）。 */
  if (act === 'track') {
    const d = T.load(name) || T.blank(name)
    const id = String(a.track || a.id || '').trim()
    if (!id) return '❌ 加轨道要给 track（如 v2 / g2 / a2）'
    if (T.trackOf(d, id)) return `✓ 轨道 ${id} 已经存在`
    const tr = T.ensureTrack(d, id)
    if (a.kind) tr.kind = String(a.kind)
    if (a.name) tr.name = String(a.name)
    T.save(name, d)
    return `✓ 加了轨道 ${id}（${tr.kind}）`
  }
  if (act === 'move') {
    const d = T.load(name)
    if (!d) return `❌ 没有这个工程：${name}`
    let hit = null, from = null
    for (const tr of (Array.isArray(d.tracks) ? d.tracks : [])) {
      const c = (tr.clips || []).find(x => x && x.id === a.clip)
      if (c) { hit = c; from = tr; break }
    }
    if (!hit) return `❌ 没找到片段 ${a.clip}`
    if (a.at !== undefined && a.at !== '') hit.start = Math.max(0, Number(a.at) || 0)
    if (a.track && a.track !== from.id) {
      const to = T.ensureTrack(d, String(a.track))
      from.clips = from.clips.filter(x => x.id !== a.clip)
      to.clips.push(hit)
    }
    T.save(name, d)
    return `✓ 移动了 ${a.clip} 到 ${a.track || from.id} @${hit.start}s`
  }
  if (act === 'trim') {
    const d = T.load(name)
    if (!d) return `❌ 没有这个工程：${name}`
    let hit = null
    for (const tr of (Array.isArray(d.tracks) ? d.tracks : [])) {
      const c = (tr.clips || []).find(x => x && x.id === a.clip)
      if (c) { hit = c; break }
    }
    if (!hit) return `❌ 没找到片段 ${a.clip}`
    const dur = Math.max(0.1, Number(a.dur) || 3)
    if (a.at !== undefined && a.at !== '') hit.start = Math.max(0, Number(a.at) || 0)
    if (hit.type === 'image' || hit.type === 'text' || hit.duration !== undefined) {
      hit.duration = dur; delete hit.out
    } else {
      hit.out = Math.round(((Number(hit.in) || 0) + dur) * 1000) / 1000
    }
    T.save(name, d)
    return `✓ 把 ${a.clip} 裁成 ${dur}s @${hit.start}s`
  }
  if (act === 'split') {
    const d = T.load(name)
    if (!d) return `❌ 没有这个工程：${name}`
    let hit = null, trFound = null, idx = -1
    for (const tr of (Array.isArray(d.tracks) ? d.tracks : [])) {
      const i = (tr.clips || []).findIndex(x => x && x.id === a.clip)
      if (i >= 0) { hit = tr.clips[i]; trFound = tr; idx = i; break }
    }
    if (!hit) return `❌ 没找到片段 ${a.clip}`
    const at = Number(a.at)
    if (!at || at <= 0) return '❌ split 要给切点秒数 at（>0）'
    const dur = (hit.type === 'image' || hit.type === 'text')
      ? (Number(hit.duration) || 0)
      : ((Number(hit.out) || 0) - (Number(hit.in) || 0))
    if (at >= dur) return `❌ 切点 ${at}s 超出片段时长 ${dur}s`
    const right = JSON.parse(JSON.stringify(hit))
    right.id = 'c' + Date.now() + '-' + Math.floor(Math.random() * 999)
    if (hit.type === 'image' || hit.type === 'text') {
      right.duration = Math.round((dur - at) * 1000) / 1000
      hit.duration = Math.round(at * 1000) / 1000
      right.start = Math.round((hit.start + at) * 1000) / 1000
    } else {
      right.in = Math.round(((Number(hit.in) || 0) + at) * 1000) / 1000
      hit.out = Math.round(((Number(hit.in) || 0) + at) * 1000) / 1000
      right.start = Math.round((hit.start + at) * 1000) / 1000
    }
    trFound.clips.splice(idx + 1, 0, right)
    T.save(name, d)
    return `✓ 把 ${a.clip} 从 ${at}s 切成两段（${hit.id} / ${right.id}）`
  }
  return `没有这个动作：${act}`
})

tool('timeline', '时间线读数：load 读分镜、duration 算总长、caption 加字幕、inspect 看每段。',
  { action: 'load | duration | inspect | list', project: '工程名' },
  { level: '只读' })(async (a) => {
  const T = require('./timeline')
  const name = String(a.project || '').trim()
  if (a.action === 'list') return T.listProjects().map(p => `${p.name} ${p.duration}s ${p.clips}段`).join('\n')
  if (!name) return '❌ 给 project'
  const d = T.load(name)
  if (!d) return `❌ 没有这个工程：${name}`
  if (a.action === 'duration') return `「${name}」总长 ${T.tail(d).toFixed(2)}s`
  if (a.action === 'inspect') {
    const rows = []
    for (const [k, tr] of Object.entries(d.tracks || {})) {
      for (const c of (tr.clips || [])) rows.push(`${k}  ${c.id}  ${(c.start || 0).toFixed(2)}–${((c.start || 0) + (c.dur || 0)).toFixed(2)}s  ${c.asset || c.text || c.template || ''}`)
    }
    return clip(`「${name}」${d.width}x${d.height}@${d.fps} 总长 ${T.tail(d).toFixed(2)}s\n` + rows.join('\n'))
  }
  return clip(JSON.stringify(d, null, 1))
})

// ══════════════════ 出片前体检（旧 engine.py 的四道闸门） ══════════════════
tool('plan_check', '出片前先把账算清楚：照这份方案渲出来是多少秒、差目标多少、口播和画面对不对得上、哪段超了源素材。出的秒数就是成片的秒数，不是估算。',
  { project: '工程名（读工程里的 plan）', data: '方案 JSON（直接传方案，可省 project）', target: '目标秒数（覆盖方案里的 target_duration）' },
  { level: '只读' })(async (a, customer) => {
  const P = require('./plan')
  const T = require('./timeline')  // ★ 2026-11-20：函数体漏了这句，从工程名读 plan 时报 "T is not defined"
  let plan = null
  if (a.data) { try { plan = JSON.parse(String(a.data)) } catch (e) { return '❌ 方案 JSON 解析失败：' + e.message } }
  else {
    const name = String(a.project || '').trim()
    if (!name) return '❌ 给 project 或 data'
    const d = T.load(name)
    if (!d) return `❌ 找不到工程「${name}」`
    plan = d.plan
    if (!plan) return `❌ 工程「${name}」里没有 plan（方案）。先用 edit_timeline 的 add 把分镜排进时间线，或直接传 data。`
  }
  if (a.target) plan.target_duration = Number(a.target) || plan.target_duration
  const r = P.planCheck(plan, { customer })
  return P.planReport(r)
})

tool('hook_check', '给开场那句打分（0–10，7 分以上才够格当冷开场），返回命中了哪些加减项。写三个备选各自打分，用最高的那个。',
  { text: '开场那句话', energy: '画面强度 0–1（可省）', rubric: '传 1 看完整评分表' },
  { level: '只读' })(async (a) => {
  const P = require('./plan')
  if (String(a.rubric || '') === '1') return P.hookRubric()
  const text = String(a.text || '').trim()
  if (!text) return '❌ 给 text'
  const r = P.hookScore(text, Number(a.energy) || 0)
  return [`${r.score} / 10  ${r.score >= P.HOOK_MIN_SCORE ? '✓ 够格当冷开场' : '✗ 不够'}`, `命中：${r.hits.join('、') || '（没有加分项）'}`, r.note].join('\n')
})

tool('pacing_check', '节奏体检：平均单镜多长、哪段拖、哪段一闪而过。参数给时长列表，或给工程名从时间线取。',
  { project: '工程名', durs: '各段时长，逗号分隔（如 2,3.5,1.2）' },
  { level: '只读' })(async (a) => {
  const P = require('./plan')
  let ds = []
  let total = 0
  if (a.durs) ds = String(a.durs).split(/[,，\s]+/).map(Number).filter((n) => n > 0)
  else {
    const name = String(a.project || '').trim()
    if (!name) return '❌ 给 project 或 durs'
    const d = T.load(name)
    if (!d) return `❌ 找不到工程「${name}」`
    for (const tr of Object.values(d.tracks || {})) {
      for (const c of (tr.clips || [])) ds.push(Number(c.dur) || (Number(c.out) || 0) - (Number(c.in) || 0) || 0)
    }
    ds = ds.filter((n) => n > 0)
    total = T.tail(d)
  }
  const r = P.pacingAudit(ds, total)
  return [`平均每镜 ${r.avg} 秒（这个时长理想 ${r.ideal} 秒）`, `最长一段 ${r.longest} 秒`,
    `节奏 ${r.score} / 10`, ...(r.flags.length ? ['问题：', ...r.flags.map((f) => '  · ' + f)] : ['没有明显问题。'])].join('\n')
})

tool('truth_check', '核对屏幕上的数字有没有在口播里说过、稿子里有没有混进导演的话（「这段重来」「改成」之类）。',
  { project: '工程名（读工程里的 plan）', data: '方案 JSON（可省 project）' },
  { level: '只读' })(async (a) => {
  const P = require('./plan')
  let plan = null
  if (a.data) { try { plan = JSON.parse(String(a.data)) } catch (e) { return '❌ 方案 JSON 解析失败：' + e.message } }
  else {
    const name = String(a.project || '').trim()
    if (!name) return '❌ 给 project 或 data'
    const d = T.load(name)
    if (!d) return `❌ 找不到工程「${name}」`
    plan = d.plan
    if (!plan) return `❌ 工程「${name}」里没有 plan。`
  }
  const r = P.truthCheck(plan)
  if (r.ok) return `✓ 事实核对通过。屏幕上的数字都在口播里说过：${r.screen_numbers.join('、') || '（没有数字）'}`
  const L2 = []
  if (r.unspoken.length) {
    L2.push(`⚠ 这 ${r.unspoken.length} 个数字屏幕上出现了但口播里没说过（观众会觉得是编的）：`)
    for (const u of r.unspoken.slice(0, 12)) L2.push(`  · 「${u.number}」在 ${u.field}：${u.text}`)
  }
  if (r.asides.length) L2.push(`⚠ 稿子里混进了导演的话：${r.asides.join('、')} —— 这些是对同事说的，不是给观众听的。`)
  return L2.join('\n')
})

tool('gate_check', '成片闸门：渲完之后核「说好的东西真的在里面吗」—— 时长、分辨率、有没有音轨、段落数对不对。',
  { video: '成片路径', duration: '方案说多少秒', width: '要的宽', height: '要的高', needAudio: '要声音传 1' },
  { level: '只读' })(async (a, customer) => {
  const P = require('./plan')
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await P.gateCheck(r.abs, {
    duration: Number(a.duration) || 0,
    width: Number(a.width) || 0,
    height: Number(a.height) || 0,
    needAudio: String(a.needAudio || '') === '1',
    needVideo: true,
  })
  const f = res.facts || {}
  const head = f.duration
    ? `${f.duration.toFixed(2)}s  ${f.width}x${f.height}  ${f.vcodec || '?'}  ${f.hasAudio ? '有音轨' : '无音轨'}`
    : '（读不出来）'
  if (res.ok) return `✓ 闸门通过\n   ${head}`
  return [`✗ 闸门没过`, `   ${head}`, ...res.problems.map((p) => '  · ' + p)].join('\n')
})

// ══════════════════ 交付（转竖屏 / 平台档 / 交付体检） ══════════════════
tool('vertical', '把一条横屏片子重排成竖屏 9:16。背景是原片模糊压暗铺满的，不是黑边。要换裁哪一块就调 focus：人站右边填 0.8。',
  { video: '要转的片子路径', out: '输出路径（留空自动）', window: '前景窗口：方形/四比五/原比例/满屏', focus: '横向裁哪：0 左 0.5 中 1 右', pos: '纵向位置：top/center/bottom' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const D = require('./delivery')
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  let out = undefined
  if (a.out) { const o = resolveUserPath(a.out, customer, true); if (o.ok) out = o.abs }
  try {
    const res = await D.reframeVertical(r.abs, { out, window: a.window || '方形', focus: a.focus === undefined ? 0.5 : Number(a.focus), pos: a.pos })
    return `✓ 已转成竖屏 ${res.size}，前景窗口 ${res.fg}\n   ${res.path}`
  } catch (e) { return '❌ ' + e.message }
})

tool('platform', '交付前查文件能不能在网页/平台播（yuv420p、faststart、编码），或把母版重排成某个平台的尺寸。action=check/export/list。',
  { action: 'check 体检 / export 导出平台档 / list 列各平台规格', video: '要体检或导出的片子路径', platform: 'export 用：youtube/shorts/reels/tiktok/douyin/视频号/小红书/igfeed/x/linkedin/web', out: 'export 的输出路径（留空自动）' },
  { level: '只读' })(async (a, customer) => {
  const D = require('./delivery')
  const act = String(a.action || 'list').trim().toLowerCase()
  if (act === 'list') {
    const rows = D.platformList().map((v) => {
      const lim = []
      if (v.max_s) lim.push(`≤${v.max_s}s`)
      if (v.max_mb) lim.push(`<${v.max_mb}MB`)
      return `· ${v.key}：${v.w}x${v.h} ${lim.join('/') || '不限'} — ${v.note}`
    })
    return ['【各平台交付档】', ...rows, '', '一条母版派生多份，别每个平台重渲。用 export 指定 platform 就出一档，出完自动跑交付体检；超了时长/大小会在 over 里点名。'].join('\n')
  }
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  if (act === 'check') return D.deliveryReport(await D.deliveryCheck(r.abs))

  if (act === 'export' || act === '导出') {
    if (!a.platform) return '❌ export 要指定 platform。用 list 看有哪些。'
    let out = undefined
    if (a.out) { const o = resolveUserPath(a.out, customer, true); if (o.ok) out = o.abs }
    try {
      const res = await D.exportPlatform(r.abs, a.platform, { out })
      const i = res.delivery.info || {}
      const head = `✓ 已导出 ${res.platform} 档：${i.width}x${i.height}，${i.duration}s，${i.mb}MB，交付体检 ${res.delivery.ok ? '全过' : '有问题'}\n   ${res.path}`
      return res.over.length ? head + '\n⚠ 超平台上限：' + res.over.join('；') : head
    } catch (e) { return '❌ ' + e.message }
  }
  return `❌ 不认识的 action：${act}（可用 check/export/list）`
})

// ══════════════════ 生图 ══════════════════
tool('image_prompt', '写真实照片级 prompt 的十段契约。要出有真实感的图先看这个，别直接堆「8k/超清/杰作」。',
  {}, { level: '只读' })(async () => require('./guide').imagePromptGuide())

tool('make_image',
  '生成一张静态图片：配图、封面、插画、海报、图标、画面示意。同步执行完才返回，path 是磁盘上真实存在的文件。'
  + '出完自动进素材库——排分镜时直接写这个文件名当 asset。要真实感先查 image_prompt 按契约写；出完用 image_review 看一眼再改。',
  { prompt: '画面描述。要真实感就照十段写：什么介质+谁在做什么+相机在哪、哪半秒、光从哪来（带光比）、机位焦段光圈、以及至少五个具体瑕疵',
    size: '目标画幅，写像素串 1080x1920 / 1920x1080 / 1024x1024。引擎自动换算成接口认的档位（1K/2K/3K/4K）+ 宽高比，出完量真实尺寸，不够目标画布自动升档重出一次。竖屏片子写 1080x1920',
    model: '生图模型 id，不填就用当前绑定的那个' },
  { level: '建议', mutates: 'render' })(async (a) => {
  const I = require('./image')
  const prompt = String(a.prompt || a.requirement || a.text || '').trim()
  if (!prompt) return '❌ 要写清楚画什么：prompt 必填，例如「科技感产品封面，深蓝背景，居中构图」。'
  try {
    const r = await I.generateImage({ prompt, size: a.size, model: a.model })
    const notes = []
    if (r.upgraded) notes.push(`接口给的图不够大，已升到 ${r.upgraded} 重出一次`)
    if (r.stillShort) notes.push('重出之后还是没到目标画布，交付前会被放大裁切 —— 换更大的档位或换个模型')
    if (r.upgradeError) notes.push('升档失败：' + r.upgradeError)
    return `✓ 出图：${r.path}\n   ${r.width}x${r.height}  ${Math.round(r.size / 1024)}KB  ${r.ms}ms${r.inLibrary ? '  已进素材库' : ''}`
      + (notes.length ? '\n   ' + notes.join('\n   ') : '')
  } catch (e) {
    /* ★ 报错要带「别再试了」的指令。
       实测：没配生图模型（或模型接口返回 404）时，AI 会换一种 prompt、
       再换个尺寸、再换个模型 id，一路试到 36 次调用 / 95 万 token / 188 秒，
       最后什么都没交出来。它把 404 当成了"临时故障"。
       这里把话说死：这是配置问题，重试没有意义，请改用纯模板路线或问用户。 */
    const msg = String(e.message || e)
    const isConfig = /还没有生图模型|没填 API Key|HTTP 40[13]/i.test(msg)
    return '❌ ' + msg
      + (isConfig
        ? '\n\n⛔ 这是**配置问题，重试没有用**。不要换 prompt、换尺寸、换模型再试。\n'
          + '   请二选一：① 改用 templates 走纯模板 + 文字路线（不需要图，一定能出片）；\n'
          + '   ② 告诉用户「这台机器没有可用的生图模型」，请他去模型管理配一个。'
        : '\n\n⚠️ 同一个生成工具连续失败 2 次就停手，别继续换写法重试。')
  }
})

tool('image_text', '【给图片叠字】往一张图上压一句字，出一张新图（封面图、社交图、缩略图）。复用全部字幕样式：钩子字（贴顶大字+顶部渐变，白底也读得清）、编辑字（左下安静）、大字、卡片。生图模型在画面里写字，六字以上会写出乱码——出干净图再拿这个叠。',
  { image: '图片路径（素材库里的或刚生成的都行）', text: '要压上去的那句话',
    preset: '钩子字 / 编辑字 / 大字 / 标准 / 卡片', size: '字号像素，一般留空', out: '输出路径，留空自动命名' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const I = require('./image')
  const img = String(a.image || a.path || a.src || '').trim()
  const txt = String(a.text || a.caption || '').trim()
  if (!img) return '❌ 要给哪张图叠字？image 填图片路径。'
  if (!txt) return '❌ 要叠什么字？text 是空的。'
  const r = resolveUserPath(img, customer)
  if (!r.ok) return '❌ ' + r.error
  let out
  if (a.out) { const o = resolveUserPath(a.out, customer, true); if (o.ok) out = o.abs }
  try {
    const res = await I.imageText(r.abs, txt, {
      out, preset: a.preset || '钩子字',
      size: String(a.size || '').trim() && Number(a.size) ? Number(a.size) : undefined,
    })
    return `✓ 叠好了：${res.path}\n   ${res.text}（${res.width}x${res.height}，样式「${res.preset}」）${res.scrim ? '，已加顶部渐变' : ''}`
  } catch (e) { return '❌ 叠字没成：' + e.message }
})

tool('image_review', '把自己刚生成的图看一遍，按真实性/值得看两条轴打分，只指出最差的那一处和该怎么改 prompt。出完不看就交，是原地打转的根本原因。',
  { image: '图片路径', shot: '这张原本想拍什么（写一句，模型据此判断跑没跑偏）', model: '视觉模型 id，不填用绑定的那个' },
  { level: '只读' })(async (a, customer) => {
  const I = require('./image')
  const r = resolveUserPath(a.image || a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await I.reviewImage(r.abs, { shot: a.shot, model: a.model })
  return res.ok ? res.report : '❌ ' + res.report
})

// ══════════════════ 渲染 ══════════════════
tool('generate', '把工程渲成片子：draft=预览（落产出/预览，可随便渲）、final=交付成片（落产出/视频）。'
  + '★ final 有硬闸门：工程的分镜必须先经用户审核同意（storyboard action=approve），否则会被拒绝——先分析需求→web_search 调研→storyboard 出分镜→用户同意，再来出片。渲完自动核时长/分辨率/音轨。',
  { project: '工程名', final: '是否交付版（1/0）', noGate: '传 1 跳过渲后闸门（不能跳过分镜审核闸门）' },
  { level: '建议', mutates: 'render' })(async (a) => {
  const R = require('./render')
  const T = require('./timeline')
  const name = String(a.project || '').trim()
  if (!name) return '❌ 给 project'
  let doc
  try { doc = T.load(name) } catch (e) { doc = null }
  const isFinal = String(a.final || '') === '1'

  // ★★ 硬闸门：交付成片必须先有「用户已审核同意」的分镜。
  // AI 绕不过去——这一步在工具内部，不是可有可无的提示词。
  // draft 预览放行（那是给用户审核用的），但 final 交付必须过这一关。
  if (isFinal) {
    const plan = (doc && doc.plan) || {}
    const hasStoryboard = Array.isArray(plan.shots) && plan.shots.length > 0
    if (!hasStoryboard) {
      return '⛔ 不能出成片：工程「' + name + '」还没有分镜文档。\n'
        + '按流程来：① 分析用户需求（给谁看/要什么结果/记住哪句/投在哪）'
        + '② 用 web_search 搜同类视频的文案和钩子 ③ 用 storyboard 写出完整分镜文档'
        + '④ 把分镜给用户看、等用户同意 ⑤ 再用 generate final=1 出片。\n'
        + '（只是想给用户看个粗预览，可以用 generate final=0 出草稿。）'
    }
    if (plan.storyboard_approved !== true) {
      return '⛔ 不能出成片：工程「' + name + '」的分镜还没经用户审核同意。\n'
        + '把分镜文档给用户看过，用户明确同意后，调用 storyboard action=approve project="' + name
        + '" 标记通过，再用 generate final=1 出片。不要用草稿当成片交。'
    }
  }

  const r = await R.renderProject(name, { final: isFinal })
  if (!r.ok) return '❌ 渲染失败：' + r.error

  const head = `✓ 出片：${r.path}\n   ${r.duration.toFixed(2)}s  ${humanSize(r.size)}  ${r.ms}ms`

  // 渲完自动核一遍。不让人自己记得去跑 gate_check —— 忘了核，
  // 一条 3.2 秒的片子照样被当成 30 秒的交付交出去。
  if (String(a.noGate || '') === '1' || !doc) return head
  try {
    const P = require('./plan')
    const plan = doc.plan || P.planFromTimeline(doc)
    const exp = {
      duration: T.tail(doc),
      width: doc.width, height: doc.height,
      needVideo: true,
      // 只有真的插过音频（audio 片段 / 配了画外音 / 视频段要求保留原声）才算「要声音」。
      // 第一版把任何 video 段都算成要声音，于是纯图片+文字的片子永远过不了闸门 ——
      // 它本来就没有声音，报「要声音但没有音轨」是假警报。
      needAudio: Object.values(doc.tracks || {}).some((tr) =>
        (tr.clips || []).some((c) =>
          c.type === 'audio'
          || (c.type === 'video' && c.keepAudio === true)
          || (c.type === 'video' && Number(c.volume) > 0 && c.keepAudio !== false && c.hasAudio === true))),
    }
    let g = await P.gateCheck(r.path, exp)
    /* ★ 闸门报「片尾黑场 / 画面不换」时自动补一次，而不是把问题丢回给 AI。
       这类问题的解法是固定的（定格最后一帧补到片尾），让 AI 自己想它多半会放弃。
       只补黑场这一种，别的问题照实报 —— 自动修「节奏太平」这种就成瞎猜了。 */
    if (!g.ok && (g.picture && g.picture.blackSec >= 1.0)) {
      try {
        const fix = await P.patchTailBlack(r.path)
        if (fix.ok && fix.patched) {
          const g2 = await P.gateCheck(fix.path, exp)
          if (g2.ok) { r.path = fix.path; g = g2; r.patched = fix.note }
        }
      } catch (e) { /* 补失败就按原样报，不掩盖 */ }
    }
    if (g.ok) return head + '\n   ✓ 闸门通过（要看成片整体效果再跑 review）'
    return head + '\n\n✗ 闸门没过（这片子不能当交付）：\n' + g.problems.map((x) => '  · ' + x).join('\n')
  } catch (e) {
    return head + '\n   （闸门没跑起来：' + e.message + '）'
  }
})

tool('render_clip', '把一张图片渲染成 mp4，本机 FFmpeg 出片，返回真实路径和时长，不需要视频模型。',
  { path: '图片路径', dur: '时长秒（默认 3）', width: '宽（默认 1080）', height: '高（默认 1920）', motion: '运镜：推近/拉远/左移/右移' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const R = require('./render')
  const r = resolveUserPath(a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await R.renderClip(r.abs, {
    dur: Number(a.dur) || 3, width: Number(a.width) || 1080,
    height: Number(a.height) || 1920, motion: a.motion,
  })
  return res.ok ? `✓ ${res.path}\n   ${res.duration.toFixed(2)}s  ${humanSize(res.size)}` : '❌ ' + res.error
})

tool('render_status', '渲染环境体检：hyperframes / node / ffmpeg 版本、有没有硬编与 libx264。',
  {}, { level: '只读' })(async () => {
  const R = require('./render')
  const r = await R.ready()
  return r.ok
    ? `✓ 渲染就绪\n  hyperframes ${r.hyperframes}\n  node ${r.node}\n  ffmpeg ${r.ffmpeg}\n  硬件编码 ${r.hardware ? '可用' : '不可用'} · libx264 ${r.libx264 ? '有' : '没有'}`
    : '❌ ' + (r.hint || '渲染环境不完整')
})

module.exports.REGISTRY = REGISTRY

// ══════════════════ 音频 ══════════════════
tool('voice', '口播配音：把一段文字用本机 TTS 念出来，返回音频路径与真实时长。',
  { text: '要念的文字', voice: '音色名（留空=默认中文女声）', rate: '语速（默认 175）', out: '输出文件名（留空自动）' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const A = require('./audio')
  const text = String(a.text || '').trim()
  if (!text) return '❌ 给 text'
  const r = await A.tts(text, { voice: a.voice, rate: Number(a.rate) || undefined })
  return r.ok ? `✓ 配音 ${r.path}\n   ${r.duration.toFixed(2)}s · 响度 ${JSON.stringify(r.loud || {})}` : '❌ ' + r.error
})

tool('words', '这段话念出来几秒 / 这么长的片子能写多少字。写稿和排时长之前先算一遍，别猜。',
  { text: '要算的文字', seconds: '或者反给秒数，算能写多少字', voice: '音色（影响语速）' },
  { level: '只读' })(async (a) => {
  const A = require('./audio')
  const s = String(a.seconds || '').trim()
  if (s) {
    const sec = Number(s) || 0
    // 中文口播 4.6 字/秒是实测中位数（新闻稿 5.2、口播 4.2）
    return `${sec} 秒大约能写 ${Math.round(sec * 4.6)} 字（口播 4.6 字/秒）。舒缓一点按 4.0 算 = ${Math.round(sec * 4.0)} 字，赶一点按 5.2 算 = ${Math.round(sec * 5.2)} 字。`
  }
  const text = String(a.text || '').trim()
  if (!text) return '❌ 给 text 或 seconds'
  const n = text.replace(/\s/g, '').length
  return `${n} 字，念出来约 ${(n / 4.6).toFixed(1)} 秒（按 4.6 字/秒）。`
})

tool('add_voiceover', '把文字念出来并混进成片音轨，输出新 mp4，画面不重编码。',
  { video: '成片路径', text: '要念的文字', voice: '音色', volume: '音量（默认 1.0）' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const A = require('./audio')
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await A.addVoiceover(r.abs, String(a.text || ''), { voice: a.voice, volume: Number(a.volume) || 1 })
  return res.ok ? `✓ ${res.path}` : '❌ ' + res.error
})

tool('add_music', '给 mp4 配背景音乐，生成新文件、不覆盖原片。没音乐文件时现场合成三和弦铺底。',
  { video: '成片路径', music: '音乐文件（留空=现场合成）', mood: '情绪：轻快/大气/温和', volume: '音量（默认 0.35）' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const A = require('./audio')
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await A.addMusic(r.abs, { music: a.music, mood: a.mood, volume: Number(a.volume) || 0.35 })
  return res.ok ? `✓ ${res.path}\n   ${res.duration ? res.duration.toFixed(2) + 's' : ''}` : '❌ ' + res.error
})

tool('sound_fx', '现场合成撞击、whoosh、上升音、心跳这些点音效，不下载任何素材包。',
  { kind: 'whoosh | impact | rise | heartbeat', dur: '时长秒' },
  { level: '建议', mutates: 'render' })(async (a) => {
  const A = require('./audio')
  const r = await A.soundFx(String(a.kind || 'whoosh'), Number(a.dur) || 0.6)
  return r.ok ? `✓ ${r.path}` : '❌ ' + r.error
})

tool('music_bpm', '测一段音乐的 BPM 和第 1 拍位置，再给出切点方案。',
  { path: '音乐文件路径' },
  { level: '只读' })(async (a, customer) => {
  const A = require('./audio')
  const r = resolveUserPath(a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await A.bpm(r.abs)
  return res.ok ? `BPM ${res.bpm.toFixed(1)} | 首拍 ${res.offset.toFixed(2)}s\n切点：${res.beats.slice(0, 20).map(x => x.toFixed(2)).join(', ')}…` : '❌ ' + res.error
})

tool('tighten', '剪掉口播里的废话：长停顿压到 0.3 秒、孤立的口癖（嗯/呃/啊）剪掉。出片前对配音跑一遍，片子立刻干净一半。',
  { path: '配音文件路径' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const A = require('./audio')
  const r = resolveUserPath(a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await A.tighten(r.abs)
  return res.ok ? `✓ ${res.path}\n   原 ${res.before.toFixed(2)}s → 现 ${res.after.toFixed(2)}s（省 ${(res.before - res.after).toFixed(2)}s，剪了 ${res.cuts} 处）` : '❌ ' + res.error
})

// ══════════════════ 字幕 ══════════════════
tool('subtitle', '逐句字幕：把片子里的说话声切成一句一句，每句识别出文字并带上真实时间，生成 .srt / .ass。',
  { path: '视频或音频路径', preset: '字幕预设：标准/大字/弹字/竖屏/标题/卡片/竖屏卡片/卡拉OK/钩子字/编辑字', to: 'srt | ass（默认 ass）', keywords: '要高亮的词，逗号分隔', width: '画布宽', height: '画布高' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const S = require('./subtitle')
  const r = resolveUserPath(a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  const to = String(a.to || 'ass')
  const info = await require('./exec').probe(r.abs)
  if (!info || !info.ok) return '❌ 读不出这条素材的参数'
  // ★ 走 buildCues(片子路径) 而不是自己拿 speechSegments 再拼 ——
  //   speechSegments 只给 [起,止] 时间，没有文字；文字必须过 ASR，
  //   拼行、断句、停留时长、句间空隙的算法都在 subtitleFromSpeech 里。
  const cues = await S.buildCues(r.abs, { maxChars: Number(a.maxChars) || undefined })
  if (!cues.length) return '❌ 这条片子听不出人声（只有配乐？）。要字幕就自己写文案，走 subtitle_style 直接排。'
  const out = to === 'srt'
    ? S.writeSrt(cues, {})
    : S.srtToAss(null, { preset: a.preset, width: Number(a.width) || info.width, height: Number(a.height) || info.height, keywords: a.keywords, cues })
  return `✓ 切出 ${cues.length} 句 → ${out.path || out}\n` + cues.slice(0, 8).map(c => `  ${c.start.toFixed(2)}–${c.end.toFixed(2)}  ${c.text}`).join('\n')
})

tool('add_caption', '把文字或一个 .srt/.ass 字幕文件烧进成片画面，真重新编码出一个新 mp4。',
  { video: '成片路径', srt: '字幕文件路径', text: '或者直接给一句话（会生成一条全程字幕）', preset: '字幕预设' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const S = require('./subtitle')
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  let srtPath = ''
  if (a.srt) {
    const sr = resolveUserPath(a.srt, customer)
    if (!sr.ok) return '❌ ' + sr.error
    srtPath = sr.abs
  } else if (a.text) {
    const info = await require('./exec').probe(r.abs)
    srtPath = S.simpleSrt(String(a.text), (info && info.duration) || 3)
  } else return '❌ 给 srt 或 text'
  const res = await S.burnCaption(r.abs, { srt: srtPath, preset: a.preset })
  return res.ok ? `✓ ${res.path}\n   ${humanSize(res.size)}` : '❌ ' + res.error
})

tool('text_style', '文字样式表：剪辑台里那 46 款成品文字样式的清单（id + 中文名 + 是否需要副色）。' +
  '\n什么时候用：要给视频加文字/标题，先调这个看有哪些款，再 edit_timeline addtext 带 tstyle=选中的 id。' +
  '\n★ 不要自己拼 CSS 塞 color 就当样式 —— 渐变、中空、霓虹、印章这些全靠整套声明串，一个 color 拼不出来。',
  { name: '按名字模糊查，如「渐变」「中空」「毛玻璃」，不填列全部' },
  { level: '读' })(async (a) => {
  const lib = require('../ui/src/textstyles')
  const q = String(a.name || '').trim()
  const all = lib.list()
  const hit = q ? all.filter(x => x.name.indexOf(q) >= 0 || x.id.indexOf(q) >= 0) : all
  if (!hit.length) return `❌ 没有匹配「${q}」的样式。全部 ${all.length} 款可以不带参数直接列。`
  const rows = hit.map(x => `${x.id || '(空)'}  ${x.name}${x.two ? '  [需副色]' : ''}`)
  return clip(`共 ${hit.length} 款文字样式（共 ${all.length} 款）：\n` + rows.join('\n') +
    `\n\n用法：edit_timeline action=addtext text=标题 tstyle=gold c2=#FF5E7E anim=charIn`)
})

tool('subtitle_style', '把 .srt 变成带样式的 .ass（短视频那种大字、关键词变色、弹字进场），不烧进画面。',
  { srt: 'srt 文件路径', preset: '字幕预设', keywords: '要高亮的词', width: '画布宽', height: '画布高' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const S = require('./subtitle')
  const r = resolveUserPath(a.srt, customer)
  if (!r.ok) return '❌ ' + r.error
  const out = S.srtToAss(r.abs, { preset: a.preset, keywords: a.keywords, width: Number(a.width), height: Number(a.height) })
  return `✓ ${out.path || out}`
})

// ══════════════════ 只读目录（形状 / 布局 / 风格） ══════════════════
tool('reveals', '【形状揭示】让画面从一块形状里长出来或收回去。短视频片头片尾最见效果的一招，不需要任何素材。从代码注册表实时读，有哪几种、怎么写都在这里。',
  { kind: '留空=全部；也可填 圆 / 方 / 条 / 斜 筛选' }, { level: '只读' })(async (a) => require('./catalog').revealsText(a.kind))

tool('layouts', '【多画面写法】一个镜头里放两个画面：画中画、分屏。从代码注册表实时读，能叠在哪个位置、分屏有哪几种比例都在这里。',
  { kind: '留空=全部；也可填 画中画 / 分屏' }, { level: '只读' })(async (a) => require('./catalog').layoutsText(a.kind))

tool('style', '【风格预设】一条片子的整体气质：调色+字幕+运镜+转场拧成一套。选一个名字写进方案的 style 字段，出片时这一整套自动落到每个分镜上，不用一段段手动写。',
  { name: '风格名，留空列出全部' }, { level: '只读' })(async (a) => require('./catalog').styleText(a.name))

tool('plan_format', '出片方案的完整字段说明。写方案前先看这个 —— 字段漏了引擎会直接报错，写错了不会报错但会被静默忽略。',
  {}, { level: '只读' })(async () => {
  return `【出片方案 plan 的字段】
{
  "title": "片子标题",
  "width": 1080, "height": 1920, "fps": 30,
  "style": "电影感",              // 可选，见 style 工具
  "voice": {                       // 可选，画外音
    "text": "全片要念的话",         // 一句话一口气念完，不要分段
    "voice": "Ting-Ting", "rate": 175
  },
  "shots": [
    {
      "no": 1,                      // 第几镜，从 1 开始
      "asset": "图片或视频的文件名",   // 必填
      "duration": 2.5,              // 必填，1.5~3.5 秒最常见
      "start": 0,                   // 视频从第几秒开始取
      "caption": "这一镜屏幕上的字",  // 可选
      "transition": "叠化",          // 这一镜「怎么进来的」，第 1 镜写了也没用
      "speed": 1.0,                 // 变速
      "zoom": [0.55,0.1,0.4,0.3],   // 聚焦某一块，比例坐标
      "layout": "左右分屏",          // 分屏（见 layouts）
      "inset": {"asset":"副素材","position":"右下","scale":0.32},
      "reveal": "圆形",              // 形状揭示（见 reveals）
      "volume": 1.0, "keepAudio": false
    }
  ]
}

【最容易漏的三处】
1. asset 只写文件名不够，得是素材库里真实存在的名字 —— 先用 assets 查。
2. duration 一定要写。不写会按 3 秒算，全片节奏就是「每镜三秒」的机械感。
3. transition 第一镜没有意义（它前面没有东西），引擎会忽略。

写完用 plan_check 体检：段长合计、转场吃掉多少、成片到底多长，一次报给你。`
})

// ══════════════════ 剪辑台状态 / 想一想 ══════════════════
tool('editor', '【剪辑台要看的东西】剪辑界面需要的状态一次给全：工程列表、当前工程的轨道、可用的字体和音色、各目录的真实路径。AI 要动剪辑台之前先用它对齐「现在是什么状态」。',
  { project: '要看哪个工程，不填就看最近改过的那个' },
  { level: '只读' })(async (a, customer) => {
  const T2 = require('./timeline')
  const A = require('./audio')
  const Sub = require('./subtitle')
  const S = require('./skills')
  const cust = customer
  const P2 = C.custPaths(cust)
  const list = T2.listProjects ? T2.listProjects() : []
  const name = String(a.project || '').trim() || (list[0] && (list[0].name || list[0].id)) || ''
  const L = ['【剪辑台状态】', `客户：${cust} · 授权档：${C.levelOf(cust)}（${C.scopeOf(cust)}）`, '']
  L.push(`工程：${list.length} 个`)
  L.push(`产出目录：${P2.videos}`)
  L.push(`图片：${P2.images}`)
  L.push(`配音：${P2.voice}`)
  L.push(`预览：${P2.previews}`)
  L.push('')
  // ★ systemVoices() 返回的是对象不是数组：{good:[{name,locale}], ...}
  //   按 Array.isArray 判会拿到空，界面上就会显示「0 个音色」。
  let voices = []
  try {
    const v = await A.systemVoices()
    const all = Array.isArray(v) ? v : Object.values(v || {}).flat()
    voices = all.filter((x) => /中文|Chinese|zh/i.test(String((x && x.name) || x)))
  } catch {}
  L.push(`可从系统直接用的中文音色：${voices.length} 个${voices.length ? '（' + voices.slice(0, 8).map((x) => x.name || x).join('、') + '）' : ''}`)
  L.push(`字幕预设：${Object.keys(Sub.SUB_PRESETS || {}).length} 档（${Object.keys(Sub.SUB_PRESETS || {}).slice(0, 6).join('、')}…）`)
  try {
    // ★ skills.js 导出的名字是 listSkills，没有 list
    const sk = S.listSkills ? S.listSkills() : []
    L.push(`导演技能：${Array.isArray(sk) ? sk.length : 0} 条`)
  } catch {}
  if (name) {
    try {
      const doc = T2.load(name)
      const tr = (doc.tracks || []).map((t) => `${t.id || t.name} ${(t.clips || []).length} 段`).join(' · ')
      L.push('', `当前工程「${name}」：${doc.width}×${doc.height}@${doc.fps || 30} · 总长 ${T2.tail(doc).toFixed(2)} 秒`, `轨道：${tr}`)
    } catch (e) { L.push('', `⚠ 工程「${name}」读不出来：${String(e.message || e).slice(0, 100)}`) }
  }
  return L.join('\n')
})

tool('think', '【先想清楚再动手】把一段判断落到纸面上，避免边做边改。适合动手前用：这条片子要什么、先做哪一步、哪一步风险最大、失败了回退到哪。不是给人看的报告，是给下一轮自己看的备忘。',
  { about: '要想清楚的问题（必填）', depth: 'brief 一句话 / normal 常规（默认）/ deep 把反对意见也写出来' },
  { level: '只读' })(async (a) => {
  const about = String(a.about || '').trim()
  if (!about) return '❌ 要给 about（要想清楚什么）。'
  const depth = String(a.depth || 'normal').toLowerCase()
  const L = ['【想一想】' + about, '']
  L.push('先把这三件事分开，别混在一起想：')
  L.push('  1) 已知的事实 —— 能量出来的（文件在不在、多长、什么规格）')
  L.push('  2) 我的判断 —— 基于事实推的（这样剪会不会太慢、这个开头够不够抓人）')
  L.push('  3) 我还不知道的 —— 猜也猜不准的（用户到底想要什么调性）')
  L.push('')
  L.push('第 3 类不要编答案。要么去量，要么直接问用户，二选一。')
  if (depth === 'deep') {
    L.push('', '再往下想一层：')
    L.push('  · 如果我判断错了，最坏会怎样？（片子废了可以重出；素材删了没法恢复）')
    L.push('  · 有没有更省事的做法？（先出一版 5 秒的看方向，别一上来做 30 秒）')
    L.push('  · 反过来想：什么证据会让我改主意？')
  }
  L.push('', '想完就去调工具，别把这段分析当成交付内容发给用户。')
  return L.join('\n')
})

// ══════════════════ 对外接口 ══════════════════
tool('openapi', '【把能力开成 HTTP 接口】让别的软件（剪映插件、脚本、另一个 AI）也能用这些能力。默认只绑 127.0.0.1、默认关着、写操作默认只出提案。status 看状态，set 改配置，apply 立即生效，rotate 换密钥，docs 拿 OpenAPI 描述。',
  { action: 'status（默认）/ set / apply / rotate / docs', enabled: 'set 用：true/false 开关', host: 'set 用：绑哪个地址，默认 127.0.0.1。改成 0.0.0.0 会让同一局域网的人也能调',
    port: 'set 用：端口，默认 8787', auto_approve: 'set 用：true 时写操作也直接执行（默认 false，只出提案）', note: 'set 用：备注' },
  { level: '完全托管', danger: ('set', 'rotate') })(async (a) => {
  const O = require('./openapi')
  const act = String(a.action || 'status').toLowerCase()

  if (act === 'set') {
    const kw = {}
    for (const k of ['enabled', 'host', 'port', 'auto_approve', 'note']) {
      if (a[k] !== undefined && a[k] !== '') kw[k] = a[k]
    }
    if ('enabled' in kw) kw.enabled = !/^(false|0|no|off)$/i.test(String(kw.enabled))
    if ('auto_approve' in kw) kw.auto_approve = !/^(false|0|no|off)$/i.test(String(kw.auto_approve))
    const d = O.setConfig(kw)
    const L = ['✅ 配置改好了：', `  开关 ${d.enabled ? '开' : '关'} · 地址 ${d.host}:${d.port} · 写操作 ${d.auto_approve ? '直接执行' : '只出提案'}`]
    L.push('', '要立刻生效就跑 action=apply。')
    if (d.host === '0.0.0.0') L.push('', '⚠ 绑了 0.0.0.0：同一个 WiFi / 局域网里的人都能调这些能力，包括读写你的文件。')
    return L.join('\n')
  }
  if (act === 'apply') {
    const st = await O.applyNow()
    if (st && st.error) return '❌ 起不来：' + st.error
    return st.running ? `✅ 已经在 http://${st.host}:${st.port}/v1 跑着` : '已停掉。'
  }
  if (act === 'rotate') {
    const d = O.rotateKey()
    return `✅ 换了新密钥：${d.key}\n\n注意：之前拿到旧密钥的软件要重新配一次，否则调不通。`
  }
  if (act === 'docs') {
    const sp = O.spec(O.config())
    return `【OpenAPI 描述】${Object.keys(sp.paths).length} 个路径\n\n` + JSON.stringify(sp, null, 2).slice(0, 6000)
  }
  const st = O.status()
  const d = O.config()
  return [
    '【对外开放接口】', 
    `状态：${st.running ? '跑着' : '没起'}${st.enabled ? '（配置为开，重启后自动起）' : '（配置为关）'}`,
    st.running ? `地址：${st.url}` : `想让别人调就 set enabled=true 再 apply`,
    `绑定：${st.host}:${st.want_port}${st.host === '0.0.0.0' ? '  ⚠ 局域网可见' : '（只有本机能连）'}`,
    `写操作：${st.auto_approve ? '直接执行' : '只出提案，等人点'}`,
    `密钥：${d.key}`,
    '',
    '别的软件这样调：',
    `  curl -H "Authorization: Bearer ${d.key}" http://${st.host}:${st.want_port}/v1/health`,
    `  curl -H "Authorization: Bearer ${d.key}" http://${st.host}:${st.want_port}/v1/tools`,
    `  curl -X POST -H "Authorization: Bearer ${d.key}" -H "Content-Type: application/json" \\`,
    `       -d '{"name":"templates","args":{"cat":"片头片尾"}}' http://${st.host}:${st.want_port}/v1/call`,
  ].join('\n')
})

// ══════════════════ 换开头 / 高光 ══════════════════
tool('swap_hook', '【只换开头做 A/B】一条片子已经能转化时，唯一该动的是开头。这个工具把新开头接到主体前面，主体一个字节都不重编码 —— 两个变量只有开头不同，A/B 测出来的差异才是开头的功劳。做完会自证主体没动过（逐像素比 PSNR）。',
  { main: '原成片路径（必填）', hook: '新开头路径（必填）—— 还没做就先生成一个两三秒的小片子当它',
    seconds: '要替换掉原片开头多少秒；不填就用新开头的时长', out: '输出路径，不填就在原片旁边加「_新开头」', crf: '新开头的画质，默认 18（越小越好）' },
  { level: '完全托管', mutates: 'render' })(async (a, customer) => {
  const fs = require('node:fs')
  const M = require('./media')
  const Hk = require('./hook')
  const find = (v) => {
    const byName = M.findByName(v, customer)
    if (byName && fs.existsSync(byName)) return byName
    const r = resolveUserPath(v, customer)
    if (r.ok && fs.existsSync(r.abs)) return r.abs
    return byName || v
  }
  if (!a.main || !a.hook) return '❌ 要两条路径：main 是原成片，hook 是新开头。新开头还没做就先出一个小片子（两三秒）当它。'
  const t0 = Date.now()
  const r = await Hk.swapHook(find(a.main), find(a.hook), {
    hookSeconds: a.seconds, out: a.out ? find(a.out) : '', crf: a.crf,
  })
  const L = [`✅ 开头换好了（${Date.now() - t0}ms）`, `成片：${r.path}`, `${r.duration ? r.duration.toFixed(2) : '?'} 秒 · 替换掉原片前 ${r.replaced.toFixed(2)} 秒`]
  r.notes.forEach((n) => L.push('· ' + n))
  L.push('', '这条片子和原片只差开头，可以直接拿去做 A/B。')
  return L.join('\n')
})

tool('highlight', '【从长片里挑高光】量声音能量曲线，挑出最值得留的几段（人激动的时候能量高）。开会、口播、访谈这类画面几乎不动的片子，声音是唯一可靠的信号。action=probe 看曲线统计，pick 挑前几段，cut 真的切出来。',
  { action: 'pick（默认，挑高光）/ probe（只报曲线统计）/ cut（切出指定段）', video: '长片路径（必填）',
    n: 'pick 要几段，默认 3', start: 'cut 用：从第几秒开始', dur: 'cut 用：切几秒',
    sensitivity: '灵敏度，0.3 挑得多 / 0.6 只挑最炸的，默认 0.45', out: 'cut 用：输出路径' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const fs = require('node:fs')
  const M = require('./media')
  const H = require('./highlight')
  const find = (v) => {
    const byName = M.findByName(v, customer)
    if (byName && fs.existsSync(byName)) return byName
    const r = resolveUserPath(v, customer)
    if (r.ok && fs.existsSync(r.abs)) return r.abs
    return byName || v
  }
  const v = find(a.video)
  if (!fs.existsSync(v)) return '❌ 找不到：' + a.video
  const act = String(a.action || 'pick').toLowerCase()

  if (act === 'probe') {
    const c = await H.curve(v)
    if (!c.ok) return '❌ ' + c.error
    const dbs = c.points.map((p) => p.db)
    const A = require('./audio')
    return [`【能量曲线】${c.count} 个点 · 每 ${c.step} 秒一个 · 全片 ${c.duration.toFixed(1)} 秒`,
      `最高 ${Math.max(...dbs)} dB · 最低 ${Math.min(...dbs)} dB · 中位 ${[...dbs].sort((x, y) => x - y)[Math.floor(dbs.length / 2)]} dB`].join('\n')
  }

  if (act === 'cut') {
    if (a.start == null || !a.dur) return '❌ cut 要给 start（从第几秒）和 dur（切几秒）。'
    const out = a.out ? find(a.out) : require('node:path').join(C.custPaths(customer).previews, '高光-' + P.stamp() + '.mp4')
    const r = await H.cut(v, out, a.start, a.dur, {})
    if (!r.ok) return '❌ 切失败：' + r.error
    return `✅ 切出来了：${r.path}\n${r.probe.duration.toFixed(2)} 秒 · ${r.probe.width}×${r.probe.height} · ${(r.probe.size / 1024 / 1024).toFixed(1)}MB`
  }

  const r = await H.pick(v, { n: a.n, sensitivity: a.sensitivity })
  return H.briefText(r)
})

// ══════════════════ 量参考片 ══════════════════
tool('study', '【量一条参考片】用户说「照这条剪」时先跑它：量出镜头多长、每 10 秒切几次、调色（亮度/对比/饱和/冷暖）、响度、语速、节拍，出一份能对着做的目标表。量出来的是数字，不是「感觉剪得快一点」。给了 compare 就量两条并对比。',
  { video: '参考片路径（必填）', compare: '另一条片子路径（可选，给了就对比两条，比值 0.7~1.3 算对上）' },
  { level: '只读' })(async (a, customer) => {
  const fs = require('node:fs')
  const S = require('./study')
  const M = require('./media')
  // ★ 不能只靠 resolveUserPath：给一个裸文件名时它会拼成 <HOME>/文件名，
  //   而这个路径确实在可访问范围内（HOME 就是根），于是 ok=true 返回一个
  //   不存在的文件 —— 症状是「文件不存在」但文件名明明是对的。
  //   所以先按名字找，找到真文件才算。
  const find = (v) => {
    const byName = M.findByName(v, customer)
    if (byName && fs.existsSync(byName)) return byName
    const r = resolveUserPath(v, customer)
    if (r.ok && fs.existsSync(r.abs)) return r.abs
    return byName || v
  }
  if (a.compare) {
    const r = await S.compare(find(a.video), find(a.compare))
    return r.ok ? r.text : '❌ ' + r.error
  }
  if (!a.video) return '❌ 要给 video（参考片路径）。'
  const r = await S.studyReference(find(a.video))
  return r.report || ('❌ ' + (r.notes || []).join('；'))
})

// ══════════════════ 公开素材 ══════════════════
tool('stock_search', '【去网上找画面】给一句话，从公开素材库里找有商用许可的视频/图片，告诉你标题、尺寸、许可、来源页。没有素材也想剪片时先用它看有什么可用。只用 CC0 / CC BY / 公有领域，署名原作者即可商用。',
  { query: '要找什么画面，写具体的东西：城市夜景 / 海浪拍礁 / 森林航拍。别写抽象词',
    kind: 'video 或 image，默认 video', limit: '要几条，默认 8' },
  { level: '只读' })(async (a) => {
  const S = require('./stock')
  return S.searchText(a.query || a.q, a.kind || 'video', a.limit)
})

tool('stock_fetch', '【把网上的画面拿下来】按关键词去公开素材库抓片段，转成能直接剪的 mp4 存进素材库，同时记下作者与许可。没素材也能出片的关键一步：先把画面弄到手，再排分镜。',
  { queries: '一组关键词，逗号分隔：城市夜景, 海浪, 森林航拍', per: '每个关键词要几条，默认 1',
    seconds: '每条取几秒，默认 2.5', width: '输出宽，默认 1920', height: '输出高，默认 1080' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const S = require('./stock')
  const r = await S.fetchToLibrary(a.queries || a.query, {
    per: a.per, seconds: a.seconds, width: a.width, height: a.height,
  }, customer)
  if (!r.ok) {
    const why = (r.failed || []).slice(0, 3).map((x) => `${x.query}「${String(x.title || '').slice(0, 30)}」${x.error || ''}`).join('；')
    return '❌ 一条都没拿到。' + (why ? '\n   ' + why : '可能是关键词太抽象，或者网络不通。')
  }
  const L = [`✅ 拿到 ${r.got.length} 段，已存进素材库：`]
  for (const g of r.got) {
    L.push(`- ${require('node:path').basename(g.path)}  ${g.width}×${g.height}  起点 ${g.from}s  〔${g.license} · ${g.artist || '作者未署'}〕`)
  }
  L.push(`\n作者与许可已记进：${r.creditFile}`)
  if (r.failed && r.failed.length) L.push(`另有 ${r.failed.length} 条没拿到（素材源不稳定，不是你的问题）`)
  L.push('\n下一步：用 assets 查真实文件名，再 edit_timeline 排进工程。')
  return L.join('\n')
})

// ══════════════════ 对话记录 ══════════════════
tool('conversations', '看历次对话：谁说了什么、AI 回了什么、调了哪些工具。读的是内核真实会话（不是另存一份），能把「上次那个片子是怎么做的」翻出来。',
  { action: 'list（默认，列清单）/ get（读一条全文，要给 id）', id: '会话 id，list 里能看到（get 用）', limit: 'list 最多几条，默认 40' },
  { level: '只读' })(async (a) => {
  const S = require('./sessions')
  const act = String(a.action || 'list').toLowerCase()
  if (act === 'get') {
    if (!a.id) return '❌ get 要给 id。'
    return S.detailText(a.id)
  }
  return S.listText()
})

// ══════════════════ 出片前综合审 / 成片体检 ══════════════════
tool('film_check', '【创作体检】出片前把方案整体审一遍：镜头是不是太长、有没有转场、有没有音效、调色统不统一、文案够不够、开场能不能抓人。不合格会说清哪条不过、怎么改。',
  { data: '整份方案（JSON 字符串或对象），就是你准备交给 generate 的那份', project: '工程名（不给 data 就用工程的）', mode: 'video（默认，推广片/口播）/ promo（纯广告）' },
  { level: '只读' })(async (a, customer) => {
  const Plan = require('./plan')
  const T2 = require('./timeline')
  let doc = a.data
  if (typeof doc === 'string') { try { doc = JSON.parse(doc) } catch { return '❌ data 不是合法 JSON' } }
  if (!doc && a.project) { const d = T2.load(a.project); doc = d.plan || Plan.planFromTimeline(d) }
  if (!doc || !Array.isArray(doc.shots)) return '❌ 要给 data（含 shots）或 project'
  const promo = String(a.mode || 'video').toLowerCase() === 'promo'
  const shots = doc.shots
  const durs = shots.map((x) => Number(x.duration) || 3)
  const ck = Plan.planCheck(doc)
  const bad = []

  const long = durs.map((d, i) => ({ i, d })).filter((x) => x.d > (promo ? 2.5 : 3.5))
  if (long.length) bad.push(`${long.length} 个镜头超长（${promo ? '2.5' : '3.5'} 秒以上）：第 ${long.map((x) => x.i + 1).join('、')} 镜 —— 单镜超过这个长度观众就走神了，拆成两镜或多给一个机位`)

  const noTrans = shots.filter((x, i) => i > 0 && !String(x.transition || '').trim()).length
  if (noTrans > shots.length * 0.5) bad.push(`${noTrans} 个接点没有转场 —— 全是硬切。硬切不是错，但连续硬切会显得粗糙`)

  const hasSfx = shots.some((x) => x.sfx || x.sound)
  if (!hasSfx && !promo) bad.push('一个音效都没写。纯口播片可以没有；有画面的片子没音效会显得没做完')

  const styles = new Set(shots.map((x) => String(x.look || x.color || '')).filter(Boolean))
  if (styles.size > 2) bad.push(`调色用了 ${styles.size} 种（${[...styles].join('/')}）—— 一条片子超过两种调色会散`)

  const copy = String(ck.copy_len || 0) || shots.map((x) => String(x.caption || '').length).reduce((x, y) => x + y, 0)
  const perSec = ck.real_duration > 0 ? copy / ck.real_duration : 0
  if (perSec < 1.2) bad.push(`文案密度只有 ${perSec.toFixed(1)} 字/秒，低于 1.2 —— 观众来不及读完，等于白写`)
  if (perSec > 6) bad.push(`文案密度 ${perSec.toFixed(1)} 字/秒，超过 6 —— 读字幕会变成赶工`)

  const hook = Plan.hookScore(shots[0] && (shots[0].caption || shots[0].copy) || '')
  if (hook.score < Plan.HOOK_MIN_SCORE) bad.push(`开场只有 ${hook.score}/10，不到 ${Plan.HOOK_MIN_SCORE} 分 —— 前 3 秒决定完播率：${hook.why || '要么没下注、要么在清嗓子'}`)

  const gap = ck.gap
  if (Math.abs(gap) > 1.5) bad.push(`照这份方案渲出来是 ${ck.real_duration.toFixed(1)} 秒，比目标 ${ck.target} 秒差 ${gap.toFixed(1)} 秒`)

  const L = [`【创作体检】${shots.length} 镜 · ${ck.real_duration.toFixed(1)} 秒 · 文案 ${perSec.toFixed(1)} 字/秒 · 开场 ${hook.score}/10`]
  if (!bad.length) L.push('', '✅ 六项都过。可以出片了。')
  else {
    L.push('', `⚠ ${bad.length} 条不过：`)
    bad.forEach((x, i) => L.push(`  ${i + 1}. ${x}`))
  }
  return L.join('\n')
})

tool('gate', '【成片体检】量一条成片逐项报过/不过：时长、分辨率、有没有音轨、黑场、死帧、响度。交片前自查，用户说「看着卡」「接缝有杂音」「声音忽大忽小」时用它。只报事实，不替你决定要不要重做。'
  + 'action=selftest 不查片子，改查「门禁自己还灵不灵」。',
  { video: '成片路径（不填就找这个客户最近出的那条）', expected: '方案里的预期时长（秒），填了就比对偏差',
    srt: '字幕文件路径（可选，给了才查字幕出框）', cuts: '切点秒数，逗号分隔；不填就不测爆音',
    action: '留空=查片子；selftest=门禁自检' },
  { level: '只读' })(async (a, customer) => {
  const fs = require('node:fs')
  const E = require('./exec')
  const act = String(a.action || '').toLowerCase()
  if (act === 'selftest') {
    const R = require('./rhythm')
    const s2 = R.selftest()
    return ['【门禁自检】卡拍判据' + (s2.ok ? '全部通过' : '有失灵')].concat(s2.cases.map((c) => `  ${c.pass ? '✅' : '❌'} ${c.name}`)).join('\n')
  }
  let v = String(a.video || '').trim()
  if (!v) { v = newestVideo(customer); if (!v) return '没有可查的成片：先出一次片，或者把 video 填上。' }
  const r0 = resolveUserPath(v, customer)
  const file = r0.ok ? r0.abs : (require('./media').findByName(v, customer) || v)
  if (!fs.existsSync(file)) return '❌ 这个成片文件不在了：' + v

  const m = await E.probe(file)
  const exp = Number(a.expected) || 0
  const problems = [], okLines = []
  const chk = (cond, good, bad) => { if (cond) okLines.push(good); else problems.push(bad) }

  chk(m.width > 0 && m.height > 0, `分辨率 ${m.width}×${m.height}`, '读不出有效分辨率')
  chk(m.width % 2 === 0 && m.height % 2 === 0, '尺寸是偶数（yuv420p 硬要求）', `尺寸 ${m.width}×${m.height} 有奇数边，编码会花屏`)
  const dur = m.duration || 0
  chk(dur > 0.5, `时长 ${dur.toFixed(2)} 秒`, `时长只有 ${dur.toFixed(2)} 秒`)
  if (exp > 0) {
    const diff = Math.abs(dur - exp)
    chk(diff <= Math.max(1, exp * 0.15), `时长与方案一致（差 ${diff.toFixed(2)} 秒）`, `时长与方案差 ${diff.toFixed(2)} 秒（方案 ${exp} 秒，成片 ${dur.toFixed(2)} 秒）`)
  }

  // 黑场：整片扫黑帧
  const black = await E.run(P.FFMPEG, ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.35:pix_th=0.10', '-f', 'null', '-'], { timeout: 300_000 })
  const blacks = (String(black.stderr || '').match(/black_start:[\d.]+/g) || []).length
  chk(blacks === 0, '没有黑场段落', `有 ${blacks} 段黑场（0.35 秒以上），观众会以为卡了`)

  // 死帧 / 内容空转。两笔账都要算，因为 freezedetect 单独不可靠。
  //
  // ★ freezedetect=n=-60dB 只认「像素几乎完全相同」。屏幕录制里缓慢压暗、
  //   呼吸感的各种细微变化都过不了这个门坎 —— 实测那条 30 秒片子后 20 秒
  //   画面几乎不动，freezedetect 却报「没有静止画面」。它查的是「完全冻死」，
  //   不是「没内容」，两个不是一回事。
  const frozen = await E.run(P.FFMPEG, ['-hide_banner', '-i', file, '-vf', 'freezedetect=n=-60dB:d=1.2', '-f', 'null', '-'], { timeout: 300_000 })
  const freezes = (String(frozen.stderr || '').match(/freeze_start:/g) || []).length
  chk(freezes === 0, '没有完全冻死的画面', `有 ${freezes} 段画面冻住超过 1.2 秒 —— 这是编码问题或者素材本身是张静止图`)

  // 真正的判据：全片换了多少次画面。
  //
  // ★ 取数方式踩过坑：`select='gt(scene,X)',showinfo` 在 ffmpeg 6.0 上
  //   stderr 里既不出现 `pts_time:` 也不出现 `scene_score`，永远返回 0 次
  //   —— 看起来像「片子完全没变化」，其实是没取到数。
  //   正确的是 `select='gt(scene,X)',metadata=print`，它会打
  //   `[Parsed_metadata_1 @ ...] lavfi.scene_score=0.149907`。
  //
  // 阈值 0.12：0.25 太钝（实测那条内容确实没变的片子，最高 score 才 0.15），
  // 0.05 又太敏感（缓慢压暗也会触发，那不是新镜头）。
  const scene = await E.run(P.FFMPEG, ['-hide_banner', '-i', file,
    '-vf', "select='gt(scene,0.12)',metadata=print", '-an', '-f', 'null', '-'], { timeout: 300_000 })
  const scores = (String(scene.stderr || '').match(/lavfi\.scene_score=[\d.]+/g) || [])
  const cuts = scores.length
  const per10 = dur > 0 ? (cuts / dur) * 10 : 0
  // 门槛：每 10 秒至少换 1 次画面。低于这个，平均每个画面停 10 秒以上，
  // 观众早就走神了。真人拍的片子（哪怕一镜到底）也会因为人在动、
  // 光在变而轻松超过；只有「一张截图停在屏幕上」会卡在这条线下。
  chk(per10 >= 1, `画面换了 ${cuts} 次（每 10 秒 ${per10.toFixed(1)} 次）`,
    `全片只换了 ${cuts} 次画面（${dur.toFixed(0)} 秒 / 每 10 秒 ${per10.toFixed(1)} 次）—— `
    + '平均每个画面停 ' + (cuts > 0 ? (dur / cuts).toFixed(1) : dur.toFixed(0)) + ' 秒，'
    + '观众会觉得片子卡了或者内容空。要么加镜头，要么把这段压短。')

  // 响度
  if (m.hasAudio) {
    const A2 = require('./audio')
    const l = await A2.measureLoud(file)
    if (l && l.lufs) {
      chk(l.lufs >= -18 && l.lufs <= -10, `响度 ${l.lufs} LUFS（平台正常区间 -14±4）`, `响度 ${l.lufs} LUFS 偏离 -14 太多（${l.lufs < -18 ? '太小，手机外放听不清' : '太大，会触发平台压限'}）`)
    }
  } else {
    problems.push('整片没有音轨（纯画面片可以忽略这条）')
  }

  const L = [`【成片体检】${require('node:path').basename(file)}`]
  for (const x of okLines) L.push('  ✅ ' + x)
  for (const x of problems) L.push('  ❌ ' + x)
  L.push('', problems.length ? `⚠ ${problems.length} 项不过。` : '✅ 全部通过，可以交片。')
  return L.join('\n')
})

// ══════════════════ 半成品与实验 ══════════════════
tool('make_slideshow', '【半成品工具】把一批图片按固定节奏串成 mp4 —— 这是素材搬运，不是做片。直接交出去就是幻灯片（一张图停几秒缓慢推近再硬切）。'
  + '正式做片走 generate（写 plan.shots，每镜 1.5–3.5 秒 + 转场 + 音效 + 调色）。用这个只适合：快速看素材、给用户看个粗排、或者补一段过场。',
  { dir: '图片所在文件夹（必填）', seconds_each: '每张停留秒数，默认 3', max: '最多用几张，默认 6',
    motion: 'kenburns / none，默认 kenburns', fps: '输出帧率，默认 30', aspect: '9:16 / 16:9 / 1:1 / 3:4，或 1080x1920' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const E = require('./exec')
  const dir = String(a.dir || a.path || '').trim()
  if (!dir || !fs.existsSync(dir)) return '❌ 要给 dir：图片所在的文件夹。'
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp'])
  const pics = fs.readdirSync(dir).map((x) => path.join(dir, x))
    .filter((x) => fs.statSync(x).isFile() && exts.has(path.extname(x).toLowerCase())).sort()
    .slice(0, Math.max(1, Number(a.max) || 6))
  if (!pics.length) return '❌ 这个文件夹里没有图片：' + dir

  const spec = String(a.aspect || '9:16')
  const dims = /^\d+x\d+$/.test(spec) ? spec.split('x').map(Number)
    : spec === '16:9' ? [1920, 1080] : spec === '1:1' ? [1080, 1080] : spec === '3:4' ? [1080, 1440] : [1080, 1920]
  const each = Math.max(0.5, Number(a.seconds_each) || 3)
  const fps = Math.max(1, Number(a.fps) || 30)
  const out = path.join(C.custPaths(customer).videos, '幻灯片-' + P.stamp() + '.mp4')

  const args = []
  for (const f of pics) args.push('-loop', '1', '-t', String(each), '-i', f)
  const filters = pics.map((_, i) => {
    let vf = `[${i}:v]scale=${dims[0]}:${dims[1]}:force_original_aspect_ratio=increase,crop=${dims[0]}:${dims[1]},setsar=1,fps=${fps}`
    if (String(a.motion || 'kenburns') !== 'none') {
      vf += `,zoompan=z='min(1.12,1+0.0009*on)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(each * fps)}:s=${dims[0]}x${dims[1]}:fps=${fps}`
    }
    return vf + `[v${i}]`
  })
  const n = pics.length
  let last = 'v0'
  let xf = ''
  for (let i = 1; i < n; i++) {
    const tag = i === n - 1 ? 'vout' : 'x' + i
    xf += `[${last}][v${i}]xfade=transition=fade:duration=0.4:offset=${(each - 0.4) * i}[${tag}];`
    last = tag
  }
  const filter = filters.join(';') + (n > 1 ? ';' + xf.replace(/;$/, '') : '') + (n === 1 ? ';[v0]null[vout]' : '')
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args,
    '-filter_complex', filter, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 1_800_000 })
  if (!r.ok || !fs.existsSync(out)) return '❌ 串片失败：' + String(r.stderr || '').slice(0, 200)
  const m = await E.probe(out)
  require('./core').history('串幻灯片', `${pics.length} 张 · ${(m.duration || 0).toFixed(1)} 秒`)
  return `⚠ 这是素材搬运，不是做片。\n✓ ${pics.length} 张串成 ${(m.duration || 0).toFixed(2)} 秒：${out}\n   ${dims[0]}x${dims[1]} @ ${fps}fps · ${(fs.statSync(out).size / 1048576).toFixed(1)}MB\n正式做片请用 generate 写 plan.shots（每镜 1.5–3.5 秒 + 转场 + 音效 + 调色）。`
})

tool('experiment', '实验片清单：看历次实验片、把某条标成「就这版」。list 列清单 / confirm 定版。',
  { action: 'list | confirm（默认 list）', index: 'confirm 用：清单里的序号，不给就标最新一条', file: 'confirm 用：文件名（和 index 二选一）', why: 'confirm 用：为什么定这版' },
  { level: '建议', mutates: 'write' })(async (a, customer) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(P.HOME, '配置', '实验片.json')
  let db = { items: [] }
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const items = Array.isArray(db.items) ? db.items : []
  const act = String(a.action || 'list').toLowerCase()

  if (act === 'confirm') {
    if (!items.length) return '❌ 还没有实验片记录。先出几条片再来定版。'
    let i = Number(a.index) - 1
    if (!Number.isFinite(i) || i < 0 || i >= items.length) {
      if (a.file) i = items.findIndex((x) => String(x.file || '').includes(String(a.file)))
      if (!Number.isFinite(i) || i < 0 || i >= items.length) i = items.length - 1
    }
    items[i].confirmed = true
    items[i].why = String(a.why || '').trim()
    items[i].confirmedAt = new Date().toISOString().slice(0, 16).replace('T', ' ')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8')
    return `✓ 定了第 ${i + 1} 条：${items[i].file}\n   ${items[i].why ? '理由：' + items[i].why : '（没写理由）'}`
  }

  if (!items.length) {
    const vids = fs.existsSync(C.custPaths(customer).previews) ? fs.readdirSync(C.custPaths(customer).previews).filter((x) => /\.mp4$/i.test(x)) : []
    if (!vids.length) return '还没有实验片。先出几条片。'
    for (const v of vids.slice(-10)) items.push({ file: v, at: '' })
  }
  return [`【实验片清单】${items.length} 条：`].concat(items.map((x, i) =>
    `  ${i + 1}. ${x.confirmed ? '★ ' : '  '}${x.file}${x.why ? '  「' + x.why + '」' : ''}`)).concat(['', '定版就把 index 传给 action=confirm。']).join('\n')
})

// ══════════════════ 角色卡 ══════════════════
tool('characters', '【角色卡】同一个人要多镜头出现时先把长相定一次。定完出图写名字即自动接上，不会漏个特征就换人。save 要一百字以上。',
  { action: 'list | save | delete（默认 list）', name: '角色名', look: '长相（save 用）：年龄、脸型、发型发色、眼睛、肤色、体型、常穿什么、疤痣', alias: '别名，逗号分开' },
  { level: '建议', mutates: 'write' })(async (a) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(P.HOME, '配置', '角色卡.json')
  let db = { items: {} }
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  if (!db.items || typeof db.items !== 'object') db.items = {}
  const act = String(a.action || 'list').toLowerCase()
  const name = String(a.name || '').trim()

  if (act === 'save') {
    const look = String(a.look || '').trim()
    if (!name) return '❌ 要给 name。'
    if (look.length < 100) {
      return `❌ 长相描述只有 ${look.length} 字，不到一百字。写少了模型每次都会补不同的细节 —— 上次是圆脸这次是方脸，就是这里省了事。\n   要写：年龄、脸型、发型发色、眼睛、肤色、体型、常穿什么、疤痣。`
    }
    const alias = String(a.alias || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)
    db.items[name] = { look, alias, updated: new Date().toISOString().slice(0, 16).replace('T', ' ') }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8')
    return `✓ 记下角色「${name}」（${look.length} 字${alias.length ? '，别名 ' + alias.join('/') : ''}）。出图时在 prompt 里写这个名字就会自动接上。`
  }
  if (act === 'delete') {
    if (!db.items[name]) return '❌ 没有这个角色：' + name
    delete db.items[name]
    fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8')
    return '✓ 删了角色「' + name + '」'
  }
  const keys = Object.keys(db.items)
  if (!keys.length) return '还没有角色卡。要同一个人多镜头出现时，用 action=save 先把长相定一次。'
  return [`【角色卡】${keys.length} 个：`].concat(keys.map((k) =>
    `  · ${k}${db.items[k].alias && db.items[k].alias.length ? '（又名 ' + db.items[k].alias.join('/') + '）' : ''}\n    ${db.items[k].look.slice(0, 100)}…`)).join('\n')
})

// ══════════════════ 记录与合规 ══════════════════
tool('insights', '记录：执行历史、费用、用量、老版质检、卡点。用户问「花了多少」「都做过什么」「上次那条片怎么剪的」时用。',
  { action: 'history | costs | usage | beats（默认 history）', path: 'beats 用：文件路径', since: 'today | 24h | 7d | 30d（usage/costs 用）', limit: '最多几条，默认 20' },
  { level: '只读' })(async (a) => {
  const C2 = require('./core')
  const act = String(a.action || 'history').toLowerCase()
  const lim = Math.max(1, Math.min(200, Number(a.limit) || 20))
  if (act === 'costs' || act === 'usage') {
    const t = C2.usageTotals()
    const rec = C2.usageRecent(lim)
    const L = [`【用量与费用】累计调用 ${t.calls || 0} 次，输入 ${t.in || 0} tokens，输出 ${t.out || 0} tokens`]
    if (t.cost) L.push(`累计费用 ${Number(t.cost).toFixed(2)} 元`)
    if (rec && rec.length) {
      L.push('', `最近 ${rec.length} 次：`)
      for (const r of rec) L.push(`  · ${r.at || r.ts || ''}  ${r.model || ''}  入${r.in || 0} 出${r.out || 0}`)
    }
    return L.join('\n')
  }
  if (act === 'beats') {
    const R = require('./rhythm')
    const raw = String(a.path || '').trim()
    if (!raw) return 'beats 要给 path：音乐或视频文件。'
    const r = await R.beatAlignment(raw)
    return r.weak ? '测不出节拍：' + (r.reason || '') : `${require('node:path').basename(raw)}：约 ${r.bpm} BPM，每拍 ${(60 / r.bpm).toFixed(3)} 秒`
  }
  const h = C2.history ? require('./paths').load('history', { items: [] }) : { items: [] }
  const items = (h.items || []).slice(-lim).reverse()
  if (!items.length) return '还没有任何执行记录。'
  return [`【执行历史】共 ${(h.items || []).length} 条，最近 ${items.length} 条：`]
    .concat(items.map((x) => `  · ${x.at || ''}  ${x.action || ''}  ${String(x.detail || '').slice(0, 70)}`)).join('\n')
})

// ══════════════════ 分析 ══════════════════
tool('analytics', '发布归因：发出去之后哪条真的有效。样本少于 3 条不下结论 —— 三条以下的差异是噪声，不是规律。',
  { action: 'report | by_time | by_tags | by_format | growth | update（默认 report）', platform: '只算某个平台，留空算全部',
    title: 'update 用：作品标题', data: 'update 用：数据 JSON，如 {"播放":1200,"点赞":38}', top: 'by_tags 返回前几个，默认 8' },
  { level: '只读' })(async (a) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const file = path.join(P.HOME, '配置', '发布数据.json')
  let db = { items: [] }
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  const items = Array.isArray(db.items) ? db.items : []
  const act = String(a.action || 'report').toLowerCase()

  if (act === 'update') {
    let d = a.data
    if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return '❌ data 不是合法 JSON' } }
    if (!d || typeof d !== 'object') return '❌ update 要给 data，例如 {"播放":1200,"点赞":38}'
    const title = String(a.title || '').trim()
    if (!title) return '❌ update 要给 title（按标题匹配记录）'
    const i = items.findIndex((x) => String(x.title || '') === title)
    const rec = { title, platform: a.platform || '', at: new Date().toISOString().slice(0, 16).replace('T', ' '), ...d }
    if (i >= 0) items[i] = { ...items[i], ...rec }
    else items.push(rec)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8')
    return `✓ 回填了「${title}」${i >= 0 ? '（更新已有记录）' : '（新建记录）'}，库里现在 ${items.length} 条。`
  }

  let pool = items
  if (a.platform) pool = pool.filter((x) => String(x.platform || '').toLowerCase().includes(String(a.platform).toLowerCase()))
  if (pool.length < 3) {
    return `样本只有 ${pool.length} 条，不到 3 条不下结论 —— 三条以下的差异是噪声，不是规律。先用 update 回填几条真实数据。`
  }
  const num = (x, k) => Number(x[k]) || 0
  const avg = (arr, k) => arr.length ? arr.reduce((s2, x) => s2 + num(x, k), 0) / arr.length : 0

  if (act === 'by_time') {
    const by = new Map()
    for (const x of pool) {
      const h = String(x.at || '').slice(11, 13)
      if (!h) continue
      if (!by.has(h)) by.set(h, [])
      by.get(h).push(x)
    }
    const rows = [...by.entries()].map(([h, arr]) => ({ h, n: arr.length, v: avg(arr, '播放') })).sort((x, y) => y.v - x.v)
    return ['【什么时段发最好】按平均播放排：'].concat(rows.map((r) => `  ${r.h}:00  ${Math.round(r.v)} 播放（${r.n} 条）`)).join('\n')
  }
  if (act === 'by_tags') {
    const by = new Map()
    for (const x of pool) {
      for (const t of String(x.tags || '').split(/[,，#\s]+/).filter(Boolean)) {
        if (!by.has(t)) by.set(t, [])
        by.get(t).push(x)
      }
    }
    const rows = [...by.entries()].map(([t, arr]) => ({ t, n: arr.length, v: avg(arr, '播放') })).sort((x, y) => y.v - x.v).slice(0, Math.max(1, Number(a.top) || 8))
    return ['【哪些话题带量】按平均播放排：'].concat(rows.map((r) => `  ${r.t}  ${Math.round(r.v)} 播放（${r.n} 条）`)).join('\n')
  }
  if (act === 'by_format') {
    const by = new Map()
    for (const x of pool) {
      const f = String(x.format || x.类型 || '未标注')
      if (!by.has(f)) by.set(f, [])
      by.get(f).push(x)
    }
    const rows = [...by.entries()].map(([f, arr]) => ({ f, n: arr.length, v: avg(arr, '播放') })).sort((x, y) => y.v - x.v)
    return ['【哪个形态好】按平均播放排：'].concat(rows.map((r) => `  ${r.f}  ${Math.round(r.v)} 播放（${r.n} 条）`)).join('\n')
  }
  if (act === 'growth') {
    const sorted = pool.slice().sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')))
    const first = avg(sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3))), '播放')
    const last = avg(sorted.slice(-Math.max(1, Math.ceil(sorted.length / 3))), '播放')
    const ratio = first > 0 ? last / first : 0
    return `【涨得多快】前段平均 ${Math.round(first)} 播放 → 后段平均 ${Math.round(last)} 播放，${ratio >= 1 ? '涨了' : '降了'} ${Math.abs((ratio - 1) * 100).toFixed(0)}%（${pool.length} 条样本）`
  }
  const total = pool.reduce((s2, x) => s2 + num(x, '播放'), 0)
  const likes = pool.reduce((s2, x) => s2 + num(x, '点赞'), 0)
  return [`【发布归因总览】${pool.length} 条` +
    `\n总播放 ${total} · 总点赞 ${likes} · 平均播放 ${Math.round(avg(pool, '播放'))}` +
    `\n平均完播率 ${(avg(pool, '完播率') || 0).toFixed(1)}% · 平均点赞率 ${total ? ((likes / total) * 100).toFixed(2) : 0}%` +
    '\n要看细的：by_time / by_tags / by_format / growth'].join('\n')
})

// ══════════════════ 素材整理 ══════════════════
tool('copy', '复制素材到别处（比如把挑好的镜头收到 精选/）。源文件不动。',
  { paths: '源文件路径数组，JSON 或逗号分隔', to: '目标文件夹' },
  { level: '可整理', mutates: 'write' })(async (a, customer) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const list = Array.isArray(a.paths) ? a.paths : String(a.paths || '').replace(/，/g, ',').split(',').map((x) => x.trim()).filter(Boolean)
  if (!list.length) return '❌ 要给 paths。'
  const t = resolveUserPath(a.to || '', customer, true)
  if (!t.ok) return '❌ 目标目录：' + t.error
  const C2 = require('./core')
  const dest = path.isAbsolute(String(a.to || '')) ? String(a.to) : C2.custPaths(customer).images + '/' + String(a.to || '').replace(/^\/+/, '')
  fs.mkdirSync(dest, { recursive: true })
  const done = [], miss = []
  for (const x of list) {
    const r = resolveUserPath(x, customer)
    const src = r.ok ? r.abs : require('./media').findByName(x, customer)
    if (!src || !fs.existsSync(src)) { miss.push(x); continue }
    const out = path.join(dest, path.basename(src))
    fs.copyFileSync(src, out)
    done.push(path.basename(src))
  }
  return [`✓ 复制了 ${done.length} 个到 ${dest}`].concat(done.map((x) => '  · ' + x))
    .concat(miss.length ? ['', `❌ 这 ${miss.length} 个找不到：`].concat(miss.map((x) => '  · ' + x)) : []).join('\n')
})

tool('move', '移动素材（整理文件夹用）。原文件会留一份备份在 缓存/移动备份/。',
  { paths: '源文件路径数组', to: '目标文件夹' },
  { level: '可整理', mutates: 'write' })(async (a, customer) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const list = Array.isArray(a.paths) ? a.paths : String(a.paths || '').replace(/，/g, ',').split(',').map((x) => x.trim()).filter(Boolean)
  if (!list.length) return '❌ 要给 paths。'
  const base = resolveUserPath(a.to || '', customer, true)
  if (!base.ok) return '❌ 目标目录：' + base.error
  const dest = path.join(base.abs)
  fs.mkdirSync(dest, { recursive: true })
  const backup = path.join(P.HOME, '缓存', '移动备份')
  fs.mkdirSync(backup, { recursive: true })
  const done = [], miss = []
  for (const x of list) {
    const r = resolveUserPath(x, customer)
    const src = r.ok ? r.abs : require('./media').findByName(x, customer)
    if (!src || !fs.existsSync(src)) { miss.push(x); continue }
    const name = path.basename(src)
    fs.copyFileSync(src, path.join(backup, P.stamp() + '-' + name))
    fs.renameSync(src, path.join(dest, name))
    done.push(name)
  }
  return [`✓ 移动了 ${done.length} 个到 ${dest}（备份在 ${backup}）`].concat(done.map((x) => '  · ' + x))
    .concat(miss.length ? ['', `❌ 这 ${miss.length} 个找不到：`].concat(miss.map((x) => '  · ' + x)) : []).join('\n')
})

// ══════════════════ 语音识别 ══════════════════
tool('transcribe_media', '【真能力·自动字幕】把视频里说的话转成文字并生成 .srt 字幕文件。优先读内嵌字幕轨（人写的，最准），没有才用本机离线识别（SenseVoice，不出本机）。',
  { video: '成片路径（必填；写错或留空会自动用最近一次出的片）' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const A = require('./asr')
  const path = require('node:path')
  let v = String(a.video || '').trim()
  if (!v) {
    const latest = newestVideo(customer)
    if (!latest) return '❌ 要给 video：还没有任何成片可以转写。'
    v = latest
  }
  const r = resolveUserPath(v, customer)
  const file = r.ok ? r.abs : (require('./media').findByName(v, customer) || v)
  const t = await A.transcribe(file)
  if (!t.ok) return '❌ ' + t.error
  return `✅ 已把视频里的话转成字幕：\n字幕文件：${t.path}\n识别来源：${t.source}${t.emotion ? '｜情绪 ' + t.emotion : ''}\n内容：\n${t.text.slice(0, 1200)}\n下一步：调 add_caption（srt 填上面这个路径）把字幕烧进画面。`
})

tool('subtitle_burn', '【逐句字幕】把片子里的说话声切成一句一句、每句带真实时间，生成能直接烧进画面的 .srt。跟 transcribe_media 的区别：那个给一整段文案，这个给每句一句、时间对得上的字幕。',
  { video: '成片路径（必填）', maxChars: '每句最多几个字，默认 18', pause: '停顿超过几秒算换句，默认 0.35' },
  { level: '建议', mutates: 'render' })(async (a, customer) => {
  const A = require('./asr')
  let v = String(a.video || '').trim()
  if (!v) return '❌ 要给 video。'
  const r = resolveUserPath(v, customer)
  const file = r.ok ? r.abs : (require('./media').findByName(v, customer) || v)
  const t = await A.sentences(file, { maxChars: a.maxChars, pause: a.pause })
  if (!t.ok) return '❌ ' + t.error
  if (!t.cues || !t.cues.length) return (t.note || '切不出句子') + '\n原文：' + String(t.text || '').slice(0, 400)
  const L = [`✅ 切成 ${t.cues.length} 句，字幕文件：${t.path}`, `来源：${t.source}`, '']
  for (const c of t.cues.slice(0, 30)) L.push(`${c.start.toFixed(2)}~${c.end.toFixed(2)}  ${c.text}`)
  if (t.cues.length > 30) L.push(`…还有 ${t.cues.length - 30} 句`)
  L.push('', '下一步：调 add_caption（srt 填上面这个路径）把字幕烧进画面。')
  return L.join('\n')
})

tool('rhythm', '【卡拍】测音乐/视频的 BPM，再量「已经排好的切点踩没踩上拍」。只报事实，不替你改方案。action=selftest 不碰片子，纯数值确认这两笔账没退化成永远 pass。',
  { path: '音乐或视频文件。测 BPM 靠听节拍，没有音频的片子测不出来',
    action: '留空=只测 BPM；check=量切点；selftest=纯数值自检',
    cuts: 'action=check 时给切点秒数，逗号分隔，例如 0.5,1,1.5,2',
    tol: '容差秒数，默认 0.08', fps: '帧率，默认 30' },
  { level: '只读' })(async (a, customer) => {
  const R = require('./rhythm')
  const act = String(a.action || 'detect').toLowerCase()
  if (act === 'selftest') {
    const s = R.selftest()
    return ['【卡拍自检】' + (s.ok ? '全部通过' : '有判据失灵')].concat(s.cases.map((c) => `  ${c.pass ? '✅' : '❌'} ${c.name}`))
      .concat(s.ok ? [] : ['先修这两笔账，别拿它们去判片子。']).join('\n')
  }
  const raw = String(a.path || a.music || a.video || '').trim()
  if (!raw) return '要给 path：音乐或视频文件。测 BPM 靠听节拍，没有音频的片子测不出来。（只跑自检就用 action=selftest。）'
  const r0 = resolveUserPath(raw, customer)
  const file = r0.ok ? r0.abs : (require('./media').findByName(raw, customer) || raw)
  const fs = require('node:fs')
  if (!fs.existsSync(file)) return '这个文件不存在：' + raw

  if (act === 'check') {
    const cuts = String(a.cuts || '').replace(/，/g, ',').split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x))
    if (!cuts.length) return 'action=check 要给 cuts：把已有的切点秒数用逗号列出来，例如 0.5,1,1.5,2。它量的是这一版到底踩没踩上，不是帮你重新排切点。'
    const al = await R.beatAlignment(file, { cuts, tol: Number(a.tol) || 0.08, fps: Number(a.fps) || 30 })
    if (al.weak) return `【切点卡拍】${require('node:path').basename(file)}：${al.reason || '测不出节拍'}`
    return [`【切点卡拍】${require('node:path').basename(file)}：约 ${al.bpm} BPM（置信 ${al.confidence}），每拍 ${(60 / al.bpm).toFixed(3)} 秒`,
      `${al.cuts} 个切点里 ${al.hits} 个落在 ±${Number(a.tol) || 0.08} 秒内（${(al.hit_rate * 100).toFixed(0)}%），随机命中率约 ${(al.random_rate * 100).toFixed(0)}%`,
      `判定：${al.follows ? '✅ 这一版是卡着拍子剪的' : '— 这一版没按拍子剪（也没说必须卡拍）'}`,
      `中位偏差 ${al.median_dist.toFixed(3)} 秒 · 平均每 ${al.beats_per_cut || '?'} 拍切一次`].join('\n')
  }

  const d = await R.detectBpm(file)
  if (!d.bpm) return `【测 BPM】${require('node:path').basename(file)}：测不出节拍。可能里面没有稳定节奏，或者压根没有音轨。`
  return `【测 BPM】${require('node:path').basename(file)}\n约 ${d.bpm} BPM（置信 ${d.confidence}），每拍 ${(60 / d.bpm).toFixed(3)} 秒，第 1 拍在 ${d.offset} 秒\n要量切点就加 action=check 并把 cuts 传进来。`
})

// ══════════════════ 知识库 ══════════════════
tool('kb_search', '搜知识库：客户偏好、项目经验、剪辑技法、素材库、品牌模板、软件排障。找东西之前先搜这里，别凭记忆猜。',
  { query: '搜索词', limit: '最多几条，默认 8' }, { level: '只读' })(async (a) => {
  const K = require('./kb')
  return K.searchText(a.query || a.q, a.limit)
})

/* ══════════════ 联网搜索：无素材创作必须先用它调研文案/钩子 ══════════════
   后端 api.js 的 websearch() 只返回「结果条数」，AI 拿不到标题和摘要，
   没法判断「这类视频别人怎么开头、用什么钩子」。这里返回真内容。 */
tool('web_search', '【联网搜文案和钩子】查某类视频/话题别人怎么做：爆款开头、文案套路、钩子写法、观众关心什么。无素材创作必须先用它调研，不许凭空编。返回真实标题+摘要+来源。',
  { query: '搜索词。例：「工业设备 短视频 开头 钩子」「口腔诊所 宣传片 文案」', limit: '最多几条，默认 8' },
  { level: '只读' })(async (a) => {
  const q = String(a.query || a.q || '').trim()
  if (!q) return '❌ 要给搜索词 query。'
  const lim = Math.max(1, Math.min(15, Number(a.limit) || 8))
  /* ★ 2026-11-22：源从 DuckDuckGo HTML 换成 Bing。
     DDG 在这台机器上 fetch 一直超时（curl -m 15 也 timeout，HTTP 000），
     而 Bing 实测 HTTP 200、能解析出 10 条真结果。两源的 HTML 结构不同，
     Bing 是 <li class="b_algo"> 包 <h2><a href>标题</a></h2> + <p class="b_lineclamp*">摘要</p>。
     保留 DDG 作兜底：Bing 解析不出结果时再试一次 DDG。 */
  const decode = (s) => String(s || '')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;|&ensp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim()
  const parseBing = (html) => {
    const items = []
    for (const b of html.split(/<li class="b_algo"/).slice(1)) {
      const tm = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
      if (!tm) continue
      const sm = b.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      const title = decode(tm[2])
      if (title) items.push({ title, url: decode(tm[1]), snippet: decode(sm && sm[1]) })
      if (items.length >= lim) break
    }
    return items
  }
  const parseDdg = (html) => {
    const items = []
    for (const b of html.split(/class="result results_links/).slice(1)) {
      const tm = b.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
      const sm = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
      if (!tm) continue
      let url = decode(tm[1])
      const um = url.match(/uddg=([^&]+)/)
      if (um) { try { url = decodeURIComponent(um[1]) } catch (e) {} }
      const title = decode(tm[2])
      if (title) items.push({ title, url, snippet: decode(sm && sm[1]) })
      if (items.length >= lim) break
    }
    return items
  }
  const sources = [
    { name: 'Bing', url: 'https://www.bing.com/search?q=' + encodeURIComponent(q), parse: parseBing },
    { name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), parse: parseDdg },
  ]
  const errors = []
  for (const src of sources) {
    try {
      const r = await globalThis.fetch(src.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      })
      const html = await r.text()
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const items = src.parse(html)
      if (items.length) {
        return `联网搜「${q}」（${src.name}）→ ${items.length} 条：\n` + items.map((x, i) =>
          `${i + 1}. ${x.title}\n   ${x.snippet || '（无摘要）'}\n   来源：${x.url}`).join('\n')
      }
      errors.push(src.name + ': 没解析出结果')
    } catch (e) { errors.push(src.name + ': ' + String(e.message || e)) }
  }
  return '（联网搜索失败：' + errors.join('；') + '。如实告诉用户没查到，不要编造搜索结果。）'
})

/* ══════════════ 分镜文档：无素材创作的核心产物 ══════════════
   流程：分析需求 → web_search 调研文案/钩子 → storyboard 出完整分镜 →
   用户审核点同意 → generate final 才放行。这一环把分镜落成文件，
   并把可渲染的 shots 存进工程，让「分镜」和「成片」是同一份东西。 */
tool('storyboard', '【出完整分镜文档】做无素材/新片前，先分析需求、用 web_search 调研同类视频的文案和钩子，再把逐镜分镜写进来。每镜要写清：画面内容、时长、屏幕字幕、怎么转场、动画效果、用哪句文案。写完落成分镜文档给用户审核，用户同意后才能出成片。',
  { project: '工程名（必填）。新建的话给个名字', title: '片子标题',
    requirement: '需求分析：给谁看、要什么结果、记住哪句、投在哪、有无禁说',
    research: 'web_search 调研到的同类视频开头/文案/钩子要点（如实写，没查到就说没查到）',
    hook: '开头 1.5 秒的钩子（一句话）', script: '文案骨架（PAS/AIDA/BAB，逐句）',
    shots: '分镜数组 JSON 字符串。每镜至少含 asset(画面/模板名或图片路径)、duration(秒)、scene(画面描述)、caption(字幕)、transition(转场)、effect(动画效果)。没有素材可用模板名或纯代码动画描述',
    width: '宽，默认 1080', height: '高，默认 1920' },
  { level: '建议', mutates: 'write', danger: [] })(async (a, customer) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const T = require('./timeline')

  // action=approve：用户审核分镜后点同意，才把闸门打开。
  // 只有这一处能把 storyboard_approved 置 true；AI 出片前 generate 会校验它。
  const action = String(a.action || '').trim()
  if (action === 'approve') {
    const nm = String(a.project || a.title || '').trim()
    if (!nm) return '❌ approve 要给工程名 project。'
    let d
    try { d = T.load(nm) } catch (e) { return '❌ 没有这个工程的分镜：' + e.message }
    if (!d.plan || !Array.isArray(d.plan.shots) || !d.plan.shots.length) {
      return '❌ 这个工程还没有分镜，不能同意。先用 storyboard 出分镜。'
    }
    d.plan.storyboard_approved = true
    d.plan.storyboard_status = 'approved'
    d.plan.storyboard_approved_at = new Date().toISOString()
    T.save(nm, d)
    const md = path.join(T.projDir(nm), 'storyboard.md')
    try {
      if (fs.existsSync(md)) {
        let txt = fs.readFileSync(md, 'utf8')
        txt = txt.replace('状态：**待你审核**', '状态：**已同意 ✓**')
        fs.writeFileSync(md, txt, 'utf8')
      }
    } catch (e) {}
    return `✓ 工程「${nm}」的分镜已通过审核（${d.plan.shots.length} 镜）。现在可以用 generate final=1 出成片了。`
  }

  const name = String(a.project || a.title || '').trim()
  if (!name) return '❌ 要给工程名 project。'
  // 解析分镜
  let shots = []
  if (a.shots) {
    try {
      const v = typeof a.shots === 'string' ? JSON.parse(a.shots) : a.shots
      shots = Array.isArray(v) ? v : (Array.isArray(v.shots) ? v.shots : [])
    } catch (e) { return '❌ shots 不是合法 JSON：' + e.message }
  }
  if (!shots.length) return '❌ shots 是空的。至少要有一镜；每镜写清画面 asset、duration、scene、caption、transition、effect。'

  // 存工程：把分镜写进 timeline，标记「待审核」
  const w = Number(a.width) || 1080, h = Number(a.height) || 1920
  let doc
  try { doc = T.load(name) } catch (e) { doc = T.blank(name, w, h, 30, 0) }
  doc.plan = Object.assign({}, doc.plan || {}, {
    title: String(a.title || name),
    requirement: String(a.requirement || ''),
    research: String(a.research || ''),
    hook: String(a.hook || ''),
    script: String(a.script || ''),
    shots: shots,
    storyboard_status: 'pending',   // 待用户审核
    storyboard_approved: false,
    storyboard_at: new Date().toISOString(),
  })
  doc.width = w; doc.height = h
  T.save(name, doc)

  // 落 markdown 分镜文档，方便用户直接看、直接改
  const dir = T.projDir(name)
  const mdPath = path.join(dir, 'storyboard.md')
  const L = ['# 分镜文档 · ' + String(a.title || name), '']
  L.push('> ' + new Date().toLocaleString('zh-CN') + ' · 共 ' + shots.length + ' 镜 · 状态：**待你审核**', '')
  if (a.requirement) L.push('## 一、需求分析\n\n' + a.requirement + '\n')
  if (a.research) L.push('## 二、同类视频调研（联网）\n\n' + a.research + '\n')
  if (a.hook) L.push('## 三、开头钩子（1.5 秒）\n\n' + a.hook + '\n')
  if (a.script) L.push('## 四、文案骨架\n\n' + a.script + '\n')
  L.push('## 五、逐镜分镜\n')
  shots.forEach(function (s, i) {
    L.push('### 第 ' + (i + 1) + ' 镜 · ' + (Number(s.duration) || 0) + ' 秒')
    L.push('- **画面**：' + (s.scene || s.asset || '—'))
    L.push('- **字幕**：' + (s.caption || '—'))
    L.push('- **转场**：' + (s.transition || '硬切'))
    L.push('- **动画效果**：' + (s.effect || '—'))
    if (s.asset) L.push('- **素材/模板**：' + s.asset)
    L.push('')
  })
  L.push('---\n', '你看完这份分镜，觉得可以了，回复「同意，开始生成」；要改哪一镜直接说，我改完再给你看。')
  try { fs.writeFileSync(mdPath, L.join('\n'), 'utf8') } catch (e) { return '❌ 分镜文档写盘失败：' + e.message }

  const total = shots.reduce((s, x) => s + (Number(x.duration) || 0), 0)
  return `✓ 分镜文档已生成（${shots.length} 镜，约 ${total.toFixed(1)} 秒），等你审核：\n   ${mdPath}\n\n` +
    shots.map((s, i) => `${i + 1}. [${(Number(s.duration) || 0)}s] ${s.scene || s.asset || '画面'} ｜字幕：${s.caption || '—'} ｜转场：${s.transition || '硬切'} ｜动画：${s.effect || '—'}`).join('\n') +
    `\n\n请让用户检查这份分镜。用户同意后，用 storyboard action=approve 标记通过，再用 generate final=1 出成片。`
})

tool('note', '把这次学到的可复用知识记进知识库（带结构的一篇，不是一句话）。标题高度相似会自动改成更新，不会长出重复条目。只在真学到东西时用，别记流水账。',
  { title: '一句话标题（必填）', body: '正文。踩坑类写「现象 → 根因 → 修复 → 验证」，规则类写「规则 → 依据 → 怎么判断违反」',
    category: '01-客户偏好 / 02-项目经验 / 03-剪辑技法 / 04-素材与素材库 / 05-品牌与模板 / 06-软件问题排查',
    tags: '标签，逗号分隔（最多 5 个）' },
  { level: '建议', mutates: 'self' })(async (a, customer) => {
  const K = require('./kb')
  const r = K.add({ title: a.title, body: a.body, category: a.category, tags: a.tags, customer, source: 'AI' })
  if (!r.ok) return '❌ ' + r.error
  return `${r.updated ? '已更新' : '已记下'}：${r.id} ${r.title}（${r.category}）`
})

// ══════════════════ 自我进化（经验库） ══════════════════
tool('self_note', '把一条可复用的判断记进经验库（一句话，不超过 600 字）。下一轮开工会自动按任务挑相关的几条加载。'
  + '只在真的学到可复用的东西时用，别记流水账。说「做不到」时必须带上你查过的工具名或文件路径，否则会被拦下来。',
  { text: '一句话判断（必填）。例：出片前必须跑 plan_check，段长和转场对不上会渲出 3 秒的片子',
    tags: '标签，逗号分隔', slug: '要替换已有条目的 slug（可选，用来改写而不是新增长一条）' },
  { level: '建议', mutates: 'self' })(async (a) => {
  const M = require('./memory')
  const text = String(a.text || a.content || a.note || '').trim()
  if (!text) return '❌ 要记什么？text 是空的。'
  const tags = String(a.tags || '').split(/[,，\s]+/).filter(Boolean)
  const r = M.add(text, tags, a.slug || a.replace)
  if (!r.ok) return '❌ ' + r.error
  return `✓ 记下了：${r.slug}${r.replaced ? '（改写了原来那条）' : ''}`
    + (r.verified ? `\n   已验证能被选中，库里现在 ${r.total} 条。` : `\n   ${r.warning}`)
})

tool('self_forget', '删掉经验库里记错的一条。记错了要能自己纠正，不能只能长胖。',
  { slug: 'slug 或那句话里的关键词' }, { level: '建议', mutates: 'self' })(async (a) => {
  const M = require('./memory')
  const r = M.forget(a.slug || a.key || a.text)
  if (!r.ok) return '❌ ' + r.error
  return `✓ 删了：${r.slug}\n   原内容是「${r.deleted}」\n   库里还剩 ${r.total} 条。`
})

tool('self_rules', '读回我沉淀的全部经验（开工时只自动加载相关的几条，这个看全部）—— 复查、找矛盾、找记错的。',
  { keyword: '只看含这个词的条目' }, { level: '只读' })(async (a) => {
  const M = require('./memory')
  const kw = String(a.keyword || '').trim()
  let ents = M.allEntries()
  if (kw) ents = ents.filter((e) => e.text.includes(kw) || e.slug.includes(kw))
  const st = M.stats()
  const lines = [`【我的经验库】共 ${st.count} 条，目录 ${st.dir}`, '（用 self_note 记新的 / self_forget 删错的）', '']
  if (!ents.length) lines.push(kw ? `（没有含「${kw}」的条目）` : '（没有条目）')
  for (const e of ents) lines.push(`- [${e.slug}] ${e.text}`)
  return lines.join('\n')
})

tool('self_inspect', '只读自己的源码/配置。白名单：app/lib、app/main.js、home/配置。看自己是怎么实现的、某条规则写在哪。',
  { path: '相对路径，例：lib/plan.js 或 配置/导演技能/xxx.md', keyword: '只返回命中关键词的行' },
  { level: '只读' })(async (a) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const roots = [path.join(P.ROOT, 'app'), P.HOME, path.join(P.ROOT, 'tools')]
  let rel = String(a.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return '❌ 要看哪个文件？path 必填。'
  let file = ''
  for (const r of roots) {
    const c = path.join(r, rel)
    if (fs.existsSync(c) && fs.statSync(c).isFile()) { file = c; break }
  }
  if (!file) return `❌ 找不到：${rel}\n   可看的位置：app/、home/、tools/`
  let body = fs.readFileSync(file, 'utf8')
  const kw = String(a.keyword || '').trim()
  if (kw) {
    const hits = body.split('\n').filter((l) => l.includes(kw))
    return `【${path.basename(file)}】含「${kw}」的 ${hits.length} 行：\n` + hits.slice(0, 60).map((l, i) => `${i + 1}. ${l.trim()}`).join('\n')
  }
  return `【${path.basename(file)}】${body.split('\n').length} 行\n` + body.slice(0, 12000)
})

tool('self_patch', '改自己的源码/配置（只允许 app/lib 与 home/配置 下的文本文件）。改完必须自己验证一遍能跑。',
  { path: '相对路径，例：lib/plan.js', old: '要被替换的原文（必须唯一命中）', new: '替换成什么' },
  { level: '完全托管', mutates: 'self' })(async (a) => {
  const fs = require('node:fs')
  const path = require('node:path')
  const rel = String(a.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const oldS = String(a.old || '')
  const newS = String(a.new || '')
  if (!rel || !oldS) return '❌ path 和 old 都必须给。'
  const allow = [path.join(P.ROOT, 'app', 'lib'), path.join(P.HOME, '配置')]
  const file = allow.map((r) => path.join(r, rel.replace(/^lib\//, ''))).find((c) => fs.existsSync(c))
    || allow.map((r) => path.join(r, rel)).find((c) => fs.existsSync(c))
  if (!file) return '❌ 不在可改范围内，或文件不存在：' + rel
  const body = fs.readFileSync(file, 'utf8')
  const n = body.split(oldS).length - 1
  if (n === 0) return '❌ 没找到那段原文，一个字都没改。'
  if (n > 1) return `❌ 那段原文命中 ${n} 处，改哪一处不明确。多带几行上下文。`
  fs.writeFileSync(file, body.replace(oldS, newS), 'utf8')
  const check = require('node:child_process').spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  return `✓ 改了 ${file}` + (check.status === 0 ? '\n   语法检查通过。' : `\n   ⚠ 语法检查没过：\n   ${(check.stderr || '').split('\n').slice(0, 6).join('\n   ')}`)
})

tool('self_audit', '自查一遍：经验库里有没有互相矛盾的、有没有说「做不到」但其实做得到的、有没有过期该删的。',
  {}, { level: '只读' })(async () => {
  const M = require('./memory')
  const ents = M.allEntries()
  if (!ents.length) return '经验库是空的。'
  const lines = [`【自查】${ents.length} 条`]
  const neg = ents.filter((e) => /(不支持|无法|不能|做不到)/.test(e.text))
  const wrong = neg.filter((e) => M.looksWrong(e.text))
  if (wrong.length) {
    lines.push('', `⚠ ${wrong.length} 条在说「做不到」但没写依据，建议复查或删掉：`)
    for (const e of wrong) lines.push(`  - [${e.slug}] ${e.text.slice(0, 80)}`)
  }
  const long = ents.filter((e) => e.text.length > M.MAX_ONE * 0.8)
  if (long.length) {
    lines.push('', `⚠ ${long.length} 条接近字数上限，考虑拆开：`)
    for (const e of long) lines.push(`  - [${e.slug}] ${e.text.length} 字`)
  }
  const never = ents.filter((e) => safeInt(e.hits) === 0)
  if (never.length) lines.push('', `有 ${never.length} 条从来没被选中过（关键词可能提得不好）`)
  if (!wrong.length && !long.length) lines.push('', '没有发现明显问题。')
  return lines.join('\n')
})

// ══════════════════ 技能 ══════════════════
tool('skills', '技能库：list 列全部、get 读一篇、match 按需求找该用哪几篇、save 存一篇。技能是本行知识。',
  { action: 'list | get | match | save | delete | sync', id: '技能 id', q: '需求描述（match 用）', content: '整篇内容（save 用）' },
  { level: '建议', mutates: 'write' })(async (a) => {
  const S = require('./skills')
  const act = String(a.action || 'list')
  if (act === 'list') {
    const all = S.listSkills()
    return clip(`共 ${all.length} 个技能：\n` + all.map(s => `- ${s.id}  ${s.title}${s.whenToUse ? '  [' + String(s.whenToUse).slice(0, 40) + ']' : ''}`).join('\n'))
  }
  if (act === 'get') {
    const c = S.skillContent(String(a.id || ''))
    return c ? clip(c) : `❌ 没有这个技能：${a.id}`
  }
  if (act === 'match') {
    const hit = S.matchSkills(String(a.q || ''), 6)
    return hit.length ? `跟你这个需求相关 ${hit.length} 篇：\n` + hit.map(s => `- ${s.id}  ${s.title}\n  ${String(s.whenToUse || s.summary || '').slice(0, 100)}`).join('\n') : '没有特别相关的技能，按通用流程做'
  }
  if (act === 'save') {
    const r = S.writeSkill(a.id, String(a.content || ''))
    return r.ok ? `✓ 存了技能 ${a.id}` : '❌ ' + r.error
  }
  if (act === 'delete') { S.deleteSkill(String(a.id || '')); return `✓ 删了 ${a.id}` }
  if (act === 'sync') {
    const r = S.syncToKernel(path.join(P.HOME, '系统', 'dsh'))
    return `✓ 同步 ${r.count} 个技能到内核技能目录`
  }
  return `没有这个动作：${act}`
})

// ══════════════════ 模型 ══════════════════
tool('models', '模型管理：list 列模型、save 增改、delete 删、test 测连接、use 切换对话模型、usage 看用量。',
  { action: 'list | save | delete | test | use | usage', id: '模型 id', name: '显示名', url: '接口地址', key: 'API Key', model: '模型 ID', kind: 'text/vision/image/video/tts/asr' },
  { level: '建议', mutates: 'write' })(async (a) => {
  const M = require('./models')
  const act = String(a.action || 'list')
  if (act === 'list') {
    const s = M.snapshot()
    return clip(`共 ${s.items.length} 个模型，当前对话用：${s.current || '（没配）'}\n`
      + s.items.map(m => `- ${m.id}  ${m.name}  [${m.kind}]  ${m.model || '空'}  ${m.usable ? '可用' : '未配好'}${m.hasKey ? ' 有密钥' : ''}${m.current ? ' ←当前' : ''}`).join('\n')
      + `\n能对话的：${s.chat.map(c => c.name).join('、') || '一个都没有'}`)
  }
  if (act === 'save') {
    const r = M.saveModel({ id: a.id, name: a.name, url: a.url, key: a.key, model: a.model, kind: a.kind })
    return `✓ 存了 ${r.name}`
  }
  if (act === 'delete') { M.deleteModel(String(a.id || '')); return `✓ 删了 ${a.id}` }
  if (act === 'test') {
    const r = await M.test(String(a.id || ''))
    return r.ok ? `✓ 通了：${r.text}` : `✗ ${r.text}`
  }
  if (act === 'use') { const r = M.setChatModel(String(a.id || '')); return `✓ 当前对话模型：${r.name}` }
  if (act === 'usage') {
    const u = M.usageTotals()
    return `总调用 ${u.total_calls || 0} 次 | 输入 ${u.total_in || 0} tok | 输出 ${u.total_out || 0} tok | 花费 ${u.total_yuan || 0} 元\n`
      + Object.entries(u.by_model || {}).map(([n, v]) => `- ${n}: ${v.calls} 次, ${v.in + v.out} tok, ${v.yuan} 元`).join('\n')
  }
  return `没有这个动作：${act}`
})

// ══════════════════ 任务 ══════════════════
tool('tasks', '任务中心：list 列任务、logs 看日志、retry 重试、cancel 取消、clear 清空。',
  { action: 'list | logs | cancel | clear | tail', id: '任务 id', since: '从第几条日志开始', limit: '几条' },
  { level: '建议', mutates: 'write' })(async (a) => {
  const T = require('./tasks')
  const act = String(a.action || 'list')
  if (act === 'list') {
    const r = T.list({ limit: Number(a.limit) || 20 })
    return clip(`共 ${r.total} 个任务，计数 ${JSON.stringify(r.counts)}\n`
      + r.items.map(t => `- ${t.id}  ${t.state} ${t.progress}%  ${t.name}${t.error ? '  ⚠ ' + String(t.error).slice(0, 60) : ''}`).join('\n'))
  }
  if (act === 'logs' || act === 'tail') {
    const t = T.tail(String(a.id || ''), Number(a.since) || 0)
    return t ? clip(`${t.name} [${t.state}] ${t.progress}%\n` + (t.logs || []).join('\n')) : '❌ 没这个任务'
  }
  if (act === 'cancel') { T.cancel(String(a.id || '')); return `✓ 取消了 ${a.id}` }
  if (act === 'clear') { const r = T.clear(40); return `✓ 清完，留了 ${r.kept} 条` }
  return `没有这个动作：${act}`
})

module.exports.REGISTRY = REGISTRY

// ══════════════════ 发布与雷达 ══════════════════
tool('publish', '发布：把成片发到抖音/小红书/快手/视频号/B站。默认只填不点发布（真发撤不回来）。',
  { platform: '平台名或 key', video: '成片路径', title: '标题', body: '正文/简介', tags: '话题，逗号分隔', exec: '真发（1）还是只填（0，默认）' },
  { level: '建议', mutates: 'write' })(async (a, customer) => {
  const Pub = require('./publish')
  const r = resolveUserPath(a.video, customer)
  if (!r.ok) return '❌ ' + r.error
  const res = await Pub.publish(a.platform, {
    video: r.abs, title: a.title, body: a.body,
    tags: a.tags ? String(a.tags).split(',').map(x => x.trim()).filter(Boolean) : [],
    exec: String(a.exec || '') === '1',
  })
  if (!res.ok) return `❌ ${res.label || res.platform}：${res.error}${res.steps ? '\n步骤：\n' + res.steps.join('\n') : ''}`
  return `${res.dryRun ? '✓ 已填好，停在发布按钮前' : '✓ 已发布'}（${res.label}）\n步骤：\n` + (res.steps || []).join('\n')
    + (res.shotUrl ? `\n截图：${res.shotUrl}` : '')
})

tool('publish_center', '发布中心：platforms 列平台、login 查登录态、open 打开浏览器、close 关浏览器。',
  { action: 'platforms | login | open | close | status', platform: '平台名（login 用）' },
  { level: '建议' })(async (a) => {
  const Pub = require('./publish')
  const B = require('./browser')
  const act = String(a.action || 'platforms')
  if (act === 'platforms') return Pub.platforms().map(p => `- ${p.label}（${p.key}）${p.aspect}  标题上限 ${p.titleMax} 字`).join('\n')
  if (act === 'login') {
    const r = await Pub.loginCheck(a.platform, { openIfNeeded: true })
    return r.ok ? `${r.label}：${r.loggedIn ? '✓ 已登录' : '✗ ' + (r.note || '未登录')}` : '❌ ' + r.error
  }
  if (act === 'open') { const r = await B.start(); return `✓ 浏览器已开（${r.browser}，端口 ${r.port}）` }
  if (act === 'close') { await B.stop(); return '✓ 已关' }
  if (act === 'status') { const s = await B.status(); return `运行中 ${s.running ? '是' : '否'} · ${s.browser || '—'} · 端口 ${s.port}` }
  return `没有这个动作：${act}`
})

tool('hotspot', '热点雷达：抓微博/抖音/B站/百度/知乎/头条/小红书的实时热搜，给二创角度。',
  { platform: '平台（默认 weibo）', limit: '几条（默认 10）', keywords: '只看这些赛道，逗号分隔', ideas: '给几条选题角度（1/0）' },
  { level: '只读' })(async (a) => {
  const H = require('./hotspot')
  const r = await H.fetch(String(a.platform || 'weibo'), Number(a.limit) || 10)
  if (!r.ok) return `❌ ${a.platform}：${r.error}`
  let out = await H.brief(String(a.platform || 'weibo'), Number(a.limit) || 10, String(a.keywords || ''))
  if (String(a.ideas || '') === '1') {
    const ideas = H.topicIdeas(r.items, String(a.keywords || ''), 3)
    out += '\n\n可以这么切：\n' + ideas.map((x, i) => `${i + 1}. ${x.title}\n   → ${x.angle}\n   形式：${x.format}`).join('\n')
  }
  return out
})

// ══════════════════ 客户与工程 ══════════════════
tool('customers', '客户：list 列客户、save 新建或切换、size 看占用。',
  { action: 'list | save | size | current', name: '客户名' },
  { level: '建议', mutates: 'write' })(async (a) => {
  const act = String(a.action || 'list')
  if (act === 'current') return `当前客户：${C.currentCustomer()}`
  if (act === 'list') {
    const dir = P.BASE.customers_dir
    const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : []
    return `共 ${names.length} 个客户，当前是「${C.currentCustomer()}」：\n` + names.map(n => `- ${n}`).join('\n')
  }
  if (act === 'save') {
    const n = String(a.name || '').trim()
    if (!n) return '❌ 给 name'
    const s = C.settings()
    s.customer = n
    C.saveSettings(s)
    return `✓ 切到客户「${n}」`
  }
  if (act === 'size') {
    const cp = C.custPaths()
    return `客户「${C.currentCustomer()}」\n根目录 ${cp.root}`
  }
  return `没有这个动作：${act}`
})

tool('projects', '工程与版本：list / open / versions / delete。剪辑工程都在「工程/剪辑」下。',
  { action: 'list | open | versions | delete', name: '工程名' },
  { level: '建议', mutates: 'write' })(async (a) => {
  const T = require('./timeline')
  const act = String(a.action || 'list')
  if (act === 'list') {
    const ps = T.listProjects()
    return clip(`共 ${ps.length} 个工程：\n` + ps.map(p => `- ${p.name}  ${p.duration}s  ${p.clips} 段`).join('\n'))
  }
  if (act === 'open') {
    const d = T.load(String(a.name || ''))
    return d ? `✓ 打开「${a.name}」${d.width}x${d.height} 总长 ${T.tail(d).toFixed(2)}s` : `❌ 没有：${a.name}`
  }
  if (act === 'versions') {
    const dir = path.join(C.custPaths().root, '工程', '剪辑', String(a.name || ''), 'versions')
    if (!existsSync(dir)) return '没有历史版本'
    const vs = readdirSync(dir).sort().reverse()
    return `「${a.name}」${vs.length} 个版本：\n` + vs.slice(0, 20).map(v => `- ${v}`).join('\n')
  }
  if (act === 'delete') { T.del(String(a.name || '')); return `✓ 删了「${a.name}」` }
  return `没有这个动作：${act}`
})

tool('works', '我的作品：list 列成片、probe 看参数、delete 删除。',
  { action: 'list | probe | delete', path: '文件路径（probe/delete 用）', limit: '几条' },
  { level: '建议', mutates: 'write' })(async (a, customer) => {
  const cp = C.custPaths(customer)
  const act = String(a.action || 'list')
  if (act === 'list') {
    const dirs = [cp.videos, cp.previews].filter(existsSync)
    const rows = []
    for (const d of dirs) {
      for (const f of readdirSync(d)) {
        if (!/\.(mp4|mov|m4v)$/i.test(f)) continue
        const full = path.join(d, f)
        const st = statSync(full)
        rows.push(`- ${f}  ${humanSize(st.size)}  ${new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)}  [${path.basename(d)}]`)
      }
    }
    rows.sort().reverse()
    return clip(`共 ${rows.length} 条成片：\n` + rows.slice(0, Number(a.limit) || 40).join('\n'))
  }
  const r = resolveUserPath(a.path, customer)
  if (!r.ok) return '❌ ' + r.error
  if (act === 'probe') {
    const info = await require('./exec').probe(r.abs)
    return info && info.ok ? `${a.path}\n  ${info.duration.toFixed(2)}s ${info.width}x${info.height}@${info.fps} ${info.vcodec}${info.hasAudio ? ' + ' + info.acodec : ''} ${humanSize(info.size)}` : '❌ 读不出参数'
  }
  if (act === 'delete') { require('fs').unlinkSync(r.abs); return `✓ 删了 ${a.path}` }
  return `没有这个动作：${act}`
})

// ══════════════════ 设置与能力 ══════════════════
tool('settings', '系统设置与授权：get 读设置、set 改设置、level 改授权档、scope 改可见范围、tools 看工具表。',
  { action: 'get | set | level | scope | tools', patch: '要改的设置，JSON（set 用）', level: '只读 | 建议 | 可整理 | 完全托管', scope: '标准 | 影创 | 本机' },
  { level: '建议', mutates: 'write', danger: ['set', 'level', 'scope'] })(async (a, customer) => {
  const act = String(a.action || 'get')
  if (act === 'get') return clip(JSON.stringify(C.settings(), null, 1))
  if (act === 'set') {
    let patch = a.patch
    if (typeof patch === 'string') { try { patch = JSON.parse(patch) } catch (e) { return '❌ patch 不是合法 JSON：' + e.message } }
    if (!patch) return '❌ 给 patch'
    const s = C.settings()
    Object.assign(s, patch)
    C.saveSettings(s)
    C.history('改设置', JSON.stringify(patch).slice(0, 120))
    return '✓ 改好了'
  }
  if (act === 'level') { const v = C.setLevel(String(a.level || '')); return `✓ 授权档：${v}` }
  if (act === 'scope') { const v = C.setScope(String(a.scope || '')); return `✓ 可见范围：${v}` }
  if (act === 'tools') {
    const rows = Object.values(REGISTRY).map(t => `- ${t.name} [${t.level}${t.mutates !== 'none' ? '/' + t.mutates : ''}] ${t.desc.slice(0, 60)}`)
    return clip(`共 ${rows.length} 个工具（当前授权 ${levelOf(customer)}）：\n` + rows.join('\n'))
  }
  return `没有这个动作：${act}`
})

tool('capabilities', '软件能力清单：从工具注册表实时生成——现在把哪些能力开放给 AI、每个要什么授权档。',
  {}, { level: '只读' })(async (a, customer) => {
  const lv = levelOf(customer)
  const byLevel = {}
  for (const t of Object.values(REGISTRY)) {
    byLevel[t.level] = byLevel[t.level] || []
    byLevel[t.level].push(t.name)
  }
  const lines = [`当前授权档：${lv}（${C.scopeOf ? C.scopeOf(customer) : ''}）`, `工具总数：${Object.keys(REGISTRY).length}`, '']
  for (const l of LEVELS) {
    if (!byLevel[l]) continue
    const okMark = (LEVEL_ORDER[lv] ?? 1) >= LEVEL_ORDER[l] ? '✓' : '✗'
    lines.push(`${okMark} ${l}（${byLevel[l].length} 个）：${byLevel[l].join('、')}`)
  }
  return clip(lines.join('\n'))
})

tool('deps', '依赖体检：这台机器上哪个能力能用、缺什么。用户报「某功能用不了」先查这个，别猜参数。',
  { action: 'check | brief' },
  { level: '只读' })(async () => {
  const E = require('./exec')
  const R = require('./render')
  const out = []
  const r = await R.ready()
  out.push(`渲染：${r.ok ? '✓ hyperframes ' + r.hyperframes + ' / node ' + r.node : '✗ ' + (r.hint || '')}`)
  out.push(`ffmpeg：${P.FFMPEG} ${existsSync(P.FFMPEG) ? '✓' : '✗'} · 硬编 ${r.hardware ? '✓' : '✗'} · libx264 ${r.libx264 ? '✓' : '✗'}`)
  out.push(`ffprobe：${existsSync(P.FFPROBE) ? '✓' : '✗'}`)
  const A = require('./audio')
  const voices = await A.systemVoices().catch(() => null)
  out.push(`本机配音：${voices && voices.good.length ? '✓ 中文音色 ' + voices.good.length + ' 个' : '✗'}`)
  const B = require('./browser')
  const bs = await B.status()
  out.push(`浏览器：${bs.installed ? (bs.running ? '✓ 运行中 ' + bs.browser : '○ 已装，未启动') : '✗ 没装 Chrome'}`)
  const M = require('./models')
  const ms = M.snapshot()
  out.push(`模型：${ms.chat.length} 个可对话`)
  const T = require('./templates')
  out.push(`模板库：${T.catalog().length} 个`)
  const S = require('./skills')
  out.push(`技能：${S.listSkills().length} 个`)
  return out.join('\n')
})

tool('history', '执行历史与用量：history 最近操作、costs 费用、usage 用量。',
  { action: 'history | costs | usage', limit: '几条' },
  { level: '只读' })(async (a) => {
  const act = String(a.action || 'history')
  const lim = Number(a.limit) || 30
  if (act === 'history') {
    const h = P.load('history', [])
    const arr = Array.isArray(h) ? h : []
    return clip(`最近 ${Math.min(lim, arr.length)} 条：\n` + arr.slice(-lim).reverse().map(x => `- ${x.at || x.time || ''}  ${x.action || ''}  ${String(x.detail || '').slice(0, 80)}`).join('\n'))
  }
  if (act === 'costs') {
    const u = require('./models').usageTotals()
    return `总花费 ${u.total_yuan || 0} 元（${u.total_calls || 0} 次调用）`
  }
  if (act === 'usage') {
    const u = require('./models').usageTotals()
    return JSON.stringify(u, null, 1)
  }
  return `没有这个动作：${act}`
})

/* ══════════════ 后台工位：把长活分包出去，主对话不陪着等 ══════════════ */
/**
 * 为什么是一个独立工具而不是让 agent 自己开子会话：
 * 模型没法「起一条新会话」——那是进程级的事。它只能声明「这件事交给谁」，
 * 真正开会话、挂监听、收结果由 lib/workers.js 做。所以这里只留一个派活口。
 */
tool('delegate_task',
  '把一件需要跑很久的活交给后台工位，立刻返回。主对话不陪着等，用户可以继续说话、加意见、改需求。'
  + '凡是「搜文案 / 写分镜 / 写代码做片子 / 批量整理」这类几十秒到几分钟的活，都应该派出去，不要自己在主对话里跑完。',
  {
    title: '给这件活起个短名字（会显示在工位条上，例如「搜爆款钩子文案」）',
    brief: '完整交代：要它做什么、给谁看、什么风格、多少量、产出成什么文件。工位之间不共享上下文，少一句它就得多问一次',
    kind: '分类：文案 | 内容 | 分镜 | 成片 | 整理（默认通用）',
    project: '关联的剪辑工程名（可选，成片类活填）',
  },
  { level: '建议', mutates: 'self' })(async (a) => {
  const W = require('./workers')
  const brief = String(a.brief || '').trim()
  if (!brief) return '❌ brief 不能空：得写清楚要它干什么'
  const w = W.spawn({ title: a.title, brief, kind: a.kind, project: a.project })
  return `已派给后台工位「${w.title}」（工位号 ${w.id}）。
它自己开会话在后台干，不会占用我们的对话。你可以接着跟我说别的、补意见，或者让我看看它干到哪了。
干完我会告诉你结果；想中途加要求就用 workers 的 say。`
})

tool('workers',
  '看后台工位在干什么 / 给某个工位补意见 / 叫停。主对话只做监理，长活的实际进度都在这里查。',
  {
    action: 'list 看全部 | one 看某个工位详情 | say 给它补一句话 | stop 叫停 | clear 清掉已结束的',
    id: '工位号（one / say / stop 用）',
    text: 'say 要补的话（例如「开头换成问句，节奏再快一点」）',
  },
  { level: '只读' })(async (a) => {
  const W = require('./workers')
  const act = String(a.action || 'list')
  if (act === 'list') {
    const l = W.list()
    if (!l.total) return '现在没有后台工位。长活可以用 delegate_task 派出去。'
    return `后台工位 ${l.total} 个（在跑 ${l.running}、已完成 ${l.done}、失败 ${l.failed}）：\n` +
      l.items.map((x) => `- [${x.id}] ${x.title} · ${x.status}${x.last ? ' · ' + x.last : ''}`).join('\n')
  }
  if (act === 'one') {
    const w = W.one(String(a.id || ''))
    if (!w) return '没有这个工位：' + a.id
    return `【${w.title}】${w.status}（${w.kind}）\n最后动作：${w.last || '—'}\n` +
      (w.steps || []).slice(-10).map((s) => `  ${s.ok ? '✓' : '✕'} ${s.what} ${String(s.detail || '').slice(0, 80)}`).join('\n') +
      (w.text ? `\n产出：\n${String(w.text).slice(-1200)}` : '') + (w.error ? `\n错误：${w.error}` : '')
  }
  if (act === 'say') {
    const id = String(a.id || '')
    const t = String(a.text || '')
    if (!id || !t) return '❌ say 需要 id 和 text'
    W.say(id, t).catch(() => {})   // 不 await：补话本身也要一会儿，别把主对话卡住
    return `已把你的意见转给工位 ${id}：「${t}」。它会在原来的活上接着改，不影响其它工位。`
  }
  if (act === 'stop') {
    const w = W.stop(String(a.id || ''))
    return `已叫停 ${w.title}。注意：内核这一轮会自己收尾，不会立刻被杀；界面不再跟踪它。`
  }
  if (act === 'clear') { W.clear(a.id ? String(a.id) : ''); return '已清掉结束的工位记录（在跑的不动）' }
  return `没有这个动作：${act}`
})

module.exports.REGISTRY = REGISTRY
module.exports.toolSchema = function toolSchema(customer) {
  const out = []
  for (const t of Object.values(REGISTRY)) {
    if (!allowed(t, customer)) continue
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.desc,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.args).map(([k, v]) => [k, { type: 'string', description: v }])),
          required: [],
        },
      },
    })
  }
  return out
}
module.exports.call = async function call(name, args, customer) {
  const t = REGISTRY[name]
  if (!t) return { ok: false, error: `没有这个工具：${name}（可用：${Object.keys(REGISTRY).join('、')}）` }
  if (!allowed(t, customer)) {
    return { ok: false, error: `「${name}」需要「${t.level}」授权，当前是「${levelOf(customer)}」。让用户到设置里把授权档调高。` }
  }
  try {
    const out = await t.fn(args || {}, customer)
    return { ok: true, text: clip(out) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 500) }
  }
}
