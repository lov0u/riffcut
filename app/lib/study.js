'use strict'
/**
 * 量一条参考片子 —— 用户发来一条片子说「照这条剪」时，先量它。
 *
 * 为什么要有：AI 靠印象去猜「感觉剪得快一点」，猜出来的不是那条片子。
 * 真正能对齐的是**数字**：镜头多长、切多密、字幕多久换一次、语速多少、
 * 响度多少、颜色偏冷还是偏暖。这些都能从成片里量出来。
 *
 * 量出来的每一项都是「目标值」，不是评价：
 * 「这条片子的镜头中位数 1.8 秒」—— 照着做就是节奏对上了。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const E = require('./exec')

/** 场景切换阈值。0.12 实测比 0.25 更合适（内容确实没变的片子最高才 0.15）。 */
const SCENE_THRESHOLD = 0.12
const SCENE_MIN = 0.15

/**
 * 切镜头。
 *
 * ★ 取数方式的坑（实测）：`select='gt(scene,X)',showinfo` 在 ffmpeg 6.0 上
 *   stderr 里**不出现 pts_time**，永远返回「一个镜头」。旧版 Python 就是
 *   这么写的，等于这个功能一直是坏的。
 *   正确的是 `select='gt(scene,X)',metadata=print` → 打 `lavfi.scene_score=`。
 *   但要拿到**时间**，还得再加 `showinfo` 且只从 metadata 行里取
 *   —— 所以这里用 metadata=print:file=- 写 stdout，逐行配 frame 时间。
 */
async function detectScenes(file, opts = {}) {
  const th = Number(opts.threshold) || SCENE_THRESHOLD
  const m = await E.probe(file)
  const dur = m.duration || 0
  if (!dur) return { ok: false, scenes: [], duration: 0, error: '读不出时长' }

  const r = await E.run(P.FFMPEG, ['-hide_banner', '-nostats', '-i', file,
    '-map', '0:v:0', '-vf', `select='gt(scene,${th})',metadata=print:file=-`,
    '-an', '-f', 'null', '-'], { timeout: 600_000 })
  // metadata=print:file=- 写的是 stdout
  const txt = String(r.stdout || '') + String(r.stderr || '')
  const times = []
  for (const line of txt.split('\n')) {
    const mt = line.match(/pts_time:([\d.]+)/)
    if (mt) times.push(Number(mt[1]))
  }
  // 有的版本只打 frame:n pts:... pts_time:...，从 frame 行里补
  if (!times.length) {
    for (const line of txt.split('\n')) {
      if (!/lavfi\.scene_score=/.test(line)) continue
      const fm = line.match(/pts_time:([\d.]+)/)
      if (fm) times.push(Number(fm[1]))
    }
  }
  times.sort((a, b) => a - b)
  const cuts = times.filter((t) => t > SCENE_MIN && t < dur - SCENE_MIN)

  // 组装成 [start,end]
  const bounds = [0, ...cuts, dur]
  const scenes = []
  for (let i = 1; i < bounds.length; i++) {
    const st = bounds[i - 1]
    const en = bounds[i]
    if (en - st >= SCENE_MIN) scenes.push({ start: Math.round(st * 100) / 100, end: Math.round(en * 100) / 100 })
  }
  return { ok: true, scenes: scenes.length ? scenes : [{ start: 0, end: dur }], duration: dur, cuts: cuts.length }
}

/**
 * 量调色特征：亮度、对比、饱和、冷暖。
 *
 * 为什么自己量而不是套滤镜：要的是**能写进方案里的数字**
 * （亮度均值 96、饱和 110、冷暖偏冷 8），不是「看着挺冷」。
 *
 * ★ metadata=print:file=- 写的是 stdout，不是 stderr。读错地方一个数都拿不到。
 */
async function lookNumbers(file, sampleFps = 2) {
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-nostats', '-i', file,
    '-vf', `fps=${sampleFps},signalstats,metadata=print:file=-`,
    '-an', '-f', 'null', '-'], { timeout: 300_000 })
  const txt = String(r.stdout || '') + String(r.stderr || '')
  const grab = (k) => {
    const a = [...txt.matchAll(new RegExp(`signalstats\\.${k}=([\\d.]+)`, 'g'))].map((x) => Number(x[1]))
    return a.length ? a : []
  }
  const yavg = grab('YAVG'), sat = grab('SATAVG'), ymin = grab('YMIN'), ymax = grab('YMAX')
  const uavg = grab('UAVG'), vavg = grab('VAVG')
  const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null)
  const out = {}
  if (yavg.length) out.luma = mean(yavg)
  if (sat.length) out.saturation = mean(sat)
  if (ymin.length && ymax.length) out.contrast = Math.round(((mean(ymax) || 0) - (mean(ymin) || 0)) * 10) / 10
  if (uavg.length && vavg.length) {
    // 冷暖：U 大 = 偏蓝（冷），V 大 = 偏红（暖）
    out.warmth = Math.round(((mean(vavg) || 0) - (mean(uavg) || 0)) * 10) / 10
  }
  return out
}

const lumaWord = (v) => (v == null ? '量不出来' : v < 60 ? '偏暗' : v > 160 ? '偏亮' : '中间调')
const satWord = (v) => (v == null ? '量不出来' : v < 60 ? '寡淡' : v > 140 ? '浓艳' : '正常')
const warmWord = (v) => (v == null ? '量不出来' : v < -6 ? '偏冷（蓝）' : v > 6 ? '偏暖（红黄）' : '中性')
const hardWord = (v) => (v == null ? '量不出来' : v < 160 ? '软（灰阶压缩）' : v > 220 ? '硬（高对比）' : '中等')

/**
 * 量整条参考片子，出一份可对着做的目标表。
 */
async function studyReference(file, opts = {}) {
  const out = { ok: false, path: String(file || ''), notes: [] }
  if (!file || !fs.existsSync(file)) { out.notes.push('文件不存在'); return out }
  const m = await E.probe(file)
  const dur = m.duration || 0
  if (!dur) { out.notes.push('读不出时长'); return out }
  out.duration = Math.round(dur * 100) / 100
  out.width = m.width
  out.height = m.height
  out.hasAudio = m.hasAudio

  // ── 镜头节奏 ──
  const sc = await detectScenes(file)
  const lens = sc.scenes.map((s) => Math.round((s.end - s.start) * 100) / 100)
  out.shots = lens.length
  if (lens.length) {
    const sl = lens.slice().sort((a, b) => a - b)
    out.shot_median = sl[Math.floor(sl.length / 2)]
    out.shot_p90 = sl[Math.min(sl.length - 1, Math.floor(sl.length * 0.9))]
    out.first_cut = sc.scenes[0] ? sc.scenes[0].end : 0
    out.cuts_per_10s = Math.round(((lens.length - 1) / Math.max(0.1, dur)) * 10 * 10) / 10
  }

  // ── 调色 ──
  Object.assign(out, await lookNumbers(file))

  // ── 声音 ──
  if (m.hasAudio) {
    const A = require('./audio')
    try {
      const l = await A.measureLoud(file)
      if (l) { out.lufs = l.lufs; out.peak = l.peak }
    } catch {}
    // 语速：能转写就量，转不了就跳过（不猜）
    try {
      const ASR = require('./asr')
      if (ASR.status().ready) {
        const t = await ASR.transcribeAudio(file)
        if (t.ok && t.text) {
          const words = (t.text.match(/[\u4e00-\u9fff]|[A-Za-z]+/g) || []).length
          out.words_per_min = Math.round((words / dur) * 60)
          out.words = words
          out.transcript = t.text.slice(0, 300)
        }
      }
    } catch {}
  }

  // ── 参考表 ──
  out.ok = true
  const R = require('./rhythm')
  let bpm = 0
  if (m.hasAudio) {
    try { const b = await R.detectBpm(file); bpm = b.bpm } catch {}
  }

  const L = [
    `【量出来的参考】${path.basename(file)}`,
    `时长 ${out.duration} 秒 · ${m.width}×${m.height} · ${m.hasAudio ? '有声音' : '没声音'}`,
    '',
    '镜头：' + (out.shots
      ? `${out.shots} 个镜头 · 中位 ${out.shot_median} 秒 · 最长那批（P90）${out.shot_p90} 秒 · 每 10 秒切 ${out.cuts_per_10s} 次`
        + (out.first_cut ? ` · 第一个切点在第 ${out.first_cut.toFixed(2)} 秒` : '')
      : '量不出镜头变化（可能整条一镜到底，或者画面几乎没变）'),
    '调色：亮度 ' + out.luma + `（${lumaWord(out.luma)}）· 对比 ${out.contrast}（${hardWord(out.contrast)}）· 饱和 ${out.saturation}（${satWord(out.saturation)}）· 冷暖 ${out.warmth}（${warmWord(out.warmth)}）`,
    m.hasAudio ? `声音：响度 ${out.lufs ?? '量不出'} LUFS · 峰值 ${out.peak ?? '量不出'} dB${out.words_per_min ? ` · 语速约 ${out.words_per_min} 字/分` : ''}${bpm ? ` · 节拍 ${bpm} BPM` : ''}`
      : '声音：整条没有音轨',
    '',
    '照这条做的话，这些就是你的目标值（不是评价，是数字）：',
  ]
  if (out.shots) L.push(`- 每镜做到 ${out.shot_median} 秒上下，最长别超过 ${out.shot_p90} 秒`)
  if (out.cuts_per_10s) L.push(`- 每 10 秒切 ${out.cuts_per_10s} 次；低于一半会显慢，高于两倍会显乱`)
  if (out.luma != null) L.push(`- 亮度做到 ${out.luma} 上下，冷暖 ${out.warmth}（${warmWord(out.warmth)}）`)
  if (out.lufs != null) L.push(`- 响度做到 ${out.lufs} LUFS 上下`)
  if (out.words_per_min) L.push(`- 语速做到 ${out.words_per_min} 字/分`)

  out.report = L.join('\n')
  return out
}

/** 两条片子对比：比值在 0.7~1.3 算对上。 */
async function compare(a, b) {
  const [x, y] = await Promise.all([studyReference(a), studyReference(b)])
  if (!x.ok || !y.ok) return { ok: false, error: '有一条量不了：' + (x.ok ? b : a) }
  const keys = [
    ['shot_median', '每镜中位秒数'], ['cuts_per_10s', '每 10 秒切几次'],
    ['luma', '亮度'], ['saturation', '饱和'], ['warmth', '冷暖'],
    ['lufs', '响度'], ['words_per_min', '语速'],
  ]
  const L = [`【两条对比】${path.basename(a)}  vs  ${path.basename(b)}`, '']
  for (const [k, label] of keys) {
    const va = x[k], vb = y[k]
    if (va == null || vb == null) continue
    const ratio = vb === 0 ? 0 : va / vb
    const ok = ratio >= 0.7 && ratio <= 1.3
    L.push(`${ok ? '✅' : '⚠'} ${label}：${va} vs ${vb}（比值 ${ratio.toFixed(2)}${ok ? '，对上了' : '，差得远'}）`)
  }
  const bad = L.filter((l) => l.startsWith('⚠')).length
  L.push('', bad ? `${bad} 项对不上 —— 这几项就是要改的地方。` : '节奏和影调都对上了。')
  return { ok: true, text: L.join('\n') }
}

module.exports = { SCENE_THRESHOLD, detectScenes, lookNumbers, studyReference, compare, lumaWord, satWord, warmWord, hardWord }
