'use strict'
/**
 * 卡拍 —— 测音乐的 BPM，再量「切点踩没踩上拍」。
 *
 * 做法是梳状相关：把起始点包络跟自己的各种周期做加权相关，
 * 滞后落在「每分钟 min~max 拍」对应的周期上时相关值最高，那个滞后就是拍长。
 *
 * 为什么不能靠「找最高的自相关峰」：160 BPM 的拍长是 375ms，
 * 在 10ms 网格上落在 37.5 格，不整除 → 能量摊到 37 和 38 两格，
 * 两边都不高，于是被误判成半速 80。梳状相关对每个候选周期 P
 * 把 e[i]·e[i+kP] 累加（k=1..8），周期不必落在网格上、用线性插值取值，
 * 非整数周期反而是它的强项。这是节拍跟踪的标准做法。
 */
const path = require('node:path')
const E = require('./exec')
const P = require('./paths')

/** 把人声/静音压掉，量「起音」而不是「响度」。 */
async function onsetEnvelope(file, seconds = 60) {
  // 16kHz 单声道，最低成本的一档；起音检测不需要高频
  const r = await E.run(P.FFMPEG, [
    '-v', 'error', '-t', String(seconds), '-i', file,
    '-ac', '1', '-ar', '16000', '-f', 's16le', '-',
  ], { timeout: 120_000, encoding: 'buffer' })
  if (!r.ok || !r.stdout || !r.stdout.length) throw new Error('读不出音频：' + String(r.stderr || '').slice(0, 120))
  const buf = r.stdout
  const n = Math.floor(buf.length / 2)
  const rate = 16000
  const hop = Math.round(rate * 0.01) // 10ms 网格
  const env = []
  // 起音 = 这一格的能量的正增量（不是能量本身）。
  // 直接用能量会把「持续的长音」也算成很多拍。
  //
  // ★ prev 必须是**上一格的能量**，不能是上一个 onset。
  //   env 里存的是已做差的 onset，拿它当 prev 相当于对信号做了二次差分，
  //   能量被削掉一大截，梳状相关的置信度会掉到 0.01 这种没意义的值。
  let prevEnergy = 0
  for (let i = 0; i + hop <= n; i += hop) {
    let e = 0
    for (let j = 0; j < hop; j += 4) { // 4 抽 1，够用且快四倍
      const v = buf.readInt16LE((i + j) * 2) / 32768
      e += v * v
    }
    const energy = Math.sqrt(e / (hop / 4))
    env.push(Math.max(0, energy - prevEnergy))
    prevEnergy = energy
  }
  return { env, hop: 0.01 }
}

/**
 * 测 BPM 和第 1 拍的偏移。返回 {bpm, offset, beats, confidence}。
 *
 * 先验压住「快歌被读成半速」：人对节拍的感知集中在 120 BPM 附近，
 * 用对数正态（中心 120、σ≈0.9 个八度）加权。
 * 判错成半速可以接受（这是数学事实：半速网格是原网格的子集，
 * 切点仍然落在真拍上，只是漏掉隔一拍的加速机会）；
 * 判错成倍速才麻烦 —— 网格会插到两拍中间，切点全都不在拍上。所以宁慢勿快。
 */
async function detectBpm(file, opts = {}) {
  const minBpm = Number(opts.minBpm) || 60
  const maxBpm = Number(opts.maxBpm) || 200
  const seconds = Number(opts.seconds) || 60
  const out = { bpm: 0, offset: 0, beats: 0, confidence: 0 }

  let env, hop
  try { ({ env, hop } = await onsetEnvelope(file, seconds)) } catch { return out }
  if (env.length < 50) return out

  const mean = env.reduce((a, b) => a + b, 0) / env.length
  const e = env.map((x) => Math.max(0, x - mean)) // 去直流

  // 20ms 精度的副本：点数减半，扫描快一倍，测 BPM 这点精度足够
  const e2 = []
  for (let i = 0; i < e.length; i += 2) e2.push(i + 1 < e.length ? Math.max(e[i], e[i + 1]) : e[i])
  const h2 = hop * 2

  /** 基频权重最高（1/k）：一个每 1 秒一响的鼓点，既是 60 BPM 也「像」120 BPM，
   *  区别就在基频 —— 120 的 k=1 滞后落在两个鼓点中间，相关为 0。
   *  等权平均会把这个差别稀释掉，于是 60 被读成 120。 */
  const comb = (periodS, harmonics = 8) => {
    let acc = 0, wsum = 0
    for (let k = 1; k <= harmonics; k++) {
      const lag = (periodS * k) / h2
      if (lag >= e2.length - 1) break
      const li = Math.floor(lag)
      const fr = lag - li
      let tot = 0
      for (let i = 0; i < e2.length - li - 1; i++) tot += e2[i] * (e2[i + li] * (1 - fr) + e2[i + li + 1] * fr)
      const w = 1 / k
      acc += (w * tot) / Math.max(1, e2.length - li - 1)
      wsum += w
    }
    return wsum ? acc / wsum : 0
  }
  const prior = (b) => Math.exp(-0.5 * Math.pow(Math.log2(b / 120) / 0.9, 2))

  let bestBpm = 0, bestScore = -1
  const scores = []
  for (let b = minBpm; b <= maxBpm + 1e-9; b += 0.5) {
    const raw = comb(60 / b)
    scores.push(raw)
    const sc = raw * prior(b)
    if (sc > bestScore) { bestScore = sc; bestBpm = b }
  }
  if (bestScore <= 0) return out
  const sortedScores = scores.slice().sort((a, b) => a - b)
  const medScore = sortedScores[Math.floor(sortedScores.length / 2)] || 1e-9

  // 0.5 BPM 的粗扫最多差 1%，一百拍下来能偏出一拍多；在最优值附近
  // 用 0.05 步长再扫一遍，精确到小数点后一位。
  let fine = bestBpm, fc = bestScore
  for (let i = -10; i <= 10; i++) {
    const bb = bestBpm + i * 0.05
    if (bb < minBpm || bb > maxBpm) continue
    const sc = comb(60 / bb) * prior(bb)
    if (sc > fc) { fc = sc; fine = bb }
  }

  // 找第 1 拍：在第一个拍长窗口里找能量最大的位置
  const period = 60 / fine
  const span = Math.max(1, Math.round(period / hop))
  let bi = 0, bv = -1
  for (let i = 0; i < Math.min(span, e.length); i++) if (e[i] > bv) { bv = e[i]; bi = i }

  return {
    bpm: Math.round(fine * 10) / 10,
    offset: Math.round(bi * hop * 1000) / 1000,
    beats: Math.floor((env.length * hop) / period),
    // 置信度用「最优得分 ÷ 全部候选得分的中位数」，比拍一个固定系数有意义：
    // 真正有节拍的素材，最优周期会明显高出其他周期一大截。
    confidence: Math.round(Math.min(1, fc / Math.max(1e-9, medScore)) * 100) / 100,
  }
}

/**
 * 切点离最近的拍位有多远。纯数学。
 *
 * 判「卡上了」用两条硬线同时卡：命中率 ≥60%，且 ≥2× 随机命中率。
 * 只卡命中率会把「切点本来就很密」误判成踩点 —— 切点越密，
 * 随机也能撞上拍。
 */
function beatAlignNumbers(cuts, bpm, offset = 0, tol = 0.08, fps = 30, duration) {
  const cs = (cuts || []).map(Number).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
  const spb = bpm > 0 ? 60 / bpm : 0
  if (!cs.length || !spb) return { cuts: cs.length, hits: 0, hit_rate: 0, random_rate: 0, follows: false, weak: true, reason: '没切点或没测出节拍' }
  const frame = 1 / Math.max(1, fps)
  let hits = 0
  const dists = []
  const nearest = []
  for (const c of cs) {
    // 最近的拍位：先算落在第几个拍，再比对前后两个
    const k = Math.round((c - offset) / spb)
    const cand = [offset + k * spb, offset + (k - 1) * spb, offset + (k + 1) * spb]
    let d = Infinity, at = 0
    for (const p of cand) {
      const dd = Math.abs(p - c)
      if (dd < d) { d = dd; at = p }
    }
    // 对齐到帧：卡到帧上就算踩上（拍位不一定落整帧）
    d = Math.abs(Math.round(d / frame) * frame)
    dists.push(Math.round(d * 1000) / 1000)
    nearest.push(Math.round(at * 1000) / 1000)
    if (d <= tol) hits++
  }
  const hitRate = hits / cs.length
  const randomRate = Math.min(1, (2 * tol) / spb)
  const med = dists.slice().sort((a, b) => a - b)[Math.floor(dists.length / 2)]
  return {
    cuts: cs.length, hits,
    hit_rate: Math.round(hitRate * 1000) / 1000,
    random_rate: Math.round(randomRate * 1000) / 1000,
    follows: hitRate >= 0.6 && hitRate >= 2 * randomRate,
    median_dist: med,
    max_dist: Math.max(...dists),
    median_spacing: cs.length > 1 ? Math.round(((cs[cs.length - 1] - cs[0]) / (cs.length - 1)) * 1000) / 1000 : null,
    beats_per_cut: cs.length > 1 && spb > 0 ? Math.round((((cs[cs.length - 1] - cs[0]) / (cs.length - 1)) / spb) * 100) / 100 : null,
    weak: false,
  }
}

/** 测一条音乐/视频的节拍，再可选地量切点。 */
async function beatAlignment(file, opts = {}) {
  const d = await detectBpm(file, opts)
  if (!d.bpm) return { weak: true, reason: '测不出节拍（可能没有人声以外的节奏，或者压根没有音轨）', bpm: 0 }
  const cuts = opts.cuts || []
  if (!cuts.length) return { weak: false, bpm: d.bpm, offset: d.offset, confidence: d.confidence, beat_seconds: Math.round((60 / d.bpm) * 1000) / 1000, cuts: 0 }
  return { weak: false, bpm: d.bpm, offset: d.offset, confidence: d.confidence, ...beatAlignNumbers(cuts, d.bpm, d.offset, opts.tol, opts.fps) }
}

/** 自检：纯数值造几条已知答案的判据，确认这两笔账没退化成永远 pass。 */
function selftest() {
  const good = beatAlignNumbers([0.5, 1.0, 1.5, 2.0, 2.5, 3.0], 120, 0, 0.08)
  const bad = beatAlignNumbers([0.25, 0.75, 1.25, 1.75, 2.25, 2.75], 120, 0, 0.08)
  const drift = beatAlignNumbers(Array.from({ length: 10 }, (_, i) => i * 0.93), 127.8, 0, 0.07)
  const cases = [
    { name: '卡在拍上的六个切点应判命中', pass: good.follows && good.hit_rate === 1 },
    { name: '踩在拍与拍中间的六个切点应判未命中', pass: !bad.follows && bad.hit_rate === 0 },
    { name: '半速网格（0.93 秒切一次配 127.8 BPM）应识别为几拍一切', pass: (drift.beats_per_cut || 0) > 1.7 },
  ]
  return { ok: cases.every((c) => c.pass), cases, good: good.hit_rate, bad: bad.hit_rate, drift_beats: drift.beats_per_cut }
}

module.exports = { onsetEnvelope, detectBpm, beatAlignNumbers, beatAlignment, selftest }
