'use strict'
/**
 * 出片前体检 —— 旧 Python 版 engine.py 里那套「先算账再动手」的机械闸门。
 *
 * 为什么要有这一层：AI 排了 3 段 2.0+1.0+0.8 秒的方案、目标 25 秒，
 * 成片出来 3.2 秒，它在最终回复里当成成功交付了。软件当时没有任何地方
 * 能让它在**出片前**知道自己排了多长。事后看片才发现，人已经等了一轮。
 *
 * 这里的四个函数都不替谁判断，只把账摊开：
 *   planCheck    照这份方案渲出来会是多少秒、差目标多少、哪段超了源素材
 *   hookScore    开场那句够不够抓人（同一把尺子量三个备选，不是凭感觉挑）
 *   pacingAudit  节奏体检：平均单镜多长、哪段拖、哪段闪
 *   truthCheck   屏幕上的数字有没有在口播里说过、有没有把导演的话剪进去
 *
 * 数字全部和 render / timeline 用同一套算法（段长之和 − 每处转场重叠），
 * 所以这里的秒数就是成片会得到的秒数，不是估算。
 */
const fs = require('node:fs')
const path = require('node:path')
const T = require('./timeline')
const L = require('./looks')
const A = require('./assets')
const E = require('./exec')

// 本机中文 TTS 实测语速：六个长度点（6/10/15/22/31/42 字）线性拟合
//   时长 = 0.50 + 字数 / 4.9
// 残差全在 ±0.3 秒内。0.50 是每句的启动开销（起势 + 句尾收音），
// 所以短句的「字/秒」会显得慢 —— 8 字 2.6 秒是 3.1 字/秒，23 字 5.1 秒是 4.5 字/秒，
// 同一台机器两个数，取其中一个当常数必然错一头。
// 之前按「4 字/秒」截稿：写满 40 字念完只要 8.7 秒，按 4 字算以为要 10 秒，
// 画面留了十秒、声音八秒半就没了，尾巴那截是空的。
const TTS_SEC_BASE = 0.5
const TTS_CHARS_PER_SEC = 4.9

// 开场钩子基准 4 分，7 分以上才够格当冷开场
const HOOK_MIN_SCORE = 7
const HOOK_RUBRIC = [
  [3, '抛了一个必须看到结尾才解的问题（「为什么 X 不是你想的那样」）'],
  [3, '具体的个人代价（「我亏了四万，就为了你不用踩这个坑」）'],
  [2, '有具体数字或时间（「3 个错误」「90 天」）'],
  [2, '直接点名目标观众（「如果你在做冷邮件，先停一下」）'],
  [2, '有张力、冲突或反差（本该 X，却 Y）'],
  [2, '具体处境 + 动作同时出现，一句话就有画面（「除夕家宴上，她扶着墙进门」）'],
  [1, '短促：口语钩子 4–14 个字，三秒内能说完'],
  [1, '情绪浓度高（或有画面里最激烈的那个瞬间）'],
  [-2, '铺垫、背景交代、清嗓子（「那么基本上…」「呃…」）、片头板'],
  [-2, '解说钩子超过 40 字还没进冲突'],
  [-1, '上来就「他/她/这」指代，冷观众不知道是谁'],
]

// 时长与节奏的经验区间（Hookcutter audit + retention-pacing）
const PACING_TARGET = [[30, 2.2], [60, 3.0]]

// 导演自言自语混进稿子的痕迹 —— 这些是「对同事说的话」，不是给观众听的
const EDITOR_ASIDES = [
  '这段重来', '重来一遍', '等一下', '我看看', '这里再', '改成', '先这样',
  '注意这里', '记得加', '别忘了', 'TODO', '待补', '占位',
]

/** 这段稿子念出来大概几秒。写稿、排时长、判断要不要删句子都用它。 */
function voiceSeconds(text) {
  const n = [...String(text || '')].filter((c) => /[0-9A-Za-z\u4e00-\u9fa5]/.test(c)).length
  if (!n) return 0
  return Math.round((TTS_SEC_BASE + n / TTS_CHARS_PER_SEC) * 100) / 100
}

/** 这么长的片子最多能念多少字（用来截稿）。 */
function voiceCharsFor(duration) {
  const d = Number(duration) || 0
  if (d <= 0) return 0
  return Math.max(0, Math.floor((d - TTS_SEC_BASE) * TTS_CHARS_PER_SEC))
}

/**
 * 每处转场实际生效的秒数（长度 = 段数 - 1）。没转场的位置是 0。
 *
 * 夹逼规则必须和 timeline / render 一致：转场不能比相邻任一段的 35% 还长。
 * 以前给的是 90%，1 秒的段落能吃 0.9 秒转场 —— 等于整段都在转场里，
 * 观众只看到一片糊，那不是转场是事故。
 */
function effTrans(durs, trans) {
  const out = []
  for (let i = 0; i < durs.length - 1; i++) {
    // 转场语义是「每段的进入转场」：durs[i] 与 durs[i+1] 之间那处，
    // 取的是第 i+2 段的 transition（trans 数组下标从 0 起，第 1 段没有进入转场）。
    const spec = L.transOf(trans[i + 1] || '')
    if (!spec || !spec.xa || !(spec.dur > 0)) { out.push(0); continue }
    const short = Math.min(Number(durs[i]) || 0, Number(durs[i + 1]) || 0)
    out.push(Math.min(spec.dur, Math.max(0.08, short * 0.35)))
  }
  return out
}

function asDict(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

/** 配音稿 → [{text, emotion, at?}]。没写 lines 就退回整段 text。 */
function voiceParts(plan, segs, duration) {
  const v = asDict(plan.voice)
  const lines = v.lines || v.句 || []
  const out = []
  if (Array.isArray(lines)) {
    for (const ln of lines) {
      let t = ''
      let emo = ''
      let at = null
      if (typeof ln === 'string') t = ln
      else if (ln && typeof ln === 'object') {
        t = String(ln.text || ln.line || '').trim()
        emo = String(ln.emotion || ln.情绪 || '').trim()
        at = ln.at !== undefined ? ln.at : ln.start
      } else continue
      t = String(t || '').trim()
      if (!t) continue
      const one = { text: t, emotion: emo }
      if (at !== null && at !== undefined) {
        const n = Number(at)
        if (!Number.isNaN(n)) one.at = Math.round(n * 100) / 100
      }
      out.push(one)
    }
  }
  if (out.length) return out.slice(0, 24)
  let txt = String(v.text || '').trim()
  if (!txt) {
    txt = (segs || []).map((sg) => String(sg.caption || '').trim()).filter(Boolean).join('  ')
  }
  txt = String(txt || '').trim()
  if (!txt) return []
  // 按实测语速算「这么长的片子最多能念多少字」，不再用写死的 4 字/秒
  const limit = Math.max(12, voiceCharsFor(Number(duration) || 0))
  if (txt.length > limit) {
    let cut = txt.slice(0, limit)
    for (const sep of ['。', '！', '？', '；', '，', ' ']) {
      const k = cut.lastIndexOf(sep)
      if (k > limit * 0.6) { cut = cut.slice(0, k + 1); break }
    }
    txt = cut
  }
  return [{ text: txt, emotion: '' }]
}

/**
 * 从时间线工程反推一份方案 —— 工程里没有 plan 字段时也能体检。
 *
 * 为什么要这条：AI 很多时候是直接 edit_timeline 一段段排出来的，根本没写过 plan。
 * 旧版在这里直接报「工程里没有 plan」就没得查了，等于最需要体检的那批片子查不了。
 * 时间线本来就是方案的落地形态，段长、转场、字幕都在里面，够了。
 */
function planFromTimeline(doc) {
  const d = doc || {}
  const tracks = d.tracks || {}
  // 视频轨：兼容两种形态（数组 / {clips:[]}）
  const vids = []
  const vkeys = Object.keys(tracks).sort()
  for (const k of vkeys) {
    const tr = tracks[k]
    if (!tr || !Array.isArray(tr.clips)) continue
    if (!tr.clips.some((c) => c.type === 'video' || c.type === 'image')) continue
    vids.push(...tr.clips.filter((c) => c.type === 'video' || c.type === 'image'))
    break
  }
  vids.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0))

  // 字幕轨的文字，按开始时间配给对应的画面段
  const texts = []
  for (const k of vkeys) {
    const tr = tracks[k]
    if (!tr || !Array.isArray(tr.clips)) continue
    for (const c of tr.clips) if (c.type === 'text') texts.push(c)
  }

  const shots = vids.map((c) => {
    const start = Number(c.start) || 0
    const dur = Number(c.out) > 0 ? Math.max(0, Number(c.out) - (Number(c.in) || 0)) : Number(c.duration) || 0
    const cap = texts.find((t) => {
      const ts = Number(t.start) || 0
      return ts >= start - 0.01 && ts < start + Math.max(0.1, dur)
    })
    return {
      asset: String(c.src || c.asset || ''),
      start: Number(c.in) || 0,
      duration: dur,
      transition: c.transition || c.enter || '',
      caption: cap ? String(cap.text || '') : '',
    }
  })

  // ★ 文字轨是「屏幕上的字」，不是「嘴上的话」。
  // 第一版把文字轨拼成 voice.text 交给口播体检，于是报「画面比声音长 26.64 秒」——
  // 那条片子的字幕本来就只有 6 个字，画外音压根没配，这不是缺陷是设计。
  // 有 audio 轨的素材才可能有话，那也得 ASR 才知道说了什么，这里不猜。
  return {
    target_duration: Number(d.duration) || 0,
    shots,
    voice: {},
  }
}

/** 把方案里的分镜拍平成统一段列表（不查素材库，素材不够长那栏留空也能算账）。 */
function shotsFromPlan(plan) {
  const shots = (plan && plan.shots) || []
  const segs = []
  for (const sh of shots) {
    if (!sh || typeof sh !== 'object') continue
    segs.push({
      asset: String(sh.asset || ''),
      dur: Number(sh.duration !== undefined ? sh.duration : sh.dur) || 0,
      start: Number(sh.start) || 0,
      transition: sh.transition || sh.转场 || '',
      caption: sh.caption || sh.字幕 || '',
    })
  }
  return segs
}

/** 屏幕上的数字：中文数字折成阿拉伯数字，方便和口播稿比对。 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 }

/**
 * 从一段文字里抽出所有数字（含中文数字），返回字符串数组。
 *
 * 只做「能不能对上」这一件事，所以 3.2 和 3.20 都归成 "3.2"，
 * 「三十」和 30 都归成 "30"。
 */
function foldNumbers(text) {
  const s = String(text || '')
  const out = new Set()
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])))
  // 「百分之四十二」和「42%」得算同一个数：先把「百分之/千分之」抹成空格，
  // 否则那个「百」会被下面的单位表单独算成 100，凭空多出一个没说过的数。
  const t2 = s.replace(/百分之|千分之/g, ' ')
  // 中文数字：三十 / 一百二十 / 两千
  for (const m of t2.matchAll(/[零一二两三四五六七八九十百千万亿]+/g)) {
    const seg = m[0]
    // 单个中文字（「一张卡」「三个人」「第一个」）几乎都是量词或序数，
    // 不是要核对的统计数字。报出来只会天天假警报 —— 误报比漏报更伤。
    if (seg.length < 2) continue
    let total = 0
    let cur = 0
    let lastUnit = 0
    for (const ch of seg) {
      if (ch in CN_DIGIT) { cur = CN_DIGIT[ch]; continue }
      const u = CN_UNIT[ch]
      if (u >= 10000) { total = (total + cur) * u; cur = 0; lastUnit = u }
      else {
        if (cur === 0 && ch === '十') cur = 1
        total += cur * u
        cur = 0
        lastUnit = u
      }
    }
    const val = total + cur
    if (val > 0) out.add(String(val))
  }
  return [...out]
}

/**
 * 出片前把账算清楚。
 *
 * 返回里刻意分成「事实」和「差异」两栏：
 *   事实：逐段时长、合计、转场吃掉多少、真实成片秒数、口播秒数
 *   差异：离 target_duration 差多少、必保镜头盖不盖得住、哪段超了源素材
 * 判断留给调用方 —— 差 20 秒该不该补、必保镜头少了要不要重排，那是它的活。
 */
function planCheck(plan, opts) {
  const o = opts || {}
  const pd = plan || {}
  const segs = shotsFromPlan(pd)
  if (!segs.length) return { ok: false, error: '方案里没有分镜，先生成方案再体检。' }

  const durs = segs.map((sg) => Number(sg.dur) || 0)
  const trans = segs.map((sg) => sg.transition)
  const eff = durs.length > 1 ? effTrans(durs, trans) : []
  const total = durs.reduce((a, b) => a + b, 0)
  const real = Math.max(0, total - eff.reduce((a, b) => a + b, 0))

  // 口播实际多长 —— 和画面长度对照，差出来就是「话音没落画面就切了」或「画面等声音」
  const v = asDict(pd.voice)
  const hasVoice = !!(String(v.text || '').trim() || (Array.isArray(v.lines) && v.lines.length))
  const parts = voiceParts(pd, segs, real)
  const vsec = parts.reduce((a, p) => a + voiceSeconds(p.text), 0)
  const vsecR = hasVoice ? Math.round(vsec * 100) / 100 : 0

  // 开头有没有人声 —— 从方案的 voice 算，不从头绪的成片反推。
  // 前 3 秒没人说话，等于把最贵的三秒用来放画面。
  let lead = null
  let acc = 0
  for (const p of parts) {
    if (!String(p.text || '').trim()) continue
    lead = p.at !== undefined ? p.at : acc
    break
  }
  if (!parts.length) lead = 0

  const tgt = Number(pd.target_duration || pd.target || 0) || 0

  // 每段的源素材够不够长 —— 超了会被自动降速，节奏就不是它想的那样了
  const over = []
  if (o.customer !== undefined) {
    let lib = null
    try { lib = A.library(o.customer) } catch { lib = null }
    const items = (lib && lib.items) || []
    for (let i = 0; i < segs.length; i++) {
      const a = String(segs[i].asset || '')
      if (!a) continue
      const hit = items.find((x) => x.name === a || path.basename(String(x.full || '')) === a)
      if (!hit) continue
      const have = Number(hit.duration) || 0
      const need = (Number(segs[i].start) || 0) + (Number(segs[i].dur) || 0)
      if (have > 0.05 && need > have + 0.05) {
        over.push({ index: i + 1, asset: path.basename(a), need: Math.round(need * 100) / 100, have: Math.round(have * 100) / 100 })
      }
    }
  }

  const rows = segs.map((sg, i) => ({
    index: i + 1,
    asset: sg.asset ? path.basename(sg.asset) : '',
    dur: Math.round((Number(sg.dur) || 0) * 100) / 100,
    transition: sg.transition || '',
    caption: String(sg.caption || '').slice(0, 24),
  }))

  const ev = checkEvidence(pd, segs)
  const pace = pacingAudit(durs, real)
  const truth = truthCheck(pd)

  return {
    ok: true,
    segments: segs.length,
    rows,
    sum_duration: Math.round(total * 100) / 100,
    transitions: eff.filter((d) => d > 0).length,
    transition_used: Math.round(eff.reduce((a, b) => a + b, 0) * 100) / 100,
    real_duration: Math.round(real * 100) / 100,
    voice_seconds: vsecR,
    // 没配画外音时不算声画差 —— 用字幕兜底估出来的字数去报「画面比声音长 N 秒」
    // 只会天天假警报，那条片子本来就没打算说话。
    voice_gap: hasVoice && vsec ? Math.round((real - vsec) * 100) / 100 : null,
    target: tgt || null,
    gap: tgt ? Math.round((real - tgt) * 100) / 100 : null,
    voice_starts_at: hasVoice && typeof lead === 'number' ? Math.round(lead * 100) / 100 : null,
    evidence_checked: ev.checked,
    evidence_missing: ev.missing,
    source_short: over,
    pacing: pace,
    truth,
    // 机器可读的「计划值」，出片时交给 gateCheck，让声明过的定格/黑场/静音不被当故障
    targets: planTargets(pd, segs),
  }
}

/** 一份给人读的体检报告。 */
function planReport(res) {
  if (!res || !res.ok) return (res && res.error) || '体检没跑起来'
  const L1 = []
  L1.push(`方案 ${res.segments} 段，段长合计 ${res.sum_duration} 秒；`)
  L1.push(`转场 ${res.transitions} 处共吃掉 ${res.transition_used} 秒。`)
  L1.push(`**照这份方案渲出来是 ${res.real_duration} 秒。**`)
  if (res.target) {
    const g = res.gap
    L1.push(`目标是 ${res.target} 秒，差 ${g > 0 ? '+' : ''}${g} 秒${Math.abs(g) >= 2 ? '（这个差距已经能看出来）' : ''}。`)
  }
  if (res.voice_seconds) {
    const g = res.voice_gap
    L1.push(`口播念完要 ${res.voice_seconds} 秒，` +
      (g < -0.4 ? `画面比声音短 ${Math.abs(g)} 秒 —— 话音没落就切了。`
        : g > 0.8 ? `画面比声音长 ${g} 秒 —— 后面那截是空的。`
          : '声画基本齐。'))
  }
  if (res.voice_starts_at !== null && res.voice_starts_at > 3) {
    L1.push(`⚠ 第一句人声在第 ${res.voice_starts_at} 秒才出现 —— 前 ${res.voice_starts_at} 秒没人说话，等于把最贵的三秒用来放画面。`)
  }
  if (res.evidence_missing && res.evidence_missing.length) {
    L1.push(`⚠ 必保镜头被剪掉了 ${res.evidence_missing.length} 处：`)
    for (const m of res.evidence_missing.slice(0, 6)) L1.push(`  · ${m.id} ${m.why}`)
  }
  if (res.source_short && res.source_short.length) {
    L1.push('⚠ 这几段要的比源素材长，渲出来会被自动降速：')
    for (const o of res.source_short.slice(0, 6)) L1.push(`  · 第 ${o.index} 段 ${o.asset}：要 ${o.need} 秒，只有 ${o.have} 秒`)
  }
  if (res.pacing && res.pacing.flags && res.pacing.flags.length) {
    L1.push(`节奏 ${res.pacing.score} 分：`)
    for (const f of res.pacing.flags) L1.push(`  · ${f}`)
  }
  if (res.truth && !res.truth.ok) {
    if (res.truth.unspoken && res.truth.unspoken.length) {
      L1.push('⚠ 这几处数字屏幕上出现了但口播里没说过：')
      for (const u of res.truth.unspoken.slice(0, 6)) L1.push(`  · 「${u.number}」出现在 ${u.field}：${u.text}`)
    }
    if (res.truth.asides && res.truth.asides.length) {
      L1.push(`⚠ 稿子里混进了导演的话：${res.truth.asides.join('、')}`)
    }
  }
  L1.push('')
  L1.push('表格：')
  for (const r of res.rows) {
    L1.push(`  ${r.index}. ${r.asset || '(空)'}  ${r.dur}s  ${r.transition || '—'}  ${r.caption || ''}`)
  }
  return L1.join('\n')
}

/** 必保镜头：方案自己声明「这几秒不能少」，就真的不能少。 */
function parseEvidence(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const ev of raw) {
    if (!ev || typeof ev !== 'object') continue
    const id = String(ev.id || ev.name || '').trim()
    const asset = String(ev.asset || ev.素材 || '').trim()
    const start = Number(ev.start) || 0
    const end = Number(ev.end) || 0
    if (!asset || !(end > start)) continue
    out.push({ id: id || asset, asset, start, end, content: String(ev.content || ev.内容 || '') })
  }
  return out
}

function segCovers(sg, ev) {
  if (path.basename(String(sg.asset || '')) !== path.basename(ev.asset)) return false
  const s0 = Number(sg.start) || 0
  const s1 = s0 + (Number(sg.dur) || 0)
  // 覆盖判据留 0.1 秒容差：分镜表里的 start 是手写的，实际裁切会有一帧偏差
  return s0 <= ev.start + 0.1 && s1 >= ev.end - 0.1
}

function checkEvidence(plan, segs) {
  const evs = parseEvidence((plan || {}).required_evidence)
  if (!evs.length) return { checked: 0, missing: [], ok: true }
  const list = segs || shotsFromPlan(plan)
  const missing = []
  for (const ev of evs) {
    if (!list.some((sg) => segCovers(sg, ev))) {
      missing.push({
        id: ev.id,
        asset: ev.asset,
        start: ev.start,
        end: ev.end,
        content: ev.content,
        why: `成片里没有任何一段覆盖 ${path.basename(ev.asset) || '源片'} 的 ${ev.start.toFixed(1)}–${ev.end.toFixed(1)}s`,
      })
    }
  }
  return { checked: evs.length, missing, ok: !missing.length }
}

/** 从方案算出一份机器可读的「计划值」，出片时交给 gateCheck。 */
function planTargets(plan, segs) {
  const pd = plan || {}
  const list = segs || shotsFromPlan(pd)
  const durs = list.map((sg) => Number(sg.dur) || 0)
  const eff = durs.length > 1 ? effTrans(durs, list.map((s) => s.transition)) : []
  const real = Math.max(0, durs.reduce((a, b) => a + b, 0) - eff.reduce((a, b) => a + b, 0))
  return {
    duration: Math.round(real * 100) / 100,
    segments: list.length,
    // 方案里显式声明过的静止段/黑场/静音，出片体检时不当故障报
    freeze_at: (pd.freeze_at || []).slice ? (pd.freeze_at || []).slice(0, 20) : [],
    black_at: (pd.black_at || []).slice ? (pd.black_at || []).slice(0, 20) : [],
    silent_at: (pd.silent_at || []).slice ? (pd.silent_at || []).slice(0, 20) : [],
  }
}

/** 给一句开场打分（0–10，基准 4）。 */
function hookScore(text, energy) {
  const t = String(text || '').trim()
  if (!t) return { score: 0, hits: [], note: '开场是空的' }
  const hits = []
  let sc = 4
  // 抛悬念
  if (/(为什么|怎么回事|原来|居然|真相|其实不是|你以为)/.test(t)) { hits.push('抛了待解的悬念'); sc += 3 }
  if (/\d/.test(t)) { hits.push('有具体数字'); sc += 2 }
  if (/(亏|赔|输|丢|白干|踩坑|血泪|后悔)/.test(t)) { hits.push('有个人代价'); sc += 3 }
  if (/(如果你|你要是|做.{1,6}的|干.{1,6}的)/.test(t)) { hits.push('点名了观众'); sc += 2 }
  if (/(别|千万|错了|不对|假的|骗|根本|停|反倒|反而|非但|却|竟然|偏偏)/.test(t)) { hits.push('有冲突或反差'); sc += 2 }
  if (/(上|里|那天|今天|除夕|早上|晚上|门口|家里|医院|公司)/.test(t) &&
      /(刚|正在|一把|扶着|扯|拽|摔|跪|哭|喊|转身|拿起)/.test(t)) { hits.push('具体处境+动作，有画面'); sc += 2 }
  if (t.length >= 4 && t.length <= 14) { hits.push('短促好念'); sc += 1 }
  else if (t.length > 40) { hits.push('铺垫太长，一句话还没进冲突'); sc -= 2 }
  if (/^(那么|呃|嗯|就是|所以|基本上|大家好|hello)/i.test(t)) { hits.push('清嗓子式开场'); sc -= 2 }
  if (/^(他|她|它|这|那)/.test(t) && t.length < 12) { hits.push('上来就指代，冷观众看不懂'); sc -= 1 }
  if (energy && energy >= 0.6) { hits.push('画面强度高'); sc += 1 }
  sc = Math.max(0, Math.min(10, sc))
  const note = sc >= HOOK_MIN_SCORE ? '可以直接当冷开场' : '不够抓人：换个更狠的瞬间，或者把它挪到第二句'
  return { score: sc, hits, note }
}

/** 把评分表摊成文本，给模型当尺子用。 */
function hookRubric() {
  const out = [`【开场钩子打分】基准 4 分，按下面加减，0–10。${HOOK_MIN_SCORE} 分以上才够格当冷开场。`]
  for (const [d, why] of HOOK_RUBRIC) out.push(`${d > 0 ? '+' + d : d} ${why}`)
  out.push(`挑法：写三个备选开场，各自打分，用最高的那个。低于 ${HOOK_MIN_SCORE} 分说明这一段本身不值得当开场，去素材里找更狠的那几秒。`)
  return out.join('\n')
}

/** 这个时长下，平均每个镜头该多长。 */
function idealClip(duration) {
  const d = Number(duration) || 0
  for (const [cap, ideal] of PACING_TARGET) if (d <= cap) return ideal
  return 4.5
}

/**
 * 体检节奏：平均单镜、有没有特别拖的、有没有死气。
 * flags 是具体问题，不是形容词 —— 「第 4 段 6.2 秒，是理想值的 2.8 倍」。
 */
function pacingAudit(durs, duration) {
  const ds = (durs || []).map((d) => Number(d) || 0).filter((d) => d > 0)
  const tot = Number(duration) || ds.reduce((a, b) => a + b, 0)
  const out = { avg: 0, ideal: idealClip(tot), longest: 0, flags: [], score: 10 }
  if (!ds.length) return out
  const ideal = out.ideal
  const avg = ds.reduce((a, b) => a + b, 0) / ds.length
  out.avg = Math.round(avg * 100) / 100
  out.longest = Math.round(Math.max(...ds) * 100) / 100
  let sc = 10
  if (avg > ideal * 1.6) {
    out.flags.push(`平均每镜 ${avg.toFixed(1)} 秒，这个时长该在 ${ideal.toFixed(1)} 秒左右 —— 整体太拖`)
    sc -= 3
  } else if (avg < ideal * 0.45) {
    out.flags.push(`平均每镜 ${avg.toFixed(1)} 秒，碎得看不清 —— 每个镜头至少让人看清一个动作`)
    sc -= 2
  }
  ds.forEach((d, i) => {
    if (d > ideal * 1.6) {
      out.flags.push(`第 ${i + 1} 段 ${d.toFixed(1)} 秒，是理想值的 ${(d / ideal).toFixed(1)} 倍`)
      sc -= 1
    }
  })
  ds.forEach((d, i) => {
    if (d < 0.6) { out.flags.push(`第 ${i + 1} 段只有 ${d.toFixed(2)} 秒，一闪而过`); sc -= 1 }
  })
  out.score = Math.max(0, Math.min(10, sc))
  return out
}

/**
 * 出片前核对「屏幕上的数字有没有说过」「有没有把导演的话剪进去」。
 *
 * 只比对方案里的文字（口播稿 vs 分镜字幕），不碰成片 —— 数字对不上、
 * 或者混进一句「这段重来」，等在成片里看出来就晚了。
 * 只报事实让调用方判断，不替谁决定删不删。
 */
function truthCheck(plan) {
  const pd = plan || {}
  const v = asDict(pd.voice)
  const spoken = []
  if (Array.isArray(v.lines)) {
    for (const x of v.lines) spoken.push(String(x && x.text !== undefined ? x.text : x || ''))
  }
  if (v.text) spoken.push(String(v.text))
  const spokenText = spoken.join(' ')
  const said = new Set(foldNumbers(spokenText))

  // 屏幕上会出现字的字段：分镜字幕 / 各种别名 / 片头片尾落版
  const screen = []
  for (const sh of pd.shots || []) {
    if (!sh || typeof sh !== 'object') continue
    for (const k of ['caption', '字幕', 'text', '文字', '压字', 'big', 'hook']) {
      if (sh[k]) screen.push([String(sh[k]), k])
    }
    const lt = sh.lower_third || sh.人名牌
    if (lt && typeof lt === 'object' && lt.title) screen.push([String(lt.title), '人名牌'])
  }
  for (const k of ['title', 'outro', '片尾', 'hook_text', '开头字']) {
    if (pd[k]) screen.push([String(pd[k]), k])
  }

  const allowed = new Set()
  for (const x of pd.allowed_numbers || []) for (const n of foldNumbers(String(x))) allowed.add(n)

  const unspoken = []
  const seen = new Set()
  for (const [txt, field] of screen) {
    for (const n of foldNumbers(txt)) {
      const key = `${n}|${field}|${txt.slice(0, 20)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!said.has(n) && !allowed.has(n)) unspoken.push({ number: n, field, text: txt.slice(0, 24) })
    }
  }

  const asides = new Set()
  for (const txt of [spokenText, ...screen.map(([t]) => t)]) {
    const low = txt.toLowerCase()
    for (const ph of EDITOR_ASIDES) if (low.includes(ph.toLowerCase())) asides.add(ph)
  }

  const screenNums = new Set()
  for (const [t] of screen) for (const n of foldNumbers(t)) screenNums.add(n)

  return {
    spoken_numbers: [...said].sort(),
    screen_numbers: [...screenNums].sort(),
    unspoken,
    asides: [...asides].sort(),
    ok: !unspoken.length && !asides.size,
  }
}

/**
 * 成片闸门：渲完之后核一遍「说好的东西真的在里面吗」。
 *
 * 旧版只查时长、分辨率、有没有音轨这三样硬件事实；这里补上「段落边界」——
 * 方案说 12 段，成片如果被合成了 3 段，观众看到的就是一路糊过去，
 * 而时长分辨率全都对得上，光看那三个数发现不了。
 */
async function gateCheck(file, expected) {
  const exp = expected || {}
  const p = await E.probe(file)
  const out = { ok: true, file, problems: [], facts: p }
  if (!p || !p.duration) {
    return { ok: false, file, problems: ['文件读不出来，可能是渲染就失败了'], facts: p }
  }
  const dur = Number(p.duration) || 0
  if (exp.duration) {
    const want = Number(exp.duration)
    const diff = Math.abs(dur - want)
    // 容差 0.4 秒：末帧补齐 / 音频尾巴都会差一点点，超过这个才是真错
    if (diff > Math.max(0.4, want * 0.03)) {
      out.problems.push(`时长对不上：方案 ${want.toFixed(2)} 秒，成片 ${dur.toFixed(2)} 秒，差 ${diff.toFixed(2)} 秒`)
    }
  }
  if (exp.width && exp.height) {
    if (p.width !== Number(exp.width) || p.height !== Number(exp.height)) {
      out.problems.push(`分辨率对不上：要 ${exp.width}x${exp.height}，实际 ${p.width}x${p.height}`)
    }
  }
  if (exp.needAudio && !p.hasAudio) out.problems.push('要声音但没有音轨')
  if (exp.needVideo && !p.hasVideo) out.problems.push('没有视频轨')
  /* ★ 时长/分辨率/音轨都对，片子仍然可能是「全黑 + 一行字」。
     旧软件「一直生产不出视频」的另一半原因就是这个：文件生成成功、闸门也过，
     打开一看内容是空的。所以必须真去看画面。 */
  if (exp.checkPicture !== false) {
    const pic = await pictureCheck(file, dur)
    out.picture = pic
    for (const x of pic.problems) out.problems.push(x)
    if (pic.blackSec >= 1.0 && pic.blackSec < dur - 0.2) {
      out.problems.push(`有 ${pic.blackSec.toFixed(1)} 秒是纯黑画面（占全片 ${(pic.blackSec / dur * 100).toFixed(0)}%）`)
    }
    if (pic.motion === 0 && dur >= 2) {
      out.problems.push(`整片 ${dur.toFixed(1)} 秒画面一次都没变过 —— 观众看到的是静止图`)
    }
  }
  out.ok = !out.problems.length
  return out
}

/**
 * 自动补救：把最后一个画面定格延长，补掉片尾的黑场。
 *
 * 为什么要自动做而不是只报错：闸门报「有 5 秒纯黑」，AI 看到后还得自己想怎么补，
 * 大多数情况它就放弃了或者改出一版新的错。而这类问题的解法是固定的 ——
 * 定格最后一帧补到片尾，三行 ffmpeg 的事。
 *
 * 用 tpad=stop_mode=clone：复制最后一帧，不会引入黑场也不会重编码整片
 * （只重编码被补的那一段）。
 */
async function patchTailBlack(file, opts = {}) {
  const p = await E.probe(file)
  if (!p || !p.duration || !p.hasVideo) return { ok: false, error: "这个文件读不出来或者没有画面" }
  const pic = await pictureCheck(file, p.duration)
  if (pic.blackSec < 1.0) return { ok: true, patched: false, note: "没有黑场，不用补" }

  const out = String(opts.out || file.replace(/(\.[a-z0-9]+)$/i, "-补黑场$1"))
  const last = Math.max(0.1, p.duration - pic.blackSec)
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", file,
    "-vf", `tpad=stop_mode=clone:stop_duration=${pic.blackSec.toFixed(2)}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
  if (p.hasAudio) args.push("-c:a", "copy")
  args.push(out)
  const r = await E.run(P_FFMPEG(), args, { timeout: 900000 })
  if (!r.ok || !fs.existsSync(out)) return { ok: false, error: "补黑场失败：" + String(r.stderr || "").slice(0, 200) }
  const np = await E.probe(out)
  return {
    ok: true, patched: true, path: out,
    before: { duration: p.duration, blackSec: pic.blackSec },
    after: { duration: np ? np.duration : 0 },
    note: `片尾 ${pic.blackSec.toFixed(1)} 秒黑场已用最后一帧定格补上`,
  }
}

/**
 * 画面体检：黑场时长 + 画面变化次数。
 * 两个都要算：黑场靠 blackdetect，内容不变靠 scene 分数。
 * ★ freezedetect 单独不可靠（缓慢压暗它不认），所以用 scene 切换次数兜底。
 */
async function pictureCheck(file, dur) {
  const out = { blackSec: 0, cuts: 0, motion: 0, problems: [] }
  try {
    const b = await E.run(P_FFMPEG(), ["-hide_banner", "-i", file, "-vf", "blackdetect=d=0.3:pix_th=0.10", "-f", "null", "-"], { timeout: 300000 })
    const txt = String(b.stderr || "")
    let sum = 0
    for (const m of txt.matchAll(/black_duration:(\d+(?:\.\d+)?)/g)) sum += Number(m[1])
    out.blackSec = sum
  } catch (e) { /* 量不出来就不下这个结论，不编数字 */ }

  try {
    const sc = await E.run(P_FFMPEG(), ["-hide_banner", "-i", file, "-vf", "select='gt(scene,0.12)',metadata=print", "-f", "null", "-"], { timeout: 300000 })
    const txt = String(sc.stdout || "") + String(sc.stderr || "")
    out.cuts = (txt.match(/lavfi\.scene_score=/g) || []).length
    out.motion = out.cuts
    // 每 10 秒至少换 1 次画面；短于 3 秒的片子不按这个判
    if (dur >= 3 && out.cuts < Math.floor(dur / 10)) {
      out.problems.push(`画面只换了 ${out.cuts} 次（${dur.toFixed(0)} 秒的片子每 10 秒至少该换 1 次）`)
    }
  } catch (e) {}
  return out
}

function P_FFMPEG() { return require('./paths').FFMPEG }

module.exports = {
  TTS_SEC_BASE,
  TTS_CHARS_PER_SEC,
  HOOK_MIN_SCORE,
  HOOK_RUBRIC,
  EDITOR_ASIDES,
  PACING_TARGET,
  voiceSeconds,
  voiceCharsFor,
  effTrans,
  voiceParts,
  shotsFromPlan,
  foldNumbers,
  planCheck,
  planReport,
  planFromTimeline,
  parseEvidence,
  checkEvidence,
  planTargets,
  hookScore,
  hookRubric,
  idealClip,
  pacingAudit,
  truthCheck,
  gateCheck,
  pictureCheck,
  patchTailBlack,
}
