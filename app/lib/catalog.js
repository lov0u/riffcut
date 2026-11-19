'use strict'
/**
 * 只读目录层 —— 把「我们到底有哪些形状 / 布局 / 风格」从代码里读出来给模型。
 *
 * 为什么做成工具而不是写在提示词里：这些表会变（加一种形状、加一套风格），
 * 写死在提示词里就会过期。模型读到的是当前这份代码真实支持的东西，
 * 它照着写出来的方案立刻能用；反过来它自己编一个不存在的形状名，
 * 引擎会当硬切静默吞掉 —— 而模型永远不知道自己写错了。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')

/** 形状揭示的蒙版表（跟 engine.py 的 MASK_SHAPES 对齐）。 */
const MASK_SHAPES = {
  圆形: '255*lt(hypot(X-W/2,Y-H/2),max(1,R))',
  椭圆: '255*lt(pow((X-W/2)/(W*0.42),2)+pow((Y-H/2)/(H*0.34),2),1)',
  方形: '255*lt(max(abs(X-W/2),abs(Y-H/2)),max(1,R))',
  竖条: '255*lt(abs(X-W/2),max(1,R))',
  横条: '255*lt(abs(Y-H/2),max(1,R))',
  斜切: '255*lt(X+Y,W*0.9+max(1,R)*2)',
  圆角方形: '255*lt(max(abs(X-W/2),abs(Y-H/2)),max(1,R))',
}

const MASK_ALIAS = {
  圆: '圆形', 圈: '圆形', circle: '圆形',
  椭圆: '椭圆', ella: '椭圆',
  方: '方形', 方框: '方形', square: '方形',
  竖: '竖条', 竖线: '竖条', 竖条: '竖条',
  横: '横条', 横线: '横条', 横条: '横条',
  斜: '斜切', 对角: '斜切', 斜切: '斜切',
  圆角: '圆角方形', 圆角方: '圆角方形', rounded: '圆角方形',
}

/** 分屏布局：名字 → 方向与比例。 */
const SPLIT_LAYOUT = { 左右分屏: ['h', [0.5, 0.5]], 上下分屏: ['v', [0.5, 0.5]], 左大右小: ['h', [0.68, 0.32]], 左小右大: ['h', [0.32, 0.68]] }

/** 画中画能放的位置。 */
const PIP_POSITIONS = ['左上', '右上', '左下', '右下', '居中']

function maskShape(name) {
  const n = String(name || '').trim()
  if (!n) return ''
  if (MASK_SHAPES[n]) return n
  const low = n.toLowerCase()
  if (MASK_ALIAS[n]) return MASK_ALIAS[n]
  if (MASK_ALIAS[low]) return MASK_ALIAS[low]
  for (const k of Object.keys(MASK_SHAPES)) if (k.includes(n) || n.includes(k)) return k
  return ''
}

/** 形状揭示的说明。读这张表就知道有哪几种、怎么写。 */
function revealsText(kind) {
  let names = Object.keys(MASK_SHAPES)
  const want = kind ? maskShape(kind) : ''
  if (want) names = [want]
  const L = ['【形状揭示】这一段的画面从形状里长出来（grow）或者收进形状里（不 grow）。', '', '可用形状：' + names.join('、')]
  L.push('', '最简单的写法：直接写形状名。',
    '  {"asset":"素材.mp4","duration":3,"reveal":"圆形"}', '',
    '要细调就写对象：',
    '  {"asset":"素材.mp4","duration":3,',
    '   "reveal":{"shape":"圆形","dur":1.2,"grow":true,"feather":8,"bg":"#101A2E"}}', '',
    '  dur     形状从无到满用几秒。1.0~1.5 最常见；想更慢更高级就 2，',
    '          但超过这一段长度的 2/3 就没时间看清画面了。',
    '  grow    true 从小长满（片头）；false 从满收到没有（片尾）。默认 true。',
    '  feather 边缘羽化像素。0 = 硬边（干净利落），8~20 = 柔边（柔和高级）。',
    '          圆角方形必须带羽化，它的圆角就是糊出来的。',
    '  bg      形状之外露出来的底色。可以是 #颜色，也可以是一段视频路径',
    '          （拿上一段画面当底，接力感更强）。默认纯黑。', '',
    '三条实战判断：',
    '1. 全片用一次就够，通常放在第一个或最后一个镜头。每段都长一遍等于没有形状。',
    '2. 它和画中画/分屏互斥——一个镜头只能有一种「怎么出现」。',
    '3. 长出来的那一秒里，画面得真的有意思（人在做事、光在动）；',
    '   静止图配形状揭示，出来是「PPT 换页动画」。全片空白底色最容易露怯。')
  return L.join('\n')
}

/** 多画面写法。 */
function layoutsText(kind) {
  const g = String(kind || '').trim()
  const showSplits = !g || g.includes('分屏') || g.includes('split')
  const showPip = !g || g.includes('画中画') || g.includes('pip')
  const L = ['【多画面写法】一个镜头里放两个画面。两种做法，一个镜头只能用一种。', '']
  if (showPip) {
    L.push('■ 画中画（另一个画面叠在主画面上）',
      '  {"asset":"主素材.mp4","duration":3,',
      '   "inset":{"asset":"副素材.mp4","position":"右下","scale":0.32,"margin":32}}',
      '',
      `  position  ${PIP_POSITIONS.join(' / ')}`,
      '  scale     副画面占主画面宽度的比例。0.26~0.36 最常见；',
      '            超过 0.45 主画面就看不全了，小于 0.2 观众看不清副画面里是什么。',
      '  margin    离边缘的像素，默认 32。', '')
  }
  if (showSplits) {
    L.push('■ 分屏（两个画面各占一半）',
      '  {"asset":"左素材.mp4","duration":3,"layout":"左右分屏","inset":{"asset":"右素材.mp4"}}', '',
      '  可选：' + Object.keys(SPLIT_LAYOUT).map((k) => `${k}（${(SPLIT_LAYOUT[k][1][0] * 100).toFixed(0)}:${(SPLIT_LAYOUT[k][1][1] * 100).toFixed(0)}）`).join(' / '), '')
  }
  L.push('三条实战判断：',
    '1. 画中画适合「主画面在讲，副画面在证明」——口播的人 + 屏幕上的数据。',
    '2. 分屏适合「两边对比」——改前/改后、A/B、两种做法。没有对比关系就别分屏。',
    '3. 副画面里必须真的在动，静止的副画面看起来像贴了一张图。')
  return L.join('\n')
}

// ── 风格包 ─────────────────────────────────────────────
const STYLE_PACK_FILE = path.join(P.HOME, '内置', '风格包.json')
let _cache = { mt: null, data: null }

function stylePack() {
  try {
    const mt = fs.statSync(STYLE_PACK_FILE).mtimeMs
    if (_cache.mt === mt && _cache.data) return _cache.data
    const data = JSON.parse(fs.readFileSync(STYLE_PACK_FILE, 'utf8'))
    _cache = { mt, data: data && Array.isArray(data.styles) ? data : { styles: [] } }
    return _cache.data
  } catch { return { styles: [] } }
}

function styleList() {
  return (stylePack().styles || []).filter((s) => s && s.name).map((s) => ({
    name: String(s.name), slug: String(s.slug || ''), family: String(s.family || ''),
    for: String(s.for || s.best_for || ''), look: String(s.look || ''),
    sub: String(s.sub || ''), camera: String(s.camera || ''),
    transition: String(s.transition || ''), accent: String(s.accent || ''),
    bg: String(s.bg || ''), text: String(s.text || ''), no_music: !!s.no_music,
  }))
}

/** 按名字或 slug 找一套风格；认不出返回 null。 */
function styleFind(name) {
  const n = String(name || '').trim()
  if (!n) return null
  const all = styleList()
  for (const s of all) if (s.name === n || s.slug === n) return s
  // 宽松匹配：风格名里常带空格或括号后缀（「电影感（叙事）」）
  for (const s of all) if (s.name && n.includes(s.name)) return s
  for (const s of all) if (s.slug && n.toLowerCase().includes(s.slug)) return s
  return null
}

function styleText(name) {
  const all = styleList()
  if (!all.length) return '风格包读不出来：' + STYLE_PACK_FILE
  const one = name ? styleFind(name) : null
  if (one) {
    return [`【风格：${one.name}】`, `家族 ${one.family}｜适合：${one.for}`,
      `调色 ${one.look}｜字幕 ${one.sub}｜运镜 ${one.camera}｜转场 ${one.transition}`,
      `强调色 ${one.accent}｜底色 ${one.bg}｜文字色 ${one.text}${one.no_music ? '｜不要配乐' : ''}`,
      '', '写进方案：{"style":"' + one.name + '"}，出片时这一整套自动落到每个分镜上。'
    ].join('\n')
  }
  const byFamily = new Map()
  for (const s of all) {
    if (!byFamily.has(s.family)) byFamily.set(s.family, [])
    byFamily.get(s.family).push(s)
  }
  const L = [`【风格预设】共 ${all.length} 套。选一个名字写进方案的 style 字段，调色+字幕+运镜+转场会一起套用，不用一段段手写。`, '']
  for (const [fam, arr] of byFamily) {
    L.push(`■ ${fam || '其他'}（${arr.length}）`)
    for (const s of arr) L.push(`  ${s.name.padEnd(12, '　')} ${s.for}`)
    L.push('')
  }
  L.push('拿单套的完整参数就把名字传给 style。')
  return L.join('\n')
}

module.exports = { MASK_SHAPES, MASK_ALIAS, SPLIT_LAYOUT, PIP_POSITIONS, maskShape, revealsText, layoutsText, stylePack, styleList, styleFind, styleText, STYLE_PACK_FILE }
