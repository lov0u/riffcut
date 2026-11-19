// 字幕：识别 → 切句 → 样式（ASS 直出）→ 烧进画面。
//
// .srt 只能管时间，样式全靠 force_style 一条，做不到「关键词变红」「字弹进来」。
// ASS 是 libass 的原生格式，能写逐条样式和内联覆盖标签 —— 短视频那种字幕
// （大字、关键词高亮、进场动画）只能走它。
const { join, basename, extname, dirname } = require('node:path')
const { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } = require('node:fs')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

const SUB_MAX_CHARS = 16
const SUB_MAX_LINES = 2
const SUB_SILENCE_DB = -32
const SUB_MIN_SILENCE = 0.42
const SUB_MIN_SEGMENT = 0.55
const SUB_MAX_SECONDS = 12.0
const GAP_KEEP = 0.7

// 名字 → [字号系数, 粗体, 描边, 阴影, 底距比例, 每句进场动画]
const SUB_PRESETS = {
  标准: [1.0, false, 2, 1, 0.11, ''],
  大字: [1.55, true, 4, 2, 0.14, '{\\fad(90,70)}'],
  弹字: [1.5, true, 4, 2, 0.14, '{\\fad(70,60)\\t(0,140,\\fscx112\\fscy112)\\t(140,260,\\fscx100\\fscy100)}'],
  竖屏: [1.7, true, 5, 2, 0.28, '{\\fad(80,60)\\t(0,130,\\fscx108\\fscy108)}'],
  标题: [2.2, true, 5, 3, 0.42, '{\\fad(150,120)}'],
  // 卡片：一句话拆成 1–3 个词一张卡，词大字大，靠读数快。
  // 描边给 0、阴影给 6 —— 用「26% 黑、柔和暗晕」顶替硬描边，
  // 白字压在白衣服/亮墙上仍然读得清，但没有一圈黑边的模板感。
  卡片: [2.0, true, 0, 6, 0.22, '{\\fad(70,60)}'],
  竖屏卡片: [2.3, true, 0, 7, 0.30, '{\\fad(70,60)}'],
  卡拉OK: [1.6, true, 4, 2, 0.16, ''],
  竖屏卡拉OK: [1.8, true, 5, 2, 0.28, ''],
  钩子字: [1.0, true, 0, 6, 0.08, '{\\fad(110,90)}'],
  编辑字: [1.0, true, 0, 0, 0.30, '{\\fad(160,140)}'],
}
const KARAOKE_PRESETS = ['卡拉OK', '竖屏卡拉OK']
// 按**短边**的比例定字号：8% 图宽是给 1080 宽竖图定的（=86 号）。
// 照字面对 1920x1080 横图取 8% 图宽会算出 153 号，一行只放六七个字、砸脸。
const SUB_BY_SHORT = { 钩子字: 0.080, 编辑字: 0.065 }
// 只有 7/8/9 是「贴顶」档；1/2/3 的 MarginV 是离底边多远。
const SUB_ANCHOR = { 钩子字: [8, 0.08], 编辑字: [7, 0.30] }
const SUB_LEFT = { 编辑字: 0.08 }
const SUB_SCRIM = { 钩子字: [0.45, 0.35] }
const CARD_PRESETS = { 卡片: 3, 竖屏卡片: 3 }
const CARD_MAX_WORDS = 3

const MARKS = '，。！？；：、…,.!?;:'
const isMark = ch => MARKS.includes(ch)
const alnum = t => [...String(t)].filter(ch => /[0-9a-zA-Z\u4e00-\u9fa5]/.test(ch))

// ── 时间格式 ──────────────────────────────────────────
/** ASS：H:MM:SS.cc（百分秒两位） */
function assTm(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`
}
/** SRT：HH:MM:SS,mmm */
function srtTm(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  const x = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}
/** #RRGGBB → &HAABBGGRR（ASS 用 BGR 顺序，00 为不透明） */
function assColor(value, alpha = '00') {
  let c = String(value || '').replace(/^#/, '').replace(/[^0-9a-fA-F]/g, '')
  if (c.length !== 6) c = 'FFFFFF'
  return `&H${alpha}${c.slice(4, 6).toUpperCase()}${c.slice(2, 4).toUpperCase()}${c.slice(0, 2).toUpperCase()}`
}

// ── 文本切分 ──────────────────────────────────────────
/**
 * 一句长中文按标点断成几行，每行不超过 limit 字，最多 maxLines 行。
 * 只在标点处断 —— 中文断在词中间会读得断气。优先选靠近 limit 的标点，
 * 不要一见逗号就断（"他站在那里，"/"一动不动，" 是一地碎片不是字幕）。
 */
function breakLine(text, limit = SUB_MAX_CHARS, maxLines = SUB_MAX_LINES) {
  let t = String(text || '').trim()
  if (t.length <= limit) return t ? [t] : []
  const out = []
  while (t.length > limit) {
    const window = t.slice(0, limit + 6)   // 允许多看几个字，找更靠后的标点
    let cut = -1
    for (let i = window.length - 1; i > Math.max(3, Math.floor(limit / 3)); i--) {
      if (isMark(window[i])) { cut = i + 1; break }
    }
    if (cut <= 0) cut = limit              // 整段没标点，硬断
    out.push(t.slice(0, cut).trim())
    t = t.slice(cut).trim()
  }
  if (t) out.push(t)
  let rows = out.filter(Boolean)
  // 行数上限：多出来的并进最后一行，而不是继续往下堆。
  // 三行以上的字幕会占掉小半个画面，手机上读起来像一堵墙。
  if (maxLines && rows.length > maxLines) {
    const keep = rows.slice(0, maxLines - 1)
    keep.push(rows.slice(maxLines - 1).join(''))
    rows = keep
  }
  return rows
}

/**
 * 把一条超长字幕拆成几条各自独立的（每条各占一段时间）。
 * 折行的天花板是「两条同时出现在画面上」；一条 70 字折两行、第二行还得放 50 字，
 * 那不是字幕是一段话糊在画面上。超了就该变成两条字幕。
 * 切法是**均分**而不是「装满一块再下一块」：46 字切成 40+6 的话第二条只闪六分之一秒。
 */
function splitLongCue(text, perLine, maxLines = SUB_MAX_LINES) {
  const t = String(text || '').replace(/\n/g, ' ').trim()
  if (!t) return []
  const rows = breakLine(t, perLine, maxLines)
  if (rows.length <= 1 || Math.max(...rows.map(x => x.length)) <= perLine * 1.25) {
    return rows.length > 1 ? [rows.join('\\N')] : rows
  }
  const chunk = Math.max(4, perLine * maxLines)
  const n = Math.max(1, Math.ceil(t.length / chunk))
  const target = Math.ceil(t.length / n)
  const pieces = []
  let rest = t
  while (rest.length > target && pieces.length < n - 1) {
    let cut = -1
    const lo = Math.max(2, Math.floor(target * 0.8))
    const hi = Math.min(rest.length - 1, Math.floor(target * 1.15))
    for (let i = hi; i >= lo; i--) {
      if (isMark(rest[i])) { cut = i + 1; break }
    }
    if (cut <= 0) cut = target
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) pieces.push(rest)
  return pieces.filter(Boolean).map(x => breakLine(x, perLine, maxLines).join('\\N'))
}

/**
 * 把一句切成几张卡，每张最多 maxWords 个词，时间按字数比例分。
 * 为什么按「词」不按「字」：中文没空格，用标点和长度猜；英文按空格切。
 * 切出来每张短，读者一眼扫完，注意力回到画面上。
 */
function cardSlices(text, start, end, maxWords = CARD_MAX_WORDS) {
  const t = String(text || '').trim()
  if (!t) return []
  let groups = []
  if (t.includes(' ')) {
    const parts = t.split(/\s+/).filter(Boolean)
    let cur = []
    for (const w of parts) {
      cur.push(w)
      if (cur.length >= maxWords) { groups.push(cur.join(' ')); cur = [] }
    }
    if (cur.length) groups.push(cur.join(' '))
  } else {
    // 中文没有空格，按字切：一张卡最多 maxWords*3 个字。
    // 先按标点断，某段还太长就按字数硬切。
    const pieces = t.split(/(?<=[，,。.！!？?；;、])/).map(x => x.trim()).filter(Boolean)
    const step = Math.max(1, Math.round(maxWords) * 3)
    for (let pc of pieces) {
      while (pc.length > step) { groups.push(pc.slice(0, step)); pc = pc.slice(step) }
      if (pc) groups.push(pc)
    }
    // 尾巴太短就并回前一张：三四个字单做一张卡，闪一下就走，看着像出错。
    // 注意不能用 groups[groups.length-2] = ... + groups.pop()：pop 先执行会让索引指错。
    if (groups.length >= 2 && groups[groups.length - 1].length <= 4) {
      const tail = groups.pop()
      groups[groups.length - 1] += tail
    }
  }
  if (!groups.length) return []
  const total = groups.reduce((a, g) => a + Math.max(1, g.length), 0)
  const span = Math.max(0.12, Number(end) - Number(start))
  const out = []
  let acc = 0
  groups.forEach((g, i) => {
    const seg = span * (Math.max(1, g.length) / total)
    const a = Number(start) + acc
    const b = i === groups.length - 1 ? Number(end) : a + seg
    out.push([a, b, g])
    acc += seg
  })
  return out
}

// ── SRT 读写 ──────────────────────────────────────────
/** 读 srt 成 [[起, 止, 文本]]。编码乱、序号跳号、多余空行都容错。 */
function parseSrt(path) {
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const out = []
  const toSec = t => {
    const s = String(t).trim().replace(',', '.')
    const [h, m, x] = (s.split(':').concat(['0', '0'])).slice(0, 3)
    return Number(h) * 3600 + Number(m) * 60 + parseFloat(x || 0)
  }
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter(x => x.trim())
    if (lines.length < 2) continue
    const ti = lines.findIndex(x => x.includes('-->'))
    if (ti < 0) continue
    const [a, z] = lines[ti].split('-->')
    if (a === undefined || z === undefined) continue
    out.push([toSec(a), toSec(z), lines.slice(ti + 1).join(' ').trim()])
  }
  return out
}

function writeSrt(rows, path) {
  const lines = []
  rows.forEach(([a, z, t], i) => {
    lines.push(String(i + 1), `${srtTm(a)} --> ${srtTm(z)}`, t, '')
  })
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

// ── 语音分段 ──────────────────────────────────────────
/**
 * 用静音检测把音频切成语音段。
 * ffmpeg 的 silencedetect 报「静音从哪里开始、多长」，语音段就是相邻两个静音之间的部分。
 * 片头/片尾的静音要单独处理，不然后面全错位。
 */
async function speechSegments(path, opts = {}) {
  const silenceDb = opts.silenceDb ?? SUB_SILENCE_DB
  const minSilence = opts.minSilence ?? SUB_MIN_SILENCE
  const minSegment = opts.minSegment ?? SUB_MIN_SEGMENT
  const maxSeconds = opts.maxSeconds ?? SUB_MAX_SECONDS
  const p = await E.probe(path)
  const dur = p ? p.duration : 0
  if (!(dur > 0)) return []
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-i', path, '-vn',
    '-af', `silencedetect=noise=${Math.round(silenceDb)}dB:d=${minSilence.toFixed(2)}`,
    '-f', 'null', '-'], { timeout: Math.max(120_000, Math.round(dur * 3000)) })
  const starts = [], ends = []
  for (const line of String(r.stderr || '').split('\n')) {
    let m
    if ((m = line.match(/silence_start:\s*([\d.]+)/))) starts.push(Number(m[1]))
    else if ((m = line.match(/silence_end:\s*([\d.]+)/))) ends.push(Number(m[1]))
  }
  // 语音段 = 静音结束 → 下一个静音开始
  const segs = []
  let cur = 0
  starts.forEach((st, i) => {
    if (st - cur >= minSegment) segs.push([cur, Math.min(st, dur)])
    cur = i < ends.length ? ends[i] : dur
  })
  if (dur - cur >= minSegment) segs.push([cur, dur])
  if (!segs.length) segs.push([0, dur])
  // 太长的段按比例硬切：一段 30 秒的字幕没人读得完
  const out = []
  for (const [a, b] of segs) {
    if (b - a <= maxSeconds) { out.push([+a.toFixed(2), +b.toFixed(2)]); continue }
    const n = Math.floor((b - a) / maxSeconds) + 1
    const step = (b - a) / n
    for (let j = 0; j < n; j++) {
      out.push([+(a + j * step).toFixed(2), +(a + (j + 1) * step).toFixed(2)])
    }
  }
  return out
}

/** 抽一段音频成 16k 单声道 wav（ASR 输入）。 */
async function sliceWav(srcPath, a, b, outPath) {
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error',
    '-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', srcPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', outPath],
  { timeout: 120_000 })
  return r.ok && existsSync(outPath)
}

/**
 * ASR：调本地 sherpa-onnx SenseVoice。没有模型就明确说清楚。
 * 内核自带 sherpa 的话可以直接用；否则退回「让模型自己写文案」。
 */
async function asr(wavPath, language = 'auto') {
  const m = findAsrModel()
  if (!m) return { ok: false, error: '本机没装语音识别模型（SenseVoice）。到「模型管理 → 语音识别」装一份，或直接自己写文案。' }
  const exe = join(m.dir, 'sherpa-onnx-offline')
  const r = await E.run(exe, ['--tokens', join(m.dir, 'tokens.txt'),
    '--sense-voice-model', join(m.dir, 'model.int8.onnx'),
    '--num-threads', '2', wavPath], { timeout: 300_000 })
  if (!r.ok) return { ok: false, error: String(r.stderr || r.stdout || '').slice(-300) }
  // 输出形如：`0.000 ... 识别结果`
  const lines = String(r.stdout || '').split('\n').map(x => x.trim()).filter(Boolean)
  const texts = lines.filter(x => !/^[\d.:\s-]+$/.test(x) && !x.startsWith('--'))
  return { ok: true, text: texts.join('').replace(/^[^\u4e00-\u9fa5a-zA-Z0-9]+/, '') }
}

function findAsrModel() {
  const roots = [join(P.SYS, '本地模型'), join(P.HOME, '系统', '本地模型')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const d of readdirSync(root)) {
      const dir = join(root, d)
      if (!existsSync(dir)) continue
      if (existsSync(join(dir, 'sherpa-onnx-offline')) &&
        existsSync(join(dir, 'tokens.txt')) &&
        (existsSync(join(dir, 'model.int8.onnx')) || existsSync(join(dir, 'model.onnx')))) {
        return { dir, name: d }
      }
    }
  }
  return null
}

/**
 * 逐段识别 → 一条条带真实时间的字幕。
 * 和「整段转写」的根本区别：那个给一整段文案，这个给能烧进画面的逐句字幕。
 */
async function subtitleFromSpeech(path, opts = {}) {
  const language = opts.language || 'auto'
  const maxChars = opts.maxChars || SUB_MAX_CHARS
  const segs = await speechSegments(path)
  if (!segs.length) return { ok: false, error: '读不出音频时长，没法分段', count: 0 }

  const tmp = join(P.CACHE_DIR || join(P.SYS, '缓存'), 'sub-' + Date.now())
  P.ensureDir(tmp)
  const items = []
  try {
    for (let i = 0; i < segs.length; i++) {
      const [a, b] = segs[i]
      const wav = join(tmp, `s${String(i).padStart(3, '0')}.wav`)
      if (!await sliceWav(path, a, b, wav)) continue
      const r = await asr(wav, language)
      if (!r.ok || !String(r.text || '').trim()) continue
      items.push([a, b, String(r.text).trim()])
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  if (!items.length) {
    return { ok: false, error: '分段后没有识别到任何语音', count: 0, segments: segs.length }
  }

  // 识别结果先过一遍「像不像人话」再决定要不要写成字幕。
  // 真实踩过：只有配乐的片子，ASR 把合成铺底当人声，每段都识出一个「我」，
  // 三行字幕整片重复同一个字，烧上去是笑话。
  const all = items.map(x => x[2]).join('')
  const bare = alnum(all).join('')
  const uniq = new Set(bare).size
  const per = bare.length / Math.max(1, items.length)
  if (bare.length >= 2 && (uniq < 5 || per < 1.6)) {
    return {
      ok: false, count: 0, segments: segs.length,
      error: `这条片子听不出人声。识别出来的只有 ${bare.length} 个字（${all.trim().slice(0, 20) || '空'}），`
        + '重复成不了句子 —— 多半是只有配乐或环境声。没有人说话就别做逐句字幕；'
        + '要字幕就自己写文案，走 subtitle_style 直接排。',
    }
  }

  // 先把每句拆成行、算出每行的起止
  const rows = []
  for (const [a, b, txt] of items) {
    const parts = []
    const sentences = String(txt).match(/[^。！？!?；;]+[。！？!?；;]*/g) || [String(txt)]
    for (const s of sentences.map(x => x.trim()).filter(Boolean)) {
      parts.push(...breakLine(s, Math.max(6, Math.round(maxChars)), 0))
    }
    if (!parts.length) continue
    const total = parts.reduce((x, y) => x + y.length, 0) || 1
    let t = a
    for (const part of parts) {
      const share = (b - a) * part.length / total
      rows.push([t, t + share, part])
      t += share
    }
  }

  // 相邻两句之间那点空隙，字幕不该跟着消失 —— 观众正看着一句等下一句，
  // 字突然空半秒，那半秒就像卡了一下。0.7 秒是手册给的线。
  for (let i = 0; i < rows.length - 1; i++) {
    const gap = rows[i + 1][0] - rows[i][1]
    if (gap > 0.01 && gap <= GAP_KEEP) rows[i][1] = rows[i + 1][0]
  }
  // 说完不等于读完：7 字/秒 + 0.25 秒；中间句只能延伸到下一句开始，不能互相覆盖。
  rows.forEach((row, i) => {
    const chars = alnum(row[2]).length
    if (chars < 4) return
    const needed = 0.25 + chars / 7.0
    if (row[1] - row[0] + 0.02 >= needed) return
    const latest = i + 1 < rows.length ? rows[i + 1][0] : row[0] + needed
    row[1] = Math.max(row[1], Math.min(latest, row[0] + needed))
  })

  const out = opts.out || join(C.custPaths().voice, `字幕-${P.stamp()}.srt`)
  P.ensureDir(dirname(out))
  writeSrt(rows, out)
  return {
    ok: true, path: out, rows, count: rows.length, segments: segs.length,
    text: rows.map(x => x[2]).join('\n').slice(0, 4000),
  }
}

/**
 * 逐句字幕的行，给工具层用。
 * ★ 第一版签名写成 buildCues(segs)，但 speechSegments 只给 [起,止] 没有文字 ——
 *   要文字必须走 ASR，所以这里收「片子路径」而不是「段落数组」。
 */
async function buildCues(path, opts = {}) {
  const r = await subtitleFromSpeech(path, opts)
  return r.ok ? (r.rows || []) : []
}

/**
 * 一句话铺满全片：不识别，直接拿文字和时长生成一条 cue。
 * 用于「给这条片子加一行标题/口号」这种场景。
 */
function simpleSrt(text, duration, out) {
  const body = String(text || '').trim()
  if (!body) throw new Error('simpleSrt 要文字')
  const dur = Number(duration) > 0 ? Number(duration) : 3
  const file = out || join(C.custPaths().voice, `字幕-${P.stamp()}.srt`)
  P.ensureDir(dirname(file))
  writeSrt([[0, dur, body]], file)
  return file
}

/** 整段转写（只要文字，不要时间）。 */
async function transcribe(path) {
  const wav = join(P.CACHE_DIR || join(P.SYS, '缓存'), `asr-${P.stamp()}.wav`)
  P.ensureDir(dirname(wav))
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], { timeout: 300_000 })
  if (!r.ok) return { ok: false, error: String(r.stderr || '').slice(-200) }
  const res = await asr(wav)
  try { rmSync(wav, { force: true }) } catch {}
  return res.ok ? { ok: true, text: res.text, path } : res
}

// ── ASS 生成 ──────────────────────────────────────────
function assStyleLine(name, font, size, color, outlineColor, bold, outline, shadow, align, marginV, secondary = null, spacing = -1.0, marginL = null) {
  const sec = secondary ? assColor(secondary) : '&H000000FF'
  const ml = marginL === null ? 40 : Math.max(0, Math.round(marginL))
  // 字段顺序：Name,font,size,color,secondary,outline_color,Bold,Italic,Underline,StrikeOut,
  //           ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
  // 别把 MarginV 写到 MarginL 位上 —— 那样字会贴到左边，垂直位置看着像没生效。
  return `Style: ${name},${font},${Math.round(size)},${assColor(color)},${sec},${assColor(outlineColor)},&H00000000,${bold ? -1 : 0},0,0,0,100,100,${spacing.toFixed(1)},0,1,${Math.round(outline)},${Math.round(shadow)},${Math.round(align)},${ml},${ml},${Math.round(marginV)},1`
}

/** 把一行字变成「逐个跟着语音亮起来」。\kf 是这段字花几厘秒填满。 */
function karaokeText(t, start, end) {
  const durCs = Math.max(1, Math.round((Number(end) - Number(start)) * 100))
  const plain = String(t).replace(/\\N/g, '')
  const n = Math.max(1, [...plain].filter(c => !/\s/.test(c)).length)
  const per = Math.max(1, Math.round(durCs / n))
  let out = ''
  let i = 0
  while (i < t.length) {
    if (t.slice(i, i + 2) === '\\N') { out += '\\N'; i += 2; continue }
    const ch = t[i]
    out += /\s/.test(ch) ? ch : `{\\kf${per}}${ch}`
    i++
  }
  return out
}

/**
 * 把 srt 转成带样式的 ASS。
 * 三件 srt 做不到、短视频必须有的：关键词高亮、进场动画、竖屏安全区。
 */
function srtToAss(srtPath, opts = {}) {
  const preset = opts.preset || '标准'
  const pset = SUB_PRESETS[preset] || SUB_PRESETS['标准']
  const [kSize, kBold, kOutline, kShadow, kMv, kFx] = pset
  const w = Math.round(opts.width || 1080), h = Math.round(opts.height || 1920)
  const s = C.settings()

  let font = String(opts.font || s.subtitle_font || 'STHeiti Medium').replace(/,/g, ' ').replace(/'/g, '')
  // 字号按画面短边算，不按固定像素：写死 26 是指 1080p，放到 720p 显得大、4K 上像蚂蚁。
  // 经验值短边 4.5% 是「一眼读完又不挡画面」（1080 → 48 号）。
  let base
  if (opts.size) base = Math.round(opts.size)
  else if (s.subtitle_size && String(s.subtitle_size) !== '26') base = clampInt(s.subtitle_size, 10, 96, 26)
  else if (SUB_BY_SHORT[preset]) base = Math.max(16, Math.round(Math.min(w, h) * SUB_BY_SHORT[preset]))
  else base = Math.max(16, Math.round(Math.min(w, h) * 0.045))
  const fsize = Math.max(12, Math.round(base * kSize))
  let mv = opts.marginV !== undefined && opts.marginV !== null ? Math.round(opts.marginV) : Math.round(h * kMv)
  let align = opts.align || 2

  // 竖屏安全区：9:16 底部约 350px 是平台自己的点赞/评论/进度条，
  // 字幕压上去会被盖住（用户看着像字幕没了，其实压在按钮下面）。
  // 两个条件都满足才抬：真的是竖屏、且这一档是贴底对齐（1/2/3）。
  // 只往上抬、不往下压：预设已经给更高就尊重预设。
  if (h >= w * 1.5 && [1, 2, 3].includes(Number(align))) {
    const safe = Math.round(h * 0.19)   // 1920 → 365
    if (mv < safe) mv = safe
  }
  // 钩子字贴顶、编辑字压在画面上三分之一 —— 这两档不用底距，改成绝对位置。
  const anchor = SUB_ANCHOR[preset]
  if (anchor && (opts.marginV === undefined || opts.marginV === null)) {
    align = anchor[0]
    mv = Math.round(h * anchor[1])
    // 贴顶档（7/8/9）还有第二个安全区：顶部约 270px 是平台标题栏/返回/时间。
    // 字顶压进去第一个字就缺一半，比字幕没做还糟。300px 是手册给的线。
    if (h >= w * 1.5 && [7, 8, 9].includes(Number(align))) {
      const top = Math.round(h * 0.157) + 1
      if (mv < top) mv = top
    }
  }

  const pc = String(opts.color || s.subtitle_color || '#FFFFFF')
  const oc = String(s.subtitle_outline_color || '#000000')
  const hl = String(opts.highlight || '#FFD400')
  const hla = assColor(hl)
  const reset = `{\\c${assColor(pc)}&}`
  const kara = opts.karaoke !== undefined ? !!opts.karaoke : KARAOKE_PRESETS.includes(preset)

  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 2',   // 2 = 不自动换行，行由我们自己的 \N 控制
    'ScaledBorderAndShadow: yes',
    // 这行给烧录看：钩子字这一档要求在烧字幕之前先叠一条顶部渐变。
    // 写在文件里而不是靠调用方传参，因为 ass 可能存下来、换个地方再烧。
    SUB_SCRIM[preset] ? `; VolenaScrim: ${SUB_SCRIM[preset][0].toFixed(2)},${SUB_SCRIM[preset][1].toFixed(2)}` : '; VolenaScrim: none',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    assStyleLine('D', font, fsize, pc, oc, kBold, kOutline, kShadow, align, mv,
      kara ? hl : null, -1.0, Math.round(w * (SUB_LEFT[preset] || 0)) || null),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  let kws = (opts.keywords || []).map(x => String(x).trim()).filter(x => x.length >= 2)
  kws.sort((a, b) => b.length - a.length)   // 长词优先，"开工"不会先匹配掉"开工大吉"

  // 一行能放多少字：字号越大、画幅越窄，能放的字越少。
  // 竖屏 1080 宽、44 号约 14 字；横屏 1920 宽约 24 字。
  // 与其让它溢出（libass 硬换行会断在词中间），不如自己按标点断。
  let perLine = Math.max(6, Math.floor((w * 0.86) / Math.max(8.0, fsize * 1.02)))
  if (w > h) perLine = Math.max(perLine, 14)

  const cardN = CARD_PRESETS[preset]
  let cues = parseSrt(srtPath)
  if (cardN) {
    const exp = []
    for (const [a, z, t] of cues) exp.push(...cardSlices(t, a, z, cardN))
    cues = exp
  } else {
    // 超长 cue 先拆成几条独立字幕：一条 70 字折两行、第二行还得放 50 字，
    // 那不是字幕是一段话糊在画面上。拆开之后各占一段时间。
    const exp = []
    for (const [a, z, t] of cues) {
      const blocks = splitLongCue(t, perLine)
      if (blocks.length <= 1) { exp.push([a, z, t]); continue }
      const total = blocks.reduce((x, b) => x + b.replace(/\\N/g, '').length, 0) || 1
      let t0 = a
      for (const b of blocks) {
        const share = (z - a) * b.replace(/\\N/g, '').length / total
        exp.push([t0, t0 + share, b])
        t0 += share
      }
    }
    cues = exp
  }

  const events = []
  for (const [a, z, txt] of cues) {
    let t = String(txt || '').replace(/\n/g, ' ').trim()
    if (!t) continue
    // 卡片已经是短块，别再按每行字数硬折 —— 一张卡折两行就失去「一眼扫完」的意义
    if (!cardN && !t.includes('\\N')) {
      const rows = breakLine(t, perLine)
      if (rows.length > 1) t = rows.join('\\N')
    }
    // 关键词上色必须放在断行之后 —— 先上色再按字数断，会把颜色标签劈成两半
    if (kws.length) {
      for (const kw of kws) {
        if (t.includes(kw)) t = t.split(kw).join(`{\\c${hla}&}${kw}${reset}`)
      }
    }
    if (kara) t = karaokeText(t, a, z)   // 卡拉OK不再叠关键词上色，会互相覆盖
    events.push(`Dialogue: 0,${assTm(a)},${assTm(z)},D,,0,0,0,,${(kFx || '') + t}`)
  }

  const out = opts.out || join(C.custPaths().voice, `字幕-${P.stamp()}.ass`)
  P.ensureDir(dirname(out))
  writeFileSync(out, head.concat(events).join('\n') + '\n', 'utf8')
  return { path: out, cues: events.length, preset, size: fsize, keywords: kws, highlight: hl, perLine, karaoke: kara, card: !!cardN }
}

const clampInt = (v, lo, hi, d) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
}

/**
 * 钩子字顶上那条渐变遮罩：一串 drawbox 叠出来。
 * 顶部 45% 高、35% 不透明线性渐到全透明，让白字压在任何亮画面上都读得清，
 * 又不至于像一条实心黑带那样把画面切断。
 * 为什么不用 gradients 滤镜：它要 overlay 带 alpha 的中间文件，本机没有能进 mp4 的 alpha 编码器。
 * 为什么不用 ASS 绘图：libass 绘图坐标按字号缩放，画出来是几条糊满全屏的横带。
 */
function scrimVf(w, h, heightRatio = 0.45, topAlpha = 0.35, steps = 24) {
  if (!(w > 0 && h > 0)) return ''
  steps = Math.max(6, Math.min(64, Math.round(steps)))
  const total = h * heightRatio
  const out = []
  let prev = 0
  for (let i = 0; i < steps; i++) {
    // 每条高度用「下一条起点减本条起点」算，别用固定 band：
    // band 取整会留半像素，相邻两条要么叠暗线、要么露亮缝，那就是肉眼看到的横条。
    const edge = Math.round((i + 1) * total / steps)
    const hh = edge - prev
    if (hh <= 0) continue
    const a = topAlpha * (1 - i / Math.max(1, steps - 1))
    if (a <= 0.004) { prev = edge; continue }
    out.push(`drawbox=x=0:y=${prev}:w=iw:h=${hh}:color=black@${a.toFixed(3)}:t=fill`)
    prev = edge
  }
  return out.join(',')
}

/** 读画面实际宽高；读不出来给 1080x1920（短视频最常见画幅）。 */
async function probeWH(path, fallback = [1080, 1920]) {
  const p = await E.probe(path)
  return p && p.width ? [p.width, p.height] : fallback
}

/**
 * 把字幕烧进画面，真重新编码出一个新 mp4。
 * 用软件自带的 libass（跟专业剪辑台同一套字体/字号/描边设置）。
 */
async function burnCaption(video, opts = {}) {
  const srtPath = opts.srt ? String(opts.srt) : ''
  const text = String(opts.text || '').trim()
  // libass 的 subtitles 滤镜对带中文/空格的路径很挑，一律先复制到纯 ASCII 临时路径
  const clean = `/tmp/riffcut_cap_${Date.now().toString(36)}.srt`
  if (srtPath) {
    if (!existsSync(srtPath)) throw new Error('找不到这个字幕文件：' + srtPath)
    copyFileSync(srtPath, clean)
  } else {
    if (!text) throw new Error('要给 text（字幕文字）或 srt（字幕文件路径）')
    const p = await E.probe(video)
    const dur = Math.max(0.5, p ? p.duration : 5)
    writeSrt([[0, dur, text.replace(/\n/g, ' ').slice(0, 48)]], clean)
  }

  const outdir = opts.final ? C.custPaths().videos : C.custPaths().previews
  P.ensureDir(outdir)
  const stem = basename(video, extname(video))
  let out = join(outdir, stem + '_字幕.mp4')
  if (existsSync(out)) out = join(outdir, `${stem}_字幕_${P.stamp()}.mp4`)

  const s = C.settings()
  // ★ 传 .ass 时绝不能再加 force_style：ASS 里字号/位置/进场动画都算好了，
  // force_style 会整段盖掉它（症状：竖屏预设字号 83 被压回 26、位置也丢）。
  // force_style 只用于「纯文本/srt 快速烧一条」那种没有样式表的场合。
  const isAss = /\.ass$/i.test(srtPath)
  const styleArg = isAss ? '' : `:force_style='${subStyle(s)}'`
  const [w, h] = await probeWH(video)
  // 顶部渐变从 ASS 头部读（写在文件里，跟着文件走），没写就用调用方给的 preset
  let scrim = SUB_SCRIM[String(opts.preset || '')]
  if (isAss) {
    const head = readFileSync(clean, 'utf8').split('\n').find(l => l.includes('VolenaScrim:'))
    const m = head && head.match(/VolenaScrim:\s*([\d.]+),\s*([\d.]+)/)
    if (m) scrim = [Number(m[1]), Number(m[2])]
    else if (head && head.includes('none')) scrim = null
  }
  const vfParts = []
  if (scrim) vfParts.push(scrimVf(w, h, scrim[0], scrim[1]))
  vfParts.push(`subtitles=${clean.replace(/:/g, '\\:')}${styleArg}`)

  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', video, '-vf', vfParts.filter(Boolean).join(','),
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'copy', out], { timeout: 420_000 })
  try { rmSync(clean, { force: true }) } catch {}
  if (!r.ok || !existsSync(out)) {
    throw new Error('字幕烧录失败：' + String(r.stderr || r.stdout || '未知原因').slice(-180))
  }
  return { ok: true, path: out, name: basename(out), srt: srtPath || '', text }
}

/** 字幕/文字卡样式全部来自软件设置，不再写死 STHeiti 26 白字。 */
function subStyle(s, big = false) {
  let size = clampInt(s.subtitle_size, 10, 96, 26)
  if (big) size = Math.min(96, size * 2)
  const align = big ? 5 : clampInt(s.subtitle_align, 1, 9, 2)
  const font = String(s.subtitle_font || 'STHeiti Medium').replace(/,/g, ' ').replace(/'/g, '')
  return `FontName=${font},FontSize=${Math.round(size)},Bold=${s.subtitle_bold ? -1 : 0},`
    + `PrimaryColour=${assColor(s.subtitle_color)},OutlineColour=${assColor(s.subtitle_outline_color)},`
    + `BorderStyle=1,Outline=${clampInt(s.subtitle_outline, 0, 8, 2)},Shadow=${clampInt(s.subtitle_shadow, 0, 6, 1)},`
    + `Alignment=${align},MarginV=${big ? 0 : clampInt(s.subtitle_margin_v, 0, 300, 48)}`
}

module.exports = {
  SUB_MAX_CHARS, SUB_MAX_LINES, SUB_PRESETS, KARAOKE_PRESETS, SUB_BY_SHORT,
  SUB_ANCHOR, SUB_LEFT, SUB_SCRIM, CARD_PRESETS, CARD_MAX_WORDS, GAP_KEEP,
  assTm, srtTm, assColor, breakLine, splitLongCue, cardSlices, parseSrt, writeSrt,
  speechSegments, sliceWav, asr, findAsrModel, subtitleFromSpeech, buildCues, simpleSrt, transcribe,
  assStyleLine, karaokeText, srtToAss, scrimVf, probeWH, burnCaption, subStyle, clampInt,
}
