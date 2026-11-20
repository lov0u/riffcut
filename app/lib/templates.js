// 模板库：457 个模板（448 可装 + 8 example 拒装）+ 用途分类 + 变量表 + 动画配方。
// 分类不照抄 registry 的 619 个技术标签 —— 那些是给作者检索用的，用户看不懂。
const { join, basename } = require('node:path')
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const P = require('./paths')

const CATS = [
  ['字幕', '口播的字幕条、逐词高亮、卡拉OK',
    ['caption-', 'caption_', '-caption', 'subtitle', 'karaoke', 'transcript']],
  ['下三分之一', '访谈/口播左下角的人名条',
    ['lower-third', 'lower third', 'lt-', 'name-bar', 'kicker']],
  ['转场', '两段素材之间的切换动画（要能接缝用）',
    ['transition', 'transitions-dev', 'crossfade', 'cross-fade', 'dissolve', 'wipe-transition', 'glitch-transition']],
  ['片头片尾', '开场、收尾、标题卡、logo 出场',
    ['intro', 'outro', 'title-card', 'opener', 'logo-reveal', 'end-card', 'credits', 'channel', 'subscribe']],
  ['图表数据', '数据可视化、计数、进度、统计',
    ['chart', 'graph', 'data-viz', 'counter', 'progress', 'stat-', 'metric', 'number-', 'ranking']],
  ['产品展示', 'App 界面、设备框、产品轮播',
    ['product', 'mock-ui', 'device', 'carousel', 'gallery', 'app-', 'screen-', 'ui-prop', 'phone', 'laptop', 'browser']],
  ['社媒包装', '聊天气泡、点赞、评论、社证卡',
    ['social', 'chat', 'message', 'tweet', 'comment', 'like-', 'proof', 'testimonial', 'review', 'notification', 'podcast']],
  ['文字动画', '大字、逐字入场、动态排版',
    ['typography', 'kinetic', 'type-', 'headline', 'quote', 'handwritten', 'text-', 'word-', 'title', 'font']],
  ['背景纹理', '极光、粒子、光效、底纹、3D 场景',
    ['background', 'shader', 'webgpu', 'webgl', 'particle', 'aurora', 'gradient', 'texture', 'noise', 'grain', 'glow', '3d', 'camera', 'liquid-glass', 'light-']],
  ['动效零件', '光标、拖尾、闪动这类单点特效，叠在画面上',
    ['cursor', 'effect', 'motion-primitive', 'blur', 'shake', 'bounce', 'reveal', 'fade', 'slide', 'scene', 'overlay']],
]
const OTHER = ['其他', '还没归类的']

const ZH_QUERY = {
  '字幕': ['字幕', '口播', '卡拉', '高亮', '逐词'],
  '下三分之一': ['人名', '三分之一', '访谈', '嘉宾'],
  '转场': ['转场', '过渡', '切换'],
  '片头片尾': ['片头', '片尾', '开场', '结尾', '标题'],
  '文字动画': ['大字', '文字', '排版', '字'],
  '图表数据': ['图表', '数据', '统计', '计数', '进度'],
  '产品展示': ['产品', '手机', '界面', '轮播', '展示'],
  '背景纹理': ['背景', '粒子', '极光', '光效', '底'],
  '社媒包装': ['聊天', '点赞', '订阅', '评论', '社媒'],
  '动效零件': ['光标', '特效', '闪', '抖动', '模糊'],
}

// UI 微交互长得像转场，其实不是 —— 演的是「界面上点了一下」，放转场里会误导。
const UI_KEYS = ['transitions.dev', 'transitions-dev', 'button', 'dropdown', 'toggle', 'modal',
  'toolbar', 'checkbox', 'menu', 'input-feedback', 'badge', 'avatar-group', 'card-resize',
  'icon-swap', 'success-check', 'number-pop-in', 'micro-transitions']

function classify(meta) {
  const blob = [meta.name, meta.title, meta.description, ...(meta.tags || [])].join(' ').toLowerCase()
  if (UI_KEYS.some(k => blob.includes(k))) return '动效零件'
  for (const [name, , keys] of CATS) if (keys.some(k => blob.includes(k))) return name
  return OTHER[0]
}

function tplRoot() { return P.RES_TEMPLATES }
function registryRoot() { return join(tplRoot(), 'registry') }
function thumbsRoot() { return join(tplRoot(), 'thumbs') }

/**
 * ★ 2026-11-20：两类「有中文就别用」的陷阱模板，集中标记，不逐个改 448 个 json。
 * 命中后 catalog() 会给条目带 trap 字段，templates 工具列表和提示词都会显示，
 * AI 看到中文内容就能自己避开；addtemplate 还会做硬兜底告警。
 *
 * 两类判据：
 *   中文缺字形 —— 文字走 Geist/typeface.json 拉丁字形做 3D 挤出或描摹，中文渲染成 ?? 或空白
 *   （KB-254 已记 frost 同类坑；extruded-logo 实测「青衣 Cyanweb」→「?? CYANW」）。
 *   静态收尾卡 —— 动效结束后完全静止的 end card，整片只用它会被引擎判「静止画面」打回。
 *
 * glass-hero / logo-outro 不在此表：它们用普通 DOM 文字、有平滑动效，中文正常。
 */
const TRAPS = {
  // 文字走拉丁字形 → 中文变 ?? / 空白，有中文换 glass-hero
  'extruded-logo':                 { kind: '中文缺字形', note: 'Geist 拉丁字库做 3D 挤出，中文渲染成 ?? 或空白；有中文换 glass-hero' },
  'frost-sequence-camera-orbit':   { kind: '中文缺字形', note: 'Geist 拉丁字体，中文渲染空白；中文放字幕轨或换模板' },
  'glass-shard-title':             { kind: '中文缺字形', note: 'Geist 拉丁字体，中文可能变 ??；有中文换 glass-hero' },
  'wireframe-portal-title':        { kind: '中文缺字形', note: 'Geist 拉丁字体；有中文换 glass-hero' },
  'variable-font-flex':            { kind: '中文缺字形', note: '可变拉丁字体，中文可能缺字；有中文换普通文字模板' },
  // 动完完全静止 → 整片只用会被判静止画面打回，用带动画 block
  'cta-close':                     { kind: '静态收尾卡', note: '动完完全静止，会被交付闸门判「静止画面」打回；用 logo-outro / glass-hero' },
  'cta-lockup':                    { kind: '静态收尾卡', note: '同上：静态收尾卡，别单独成片' },
  'logo-brand-close':              { kind: '静态收尾卡', note: '同上：静态收尾卡，别单独成片' },
}

/**
 * 模板目录。只扫 blocks / components —— examples/ 是「整场戏」完整示例，
 * 不是能装进时间线的模板，混进卡片墙点「装进工程」必然失败。
 */
let _cache = null
function catalog(force = false) {
  if (_cache && !force) return _cache
  const base = registryRoot()
  const thumbs = thumbsRoot()
  const out = []
  for (const [kind, dirname] of [['block', 'blocks'], ['component', 'components']]) {
    const d = join(base, dirname)
    if (!existsSync(d)) continue
    let names
    try { names = readdirSync(d) } catch { continue }
    for (const n of names.sort()) {
      const j = join(d, n, 'registry-item.json')
      if (!existsSync(j)) continue
      let m
      try { m = JSON.parse(readFileSync(j, 'utf8')) } catch { continue }
      const dm = m.dimensions || {}
      const pv = m.preview || {}
      const nm = m.name || n
      const localThumb = existsSync(join(thumbs, nm + '.png'))
      out.push({
        name: nm, kind, cat: classify(m),
        title: m.title || n,
        desc: String(m.description || '').slice(0, 160),
        duration: m.duration,
        w: dm.width, h: dm.height,
        preview: pv.video || '',
        poster: localThumb ? `/tplthumb/${nm}.png` : (pv.poster || ''),
        tags: m.tags || [],
        hasThumb: localThumb,
        trap: TRAPS[nm] || null,   // ★ 有中文内容要避开的陷阱标记（见 TRAPS 表）
      })
    }
  }
  _cache = out
  return out
}

function stats(items) {
  items = items || catalog()
  const m = {}
  for (const x of items) {
    if (!m[x.cat]) m[x.cat] = { n: 0, cat: x.cat }
    m[x.cat].n++
  }
  return m
}

function _zhCats(query) {
  const q = String(query || '').toLowerCase()
  return Object.entries(ZH_QUERY).filter(([, ws]) => ws.some(w => q.includes(w))).map(([c]) => c)
}

function search(items, query = '', cat = '', kind = '') {
  items = items || catalog()
  const q = String(query || '').trim().toLowerCase()
  const cats = _zhCats(q)
  return items.filter(x => {
    if (kind && x.kind !== kind) return false
    if (cat && x.cat !== cat) return false
    if (!q) return true
    if (cats.length && cats.includes(x.cat)) return true
    const blob = [x.name, x.title, x.desc, x.cat, ...(x.tags || [])].join(' ').toLowerCase()
    return blob.includes(q)
  })
}

// ── 变量表 ────────────────────────────────────────────
const VAR_ATTR = /data-composition-variables\s*=\s*'(\[.*?\])'/s

function readVars(htmlPath) {
  let s
  try { s = readFileSync(htmlPath, 'utf8') } catch { return [] }
  const m = s.match(VAR_ATTR)
  if (!m) return []
  let raw = m[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(v => v && v.id).map(v => ({
      id: v.id, type: v.type, label: v.label || v.id,
      default: v.default, options: v.options,
      description: v.description || '',
      role: v.role || '',
    }))
  } catch { return [] }
}

/** 找某个模板声明的可改项。 */
function varsFor(which, tplName) {
  const base = registryRoot()
  for (const dirname of ['blocks', 'components']) {
    const d = join(base, dirname, tplName)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.html')) continue
      const v = readVars(join(d, f))
      if (v.length) return v
    }
  }
  return []
}

function itemMeta(name) {
  const base = registryRoot()
  for (const dirname of ['blocks', 'components']) {
    const j = join(base, dirname, name, 'registry-item.json')
    if (!existsSync(j)) continue
    try { return JSON.parse(readFileSync(j, 'utf8')) } catch { return null }
  }
  return null
}

function htmlOf(name) {
  const base = registryRoot()
  for (const dirname of ['blocks', 'components']) {
    const d = join(base, dirname, name)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) if (f.endsWith('.html')) return join(d, f)
  }
  return null
}

// ── 动画配方（拆模板怎么动的手脚）──────────────────────
function recipe(name) {
  const all = catalog()
  const meta = itemMeta(name)
  if (!meta) {
    const near = all.filter(x => x.name.includes(name) || name.includes(x.name)).slice(0, 5).map(x => x.name)
    return { error: `模板库里没有「${name}」`, near }
  }
  const html = htmlOf(name)
  let src = ''
  try { src = html ? readFileSync(html, 'utf8') : '' } catch {}

  // 进场缓动：抓 gsap ease 字符串
  const eases = {}
  for (const m of src.matchAll(/ease\s*:\s*["']([a-zA-Z0-9.\-]+)["']/g)) {
    eases[m[1]] = (eases[m[1]] || 0) + 1
  }
  // 持续时间
  const durs = {}
  for (const m of src.matchAll(/duration\s*:\s*([0-9.]+)/g)) {
    const v = parseFloat(m[1])
    if (v > 0 && v < 30) durs[v] = (durs[v] || 0) + 1
  }
  // 相邻错开
  const gaps = {}
  for (const m of src.matchAll(/stagger\s*:\s*([0-9.]+)/g)) {
    const v = parseFloat(m[1])
    if (v > 0 && v < 5) gaps[v] = (gaps[v] || 0) + 1
  }
  const dim = meta.dimensions || {}
  const cls = classify(meta)
  return {
    name, title: meta.title || name, 这类: cls,
    时长: meta.duration || 0,
    画幅: dim.width ? `${dim.width}x${dim.height}` : '',
    进场缓动: Object.entries(eases).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, n]) => ({ ease: e, 次数: n })),
    持续时间: Object.entries(durs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s, n]) => ({ 秒: Number(s), 次数: n })),
    相邻间隔: Object.keys(gaps).map(Number).sort((a, b) => a - b).slice(0, 6),
    怎么抄: _howToCopy(cls, eases, durs, gaps),
    说明: String(meta.description || '').slice(0, 200),
  }
}

function _howToCopy(cls, eases, durs, gaps) {
  const ease = Object.entries(eases).sort((a, b) => b[1] - a[1])[0]
  const dur = Object.entries(durs).sort((a, b) => b[1] - a[1])[0]
  const gap = Object.keys(gaps).map(Number).sort((a, b) => a - b)[0]
  const parts = []
  if (ease) parts.push(`进场的缓动是 ${ease[0]}，你自己的动画也用这个曲线，别用默认的 linear`)
  if (dur) parts.push(`单段动作用 ${dur[0]} 秒，快了显得慌、慢了显得拖`)
  if (gap) parts.push(`多个元素之间错开 ${gap} 秒，一起进场会糊成一团`)
  if (cls === '转场') parts.push('转场要卡在接缝上：前一段最后 0.3 秒开始动，后一段第一帧就到位')
  if (cls === '字幕') parts.push('字幕跟着口播走，一句一个字幕，别一整段塞一行')
  if (!parts.length) parts.push('这个模板的动作参数写在 JS 里不好拆，建议直接装进工程看效果')
  return parts.join('；')
}

/** 找同族模板（同类别、同画幅、时长接近）。 */
function family(name, limit = 8) {
  const all = catalog()
  const meta = itemMeta(name)
  if (!meta) {
    const near = all.filter(x => x.name.includes(name) || name.includes(x.name)).slice(0, 5).map(x => x.name)
    return { error: `模板库里没有「${name}」`, near }
  }
  const cls = classify(meta)
  const dim = meta.dimensions || {}
  const dur = Number(meta.duration) || 0
  const same = all.filter(x => x.name !== name && x.cat === cls)
  same.sort((a, b) => {
    const da = Math.abs((a.duration || 0) - dur) + (a.w === dim.width ? 0 : 2)
    const db = Math.abs((b.duration || 0) - dur) + (b.w === dim.width ? 0 : 2)
    return da - db
  })
  return {
    本体: { name, title: meta.title || name, duration: meta.duration || 0, cat: cls },
    同族: same.slice(0, limit).map(x => ({ name: x.name, title: x.title, duration: x.duration, desc: x.desc.slice(0, 60) })),
  }
}

module.exports = {
  CATS, OTHER, ZH_QUERY, UI_KEYS, classify, TRAPS,
  catalog, stats, search, readVars, varsFor, itemMeta, htmlOf, recipe, family,
  tplRoot, registryRoot, thumbsRoot,
}
