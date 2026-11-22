// 音频：配音（TTS）/ 配乐 / 音效 / 响度收尾。
//
// 这一层最容易做错的地方是「响度」：不是把每一层都调到 1.0 就行，
// 是层与层之间要差对档次。对白比配乐低 6dB 人声就被音乐埋了；
// 音效比对白还响，观众只听到「咚」听不到台词。
const { join, basename, extname, dirname } = require('node:path')
const { existsSync, statSync, mkdirSync, unlinkSync, renameSync, readdirSync } = require('node:fs')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

// 四层电平（相对对白的 dB 差）。数字来自实拍剪辑手册的四层标准：
// 对白 0 / 音效 −6~−10 / 配乐 −18~−24 / 环境底噪 −26~−32。
const AUDIO_LAYER_DB = { voice: 0.0, sfx: -8.0, bgm: -21.0, ambience: -29.0 }
const AUDIO_DUCK_DB = -4.0        // 说话时配乐再让 4dB
const LOUD_TARGET_LUFS = -14.0    // 短视频平台通行口径
const LOUD_TRUE_PEAK = -1.0       // 真峰值上限，留 1dB 余量防削波
// alimiter 压的是 PCM 峰值，后面还要重编一次 AAC（有损）。
// 实测限幅到 -1.0 dBFS 后成品会回到 -0.8，正好被判削波失败。
// 所以限幅目标比交付上限再低一点，把编码回升留出来。
const AAC_PEAK_HEADROOM_DB = 1.2

/** 只规范送进 TTS 的读音文本，不改屏幕上的品牌写法。 */
function speakText(text) {
  return String(text || '').replace(/[^\W\d_]+/gu, (word) => {
    if (/^[\x00-\x7F]+$/.test(word)) return word
    // 去调号
    const plain = word.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').replace(/[^\x00-\x7F]/g, '')
    if (!plain) return word
    if (plain.length > 1 && plain === plain.toUpperCase()) {
      return plain[0].toUpperCase() + plain.slice(1).toLowerCase()
    }
    return plain
  })
}

/** 系统里有的音色。不写死音色名 —— 真有的才用。 */
async function systemVoices() {
  const r = await E.run('/usr/bin/say', ['-v', '?'], { timeout: 20_000 })
  const good = [], bad = []
  for (const line of String(r.stdout || '').split('\n')) {
    // 形如：`Eddy (中文（中国大陆）)     zh_CN    # 你好！我叫Eddy。`
    const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s*(#.*)?$/)
    if (!m) continue
    const name = m[1].trim()
    const locale = m[2]
    if (locale !== 'zh_CN') continue
    ;(/not installed|未安装/i.test(line) ? bad : good).push({ name, locale })
  }
  return { good, bad }
}

/**
 * 配音。三级回落，保证一定能出声：
 *   ①本地 Ming 情感配音（mlx，跑在独立环境）
 *   ②ZipVoice 克隆（需要参考音频 + 参考文本）
 *   ③系统 say（默认 Tingting）
 * 前两级要模型和参考音；这一版先把第三级做扎实，前两级保留钩子。
 */
/* ============ Ming-3.0 本地情感配音（audio.cpp / GGUF） ============

为什么走 audio.cpp 而不是 mlx：
  Ming 官方只有 PyTorch / MLX 两种跑法，两个都要 Python 环境。客户装个软件
  不该先装 Python + mlx，所以换成 audio.cpp 的 GGUF 版 —— 它是预编译的
  C++ 二进制（macOS arm64 Metal 版 38MB，随包发），模型是单文件 GGUF，
  推理全在 Metal 上，不依赖任何 Python 运行时。

模型与二进制的落点（都在安装包的 Resources 下，客户不用下载）：
  <RES>/tools/audio.cpp/audiocpp_cli        ← 预编译 CLI
  <RES>/tools/audio.cpp/model_specs/        ← ming3_tts.json 等 spec
  <RES>/models/ming-3.0-tts-0.5b-q8_0.gguf  ← 1.66GB 权重（q8_0 够用）

★ 实测（本机 M6 / Metal）：一句 21 字中文 2.8 秒出 3.9 秒 44.1kHz 单声道音频，
  音量 mean -16.9dB / max -0.0dB。emotion / speed / voice_design 三种模板都通。
*/
const MING_FAMILY = 'ming3_tts'
const MING_GGUF_NAME = 'ming-3.0-tts-0.5b-q8_0.gguf'

/** audio.cpp CLI 与模型在哪儿。打包版在 Resources 下，开发版在 tools/ 下。 */
function mingPaths() {
  const RES = join(__dirname, '..', '..')
  const cands = [
    { cli: join(RES, 'tools', 'audio.cpp', 'audiocpp_cli'), spec: join(RES, 'tools', 'audio.cpp', 'model_specs'), model: join(RES, 'models', MING_GGUF_NAME) },
    { cli: join(RES, 'tools', 'audio.cpp', 'audiocpp_cli'), spec: join(RES, 'tools', 'audio.cpp', 'model_specs'), model: join(P.HOME, '系统', '本地模型', '语音', 'weights', 'ming-tts', MING_GGUF_NAME) },
    { cli: join(__dirname, '..', '..', 'tools', 'audio.cpp', 'audiocpp_cli'), spec: join(__dirname, '..', '..', 'tools', 'audio.cpp', 'model_specs'), model: join(__dirname, '..', '..', 'tools', 'audio.cpp', 'models', MING_GGUF_NAME) },
  ]
  for (const c of cands) {
    if (existsSync(c.cli) && existsSync(c.model)) return c
  }
  return null
}

/** Ming 能不能用。不能就说明缺哪个文件，别只说「不可用」。 */
function mingState() {
  const p = mingPaths()
  if (!p) return { ok: false, step: 'Ming 配音引擎还没装（audiocpp_cli 或 GGUF 权重不在）' }
  let mb = 0
  try { mb = Math.round(statSync(p.model).size / 1048576) } catch (e) {}
  return { ok: true, cli: p.cli, spec: p.spec, model: p.model, mb, step: 'Ming 引擎就绪（' + mb + 'MB 权重）' }
}

/**
 * 用 Ming 合成一段。返回 {ok, path, duration, ms}。
 *
 * ★ 参数为什么要分开传 template：
 *   Ming 有八个模板（tts / basic / emotion / dialect / ip / voice_design ...），
 *   不同模板接受的字段不同 —— 实测往 basic 里塞 emotion 会直接报
 *   `unsupported Ming BASIC control: emotion`。所以调用方要说清用哪个模板。
 */
async function mingTts(text, opts) {
  opts = opts || {}
  const st = mingState()
  if (!st.ok) return { ok: false, error: st.step }
  const txt = String(text || '').trim()
  if (!txt) return { ok: false, error: '配音文本是空的' }

  const outdir = C.custPaths().voice
  P.ensureDir(outdir)
  const out = opts.out || join(outdir, 'Ming配音-' + P.stamp() + '.wav')

  const task = opts.task === 'clone' ? 'clon' : (opts.task === 'design' ? 'vdes' : 'tts')
  const args = [
    '--family', MING_FAMILY,
    '--task', task,
    '--backend', opts.backend || 'metal',
    '--model', st.model,
    '--text', txt,
    '--out', out,
  ]
  // spec 目录：不传它会去 cwd 找 model_specs/，从 app 目录调起来必失败
  if (st.spec && existsSync(st.spec)) args.unshift('--model-spec-override', st.spec)

  /* ★ Ming 3.0 的参数是「按模板分组」的枚举，不是数值。
     实测（tools/audio.cpp/model_specs/ming3_tts.json）：
       · speed  只认 慢速|中速|快速，且**只属于 basic 模板**
       · pitch  只认 低|中|高，只属于 basic
       · volume 只认 低|中|高，只属于 basic
       · emotion 只属于 emotion 模板（字符串标签）
       · voice_id 只属于 ip 模板，值是 US_Emma / US_James / UK_George / UK_Charlotte
     以前这里无条件把 speed/pitch/volume/emotion 全塞进去（还是数字 1.0/0 这种），
     于是任何一次配音都报 `Ming TTS does not accept structured controls` ——
     配音页整块功能等于死的。现在按模板只传它认的键，值也做归一化。
     音色本身走 voice_ref（参考音频），不是 voice_id。 */
  const tpl = String(opts.template || 'tts')
  const opt = (k, v) => { if (v !== undefined && v !== null && v !== '') args.push('--request-option', k + '=' + v) }

  opt('language', opts.language || 'zh')
  opt('template_name', tpl)

  if (tpl === 'basic') {
    // 数值/中英文都归一化成它认的三个枚举值
    const rateMap = (v) => {
      const s = String(v == null ? '' : v).trim()
      if (['慢速', '中速', '快速'].includes(s)) return s
      const n = Number(v)
      if (!Number.isFinite(n)) return ''
      return n < 0.85 ? '慢速' : (n > 1.15 ? '快速' : '中速')
    }
    const triMap = (v) => {
      const s = String(v == null ? '' : v).trim()
      if (['低', '中', '高'].includes(s)) return s
      const n = Number(v)
      if (!Number.isFinite(n)) return ''
      return n < -0.5 ? '低' : (n > 0.5 ? '高' : '中')
    }
    opt('speed', rateMap(opts.speed))
    opt('pitch', triMap(opts.pitch))
    opt('volume', triMap(opts.volume))
  }
  if (tpl === 'emotion') opt('emotion', opts.emotion)
  if (tpl === 'ip') {
    const VID = ['US_Emma', 'US_James', 'UK_George', 'UK_Charlotte']
    const v = String(opts.voiceId || '')
    if (VID.includes(v)) opt('voice_id', v)
  }
  if (tpl === 'dialect') opt('dialect', opts.dialect)
  opt('instruct', opts.instruct)
  /* ★ voice_ref 是顶层参数，不是 request-option。
     实测 `--request-option voice_ref=...` 会被引擎直接拒绝：
       audiocpp_cli failed: unknown Ming TTS request option: voice_ref
     只有顶层的 `--voice-ref <file>` 才认。以前这里写成 opt('voice_ref', ...)
     等于克隆永远传不进参考音频，所谓「用我的音色」出来的全是默认嗓子。 */
  if (opts.voiceRef) args.push('--voice-ref', String(opts.voiceRef))
  opt('reference_text', opts.referenceText)

  const t0 = Date.now()
  const r = await E.run(st.cli, args, { timeout: 600_000 })
  const ms = Date.now() - t0
  if (!existsSync(out)) {
    const msg = String(r.stderr || r.stdout || '')
      .split('\n').filter(x => /fail|error|unsupported/i.test(x)).join(' ').slice(0, 300)
    return { ok: false, error: msg || 'Ming 没生成出音频文件', ms }
  }
  const p = await E.probe(out)
  C.history('生成配音', 'Ming · ' + txt.length + ' 字')
  return { ok: true, path: out, name: basename(out), engine: 'ming', duration: p ? p.duration : 0, ms }
}

/** Ming 的音色目录：内置音色 + 情感/语速/音高/音量四组控制项。 */
function mingVoices() {
  const m = require('./voicemodels')
  let list = []
  try { list = (m.MING_VOICES || []).slice() } catch (e) {}
  return list
}

async function tts(text, opts = {}) {
  const s = C.settings()
  let voice = opts.voice || s.voice || ''
  if (!voice) {
    const sv = await systemVoices()
    voice = (sv.good[0] && sv.good[0].name) || 'Tingting'
  }
  /* ★ 音色名如果是用户自己录的（音色/index.json 里有），就必须走克隆：
     传 sample.wav 当参考音频。否则 Ming 拿到一个它不认识的音色名，
     照样用默认嗓子念 —— 用户「选了我的音色」，成品却是别人的声音。
     这一段放在最前面，保证试听、配音工具、出片全走同一条判断。 */
  let autoRef = ''
  if (!opts.voiceRef && voice) {
    try {
      autoRef = require('./voicemodels').myVoiceFile(voice) || ''
    } catch (e) { autoRef = '' }
  }
  const effectiveRef = opts.voiceRef || autoRef
  const rate = parseInt(opts.rate || s.voice_rate || 175, 10)
  const outdir = C.custPaths().voice
  P.ensureDir(outdir)
  const out = opts.out || join(outdir, `配音-${P.stamp()}.wav`)
  const txt = speakText(String(text || '').trim())
  if (!txt) throw new Error('配音文本是空的')

  /* ★ 优先 Ming（本地、有情感、190+ 音色）；只有引擎缺失或合成失败才退回系统 say。
     用户明确要求过：不许因为「省事」就把它降级成系统音色。 */
  if (opts.engine !== 'system' && String(voice || '') !== 'macos-system' && String(opts.voiceModel || '') !== 'macos-system') {
    const m = await mingTts(text, {
      out,
      task: effectiveRef ? 'clone' : 'tts',
      template: opts.template || (opts.emotion ? 'emotion' : 'tts'),
      language: opts.language || 'zh',
      speed: opts.speed, pitch: opts.pitch, volume: opts.volume,
      emotion: opts.emotion, instruct: opts.instruct, dialect: opts.dialect,
      voiceRef: effectiveRef, referenceText: opts.referenceText,
      backend: opts.backend,
    })
    if (m.ok) {
      return {
        ok: true, path: m.path, name: m.name,
        voice: (opts.voiceName || voice || 'Ming'), rate,
        duration: m.duration, engine: 'ming', ms: m.ms, cloned: !!effectiveRef,
      }
    }
    // 记下为什么退回，别让「Ming 坏了」这件事静悄悄变成系统音色
    console.error('[audio] Ming 不可用，退回系统配音：' + m.error)
    if (opts.strictMing) throw new Error('Ming 配音失败：' + m.error)
  }

  const aiff = out + '.aiff'
  const r = await E.run('/usr/bin/say', ['-v', voice, '-r', String(rate), '-o', aiff, txt], { timeout: 300_000 })
  if (!r.ok || !existsSync(aiff)) {
    throw new Error(`系统配音失败（音色 ${voice}）：${String(r.stderr || '').slice(0, 200)}`)
  }
  // say 出的是 aiff，转 wav 便于后续统一处理
  await E.ffmpeg(['-v', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '2', out], { timeout: 120_000 })
  try { unlinkSync(aiff) } catch {}
  const p = await E.probe(out)
  C.history('生成配音', `${voice} · ${txt.length} 字`)
  return { ok: true, path: out, name: basename(out), voice, rate, duration: p ? p.duration : 0, engine: 'system' }
}

/** 配乐情绪 → 现场合成的参数（根音、三和弦比例、速度）。 */
function bgmMood(mood) {
  const m = String(mood || '').trim()
  if (/轻快|活泼|欢快/.test(m)) return [392.0, [1.0, 1.26, 1.5], 1.6]
  if (/大气|史诗|壮|宏大/.test(m)) return [130.8, [1.0, 1.5, 2.0], 4.0]
  return [261.6, [1.0, 1.25, 1.5], 2.8]
}

/**
 * 配乐：有音乐文件就循环裁到片长；没有就现场合成三和弦铺底。
 *
 * 两个坑（本地实测踩过）：
 *   ① aevalsrc 表达式里不能出现逗号 —— 会被当参数分隔符。取模要用
 *      t-beat*floor(t/beat)，不能用 mod()。
 *   ② 整条 -i 走 argv 不经 shell，不要自己加反斜杠引号。
 */
async function makeBgm(out, duration, opts = {}) {
  const [root, chord, beat] = bgmMood(opts.mood)
  const music = String(opts.music || '').trim()
  P.ensureDir(dirname(out))
  if (music && existsSync(music)) {
    await E.ffmpeg(['-v', 'error', '-y', '-stream_loop', '-1', '-i', music,
      '-t', String(duration), '-ar', '48000', '-ac', '2', out], { timeout: 600_000 })
    // ★ 必须带 ok:true —— 调用方按 r.ok 判成功，漏了它就会被当成失败（踩过）
    if (!existsSync(out)) return { ok: false, error: 'BGM 没生成出来' }
    return { ok: true, path: out, source: music, kind: 'file' }
  }
  // 三和弦衰减垫底：每个音按节拍重击一次，指数衰减把余音收掉
  const terms = chord.map(ratio => {
    const f = root * ratio
    return `0.16*sin(2*PI*${f.toFixed(3)}*t)*exp(-0.35*(t-${beat.toFixed(2)}*floor(t/${beat.toFixed(2)})))`
  })
  const expr = terms.join('+')
  const r = await E.ffmpeg(['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=48000:c=stereo`,
    '-t', String(duration), out], { timeout: 600_000 })
  if (!r.ok || !existsSync(out)) return { ok: false, error: String(r.stderr || '').slice(0, 160) || 'BGM 没生成出来' }
  return { ok: true, path: out, source: 'synth', kind: 'synth', expr }
}

/** 读一段音频的积分响度(LUFS)与最大真峰值(dB)。读不出来返回 null。 */
async function measureLoud(path) {
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-i', path, '-vn',
    '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeout: 180_000 })
  const txt = String(r.stderr || '')
  const mi = [...txt.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].map(m => parseFloat(m[1]))
  const mp = [...txt.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].map(m => parseFloat(m[1]))
  if (!mi.length) return null
  return { lufs: mi[mi.length - 1], peak: mp.length ? mp[mp.length - 1] : null }
}

/**
 * 按四层标准算这一层该给多少线性增益。
 *
 * 为什么不用固定数字：素材响度差得很远。同一个配音文件是 −16 LUFS、
 * 另一条是 −26 LUFS，都给 voice=1.0 的话两条片子听起来像两个软件做的。
 * 做法是先量这层实测响度，算出离对白基准差多少，再补回目标档位。
 * 量不出来就退回经验线性值 —— 绝不因为量不到就静音。
 */
async function layerGain(layer, path) {
  const targetRel = Number(AUDIO_LAYER_DB[String(layer || '')] || 0)
  if (!path || !existsSync(path)) return Math.pow(10, targetRel / 20)
  const m = await measureLoud(path)
  if (!m || !Number.isFinite(m.lufs)) return Math.pow(10, targetRel / 20)
  // 混完整体会被 finalize 归一到 −14 LUFS，所以这里只要「相对对白」的比例对
  const want = LOUD_TARGET_LUFS + targetRel
  let gainDb = want - m.lufs
  gainDb = Math.max(-30, Math.min(18, gainDb))   // 别把静音段推成一片嘶声
  return Math.pow(10, gainDb / 20)
}

/** 把成片音轨拉到一个固定响度，并用限幅器兜住峰值。 */
async function loudnorm(inPath, outPath) {
  const tp = LOUD_TRUE_PEAK - AAC_PEAK_HEADROOM_DB
  const filter = [
    `loudnorm=I=${LOUD_TARGET_LUFS}:TP=${tp}:LRA=11:print_format=summary`,
    `alimiter=limit=${Math.pow(10, tp / 20).toFixed(4)}:level=disabled`,
  ].join(',')
  const r = await E.ffmpeg(['-v', 'error', '-y', '-i', inPath, '-vn',
    '-af', filter, '-c:a', 'aac', '-b:a', '192k', outPath], { timeout: 900_000 })
  return r.ok && existsSync(outPath)
}

/**
 * 混完所有声音后收尾：统一响度 + 限幅。**必须放在音效之后** ——
 * 配乐 0.25 + 配音 1.0 + 原声 1.0 + 点音效，峰值能到 2.3 左右，
 * 在响的地方会削出破音。量一次、加固定增益、过一道限幅器：
 * 整条片子的前后比例不变，只把整体挪到目标响度。
 * 这和「动态压缩」是两件事，压缩会把没人说话的底噪一起抬起来。
 */
async function finalize(path, opts = {}) {
  if (!existsSync(path)) return path
  const tmp = path + '.loud.mp4'
  const ok = await loudnorm(path, tmp)
  if (!ok) return path
  try {
    unlinkSync(path)
    renameSync(tmp, path)
  } catch { return tmp }
  if (opts.log) {
    const m = await measureLoud(path)
    if (m) opts.log(`响度已统一到 ${LOUD_TARGET_LUFS} LUFS，峰值 ${m.peak ?? '?'} dB`)
  }
  return path
}

/** 把一条音频铺到视频时长上（循环或截断），用于 BGM。 */
async function fitTo(out, srcPath, duration) {
  await E.ffmpeg(['-v', 'error', '-y', '-stream_loop', '-1', '-i', srcPath,
    '-t', String(duration), '-ar', '48000', '-ac', '2', out], { timeout: 600_000 })
  return out
}

/** 工程里现有的音乐素材。 */
function musicFiles() {
  const dir = P.RES_MUSIC
  const out = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).sort()) {
    const ext = extname(f).toLowerCase()
    if (!P.AUDIO_EXT.has(ext)) continue
    out.push({ name: f, path: join(dir, f), size: statSync(join(dir, f)).size })
  }
  return out
}


// ══════════════ 音效：现场合成，不依赖任何素材包 ══════════════
// 重击、whoosh、上升音这些是「电影感」的一半。它们的共同点是波形很简单 ——
// 一个指数衰减的正弦就是一次撞击，一段带通噪声就是一次擦身而过。
// 所以不用下载音效包，公式直接算出来，理论上无限清晰、没有版权问题。
const SFX_KINDS = {
  冲击: { desc: '一次闷响，砸下去、撞上、落地。0.5 秒内衰减完', src: "aevalsrc='0.85*sin(2*PI*55*t)*exp(-7*t)':s=44100:d=0.6", post: 'volume=0.9' },
  轰鸣: { desc: '更沉的撞击，尾音长，适合大场面和转场', src: "aevalsrc='0.6*sin(2*PI*42*t)*exp(-3*t)+0.35*sin(2*PI*84*t)*exp(-5*t)':s=44100:d=1.4", post: 'volume=0.9' },
  whoosh: { desc: '快速划过的风声，转场/甩镜/翻页', src: 'anoisesrc=d=0.6:c=pink:a=0.35', post: 'highpass=f=500,lowpass=f=7000,afade=t=in:st=0:d=0.25,afade=t=out:st=0.35:d=0.25,volume=1.2' },
  上升音: { desc: '越来越紧的嗡鸣，铺垫到爆点前那两秒', src: 'sine=f=180:d=2.5', post: 'vibrato=f=3:d=0.6,afade=t=in:st=0:d=2.5,volume=0.55' },
  滴答: { desc: '极短的清脆一点，切点、数字跳动、按键', src: "aevalsrc='0.5*sin(2*PI*1800*t)*exp(-60*t)':s=44100:d=0.14", post: 'volume=0.7' },
  心跳: { desc: '两下低频，紧张感', src: "aevalsrc='0.7*sin(2*PI*48*t)*exp(-9*t)+0.55*sin(2*PI*44*(t-0.18))*exp(-9*(t-0.18))*(gte(t,0.18))':s=44100:d=0.7", post: 'volume=0.9' },
  风声: { desc: '持续的环境底噪，填静场、做空镜', src: 'anoisesrc=d=3:c=brown:a=0.3', post: 'lowpass=f=900,afade=t=in:st=0:d=0.6,afade=t=out:st=2.4:d=0.6,volume=0.8' },
  电流: { desc: '刺啦一下，故障感、闪白、卡点', src: 'anoisesrc=d=0.25:c=white:a=0.25', post: 'highpass=f=2000,afade=t=out:st=0.12:d=0.13,volume=0.8' },
  啪: { desc: '干脆的一下，扇门、拍桌、翻牌', src: "aevalsrc='0.8*sin(2*PI*900*t)*exp(-45*t)':s=44100:d=0.09", post: 'volume=0.85' },
}
const SFX_ALIAS = { 撞: '冲击', 砸: '冲击', boom: '轰鸣', 低音: '轰鸣', 划过: 'whoosh', 唰: 'whoosh', riser: '上升音', tick: '滴答', click: '滴答', 紧张: '心跳', 环境: '风声', glitch: '电流', 故障: '电流', 拍: '啪' }

/** 音效名字归一。认不出返回空串。 */
function sfxKey(name) {
  const n = String(name || '').trim()
  if (!n) return ''
  if (SFX_KINDS[n]) return n
  if (SFX_ALIAS[n]) return SFX_ALIAS[n]
  for (const k of Object.keys(SFX_KINDS)) if (n.includes(k)) return k
  for (const [k, v] of Object.entries(SFX_ALIAS)) if (k && n.includes(k)) return v
  return ''
}

/**
 * 合成一个音效 wav。同样参数第二次直接拿缓存，不重算。
 * kind 认不出就报错，不偷偷换成别的音效 —— 换了用户根本不知道听到的不是他要的。
 */
async function soundFx(kind, dur) {
  const k = sfxKey(kind)
  if (!k) {
    return { ok: false, error: `认不出「${kind}」这个音效。能用的是：${Object.keys(SFX_KINDS).join('、')}` }
  }
  const dir = join(C.custPaths().cache, '音效')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `sfx-${k}.wav`)
  if (existsSync(out) && statSync(out).size > 1024) return { ok: true, path: out, kind: k, cached: true }
  const def = SFX_KINDS[k]
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', def.src]
  if (def.post) args.push('-af', def.post)
  if (dur) args.push('-t', String(dur))
  args.push(out)
  const r = await E.run(P.FFMPEG, args, { timeout: 120_000 })
  if (!r.ok || !existsSync(out)) return { ok: false, error: String(r.stderr || '').slice(0, 160) }
  return { ok: true, path: out, kind: k }
}

/** 列出全部可用音效。 */
function sfxList() {
  return Object.entries(SFX_KINDS).map(([k, v]) => ({ kind: k, desc: v.desc }))
}

/**
 * 把一段配音混进片子里（片子还得保留原声时用这个，不是替换）。
 * volume 默认 1.0，对白压底时给 0.9~1.2。
 */
async function addVoiceover(video, voiceFile, opts = {}) {
  if (!existsSync(video)) return { ok: false, error: '视频不在了：' + video }
  if (!existsSync(voiceFile)) return { ok: false, error: '配音不在了：' + voiceFile }
  const vol = Number(opts.volume) || 1
  const at = Number(opts.at) || 0
  const out = opts.out || join(dirname(video), basename(video, extname(video)) + '_配音' + extname(video))
  const delay = Math.round(at * 1000)
  // amix 会整体降音量（两路各 -6dB），用 normalize=0 保住原声电平
  const fc = `[1:a]volume=${vol},adelay=${delay}|${delay}[v];[0:a][v]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', voiceFile,
    '-filter_complex', fc, '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out], { timeout: 600_000 })
  if (!r.ok) return { ok: false, error: String(r.stderr || '').slice(0, 180) }
  const p = await E.probe(out)
  return { ok: true, path: out, duration: p.duration }
}

/**
 * 铺背景音乐。默认压到 -21dB（AUDIO_LAYER_DB.bgm）—— BGM 是垫底，
 * 不是主角；给 0.35 这种线性音量听着还是吵，得按 dB 算。
 */
async function addMusic(video, opts = {}) {
  if (!existsSync(video)) return { ok: false, error: '视频不在了：' + video }
  let music = opts.music || ''
  if (music && !existsSync(music)) {
    // 允许给「音乐库」里的文件名
    const hit = musicFiles().find((x) => x.name === music || x.name.includes(music))
    music = hit ? hit.path : ''
  }
  const tmpMusic = []
  if (!music) {
    // 没有现成音乐就现场合成一段
    const mood = opts.mood || 'warm'
    const p = await E.probe(video)
    const dur = p.duration || 30
    const out = join(C.custPaths().cache, 'bgm-' + P.stamp() + '.m4a')
    const r = await makeBgm(out, dur, { mood })
    if (!r.ok) return { ok: false, error: '合成 BGM 失败：' + (r.error || '') }
    music = out
    tmpMusic.push(out)
  }
  const vol = opts.volume != null ? Number(opts.volume) : 0.35
  const db = 20 * Math.log10(Math.max(0.01, vol))
  const out = opts.out || join(dirname(video), basename(video, extname(video)) + '_配乐' + extname(video))
  const fc = `[1:a]volume=${db.toFixed(1)}dB,aloop=loop=-1:size=2e9[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', music,
    '-filter_complex', fc, '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', out], { timeout: 600_000 })
  for (const t of tmpMusic) { try { unlinkSync(t) } catch {} }
  if (!r.ok) return { ok: false, error: String(r.stderr || '').slice(0, 180) }
  const p = await E.probe(out)
  return { ok: true, path: out, duration: p.duration }
}

/**
 * 剪掉口播里的废话：长停顿压到 0.3 秒、孤立的口癖（嗯/呃/啊）剪掉。
 * 出片前对配音跑一遍，片子立刻干净一半。
 */
async function tighten(path, opts = {}) {
  if (!existsSync(path)) return { ok: false, error: '文件不在了：' + path }
  const keep = Number(opts.pauseKeep ?? 0.3)
  const minSil = Number(opts.pauseMin ?? 0.45)
  const out = opts.out || join(dirname(path), basename(path, extname(path)) + '_紧凑' + extname(path))
  // silencedetect 找出所有静音段，只把超过 minSil 的压到 keep
  const det = await E.run(P.FFMPEG, ['-hide_banner', '-i', path, '-af', `silencedetect=noise=-38dB:d=${minSil}`, '-f', 'null', '-'], { timeout: 600_000 })
  const txt = String(det.stderr || '')
  const starts = [...txt.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const ends = [...txt.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const pr = await E.probe(path)
  const dur = pr.duration || 0
  const cuts = []
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i]
    const b = ends[i] != null ? ends[i] : dur
    if (b - a > keep + 0.05) cuts.push({ from: a + keep, to: b })
  }
  if (!cuts.length) return { ok: true, path, duration: dur, cuts: 0, note: '没找到需要压的停顿（已经很紧凑了）' }
  // 用 select 滤镜按时间保留：反选掉要删的区间
  const keepExpr = cuts.map((c) => `between(t,${c.from.toFixed(3)},${c.to.toFixed(3)})`).join('+')
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path,
    '-af', `aselect='not(${keepExpr})',asetpts=N/SR/TB`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out], { timeout: 600_000 })
  if (!r.ok) return { ok: false, error: String(r.stderr || '').slice(0, 180) }
  const p2 = await E.probe(out)
  return { ok: true, path: out, duration: p2.duration, before: dur, cuts: cuts.length, saved: dur - (p2.duration || dur) }
}

/** 测 BPM 与首拍位置，再给切点方案。转调 rhythm.detectBpm，这里只是起个别名。 */
async function bpm(path, opts = {}) {
  const R = require('./rhythm')
  const r = await R.detectBpm(path, opts)
  if (!r.ok || !r.bpm) return { ok: false, error: r.error || '这条音频没有明显的节拍（可能是纯人声或环境音）' }
  const beats = []
  for (let t = r.offset || 0; t < (r.duration || 60); t += 60 / r.bpm) beats.push(Math.round(t * 100) / 100)
  return { ok: true, bpm: r.bpm, offset: r.offset || 0, beats, confidence: r.confidence }
}

/** 转写（转调 asr.transcribe，audio 层不再自己实现一遍）。 */
async function transcribe(file, opts = {}) {
  const ASR = require('./asr')
  return ASR.transcribe(file, opts)
}

/** 逐句字幕（转调 asr.sentences）。 */
async function sentences(file, opts = {}) {
  const ASR = require('./asr')
  return ASR.sentences(file, opts)
}

module.exports = {
  AUDIO_LAYER_DB, AUDIO_DUCK_DB, LOUD_TARGET_LUFS, LOUD_TRUE_PEAK, AAC_PEAK_HEADROOM_DB,
  speakText,
  mingTts,
  mingState,
  mingPaths,
  mingVoices, systemVoices, tts, bgmMood, makeBgm, measureLoud, layerGain,
  loudnorm, finalize, fitTo, musicFiles,
  SFX_KINDS, SFX_ALIAS, sfxKey, sfxList, soundFx,
  addVoiceover, addMusic, tighten, bpm, transcribe, sentences,
}
