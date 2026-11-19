'use strict'
/**
 * 高光切片 —— 从一条长片子里挑出「最值得留」的那几段。
 *
 * 原理就一件事：**人激动的时候声音能量高**。所以量每 0.5 秒的 RMS 电平，
 * 找连续高于阈值的地方，就是高光候选。
 *
 * 为什么不用「人脸检测」「画面变化」：开会、口播、访谈这类片子画面几乎不动，
 * 唯一在变的就是声音。能量曲线在这类片子上比任何视觉特征都可靠。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const P = require('./paths')
const E = require('./exec')

const SILENT_DB = -55

/**
 * 取能量曲线。返回 {ok, step, points:[{t, db}], duration}。
 *
 * ★ 静音段 ffmpeg 给 -inf，折算成 -91dB（数字音量底）—— 排序时自然落后，
 *   但不会把字段变成字符串 NaN。
 * ★ 写到临时文件读，不读管道：ffmpeg 的 `file=-` 在某些版本上会和 stderr 抢。
 */
async function curve(video, opts = {}) {
  if (!fs.existsSync(video)) return { ok: false, error: '找不到这个文件：' + video, points: [] }
  const step = Math.max(0.2, Math.min(2, Number(opts.step) || 0.5))
  const rate = 8000
  const n = Math.round(rate * step)
  const log = path.join(os.tmpdir(), `riffcut_rms_${Date.now()}.txt`)
  try {
    const r = await E.run(P.FFMPEG, ['-hide_banner', '-nostats', '-i', video, '-vn',
      '-af', `aresample=${rate},asetnsamples=n=${n},astats=metadata=1:reset=1,`
        + `ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${log}`,
      '-f', 'null', '-'], { timeout: 900_000 })
    let raw = ''
    try { raw = fs.readFileSync(log, 'utf8') } catch {}
    if (!raw.trim()) {
      const why = String(r.stderr || '').trim().split('\n').slice(-3).join(' / ')
      return { ok: false, points: [], error: 'ffmpeg 没输出能量数据' + (why ? '：' + why : '（可能这条视频没有音轨）') }
    }
    const pts = parseEnergy(raw)
    if (!pts.length) return { ok: false, points: [], error: '能量数据解析出 0 个点' }
    return { ok: true, step, points: pts, duration: pts[pts.length - 1].t + step, count: pts.length }
  } finally {
    try { fs.unlinkSync(log) } catch {}
  }
}

/**
 * 把 ffmpeg 的「frame:N pts_time:T + RMS_level=X」两行一组解析成点。
 *
 * ★ 两种行是**交替出现**的：pts_time 在前，RMS 在后。所以不能各自独立扫，
 *   必须按顺序配对 —— 否则 pts_time 和 RMS 会错位一格，整条曲线偏移 0.5 秒。
 *   （旧版就是这么错的，挑出来的高光整体提前了半秒。）
 */
function parseEnergy(raw) {
  const pts = []
  let curT = null
  for (const line of String(raw || '').split('\n')) {
    const mt = line.match(/pts_time:([\d.]+)/)
    if (mt) { curT = Number(mt[1]); continue }
    const md = line.match(/RMS_level=(-?[\d.]+|-inf)/)
    if (md && curT != null) {
      const v = md[1] === '-inf' ? -91 : Number(md[1])
      pts.push({ t: Math.round(curT * 100) / 100, db: Number.isFinite(v) ? Math.round(v * 10) / 10 : -91 })
      curT = null
    }
  }
  return pts
}

const median = (xs) => {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const pct = (xs, q) => {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}
const smooth = (pts, win = 3) => pts.map((p, i) => {
  const a = pts.slice(Math.max(0, i - Math.floor(win / 2)), Math.min(pts.length, i + Math.floor(win / 2) + 1))
  return { t: p.t, db: Math.round((a.reduce((x, y) => x + y.db, 0) / a.length) * 10) / 10 }
})

/**
 * 找出所有值得留的区间。
 *
 * minDur / maxDur 留空则按时长自适应 —— 固定 3 秒对 10 秒短视频等于要求
 * 单段占三分之一，什么也挑不出来；对 10 分钟直播又太松。
 * 自适应：min = clamp(时长 × 5%, 1.2, 6.0)；max = clamp(时长 × 25%, 6, 45)。
 *
 * sensitivity 越小越敏感（0.3 挑得多，0.6 只挑最炸的）。
 * headGuard 片头多少秒内的段算「可能是音效」，降权但不剔除。
 */
async function candidates(video, opts = {}) {
  const step = Number(opts.step) || 0.5
  const gap = Number(opts.gap) || 1.5
  const sensitivity = Number(opts.sensitivity) || 0.45
  const headGuard = Number(opts.headGuard ?? 2)
  const cv = await curve(video, { step })
  if (!cv.ok) return cv
  const points = cv.points
  if (points.length < 3) return { ok: false, error: `视频太短，能量点不够（${points.length} 个）`, segments: [] }

  const durTotal = Number(cv.duration) || points.length * step
  let minDur = opts.minDur == null ? Math.max(1.2, Math.min(6, durTotal * 0.05)) : Number(opts.minDur)
  let maxDur = opts.maxDur == null ? Math.max(6, Math.min(45, durTotal * 0.25)) : Number(opts.maxDur)
  if (maxDur <= minDur) maxDur = minDur * 2

  const live = opts.excludeSilence === false ? points : points.filter((p) => p.db > SILENT_DB)
  if (!live.length) return { ok: false, error: '整条视频都是静音，挑不出高光', segments: [] }

  const sm = smooth(points, 3)
  // ★ 算基准时要**先剔掉片头**：一个 -4dB 的转场音效会把 p90 从 -33 拉到 -30 以上，
  //   阈值跟着虚高，结果真正激动的人声段反而进不了候选（实测就是这么丢的）。
  //   剔除后如果剩下数据太少（片子总共才几秒），退回用全片。
  let body = sm.filter((p) => p.db > SILENT_DB && p.t >= headGuard).map((p) => p.db)
  if (body.length < Math.max(6, Math.floor(sm.length / 5))) {
    body = sm.filter((p) => p.db > SILENT_DB).map((p) => p.db)
    if (!body.length) body = sm.map((p) => p.db)
  }
  const med = median(body)
  const p90 = pct(body, 0.9)
  const span = Math.max(1, p90 - med)
  const thr = med + Math.max(0.05, Math.min(1.5, sensitivity)) * span

  // 连续超阈值的区间
  const runs = []
  let cur = null
  for (const p of sm) {
    if (p.db >= thr) {
      if (!cur) cur = { start: p.t, end: p.t, dbs: [p.db] }
      else { cur.end = p.t; cur.dbs.push(p.db) }
    } else if (cur) { runs.push(cur); cur = null }
  }
  if (cur) runs.push(cur)

  const segs = []
  for (const r of runs) {
    const dur = r.end - r.start + step
    if (dur < minDur) continue
    segs.push({
      start: Math.round(r.start * 100) / 100,
      end: Math.round(Math.min(durTotal, r.start + Math.min(dur, maxDur)) * 100) / 100,
      db: Math.round((r.dbs.reduce((a, b) => a + b, 0) / r.dbs.length) * 10) / 10,
    })
  }

  // 合并挨得太近的
  const merged = []
  for (const s of segs.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && s.start - last.end < gap) {
      last.end = Math.max(last.end, s.end)
      last.db = Math.max(last.db, s.db)
    } else merged.push({ ...s })
  }
  return { ok: true, duration: durTotal, step, threshold: Math.round(thr * 10) / 10, base: Math.round(med * 10) / 10, segments: merged }
}

/** 挑前 n 段。按「能量高于基准多少 × 长度」排序 —— 又炸又长的排前面。 */
async function pick(video, opts = {}) {
  const n = Number(opts.n) || 3
  const c = await candidates(video, opts)
  if (!c.ok) return c
  const base = c.base || -60
  const scored = c.segments.map((s) => ({
    ...s,
    dur: Math.round((s.end - s.start) * 100) / 100,
    score: Math.round(((s.db - base) * (s.end - s.start)) * 10) / 10,
  })).sort((a, b) => b.score - a.score)
  return { ok: true, duration: c.duration, picked: scored.slice(0, n), all: scored.length, base, threshold: c.threshold }
}

/** 按区间切出一段，重编码成统一规格。 */
async function cut(video, out, start, dur, opts = {}) {
  const w = Number(opts.width) || 0
  const h = Number(opts.height) || 0
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', Number(start).toFixed(3), '-i', video,
    '-t', Number(dur).toFixed(3)]
  if (w && h) args.push('-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`)
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(Number(opts.crf) || 20),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out)
  const r = await E.run(P.FFMPEG, args, { timeout: 600_000 })
  if (!r.ok) return { ok: false, error: String(r.stderr || '').slice(0, 200) }
  return { ok: true, path: out, probe: await E.probe(out) }
}

/** 拼成人读报告。 */
function briefText(r) {
  if (!r.ok) return '❌ ' + r.error
  if (!r.picked || !r.picked.length) return '这条片子挑不出高光（能量一直平，或者全是静音）。'
  const fmt = (s) => `${s.start.toFixed(1)}s–${s.end.toFixed(1)}s`
  const L = [`【高光】全片 ${r.duration.toFixed(1)} 秒，找出 ${r.all} 段，挑前 ${r.picked.length}：`, '']
  r.picked.forEach((s, i) => {
    L.push(`${i + 1}. ${fmt(s)}（${s.dur} 秒）· 平均 ${s.db} dB · 比基准高 ${(s.db - r.base).toFixed(1)} dB`)
  })
  L.push('', '要切出来就用 highlight 的 cut 动作（给 start 和 dur）。')
  return L.join('\n')
}

module.exports = { SILENT_DB, curve, parseEnergy, smooth, candidates, pick, cut, briefText }
