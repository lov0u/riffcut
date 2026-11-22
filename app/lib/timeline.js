// 多轨剪辑工程：我们的 timeline.json → HyperFrames 认的 composition HTML。
//
// 只借渲染引擎，不借界面。素材路径、轨道结构、参数全是我们的格式。
//
// 片段几何语义（全项目唯一约定）：
//   x/y 是画面中心点的比例 0~1
//   w/h 是占画布的比例
//   at  是片段内进度 0~1（不是绝对秒）—— 片段挪动/改长度时关键帧自动跟随
//   keys 关键帧是「路径点」，每个点表示「到这个时刻要达到这个状态」
//   vol 音量包络必须预先烘进音频文件（引擎只读静态 data-volume）
const { join, basename, extname, dirname, relative } = require('node:path')
const { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

const W_DEFAULT = 1920, H_DEFAULT = 1080, FPS_DEFAULT = 30
const md5 = s => createHash('md5').update(String(s)).digest('hex')
/* 46 款文字样式的唯一一份数据在 app/ui/src/textstyles.js（界面也用同一个文件）。
   这里只用来解析样式 id → CSS 声明串，AI 或界面给的 tstyle 都能落地。 */
let TS_LIB = null
function tsLib() {
  if (TS_LIB) return TS_LIB
  try { TS_LIB = require('../ui/src/textstyles.js') } catch (e) { TS_LIB = null }
  return TS_LIB
}

// 美学默认值：进场慢、退场快。两个一样长时收尾显得拖沓。
const EASE_IN = 'power3.out', EASE_OUT = 'power2.in', DUR_IN = 0.5, DUR_OUT = 0.35
/* 逐字动效节奏（秒）。跟界面 05-专业剪辑.html 里的 CH_STEP/CH_DUR/TW_STEP 必须逐位相同。 */
const CH_STEP = 0.045, CH_DUR = 0.32, TW_STEP = 0.055

const ANIM_PRESETS = {
  fade: [{ opacity: 0 }, { opacity: 0 }],
  slideUp: [{ opacity: 0, y: 40 }, { opacity: 0, y: -40 }],
  slideDown: [{ opacity: 0, y: -40 }, { opacity: 0, y: 40 }],
  slideLeft: [{ opacity: 0, x: 60 }, { opacity: 0, x: -60 }],
  slideRight: [{ opacity: 0, x: -60 }, { opacity: 0, x: 60 }],
  zoomIn: [{ opacity: 0, scale: 1.18 }, null],
  zoomOut: [{ opacity: 0, scale: 0.86 }, null],
  /* ★ kenburns 原来是 [null,null] —— 等于选了什么都不发生，是个死档位。
     用户点了「缓慢推镜」画面纹丝不动，还以为是没生效。
     现在文字/画面在 tweens() 里按 c.zoom（默认 1.08）全段线性推，见下面的 kenburns 分支。 */
  kenburns: [null, null],
}

const VEXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])
const AEXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])
const IEXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

function root() {
  const base = join(C.custPaths().root, '工程', '剪辑')
  P.ensureDir(base)
  return base
}

function safeName(name) {
  const n = String(name || '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '')
  return (n || '未命名工程').slice(0, 60)
}

function projDir(name) {
  const d = join(root(), safeName(name))
  P.ensureDir(join(d, 'assets'))
  return d
}

const fileOf = name => join(projDir(name), 'timeline.json')

function blank(name, width = W_DEFAULT, height = H_DEFAULT, fps = FPS_DEFAULT, duration = 10.0) {
  return {
    name: String(name),
    width: +width, height: +height, fps: +fps, duration: +duration,
    tracks: [
      { id: 'v1', kind: 'video', name: '主视频', clips: [] },
      { id: 'g1', kind: 'graphics', name: '图形', clips: [] },
      { id: 't1', kind: 'text', name: '字幕', clips: [] },
      { id: 'a1', kind: 'audio', name: '音频', clips: [] },
    ],
  }
}

function load(name) {
  const f = fileOf(name)
  if (!existsSync(f)) throw new Error('没有这个剪辑工程：' + name)
  let d
  try { d = JSON.parse(readFileSync(f, 'utf8')) } catch (e) {
    throw new Error(`工程文件读不出来（${e.message}）：${f}`)
  }
  if (!Array.isArray(d.tracks)) d.tracks = blank(name).tracks
  return d
}

function tail(data) {
  let end = 0
  for (const t of data.tracks || []) {
    for (const c of t.clips || []) {
      const st = Number(c.start || 0)
      let d
      if (c.type === 'text' || c.type === 'template') d = Number(c.duration || 3)
      else {
        d = Math.max(0.1, Number(c.out || 0) - Number(c.in || 0))
        d = d / Math.max(0.1, Number(c.speed || 1))
      }
      end = Math.max(end, st + d)
    }
  }
  return end
}

function save(name, data) {
  const f = fileOf(name)
  const d = { ...(data || {}) }
  d.name = String(name)
  /* ★ 2026-11-20：画幅兜底。AI 用 save 手搓 JSON 建工程时经常不写 width/height，
     以前这里只补 name/duration，于是落盘的 timeline.json 完全没有画幅：
     预览 edComposeFit 拿到 undefined → NaN，渲染也只能猜画幅，
     片尾模板塞进「没画幅」的工程自然画面对不上。
     blank() 建工程时有默认 1920×1080，save 也必须兜底，别让手搓工程把画幅丢了。 */
  d.width = Number(d.width) > 0 ? Math.round(Number(d.width)) : W_DEFAULT
  d.height = Number(d.height) > 0 ? Math.round(Number(d.height)) : H_DEFAULT
  d.fps = Number(d.fps) > 0 ? Number(d.fps) : FPS_DEFAULT
  // 时长永远不短于最后一个片段的尾巴，否则渲出来会被截断
  d.duration = Math.round(Math.max(1.0, Number(d.duration || 1.0), tail(d)) * 1000) / 1000
  writeFileSync(f, JSON.stringify(d, null, 2), 'utf8')
  syncTemplateDurations(name, d)
  return d
}

/**
 * 把每个模板片段现在的 duration 同步进它自己那份模板 HTML 的 data-duration。
 *
 * ★ 为什么必须在保存这一层做
 *   HyperFrames 定子合成时长用的是「模板自己的 data-duration 优先」
 *   （hyperframes/dist/chunk-JGKI7FHX.js:14391），不是父文档 div 上那个。
 *   用户在时间线上把片段从 5 秒拖到 30 秒，只在 timeline.json 里改了 duration，
 *   模板内部完全不知道 —— 演完 5 秒就停在最后一帧，剩下 25 秒是死的。
 *   在保存时统一对齐，用户和 AI 两种改时长的方式都能覆盖到。
 *
 * ★ 每个片段一份副本（<name>--<clipId>.html），不共用一个文件。
 *   否则同一模板在一段时间线上装两次、一次 5 秒一次 30 秒，会互相把对方的时长改掉。
 * ★ 已有副本就原地改时长；片段 src 还指着共用模板时，才生成自己的副本。
 */
function syncTemplateDurations(name, d) {
  let TT
  try { TT = require('./tpltext') } catch { return }
  const dir = projDir(name)
  let changed = false
  for (const tr of (d && d.tracks) || []) {
    for (const c of (tr && tr.clips) || []) {
      if (!c || c.type !== 'template') continue
      const want = Number(c.duration)
      if (!(want > 0.05)) continue
      const srcRel = String(c.src || '').trim()
      if (!srcRel) continue
      const srcAbs = join(dir, srcRel)
      if (!existsSync(srcAbs)) continue
      const perClip = 'compositions/' + String(c.name || basename(srcRel, extname(srcRel))) +
        '--' + String(c.id || '').replace(/[^\w-]/g, '') + '.html'
      const perAbs = join(dir, perClip)
      try {
        if (srcRel === perClip) {
          if (TT.patchDuration(perAbs, want)) changed = true
        } else {
          /* 还指着共用模板：只有「要的时长 ≠ 模板原时长」时才拆出副本，
             否则手动拖一下时长就把所有人都拆散了，目录里全是副本。 */
          const html = readFileSync(srcAbs, 'utf8')
          const cur = (html.match(/data-composition-id[^>]*?data-duration\s*=\s*["']([^"']*)["']/) || [])[1]
          const curSec = Number(cur)
          if (!(Math.abs((Number.isFinite(curSec) ? curSec : 0) - want) < 0.01)) {
            if (TT.writeCopyFull(srcAbs, perAbs, c.edits || null, want)) changed = true
            c.src = perClip
            changed = true
          }
        }
      } catch { /* 单个片段失败不该让保存整体失败 */ }
    }
  }
  if (changed) writeFileSync(fileOf(name), JSON.stringify(d, null, 2), 'utf8')
}

const INTERNAL_NAMES = new Set(['_模板试用'])
const isInternal = name => INTERNAL_NAMES.has(String(name)) || String(name).startsWith('_')

function listProjects() {
  const out = []
  let names
  try { names = readdirSync(root()) } catch { return out }
  for (const n of names.sort()) {
    const d = join(root(), n)
    let st
    try { st = statSync(d) } catch { continue }
    if (!st.isDirectory() || isInternal(n)) continue
    const f = join(d, 'timeline.json')
    if (!existsSync(f)) continue
    let data
    try { data = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    const clips = (data.tracks || []).reduce((a, t) => a + (t.clips || []).length, 0)
    /* ★ 时长要用「真实内容长度」tail()，不能读 data.duration。
       data.duration 是新建工程时的画布默认值（10 秒），之后往里加片段不会改它 ——
       于是列表里显示 10s，实际渲出来 5s，用户以为工程建错了。
       没片段的空工程才退回 data.duration（那时它就是画布长度，合理）。 */
    let dur = 0
    try { dur = clips > 0 ? tail(data) : (Number(data.duration) || 0) } catch { dur = Number(data.duration) || 0 }
    out.push({
      name: n, duration: dur, clips,
      width: data.width, height: data.height,
      mtime: Math.floor(statSync(f).mtimeMs / 1000),
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function del(name) {
  try { rmSync(projDir(name), { recursive: true, force: true }); return true } catch { return false }
}

function assets(name) {
  const d = join(projDir(name), 'assets')
  const out = []
  let files
  try { files = readdirSync(d) } catch { return out }
  for (const f of files.sort()) {
    if (f.startsWith('.')) continue
    const full = join(d, f)
    if (!statSync(full).isFile()) continue
    const ext = extname(f).toLowerCase()
    const kind = VEXT.has(ext) ? 'video' : AEXT.has(ext) ? 'audio' : IEXT.has(ext) ? 'image' : ''
    if (!kind) continue
    const item = { name: f, src: 'assets/' + f, kind, size: statSync(full).size }
    if (kind !== 'image') item.duration = 0
    out.push({ ...item, full })
  }
  return out
}

async function assetsWithDuration(name) {
  const out = assets(name)
  for (const it of out) {
    if (it.kind === 'audio' || it.kind === 'video') {
      const p = await E.probe(it.full)
      it.duration = p ? Math.round(p.duration * 1000) / 1000 : 0
    }
    delete it.full
  }
  return out
}

/** 把外部文件复制进工程 assets/。复制而不是引用：工程搬到别处也不会丢素材。 */
function importAsset(name, srcPath) {
  const src = String(srcPath).replace(/^~/, require('node:os').homedir())
  if (!existsSync(src)) throw new Error('找不到这个文件：' + srcPath)
  const st = statSync(src)
  if (!st.isFile()) throw new Error('这不是文件：' + srcPath)
  const ext = extname(src).toLowerCase()
  if (!VEXT.has(ext) && !AEXT.has(ext) && !IEXT.has(ext)) throw new Error('这个格式不支持：' + ext)
  const adir = join(projDir(name), 'assets')
  let dst = join(adir, basename(src))
  // 同名同尺寸已在工程里就复用，不再复制（同一张图导两次不该出两个条目）
  if (existsSync(dst) && statSync(dst).size === st.size) {
    // reuse
  } else {
    let i = 1
    while (existsSync(dst)) {
      dst = join(adir, `${basename(src, ext)}-${i}${ext}`)
      i++
    }
    copyFileSync(src, dst)
  }
  const kind = VEXT.has(ext) ? 'video' : AEXT.has(ext) ? 'audio' : 'image'
  const item = { name: basename(dst), src: 'assets/' + basename(dst), kind, size: statSync(dst).size }
  return item
}

// ── 几何 ──────────────────────────────────────────────
const num = (v, d = 0) => {
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const sec = x => {
  const n = Number(x)
  if (!Number.isFinite(n)) return '0'
  return (n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')) || '0'
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 模板的原始画幅。读一次缓存一次 —— 渲染时每个模板片段都要问。 */
const _TPL_DIM = new Map()
function templateDims(name) {
  const n = String(name || '').trim()
  if (!n) return null
  if (_TPL_DIM.has(n)) return _TPL_DIM.get(n)
  let dim = null
  try {
    const meta = require('./templates').itemMeta(n)
    const d = meta && meta.dimensions
    if (d && Number(d.width) > 0 && Number(d.height) > 0) {
      dim = { width: Number(d.width), height: Number(d.height) }
    }
  } catch (e) { /* 读不到就退回旧行为（铺满），不能让一个元信息读失败把渲染整个搞挂 */ }
  _TPL_DIM.set(n, dim)
  return dim
}

function geom(c) {
  const x = num(c.x, 0.5), y = num(c.y, 0.5)
  const st = [`left:${sec(x * 100)}%`, `top:${sec(y * 100)}%`]
  const wv = c.w, hv = c.h
  if (wv === undefined && hv === undefined) st.push('width:100%', 'height:100%')
  else {
    st.push(`width:${sec(num(wv, 1.0) * 100)}%`)
    st.push(`height:${sec(num(hv, 1.0) * 100)}%`)
  }
  const r = num(c.radius, 0)
  if (r > 0) {
    st.push(`border-radius:${sec(r)}${r > 1 ? 'px' : '%'}`)
    st.push('overflow:hidden')
  }
  if (c.opacity !== undefined && c.opacity !== null) st.push(`opacity:${sec(num(c.opacity, 1))}`)
  if (c.z !== undefined && c.z !== null) st.push(`z-index:${Math.round(num(c.z, 1))}`)
  if (['1', 'true', 'yes'].includes(String(c.shadow || '').toLowerCase())) {
    st.push('box-shadow:0 12px 40px rgba(0,0,0,.34)')
  }
  const base = {}
  const sc = num(c.scale, 1.0)
  if (Math.abs(sc - 1) > 1e-6) base.scale = sc
  const rot = num(c.rotate, 0)
  if (Math.abs(rot) > 1e-6) base.rotation = rot
  return [st.join(';'), base]
}

/** 片段字段语义 → gsap 写法。全模块唯一一处做单位换算。 */
function toGsap(k, v, bx, by, W, H) {
  if (k === 'x') return W ? ['x', Math.round((v - bx) * W * 10) / 10] : null
  if (k === 'y') return H ? ['y', Math.round((v - by) * H * 10) / 10] : null
  if (k === 'w') return ['width', `${Math.round(Math.max(1.0, v * 100) * 100) / 100}%`]
  if (k === 'h') return ['height', `${Math.round(Math.max(1.0, v * 100) * 100) / 100}%`]
  if (k === 'rotate') return ['rotation', v]
  if (k === 'opacity') return ['opacity', Math.max(0, Math.min(1, v))]
  if (k === 'scale') return ['scale', Math.max(0.01, v)]
  if (k === 'radius') return ['borderRadius', `${Math.round(v)}px`]
  return null
}

/** 关键帧 → gsap 补间。关键帧是「路径点」，每个点从前一个点走过去。 */
function keyTweens(c, start, length, W = 0, H = 0) {
  const ks = c.keys
  if (!Array.isArray(ks) || !ks.length) return []
  const bx = num(c.x, 0.5), by = num(c.y, 0.5)
  const pts = []
  for (const k of ks) {
    if (!k || typeof k !== 'object') continue
    let at = num(k.at, -1)
    if (at < 0) continue
    at = Math.max(0, Math.min(1, at))
    const to = {}
    for (const [kk, vv] of Object.entries(k)) {
      if (['at', 'd', 'ease'].includes(kk)) continue
      const v = num(vv, null)
      if (v === null) continue
      const pair = toGsap(kk, v, bx, by, W, H)
      if (pair) to[pair[0]] = pair[1]
    }
    if (Object.keys(to).length) {
      pts.push({
        at: Math.round((start + at * length) * 1000) / 1000,
        d: num(k.d, 0), ease: String(k.ease || 'power2.inOut').trim(), to,
      })
    }
  }
  pts.sort((a, b) => a.at - b.at)
  if (!pts.length) return []
  const out = []
  pts.forEach((pt, i) => {
    if (i === 0) {
      if (pt.at <= start + 0.001) return
      out.push({ at: start, d: Math.round((pt.at - start) * 1000) / 1000, ease: pt.ease, to: { ...pt.to } })
      return
    }
    const prev = pts[i - 1]
    const gap = Math.round((pt.at - prev.at) * 1000) / 1000
    const d = pt.d > 0 ? pt.d : Math.max(0.05, gap)
    out.push({ at: prev.at, d, ease: pt.ease, to: { ...pt.to } })
  })
  return out
}

/** 音量包络 → 补间（打在代理对象上，onUpdate 同步给 el.volume）。 */
function volTweens(c, start, length) {
  let ks = c.vol
  if (!Array.isArray(ks) || !ks.length) {
    const fi = num(c.fadeIn, 0), fo = num(c.fadeOut, 0)
    if (fi <= 0 && fo <= 0) return []
    const base = num(c.volume, 1.0)
    ks = [{ at: 0, v: fi > 0 ? 0 : base }]
    if (fi > 0) ks.push({ at: Math.min(1, fi / Math.max(0.1, length)), v: base })
    if (fo > 0) {
      ks.push({ at: Math.max(0, 1 - fo / Math.max(0.1, length)), v: base })
      ks.push({ at: 1, v: 0 })
    }
  }
  const pts = []
  for (const k of ks) {
    if (!k || typeof k !== 'object') continue
    const at = num(k.at, -1)
    if (at < 0) continue
    pts.push({
      at: Math.round((start + Math.max(0, Math.min(1, at)) * length) * 1000) / 1000,
      d: num(k.d, 0), ease: String(k.ease || 'power1.inOut').trim(),
      v: Math.max(0, Math.min(1, num(k.v, 1.0))),
    })
  }
  pts.sort((a, b) => a.at - b.at)
  const out = []
  pts.forEach((pt, i) => {
    if (i === 0) {
      if (pt.at <= start + 0.001) return
      out.push({ at: start, d: Math.round((pt.at - start) * 1000) / 1000, ease: pt.ease, v: pt.v })
      return
    }
    const prev = pts[i - 1]
    const gap = Math.round((pt.at - prev.at) * 1000) / 1000
    out.push({ at: prev.at, d: pt.d > 0 ? pt.d : Math.max(0.05, gap), ease: pt.ease, v: pt.v })
  })
  return out
}

function tweens(c, start, length, W = 0, H = 0) {
  const tw = []
  const fi = num(c.fadeIn, 0), fo = num(c.fadeOut, 0)
  const preset = String(c.anim || '').trim()
  /* 逐字类动效（逐字弹入 / 打字机）自己管每个字的相位（见 toComposition 里拆 span），
     整块再叠一层淡入就把「一个字一个字蹦出来」糊成「整块淡进来」，观感完全不是一回事。
     所以这两款不走预设分支。 */
  const charMode = preset === 'charIn' || preset === 'typewriter'
  // 有 keyframes 时不再叠预设位移：两套都在动 x/y，会互相覆盖
  const [pIn, pOut] = (charMode || (Array.isArray(c.keys) && c.keys.length))
    ? [null, null]
    : (ANIM_PRESETS[preset] || [null, null])
  const frm = (c.from && typeof c.from === 'object') ? c.from : pIn
  const to = (c.to && typeof c.to === 'object') ? c.to : pOut
  const ease = String(c.ease || EASE_IN)
  const dIn = fi > 0 ? fi : (frm ? DUR_IN : 0)
  const dOut = fo > 0 ? fo : (to ? DUR_OUT : 0)

  if (dIn > 0) {
    const f = { ...(frm || { opacity: 0 }) }
    if (f.opacity === undefined) f.opacity = 0
    const v = { opacity: num(c.opacity, 1) }
    for (const k of Object.keys(f)) {
      if (k === 'opacity') continue
      if (k === 'x') v.x = 0
      else if (k === 'y') v.y = 0
      else if (k === 'scale') v.scale = num(c.scale, 1.0)
      else if (k === 'rotation') v.rotation = num(c.rotate, 0)
    }
    tw.push({ at: start, d: dIn, ease, from: f, to: v })
  }

  // 整段缓推（Ken Burns）
  /* ★ 原来只认 c.zoom > 0。而 ANIM_PRESETS.kenburns 是 [null,null]，
     也就是说面板上选「缓慢推镜」时 c.zoom 从来没被写过 → 这段判断永远不成立，
     选与不选一模一样。现在：选了 kenburns 但没给 zoom 时用 1.08 兜底。 */
  const zm = num(c.zoom, 0) || (preset === 'kenburns' ? 1.08 : 0)
  if (zm > 0 && length > 0.4) tw.push({ at: start, d: length, ease: 'none', to: { scale: zm } })

  // 退场必须比进场短：两个一样长时收尾显得拖沓
  if (dOut > 0 && to) {
    const t = { ...to }
    if (t.opacity === undefined) t.opacity = 0
    tw.push({ at: Math.max(start, start + length - dOut), d: dOut, ease: EASE_OUT, to: t })
  }

  // 关键帧排最后：它一定指向结束状态，不能被出场动画顶掉
  tw.push(...keyTweens(c, start, length, W, H))
  return tw
}

/** 音量包络 → ffmpeg volume 时间表达式（分段线性插值）。 */
function volExpr(pts, length) {
  const ps = []
  for (const k of pts) {
    if (!k || typeof k !== 'object') continue
    const at = Number(k.at), v = Number(k.v)
    if (!Number.isFinite(at) || !Number.isFinite(v)) continue
    ps.push([Math.max(0, Math.min(1, at)) * Math.max(0.01, length), Math.max(0, Math.min(1, v))])
  }
  if (!ps.length) return ''
  ps.sort((a, b) => a[0] - b[0])
  if (ps[0][0] > 0) ps.unshift([0, ps[0][1]])
  if (ps.length === 1) return ps[0][1].toFixed(4)
  let expr = ps[ps.length - 1][1].toFixed(4)
  for (let i = ps.length - 1; i > 0; i--) {
    const [t0, v0] = ps[i - 1], [t1, v1] = ps[i]
    let seg
    if (t1 - t0 < 1e-6) seg = v1.toFixed(4)
    else {
      const k = (v1 - v0) / (t1 - t0)
      seg = `${v0.toFixed(4)}+${k.toFixed(6)}*(t-${t0.toFixed(4)})`
    }
    expr = `if(lt(t,${t1.toFixed(4)}),${seg},${expr})`
  }
  return expr
}

/** 把包络烘进一份音频副本，返回新文件路径；做不了返回 null。 */
async function bakeVol(srcPath, pts, tin, length) {
  const expr = volExpr(pts, length)
  if (!expr) return null
  if (!existsSync(srcPath)) return null
  const dir = dirname(srcPath)
  const tag = md5(`${basename(srcPath)}|${expr}|${tin}|${length}`).slice(0, 10)
  const dst = join(dir, `${basename(srcPath, extname(srcPath))}.vol-${tag}.m4a`)
  if (existsSync(dst) && statSync(dst).size > 1024) return dst
  const args = ['-v', 'error', '-y']
  if (tin > 0) args.push('-ss', tin.toFixed(3))
  args.push('-t', Math.max(0.1, length).toFixed(3), '-i', srcPath,
    '-vn', '-af', `asetpts=PTS-STARTPTS,volume=eval=frame:volume='${expr}'`,
    '-c:a', 'aac', '-b:a', '192k', dst)
  const r = await E.run(P.FFMPEG, args, { timeout: 1_800_000 })
  if (!r.ok || !existsSync(dst) || statSync(dst).size < 1024) return null
  return dst
}

// ── composition HTML 外壳 ─────────────────────────────
const COMP_HEAD = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>__NAME__</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:#000;overflow:hidden}
  /* 片段一律「左上角 + translate(-50%,-50%)」定位：x/y 传 50%/50% 就是原来的满屏。
     这样 x/y 才能是「画面中心点」，AI 说「放到右上角 x=0.78 y=0.22」是直觉对得上的。 */
  .vl-clip{position:absolute;transform:translate(-50%,-50%);transform-origin:center center;
           will-change:transform,opacity}
  /* 字幕底衬：白底模板上白字直接消失，加一层半透明底比堆阴影可靠。
     片段上写 plate="0" 可以关掉，想要裸字时用。 */
  .vl-tx{position:absolute;transform:translate(-50%,-50%);text-align:center;
         font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;
         white-space:pre-wrap;line-height:1.35;text-shadow:0 2px 12px rgba(0,0,0,.45);
         max-width:86%;background:rgba(10,16,24,.58);backdrop-filter:blur(2px);
         padding:10px 24px;border-radius:12px;box-shadow:0 6px 26px rgba(0,0,0,.22)}
  /* 演示稿整页文字：没有底衬，按字段控对齐/行宽/行距 */
  .vl-tx-plain{background:none;padding:0;box-shadow:none;backdrop-filter:none;text-shadow:none}
  .vl-layer{position:absolute;transform:translate(-50%,-50%);transform-origin:center center;
            will-change:transform,opacity}
  /* 层序：视频在最下，模板/图形在中间，文字永远压在最上。
     否则一条占满全屏的模板会把字幕整个盖住。 */
  .vl-clip{z-index:1}
  .vl-layer{z-index:2}
  .vl-tx{z-index:3}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="__DUR__"
     data-width="__W__" data-height="__H__" data-fps="__FPS__"
     style="width:__W__px;height:__H__px;position:relative;background:#000;overflow:hidden;--hf-w:__W__;--hf-h:__H__">
__BODY__
</div>
<script src="lib/gsap.min.js"></script>
<script>
  window.__VL_ANIM = __ANIM__;
  window.__timelines = window.__timelines || {};
  var _tl = gsap.timeline({paused:true});
  window.__timelines["main"] = _tl;
  /* 逐片段动画。数据由 toComposition 生成为 __VL_ANIM 数组。
     用绝对时间轴位置（tl.fromTo(..., at)）而不是相对串联 ——
     片段在时间线上是绝对排布的，串联会随片段顺序错位。 */
  (window.__VL_ANIM || []).forEach(function (a) {
    var el = document.querySelector(a.sel);
    if (!el) return;
    /* 基准位移必须交给 gsap 管：所有片段用「左上角 + translate(-50%,-50%)」定位，
       gsap 写 transform 会整段覆盖，所以把 xPercent/yPercent 也交给它，
       否则一次 scale 就把居中位移抹掉，画面会跳到右下角。 */
    gsap.set(el, {xPercent: -50, yPercent: -50});
    (a.tweens || []).forEach(function (tw) {
      /* vars 是「去哪儿」：必须是 tw.to 的属性和 duration/ease 合并。
         只写 duration/ease 的话 fromTo 的终点是空的，进场等于原地从透明变不透明。 */
      var vars = {duration: tw.d, ease: tw.ease || "power2.out"};
      var dst = tw.to || {};
      for (var k in dst) {
        if (k === "duration" || k === "ease") continue;
        vars[k] = dst[k];
      }
      if (tw.from) _tl.fromTo(el, tw.from, vars, tw.at);
      else _tl.to(el, vars, tw.at);
    });
    /* 音量包络：补的不是 el.volume —— gsap 对 DOM 目标默认按 CSS 属性处理，
       volume 是 HTMLMediaElement 的属性不是样式，直接写会被当无效样式丢掉。
       所以补一个 {v:...} 代理对象，onUpdate 时再写回 el.volume。 */
    /* 逐字类动效。charIn：每个字从「隐形 + 下移 14px + 0.86 倍」弹到位；
       typewriter：一个字一个字蹦出来，出来就不动。
       两条都用 gsap.set 打初始态 + stagger 排时间，不走 _tl.to 循环 —— 
       一段 40 字就是 40 次 to()，长片子上百段直接卡。 */
    if (a.chars) {
      var chs = el.querySelectorAll(".vl-ch");
      if (chs.length) {
        var _step = a.chars.mode === "typewriter" ? __TW_STEP__ : __CH_STEP__;
        gsap.set(chs, {display: "inline-block", whiteSpace: "pre"});
        if (a.chars.mode === "typewriter") {
          gsap.set(chs, {opacity: 0});
          _tl.to(chs, {opacity: 1, duration: 0.01, stagger: _step, ease: "none"}, a.chars.at);
        } else {
          gsap.set(chs, {opacity: 0, y: 14, scale: 0.86, transformOrigin: "50% 60%"});
          _tl.to(chs, {opacity: 1, y: 0, scale: 1, duration: __CH_DUR__, stagger: _step, ease: "power3.out"}, a.chars.at);
        }
      }
      return;
    }
    if (a.vol && a.vol.length) {
      var _p = {v: (a.vol0 === undefined ? 1 : a.vol0)};
      var _apply = function () { try { el.volume = Math.max(0, Math.min(1, _p.v)); } catch (e) {} };
      _apply();
      a.vol.forEach(function (tw) {
        _tl.to(_p, {v: tw.v, duration: tw.d, ease: tw.ease || "power1.inOut",
                    onUpdate: _apply, onComplete: _apply}, tw.at);
      });
    }
  });
</script>
</body>
</html>
`

/**
 * timeline.json → composition HTML。
 * 轨道语义：video→<video>，audio→<audio>，image→<img>，text→绝对定位 div，template→data-composition-src
 */
async function toComposition(data, projDirPath) {
  const w = Math.round(Number(data.width) || W_DEFAULT)
  const h = Math.round(Number(data.height) || H_DEFAULT)
  const fps = Math.round(Number(data.fps) || FPS_DEFAULT)
  // 总时长以片段末尾为准：声明值只是兜底（新建工程写 10，加了片段从不变）
  const tailSec = tail(data)
  const dur = tailSec > 0.05 ? tailSec : (Number(data.duration) || 10.0)

  const body = []
  const anim = []
  const tracks = data.tracks || []
  for (let ti = 0; ti < tracks.length; ti++) {
    const tr = tracks[ti]
    const kind = tr.kind || 'video'
    const clips = tr.clips || []
    for (let ci = 0; ci < clips.length; ci++) {
      const c = clips[ci]
      const start = Number(c.start || 0)
      const ctype = c.type || kind

      if (['video', 'audio', 'image'].includes(ctype)) {
        let src = String(c.src || '').trim()
        if (!src) continue
        const tin = Number(c.in || 0), tout = Number(c.out || 0)
        // 图片没有入点出点，只能靠 duration
        const length = tout > tin ? Math.max(0.1, tout - tin) : Math.max(0.1, Number(c.duration || 3))
        const tag = { video: 'video', audio: 'audio', image: 'img' }[ctype]
        let extra = ctype === 'video' ? ' muted playsinline' : (ctype === 'audio' ? ' preload="auto"' : '')
        let vol = c.volume

        // 音量包络必须烘进音频文件（引擎只读静态 data-volume）
        if (ctype !== 'image' && Array.isArray(c.vol) && c.vol.length && projDirPath) {
          const abs = src.startsWith('/') ? src : join(projDirPath, src)
          const baked = await bakeVol(abs, c.vol, tin, length)
          if (baked) {
            src = abs === baked ? src : relative(projDirPath, baked)
            vol = 1.0
          }
        }
        if (vol !== undefined && vol !== null && ctype !== 'image') extra += ` data-volume="${sec(vol)}"`

        let fit = String(c.fit || 'cover').toLowerCase()
        if (!['cover', 'contain', 'fill'].includes(fit)) fit = 'cover'
        const [gstyle] = geom(c)
        let style
        if (ctype === 'audio') style = 'position:absolute;display:none'
        else style = `position:absolute;${gstyle};object-fit:${fit}`

        const cid = 'vl-' + String(c.id || `${ti}-${body.length}`)
        body.push(`<${tag} id="${esc(cid)}" class="clip vl-clip" src="${esc(src)}" data-start="${sec(start)}" data-duration="${sec(length)}" data-media-start="${sec(tin)}" data-track-index="${ti}" style="${style}"${extra}></${tag}>`)

        const tw = tweens(c, start, length, w, h)
        const vt = ctype !== 'image' ? volTweens(c, start, length) : []
        if (tw.length || vt.length) {
          const item = { sel: '#' + cid }
          if (tw.length) item.tweens = tw
          if (vt.length) {
            item.vol = vt
            // 起始音量必须一起写：包络第一条从「当前值」出发
            item.vol0 = num(c.volume, 1.0)
          }
          anim.push(item)
        }

      } else if (ctype === 'text') {
        const txt = String(c.text || '')
        if (!txt) continue
        const length = Math.max(0.2, Number(c.duration || 3))
        const size = Math.round(Number(c.size) || 48)
        const color = String(c.color || '#FFFFFF')
        const x = (c.x !== undefined && c.x !== null ? Number(c.x) : 0.5) * 100
        const y = (c.y !== undefined && c.y !== null ? Number(c.y) : 0.86) * 100
        let extra = c.bold ? 'font-weight:700;' : ''
        // plate="0" → 裸字，不加底衬（PPT 式整页文字必须裸，白底上加半透明黑衬会显脏）
        /* 字体样式串（界面「文字样式」选的那几十款）先读出来，因为「是不是裸字」
           要由它决定：渐变/中空/发光那几款自己不带底衬，套上默认黑底就是脏的。 */
        /* ★ 样式有两种来源，优先用片段上已经解析好的 tcss（界面点样式时写的），
           没有 tcss 但写了 tstyle 时才回头去样式表里算 —— AI 通过 edit_timeline
           只给 tstyle 的情况下，光看 tcss 会当成「没样式」，字就退成默认黑底衬。 */
        let tcssRaw = String(c.tcss || '').trim()
        if (!tcssRaw && c.tstyle) {
          const lib = tsLib()
          if (lib && lib.cssOf) tcssRaw = String(lib.cssOf(c.tstyle, c.color, c.c2) || '').trim()
        }
        const styleBare = !!tcssRaw && !/background/i.test(tcssRaw)
        const bare = styleBare
          || ['0', 'false', 'no'].includes(String(c.plate === undefined ? '1' : c.plate).toLowerCase())
        if (bare) {
          extra += 'background:none;padding:0;box-shadow:none;backdrop-filter:none;'
          // 样式自带 text-shadow（发光/立体/长投影）必须留着，否则那些款全废
          if (!/text-shadow/i.test(tcssRaw)) extra += 'text-shadow:none;'
        }
        // ★ 这几个字段原来存了但渲染层不读 —— align 恒为居中，weight/lineHeight/maxWidth 直接被丢。
        //   症状：写了「左对齐要点」出来还是居中，写了加粗还是细的，看不出报错。
        /* ★ text-align:left 单独写没有用：.vl-tx 是 absolute + translate(-50%,-50%)，
           不加宽度时块是 shrink-to-fit，宽度=内容宽度，左对齐看不出来。
           但也不能改 transform/left（会和 translate 打架，内容被推出画面 —— 试过，整块飞出左边）。
           正解：给死宽度 + 用 margin-left 把块居中成想要的位置，块内部再左对齐。
           padding-left 用 em 相对字号，正文和标题自动成比例。 */
        const al = String(c.align || "").toLowerCase()
        if (al === "left" || al === "right") {
          const bw = Math.round(Number(c.maxWidth) || 760)
          extra += `text-align:${al};width:${bw}px;padding-left:0.5em;padding-right:0.5em;`
        } else if (al) {
          extra += `text-align:${al};`
        }
        if (c.weight) extra += `font-weight:${Number(c.weight) || 400};`
        if (c.lineHeight) extra += `line-height:${Number(c.lineHeight)};`
        if (c.maxWidth) extra += `max-width:${Math.round(Number(c.maxWidth))}px;`
        /* ★ 界面「文字样式」那一栏选的成品样式，落地成 c.tcss（已经解析好的声明串，
           主色 {C} 在界面侧就替换掉了）。放在最后拼，覆盖上面的基础值 ——
           40 多个样式各带 padding/border/gradient/text-shadow，逐个字段映射会漏。
           颜色仍以 c.color 为准：样式串里 color:transparent 的渐变字靠
           -webkit-text-fill-color 生效，两者不冲突（实测过）。 */
        if (tcssRaw) extra += tcssRaw.replace(/;?\s*$/, ';')
        const cid = 'vl-' + String(c.id || `t${ti}-${body.length}`)
        /* 逐字类动效：拆成一个个 span，每个字带 --i（序号），相位交给播放器统一算。
           ★ 必须在服务端就拆好 —— 客户端再拆的话，gsap 的时间轴要对几百个
             span 逐个找选择器，一段 20 字的字幕就是 20 次 querySelector，
             长片子直接卡住。这里生成 .vl-ch-<i> 的类名，播放器一次性批量取。 */
        const anmName = String(c.anim || '').trim()
        const charMode = anmName === 'charIn' || anmName === 'typewriter'
        let inner = esc(txt)
        if (charMode) {
          const parts = []
          for (let i = 0; i < txt.length; i++) {
            const ch = txt.charAt(i)
            const show = ch === ' ' ? '\u00a0' : esc(ch)
            /* 每个字一个 span，类名带序号。空格用 &nbsp;，inline-block 里的空格会塌。 */
            parts.push(`<span class="vl-ch" data-i="${i}">${show}</span>`)
          }
          inner = parts.join('')
        }
        body.push(`<div id="${esc(cid)}" class="clip vl-tx${bare ? ' vl-tx-plain' : ''}" data-start="${sec(start)}" data-duration="${sec(length)}" data-track-index="${ti}" data-track-kind="captions" style="left:${sec(x)}%;top:${sec(y)}%;font-size:${size}px;color:${color};${extra}">${inner}</div>`)
        const tw = tweens(c, start, length, w, h)
        if (tw.length) anim.push({ sel: '#' + cid, tweens: tw })
        /* 逐字相位单独走一条记录，播放器里用 gsap.set + stagger 处理：
           不用 timeline 里几百个 to()，一段 40 字也就是一次 stagger 调用。 */
        if (charMode) anim.push({ sel: '#' + cid, chars: { mode: anmName, count: txt.length, at: sec(start) } })

      } else if (ctype === 'template') {
        const src = String(c.src || '').trim()
        if (!src) continue
        const length = Math.max(0.2, Number(c.duration || 3))
        const vv = c.vars || {}
        let attr = ''
        if (Object.keys(vv).length) {
          attr = ` data-variable-values='${JSON.stringify(vv).replace(/'/g, '&#39;')}'`
        }
        /* ★ 模板画幅：容器一律给「模板原画幅」，不改成目标画幅。
           实测：容器改成 1080x608 时模板内部仍按 1920 算坐标 → 文字右溢被切；
           容器给 1920x1080 时排版完全正确。所以这里保持原画幅，
           真正的「缩进画布」由 render.applyFitPatch 注入到模板体内的 #hf-stage 完成。
           显式给了 w/h 或打了 w/h 关键帧就尊重用户，不动。 */
        let gs = geom(c)[0]
        const keyedWH = Array.isArray(c.keys) && c.keys.some((k) => k && (k.w !== undefined || k.h !== undefined))
        if (c.w === undefined && c.h === undefined && !keyedWH) {
          const dim = templateDims(c.name)
          if (dim) {
            gs = gs.replace(/width:[^;]*;?/, `width:${dim.width}px;`)
                   .replace(/height:[^;]*;?/, `height:${dim.height}px;`)
          }
        }
        const cid = 'vl-' + String(c.id || `g${ti}-${body.length}`)
        body.push(`<div id="${esc(cid)}" class="clip vl-layer" data-composition-id="${esc(String(c.name || basename(src, extname(src))))}" data-composition-src="${esc(src)}" data-start="${sec(start)}" data-duration="${sec(length)}" data-track-index="${ti}" data-track-kind="graphics" style="position:absolute;${gs}"${attr}></div>`)
        const tw = tweens(c, start, length, w, h)
        if (tw.length) anim.push({ sel: '#' + cid, tweens: tw })
      }
    }
  }

  const animJs = JSON.stringify(anim).replace(/</g, '\\u003c')
  return COMP_HEAD
    .replace(/__NAME__/g, esc(String(data.name || 'composition')))
    .replace(/__W__/g, String(w))
    .replace(/__H__/g, String(h))
    .replace(/__FPS__/g, String(fps))
    .replace(/__DUR__/g, sec(dur))
    .replace('__BODY__', body.join('\n'))
    .replace('__ANIM__', animJs)
    /* 逐字动效的两个节奏常量，必须跟界面侧 CH_STEP/CH_DUR/TW_STEP 完全一致，
       否则编辑器里看着 45ms、成片变别的数，节奏就散了。 */
    .replace(/__CH_STEP__/g, String(CH_STEP))
    .replace(/__CH_DUR__/g, String(CH_DUR))
    .replace(/__TW_STEP__/g, String(TW_STEP))
}

async function writeComposition(name) {
  const d = load(name)
  const dir = projDir(name)
  const html = await toComposition(d, dir)
  const f = join(dir, 'index.html')
  writeFileSync(f, html, 'utf8')
  // gsap 副本：装模板和写外壳都从这儿取，不联网
  const libDir = join(dir, 'lib')
  P.ensureDir(libDir)
  const gsap = join(libDir, 'gsap.min.js')
  if (!existsSync(gsap)) {
    const local = join(__dirname, 'vendor', 'gsap.min.js')
    if (existsSync(local)) copyFileSync(local, gsap)
  }
  return { html: f, name }
}

module.exports = {
  W_DEFAULT, H_DEFAULT, FPS_DEFAULT, EASE_IN, EASE_OUT, DUR_IN, DUR_OUT, ANIM_PRESETS,
  CH_STEP, CH_DUR, TW_STEP,
  root, safeName, projDir, fileOf, blank, load, save, tail,
  isInternal, listProjects, del, assets, assetsWithDuration, importAsset,
  trackOf, ensureTrack, mediaClip, textClip,
  geom, toGsap, keyTweens, volTweens, tweens, volExpr, bakeVol,
  toComposition, writeComposition,
}

/**
 * 按 id 找轨道。
 * ★ 为什么需要这个：tracks 是**数组**（[{id:'v1',kind:'video',clips:[]}, ...]），
 *   但工具层一直写成 d.tracks['v1'] —— 给数组设字符串下标，JS 不报错，
 *   但 JSON.stringify 会直接丢掉它。症状是「加片段报成功、工程里一个片段都没有」，
 *   而且文件看起来完全正常（tracks 还是那四个空轨道）。
 */
function trackOf(data, id) {
  const arr = (data && Array.isArray(data.tracks)) ? data.tracks : []
  return arr.find((t) => t && t.id === id) || null
}

/** 拿轨道，没有就补一个（按 id 猜 kind）。 */
function ensureTrack(data, id) {
  if (!Array.isArray(data.tracks)) data.tracks = blank(data.name || '_').tracks
  let t = trackOf(data, id)
  if (t) return t
  const kind = id.startsWith('a') ? 'audio' : id.startsWith('t') ? 'text' : id.startsWith('g') ? 'graphics' : 'video'
  t = { id, kind, name: id, clips: [] }
  data.tracks.push(t)
  return t
}

/**
 * 造一个媒体片段，字段名对齐渲染层。
 * ★ 渲染层读的是 src / start / in / out / type，不是 path / at / dur / asset ——
 *   写错字段不会报错，渲出来就是一片黑。
 */
function mediaClip({ src, type, start = 0, dur = 3, fit = 'cover', volume, inPoint = 0 }) {
  const c = {
    id: 'c' + Date.now() + '-' + Math.floor(Math.random() * 999),
    type: type || 'video',
    src: String(src),
    start: Math.round(Number(start) * 1000) / 1000,
    in: Math.round(Number(inPoint) * 1000) / 1000,
    out: Math.round((Number(inPoint) + Number(dur)) * 1000) / 1000,
    speed: 1,
  }
  if (type === 'image') { delete c.in; delete c.out; c.duration = Number(dur) }
  if (volume !== undefined && type !== 'image') c.volume = Number(volume)
  if (fit) c.fit = fit
  return c
}

/** 造一个字幕/文字片段。文字用 duration 不是 out。 */
function textClip({ text, start = 0, dur = 3, size = 64, color = '#FFFFFF', x = 0.5, y = 0.84, align = 'center', anim = 'fade', height = 1920, plate, weight, maxWidth, lineHeight, tstyle, c2 }) {
  return {
    id: 'tx' + Date.now() + '-' + Math.floor(Math.random() * 99),
    type: 'text',
    text: String(text || ''),
    start: Math.round(Number(start) * 1000) / 1000,
    duration: Math.round(Number(dur) * 1000) / 1000,
    // ★ size 是**像素**，不是比例。渲染层写的是 font-size:${size}px ——
    //   第一版按比例存 0.045，编译出来是 font-size:0px，字幕存在但一个字看不见，
    //   而且不报错、闸门也过（时长分辨率都对）。传比例进来时按画布高度换算。
    size: (() => {
      const v = Number(size)
      if (!v || v <= 0) return 64
      return v < 1 ? Math.round(v * (Number(height) || 1920)) : Math.round(v)
    })(),
    color: String(color || '#FFFFFF'),
    x: Number(x) || 0.5, y: Number(y) === 0 ? 0 : (Number(y) || 0.84),
    opacity: 0.92, align, anim,
    // ★ 这三个是给「PPT 式整页文字」用的：
    //   plate:"0" 去掉那层深色底衬（演示稿不需要，白底上会变脏）；
    //   weight:700 标题加粗；maxWidth 限制行宽（一行 40 个字没人看得完）。
    plate: plate === undefined ? '1' : String(plate),
    ...(weight ? { weight: Number(weight) } : {}),
    ...(maxWidth ? { maxWidth: Number(maxWidth) } : {}),
    ...(lineHeight ? { lineHeight: Number(lineHeight) } : {}),
    fadeIn: 0.3, fadeOut: 0.3,
    /* 样式：tstyle 是样式 id（金渐变 gold、白中空 hollowW…），
       tcss 是当着色/副色确定后解析出来的声明串。
       ★ 两个都要存：tcss 让渲染端不用再查表（快且不会因为样式表改版漂移），
         tstyle 让界面回来时能高亮「当前选的是哪一款」。只存 tcss 的话，
         重新打开工程那 46 个格子里一个都不会亮。 */
    ...(tstyle ? { tstyle: String(tstyle) } : {}),
    ...(c2 ? { c2: String(c2) } : {}),
    ...(tstyle ? (() => {
      const lib = tsLib()
      const css = lib && lib.cssOf ? lib.cssOf(tstyle, color, c2) : ''
      return css ? { tcss: css } : {}
    })() : {}),
  }
}
