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
/**
 * 把一个模板的**编排语法**拆出来 —— 这是给 AI 学「怎么设计内容」用的，不是给复制用的。
 *
 * ★ 为什么要区分「编排语法」和「素材」
 *   模板的价值不是「这段 5 秒画面可以直接用」，而是它演示了一套组织视听信息的方法：
 *   几秒换一个信息块、块内元素怎么错开、不同类型的动作配什么缓动、
 *   强调靠什么手段（缩放/呼吸/位移）。AI 学会这套语法，就能用**自己的内容**
 *   写出一分钟同风格的片子，而不是把 5 秒模板复制 12 遍。
 *
 * ★ 从源码里能可靠抽到的东西
 *   1. 拍子（beats）：`tl.to(..., 绝对秒)` 第三个参数就是编排时刻。聚成簇就是「第几拍」。
 *   2. 错开量（stagger）：同一拍内相邻时刻的差，通常在 0.1~0.4 秒。
 *   3. 缓动语义（ease → 用途）：back.out 用于「弹出来」、power3.out 用于「快速到位」、
 *      sine.inOut 用于「呼吸/脉动」、expo.out 用于「猛地冲进来」。这是配色的那个"色板"。
 *   4. 变化维度（哪些属性在动）：opacity / scale / x / y / width / filter —— 决定
 *      「这个模板靠什么制造动感」，也就决定 AI 复用时要动哪些属性才像。
 */
function choreo(name) {
  const meta = itemMeta(name)
  if (!meta) return { error: `模板库里没有「${name}」` }
  const f = htmlOf(name)
  let src = ''
  try { src = f ? readFileSync(f, 'utf8') : '' } catch { return { error: '读不到模板源码' } }
  const design = Number(meta.duration) || 0

  /* 1. 拍子：抓 gsap 调用末尾的绝对时间参数 */
  const reCall = /tl\.(to|from|fromTo|set|add)\s*\(([\s\S]{0,400}?)\)\s*;/g
  const easeTally = {}
  const propTally = {}
  const calls = []
  let m
  while ((m = reCall.exec(src))) {
    const body = m[2]
    const at = body.match(/,\s*(-?[0-9][0-9.]*)\s*$/)
    const dm = body.match(/duration\s*:\s*([0-9.]+)/)
    const em = body.match(/ease\s*:\s*["']([a-zA-Z0-9.()\-]+)["']/)
    const props = [...body.matchAll(/\b(opacity|scale|scaleX|scaleY|x|y|width|height|rotation|filter|clipPath|blur)\s*:/g)].map(x => x[1])
    if (em) easeTally[em[1]] = (easeTally[em[1]] || 0) + 1
    for (const pp of props) propTally[pp] = (propTally[pp] || 0) + 1
    calls.push({ at: at ? Number(at[1]) : null, dur: dm ? Number(dm[1]) : 0.4, props })
  }

  /* ★ 两种时刻口径，优先用绝对时间。
     模板写 `tl.to(x, {...}, 2.1)` 时那个 2.1 是**确定的编排时刻**，最准。
     写 `tl.to(x, {...})` 不带第三个参数时，gsap 会接在时间轴末尾，只能靠
     duration 累加推算 —— 够判节拍，但会被零碎的 set/add 带偏
     （实测 app-showcase 混入推算后，3 拍变 2 拍、每拍 2 秒变 7.5 秒，结论全歪）。
     所以：绝对时刻能聚出 >= 2 拍，就只用绝对时刻；否则才退回推算。 */
  const beats = new Map()
  const absTimes = calls.filter(c => c.at != null && c.at >= 0 && c.at < 600).map(c => Math.round(c.at * 10) / 10)
  if (absTimes.length) {
    for (const t of absTimes) beats.set(t, (beats.get(t) || 0) + 1)
  }
  let usedRelative = false
  if (beats.size < 2) {
    usedRelative = true
    beats.clear()
    let cursor = 0
    for (const c of calls) {
      let t
      if (c.at != null && c.at >= 0 && c.at < 600) { t = c.at; cursor = c.at }
      else { t = Math.round((cursor + c.dur) * 10) / 10; cursor = t }
      const key = Math.round(t * 10) / 10
      beats.set(key, (beats.get(key) || 0) + 1)
    }
  }

  /* 2. 把时刻聚成「拍」：相邻时刻差 < 0.8 秒的算同一拍 */
  const times = [...beats.keys()].sort((a, b) => a - b)
  const groups = []
  for (const t of times) {
    const last = groups[groups.length - 1]
    if (last && t - last[last.length - 1] < 0.8) last.push(t)
    else groups.push([t])
  }
  const 拍子 = groups.map((g, i) => ({
    第几拍: i + 1,
    开始: g[0],
    结束: g[g.length - 1],
    元素数: g.reduce((s, t) => s + (beats.get(t) || 0), 0),
    错开: g.length > 1 ? Math.round(((g[g.length - 1] - g[0]) / (g.length - 1)) * 100) / 100 : 0,
  }))

  /* 3. 拍与拍的间隔 —— 决定「多少秒换一个信息块」 */
  const 拍间隔 = []
  for (let i = 1; i < 拍子.length; i++) {
    拍间隔.push(Math.round((拍子[i].开始 - 拍子[i - 1].开始) * 10) / 10)
  }

  /* 4. 缓动语义：把 gsap 的曲线名翻译成「什么时候用」 */
  const EASE_SENSE = {
    'back.out': '弹性回弹：元素"弹"出来，适合卡片/图标登场，有一点点过头再回来',
    'elastic.out': '强弹性：甩进来的感觉，别用在正文，容易累',
    'expo.out': '猛地冲进来然后立刻稳住，适合标题、大招',
    'power4.out': '快速冲刺后急停，适合重点数字',
    'power3.out': '快速到位，最通用的"进场"，不抢戏',
    'power2.out': '缓一些的到位，适合次级元素、辅助信息',
    'power1.out': '柔和，适合背景类变化',
    'sine.inOut': '来回呼吸/脉动，适合强调循环、数据高亮',
    'power1.inOut': '平滑来回，适合位移往复',
    'none': '匀速，适合进度、扫描线、旋转',
    'linear': '匀速，同上',
  }
  /* ★ 缓动要按「用途」分类，不能只按出现次数排序。
     实测 app-showcase 出现最多的是 sine.inOut（6 次），但它是用来做数据高亮的
     呼吸感；真正负责"进场"的是 back.out / power3.out。AI 拿到"主缓动 sine.inOut"
     就会把所有元素都做成慢慢脉动，画面一片发虚。
     所以分成「进场」「强调」「循环」三档，AI 该用哪档用哪档。 */
  const EASE_ROLE = {
    'back.out': '进场', 'elastic.out': '进场', 'expo.out': '进场',
    'power4.out': '进场', 'power3.out': '进场', 'power2.out': '进场', 'power1.out': '进场',
    'sine.inOut': '循环', 'power1.inOut': '循环', 'none': '循环', 'linear': '循环',
    'power2.in': '退场', 'power3.in': '退场', 'power4.in': '退场', 'back.in': '退场',
  }
  const 缓动全 = Object.entries(easeTally).sort((a, b) => b[1] - a[1]).map(([e, n]) => {
    const base = e.split('(')[0]
    return { 曲线: e, 次数: n, 用途: EASE_ROLE[base] || EASE_ROLE[e] || '其它', 用在: EASE_SENSE[base] || EASE_SENSE[e] || '' }
  })
  const 缓动 = 缓动全.slice(0, 8)
  /* 真正的进场缓动：从「进场」档里按"通用程度"挑，不按次数。
     依据：power3.out 是最通用的进场（快速到位不抢戏），back.out 带弹性适合卡片，
     power1.out 太软、只适合背景层。模板里三者次数接近时，选错的会误导 AI。 */
  const 进场优先 = ['power3.out', 'power2.out', 'expo.out', 'back.out', 'power4.out', 'elastic.out', 'power1.out']
  const 进场候选 = 缓动全.filter(x => x.用途 === '进场').map(x => x.曲线.split('(')[0])
  const 进场缓动 = 进场优先.find(e => 进场候选.includes(e)) || 进场候选[0] || 'power3.out'
  const 强调缓动 = ((缓动全.find(x => x.用途 === '循环' && !/^(none|linear)$/i.test(x.曲线.split('(')[0])) || {}).曲线) || 进场缓动

  /* 5. 变化维度 —— 这个模板靠什么制造动感 */
  const PROPS_CN = {
    opacity: '透明度（淡入淡出，几乎所有模板的底子）',
    scale: '缩放（放大吸引注意，缩小让位）',
    x: '横向位移（从侧面滑入）',
    y: '纵向位移（从下往上抬升）',
    width: '宽度（数据条、进度条生长）',
    height: '高度',
    rotation: '旋转',
    filter: '滤镜（模糊、亮度，做景深/光感）',
    clipPath: '遮罩（擦除式揭示）',
  }
  const 变化维度 = Object.entries(propTally).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([p, n]) => ({ 属性: p, 次数: n, 说明: PROPS_CN[p] || '' }))

  const 每拍秒数 = 拍间隔.length ? Math.round((拍间隔.reduce((a, b) => a + b, 0) / 拍间隔.length) * 10) / 10 : design

  return {
    模板: name,
    标题: meta.title || name,
    这类: classify(meta),
    设计时长: design,
    画幅: (meta.dimensions && meta.dimensions.width) ? `${meta.dimensions.width}x${meta.dimensions.height}` : '',
    拍子数: 拍子.length,
    时刻口径: usedRelative ? '相对（模板没写绝对时间，按动作时长累加推算）' : '绝对（模板里写死的编排时刻）',
    每拍秒数,
    拍子,
    排法: 拍间隔.length
      ? `每 ${每拍秒数} 秒换一个信息块，一共 ${拍子.length} 拍；每一拍里 ${拍子.reduce((s, b) => s + b.元素数, 0)} 个元素分 ${Math.round(拍子.reduce((s, b) => s + b.元素数, 0) / 拍子.length)} 批错开进场`
      : `只有一拍（${design || '?'} 秒），没有"几秒换一个信息块"的分拍结构。这个模板教给你的是"氛围"和"整体运镜"，不是信息节奏——拿它当背景层，文字/数据自己按别的节奏排`,
    缓动,
    进场缓动,
    强调缓动,
    变化维度,
    教给你什么: _choreoLesson({ 拍子, 每拍秒数, 缓动, 进场缓动, 强调缓动, 变化维度, design }),
  }
}

function _choreoLesson(o) {
  const { 拍子, 每拍秒数, 缓动, 进场缓动, 强调缓动, 变化维度, design } = o
  const L = []
  if (每拍秒数 > 0 && 拍子.length > 1) {
    L.push(`节奏骨架：${每拍秒数} 秒一个信息块。你的长片按这个节拍切内容 —— 60 秒就是 ${Math.round(60 / 每拍秒数)} 个信息块，一块只讲一件事`)
  } else if (design > 0) {
    L.push(`这个模板没有分拍结构（连续驱动），它的价值在"氛围"：整片用它当背景层，文字/数据用别的轨道叠上去`)
  }
  const s0 = 拍子[0]
  if (s0 && s0.错开 > 0) {
    L.push(`同拍内错开 ${s0.错开} 秒：一块内容里的几个元素不要同时出现，依次进场才有层次`)
  }
  if (进场缓动) {
    const e = 缓动.find(x => x.曲线 === 进场缓动) || {}
    L.push(`进场用 ${进场缓动}${e.用在 ? ' —— ' + e.用在 : ''}。元素"登场"一律用这条曲线，别用 sine 那种，会显得发虚`)
  }
  if (强调缓动 && 强调缓动 !== 进场缓动) {
    const e = 缓动.find(x => x.曲线 === 强调缓动) || {}
    L.push(`强调/呼吸用 ${强调缓动}${e.用在 ? ' —— ' + e.用在 : ''}。只用在"要人注意的那个数"上，别全场都用`)
  }
  const p0 = 变化维度[0]
  if (p0) {
    L.push(`动感来源主要是 ${p0.属性} —— ${p0.说明}。要像它，就得把主要动作放在这个属性上，别乱加别的`)
  }
  L.push('复制这个模板的画面没有意义；照着它的节奏/错开/缓动/变化维度，写你自己的内容才有意义')
  return L
}

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
    拉长: stretchProfile(src, name, meta),
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

/**
 * 这个模板能不能把时长拉长、拉长后是什么效果 —— 给 AI 判断「用同一个模板铺满长片」怎么下手。
 *
 * ★ 为什么必须区分类型（448 个模板全量普查出来的四类）
 *   HyperFrames 定子合成时长用的是模板自己的 data-duration（见 render.js addTemplate
 *   里的注释），我们已经会把片段时长同步进去，但**拉长后画面表现取决于模板怎么驱动动画**：
 *     B 归一化 26 个：`t / duration` 驱动，拉多长就演多长，最理想。
 *     A 连续  8 个：`Math.sin(t*0.55)` 这类无限函数，拉多长都自然。
 *     C 演完停 156 个：`tl.to({}, {duration:dur}, 0)` 只是把时间轴补到全长，
 *                     动画本身演完就停在最后一帧 —— 后半段是静止画面。
 *     D 固定 258 个：完全不读 duration，改了一点用都没有。
 *   C/D 占 92%，所以「拖长片段」对绝大多数模板是无效操作。真正的解法是
 *   **同一模板多段接力**：每段 3~6 秒，内容换掉，动画语言完全一致。
 */
function stretchProfile(src, name, meta) {
  const design = Number(meta && meta.duration) || 0
  const readsDur = /dataset\.duration|getAttribute\(['"]data-duration/.test(src)
  const norm = /(t|time|elapsed)\s*\/\s*(host\.)?(duration|dur)\b|\/\s*(host\.)?duration\s*\*/.test(src)
  const cont = /Math\.(sin|cos)\(\s*(t|clock\.t|state\.t)\s*\*|[^a-zA-Z]t\s*\*\s*0\.\d+/.test(src)
  const pad = /pad to full|tl\.to\(\{\}\s*,\s*\{\s*duration/.test(src)
  let kind, 拉长后, 怎么用
  if (norm) {
    kind = 'B归一化'
    拉长后 = '动画跟着时长整体放慢，任何长度都铺满，不会停'
    怎么用 = '直接装进时间线拉长就行；但拉太长会变慢，超过 3 倍设计时长建议改用多段接力'
  } else if (cont) {
    kind = 'A连续'
    拉长后 = '按连续时间驱动，拉多长都自然，不会停也不会变慢'
    怎么用 = '直接拉长最省事；内容多的片子用它当背景层，再叠文字片段说明'
  } else if (pad || readsDur) {
    kind = 'C演完停'
    拉长后 = `动画按设计节奏演完（约 ${design || '原设计'} 秒）就停在最后一帧，之后是静止画面`
    怎么用 = `别硬拉长。用同一个模板装 ${Math.max(2, Math.ceil((design || 4) ? 60 / (design || 4) : 12))} 段接力，每段换内容（改字），段间不留缝，视觉语言完全一致`
  } else {
    kind = 'D固定'
    拉长后 = '完全不读时长，拉长没有任何效果，后半段死帧'
    怎么用 = '只能多段接力：同一模板重复装，每段换内容；或者把它当片头片尾装饰，中间内容用别的轨表达'
  }
  return {
    类型: kind,
    设计时长: design,
    读时长: readsDur,
    拉长后,
    怎么用,
    /* 一段多长最像原设计：不超过设计时长，太短会切掉动作，太长会停在半路 */
    建议单段: design > 0 ? Math.round(Math.min(design, Math.max(2, design)) * 10) / 10 : 4,
  }
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
  catalog, stats, search, readVars, varsFor, itemMeta, htmlOf, recipe, stretchProfile, choreo, family,
  tplRoot, registryRoot, thumbsRoot,
}
