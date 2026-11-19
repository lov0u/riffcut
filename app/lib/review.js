'use strict'
/**
 * 看成片 —— 把刚剪出来的片子摊开给模型看：结构表 + 图墙。
 *
 * 为什么是这两样而不是「逐帧全看」：
 *  · 结构表管「这条片子是怎么拼起来的」——每段几秒到几秒、素材是什么、
 *    怎么接进来的。时间轴本身就能读出硬伤（某段 0.4 秒太短、相邻两段
 *    用了同一素材、转场种类换得眼花）。
 *  · 图墙管「画面上到底有没有东西」——一次看完节奏。一次送三十张小图给
 *    视觉模型 token 是三十倍，拼成一张就便宜得多；代价是每格变糙，
 *    要看清某一格的具体表情还得单独抽那一秒。
 *
 * 只给结构表也能干活：没有视觉模型的纯文本模型照样能凭时间轴判断节奏。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')
const M = require('./models')
const Plan = require('./plan')
const Media = require('./media')

const REVIEW_WALL_COLS = 5
const REVIEW_WALL_MAX = 30

/**
 * 成片的结构：每段第几秒到第几秒、用的什么、怎么接的。
 *
 * 起点用和转场合成完全相同的累积算法：转场让两段重叠，后一段的起点 =
 * 当前累计长度 − 这次转场吃掉的时长。不这么算，结构表上的秒数跟成片
 * 就对不上，模型指出的「第几秒不对」也就跟着错。
 */
function timelineText(planData, project, video) {
  const shots = (planData && planData.shots) || []
  const durs = shots.map((x) => Number(x.duration) || 3)
  const trans = shots.map((x) => String(x.transition || ''))
  const eff = trans.map((t, i) => (i === 0 ? 0 : Plan.effTrans(durs, trans)[i - 1] || 0))

  const lines = []
  let acc = durs.length ? durs[0] : 0
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i]
    const st = i === 0 ? 0 : Math.max(0, acc - (eff[i - 1] || 0))
    const bits = [`${i + 1}. ${st.toFixed(1)}s~${(st + durs[i]).toFixed(1)}s ${durs[i].toFixed(1)}s`, `素材=${sh.asset || '?'}`]
    if (sh.start !== undefined && sh.start !== null) bits.push(`入点=${Number(sh.start).toFixed(1)}s`)
    if (trans[i] && i > 0) bits.push('接=' + trans[i])
    if (sh.layout) bits.push(`分屏=${sh.layout}（副画面 ${(sh.inset && sh.inset.asset) || '?'}）`)
    else if (sh.inset) bits.push(`画中画=${sh.inset.asset || '?'}@${sh.inset.position || '右下'}`)
    if (sh.speed && Math.abs(Number(sh.speed) - 1) > 0.01) bits.push(`速度=${Number(sh.speed).toFixed(2)}x`)
    if (sh.caption) bits.push('字幕=' + String(sh.caption).slice(0, 24))
    lines.push('  ' + bits.join(' | '))
    acc = i === 0 ? durs[0] : acc + durs[i] - (eff[i - 1] || 0)
  }
  let head = '【这条片子是怎么拼起来的】'
  if (video && fs.existsSync(video)) head = `【这条片子是怎么拼起来的】成片 ${(videoDur(video) || 0).toFixed(2)} 秒，${shots.length} 段`
  else if (shots.length) head += `${shots.length} 段`
  return head + (lines.length ? '\n' + lines.join('\n') : '\n（没有分镜结构，只有成片文件）')
}

function videoDur(file) {
  try {
    const out = require('node:child_process').execFileSync(P.FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 20_000 })
    return Number(String(out).trim()) || 0
  } catch { return 0 }
}

/** 反查这条成片是哪个工程出的（草稿也算）。 */
function findProjectByOutput(video) {
  const want = path.basename(video)
  let names = []
  try { names = require('./timeline').listProjects().map((x) => x.name || x) } catch { return null }
  for (const n of names) {
    try {
      const d = require('./timeline').load(n)
      const o = d.output || {}
      const main = o['主成片'] ? path.basename(o['主成片']) : ''
      const draft = o['草稿'] ? path.basename(o['草稿']) : ''
      if (main === want || draft === want) return { name: n, doc: d }
    } catch {}
  }
  return null
}

/**
 * 把成片摊开给模型看：结构表 + 图墙 → 它自己说哪里不对。
 *
 * 返回 {ok, wall, timeline, report, model}。没有视觉模型时只给结构表，
 * 让纯文本模型也能凭时间轴判断节奏。
 */
async function reviewOutput(opts = {}) {
  const out = { ok: false, wall: null, timeline: '', report: '', model: '' }
  let video = String(opts.video || '').trim()
  let planData = opts.data || null
  let project = String(opts.project || '').trim()

  if (!video && project) {
    try {
      const doc = require('./timeline').load(project)
      video = String((doc.output || {})['主成片'] || (doc.output || {})['草稿'] || '')
      if (!planData) planData = doc.plan || Plan.planFromTimeline(doc)
    } catch (e) { return { ...out, report: '打不开这个工程：' + e.message } }
  }
  if (!video) return { ...out, report: '没有成片可看：要么给 video 路径，要么给 project 名字。' }
  if (!fs.existsSync(video)) return { ...out, report: '这个成片文件不在了：' + video }

  // 只拿到成片路径时，反查是哪个工程出的 —— 没有结构表，模型只能猜段落
  if (!planData && !project) {
    const hit = findProjectByOutput(video)
    if (hit) {
      project = hit.name
      planData = hit.doc.plan || Plan.planFromTimeline(hit.doc)
    }
  }

  out.timeline = timelineText(planData, project, video)
  try {
    out.wall = await Media.contactSheet(video, { maxTiles: Number(opts.maxTiles) || REVIEW_WALL_MAX })
  } catch (e) { out.wall = null }

  const mid = require('./image').findVisionModel(opts.model)
  if (!mid) {
    out.report = '没有配视觉模型，只能给你结构表。凭时间轴也能看出不少问题——某段特别短、相邻两段用同一素材、转场种类太多，这些都是硬伤。'
    return out
  }

  const dur = videoDur(video)
  let text = '这是我刚剪出来的一条片子，你帮我看。\n\n' + out.timeline + '\n\n'
  if (out.wall) {
    text += `下面是一张图墙：按时间从左到右、从上到下排，共 ${out.wall.tiles} 格，每格约隔 ${(dur / out.wall.tiles).toFixed(1)} 秒。格子上没有标时间，你要自己按顺序对。\n`
  }
  text += `
我要你说的是：
1. 节奏——哪一段太长让人走神、哪一段太短还没看清就过去了（指出第几段）；
2. 接点——哪两段之间跳、方向反了、或者同一个画面用了两次；
3. 画面——有没有段落黑着、糊着、明显是废镜头；
4. 只说真看得出来的问题。看不出来就说看不出来，不要凑数。每条都写清「第几段、什么问题、怎么改」。`

  try {
    const content = [{ type: 'text', text }]
    if (out.wall) {
      const b64 = fs.readFileSync(out.wall.path).toString('base64')
      content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } })
    }
    const r = await M.chat(mid, [{ role: 'user', content }], { maxTokens: 1600 })
    if (!r || !r.ok) {
      out.report = '看片时模型出错了：' + ((r && r.error) || '没回话')
      return out
    }
    out.report = String(r.text || '').trim()
    out.model = r.model || mid
    out.ok = true
  } catch (e) {
    out.report = '看片时模型出错了：' + e.message
  }
  return out
}

/** 摊成人读的几段。 */
function reviewReport(r) {
  const L = [r.timeline || '']
  if (r.wall) {
    L.push(`\n图墙：${r.wall.tiles} 格（${r.wall.cols} 列 × ${r.wall.rows} 行），约每 ${r.wall.step.toFixed(1)} 秒一格 → ${r.wall.path}`)
  }
  if (r.report) L.push('\n【看下来是这样】\n' + r.report)
  return L.filter(Boolean).join('\n')
}

module.exports = { REVIEW_WALL_COLS, REVIEW_WALL_MAX, timelineText, findProjectByOutput, reviewOutput, reviewReport, videoDur }
