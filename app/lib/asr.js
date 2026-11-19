'use strict'
/**
 * 语音转文字（完全离线）。
 *
 * 优先读视频内嵌字幕轨 —— 那是最准的，因为它是人写的。
 * 没有内嵌轨才用本机 SenseVoice 权重（随软件预置，不出本机）。
 *
 * ★ 关键：SenseVoice 会给每个字的 timestamps。这正是「逐句字幕」能做的原因 ——
 * 有真实时间戳才能把一整段文字切成一句一句、每句带自己的起止时间；
 * 只给一段文字的话，字幕时间只能按字数猜，猜出来跟说话节奏对不上。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

const SHERPA_DIR = path.join(P.ROOT, 'kernel', 'dsh', 'node_modules', 'sherpa-onnx-node')
const ASR_WEIGHTS = path.join(P.HOME, '系统', '本地模型', '语音', 'weights', 'sense-voice')

/** 本机有没有装好离线识别能力。 */
function status() {
  const model = path.join(ASR_WEIGHTS, 'model.int8.onnx')
  const tokens = path.join(ASR_WEIGHTS, 'tokens.txt')
  return {
    ready: fs.existsSync(SHERPA_DIR) && fs.existsSync(model) && fs.existsSync(tokens),
    sherpa: fs.existsSync(SHERPA_DIR) ? SHERPA_DIR : '',
    model: fs.existsSync(model) ? model : '',
    weightsDir: ASR_WEIGHTS,
  }
}

let _rec = null
/** 识别器创建一次要几百毫秒、还占内存，复用。 */
function recognizer() {
  if (_rec) return _rec
  const st = status()
  if (!st.ready) throw new Error('本机没有语音识别模型：' + st.weightsDir)
  const asr = require(path.join(SHERPA_DIR, 'non-streaming-asr.js'))
  _rec = new asr.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: st.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: path.join(ASR_WEIGHTS, 'tokens.txt'),
      numThreads: 2, provider: 'cpu', debug: 0,
    },
  })
  return _rec
}

/** 把任意音视频转成 16kHz 单声道 Float32。 */
async function toSamples(file) {
  const r = await E.run(P.FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
    { timeout: 1_800_000, encoding: 'buffer' })
  if (!r.ok || !r.stdout) throw new Error('抽不出音轨：' + String(r.stderr || '').slice(0, 150))
  const buf = r.stdout
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/**
 * 识别一整段音频。返回 {ok, text, tokens, timestamps, emotion, event, source}。
 *
 * tokens 与 timestamps 一一对应（每字的起音时间，秒）——
 * 逐句字幕靠它把文字切到真实时间上，而不是按字数平均。
 */
async function transcribeAudio(file) {
  const st = status()
  if (!st.ready) return { ok: false, error: '本机没有语音识别模型：' + st.weightsDir, source: '' }
  const samples = await toSamples(file)
  if (samples.length < 16000 * 0.2) return { ok: false, error: '这段音频太短（不到 0.2 秒）' }
  const rec = recognizer()
  const stream = rec.createStream()
  stream.acceptWaveform({ samples, sampleRate: 16000 })
  rec.decode(stream)
  const r = rec.getResult(stream) || {}
  const text = String(r.text || '').trim()
  if (!text) return { ok: false, error: '跑通了但没识别到语音（可能是纯配乐/无人声）', source: 'SenseVoice' }
  return {
    ok: true,
    text,
    tokens: r.tokens || [],
    timestamps: r.timestamps || [],
    emotion: String(r.emotion || '').replace(/[<|>]/g, ''),
    event: String(r.event || '').replace(/[<|>]/g, ''),
    lang: String(r.lang || '').replace(/[<|>]/g, ''),
    source: '本地 SenseVoice（离线）',
  }
}

/**
 * 转写一条视频。
 *
 * 先试内嵌字幕轨 —— 那是人写的，比任何识别都准。没有才走离线识别。
 */
async function transcribe(video) {
  const file = String(video || '').trim()
  if (!file || !fs.existsSync(file)) return { ok: false, error: '这个文件不存在：' + video }
  const outDir = C.custPaths().voice
  P.ensureDir(outDir)
  const srtOut = path.join(outDir, '转写-' + P.stamp() + '.srt')

  // 1) 内嵌字幕轨
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:s:0', '-c:s', 'srt', '-y', srtOut], { timeout: 60_000 })
  if (r.ok && fs.existsSync(srtOut) && fs.statSync(srtOut).size > 10) {
    return { ok: true, source: '视频内嵌字幕轨', text: fs.readFileSync(srtOut, 'utf8').slice(0, 4000), path: srtOut }
  }

  // 2) 离线识别
  const t = await transcribeAudio(file)
  if (!t.ok) {
    const st = status()
    return {
      ok: false,
      error: st.ready
        ? '这段片子里没有说话声（或没识别到语音）——本机语音识别模型是好的，不用安装。要字幕的话，直接用 add_caption 把文字烧进画面就行。'
        : '这段视频没有内嵌字幕轨，本机也还没装语音识别模型。',
      ffmpeg_error: String(r.stderr || '').slice(0, 160),
    }
  }
  const m = await E.probe(file)
  const dur = (m && m.duration) || 0
  const lines = ['1', `${srtTm(0)} --> ${srtTm(dur)}`, t.text, '']
  fs.writeFileSync(srtOut, lines.join('\n'), 'utf8')
  return { ok: true, source: t.source, text: lines.join('\n').slice(0, 4000), path: srtOut, emotion: t.emotion }
}

function srtTm(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(ss)},${p(ms, 3)}`
}

/**
 * 逐句字幕：切成一句一句、每句带真实时间。
 *
 * 用 SenseVoice 的逐字时间戳做切分 —— 按标点和停顿切，
 * 而不是按字数平均。字数平均切出来的字幕，说话快的地方字幕跟不上、
 * 慢的地方字幕提前消失。
 */
async function sentences(video, opts = {}) {
  const file = String(video || '').trim()
  if (!file || !fs.existsSync(file)) return { ok: false, error: '这个文件不存在：' + video }
  const t = await transcribeAudio(file)
  if (!t.ok) return { ok: false, error: t.error || '没识别到语音' }

  const toks = t.tokens || []
  const ts = t.timestamps || []
  if (!toks.length || !ts.length) return { ok: true, text: t.text, cues: [], note: '识别到了文字但没有逐字时间，只能给整段' }

  const m = await E.probe(file)
  const dur = (m && m.duration) || 0

  // 按标点 + 停顿切句。停顿阈值用 0.35 秒：正常说话的字间隔在 0.1~0.3 秒，
  // 超过 0.35 基本就是换气/换句了。
  const PUNCT = /[。！？；…，,.!?;]$/
  const PAUSE = Number(opts.pause) || 0.35
  const MAXCH = Number(opts.maxChars) || 18
  const cues = []
  let cur = { text: '', start: ts[0] || 0, end: ts[0] || 0 }
  for (let i = 0; i < toks.length; i++) {
    const ch = toks[i]
    const at = Number(ts[i]) || cur.end
    const gap = at - cur.end
    if (cur.text && (gap > PAUSE || cur.text.length >= MAXCH)) {
      cues.push(cur)
      cur = { text: '', start: at, end: at }
    }
    cur.text += ch
    cur.end = at
    if (PUNCT.test(ch) && cur.text.length >= 4) {
      cues.push(cur)
      cur = { text: '', start: cur.end, end: cur.end }
    }
  }
  if (cur.text) cues.push(cur)
  if (!cues.length) return { ok: true, text: t.text, cues: [], note: '切不出句子' }

  // 收尾：每句至少停 0.6 秒才读得完；与下一句重叠就压到下一句起点
  for (let i = 0; i < cues.length; i++) {
    const minEnd = cues[i].start + Math.max(0.6, cues[i].text.length * 0.16)
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : dur || minEnd
    cues[i].end = Math.min(Math.max(cues[i].end, minEnd), nextStart > cues[i].start ? nextStart : minEnd)
  }

  const outDir = C.custPaths().voice
  P.ensureDir(outDir)
  const srtOut = path.join(outDir, '逐句-' + P.stamp() + '.srt')
  const body = cues.map((c, i) => `${i + 1}\n${srtTm(c.start)} --> ${srtTm(c.end)}\n${c.text}\n`).join('\n')
  fs.writeFileSync(srtOut, body, 'utf8')
  return { ok: true, cues, path: srtOut, source: t.source, emotion: t.emotion, text: cues.map((c) => c.text).join('') }
}

module.exports = { SHERPA_DIR, ASR_WEIGHTS, status, transcribeAudio, transcribe, sentences, srtTm }
