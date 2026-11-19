/**
 * 本地模型管理（对应旧版 /api/localmodels）。
 *
 * 三格：system_tts（macOS 自带音色）/ asr（SenseVoice 离线识别）/ tts（神经配音）。
 *
 * ★ 一条铁律：状态只从「磁盘上真有没有权重」算，不看配置文件里写了什么。
 * 旧版这里自己算一遍、配音页另算一遍，判据还不一样，于是同一个模型
 * 在两个页面显示两种状态 —— 用户没法判断到底能不能用。
 * 现在 asr 直接问 asr.status()（它自己就在查权重文件），没有第二种事实源。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')

/** 三个包的中文元信息。size 是「下载要多少」，不是「已占用」 */
const PKGS = {
  system_tts: {
    name: 'macOS 系统音色（配音）',
    size: '',
    desc: '用系统自带的语音合成念稿。不下载、不占空间，声音偏机械但能立刻用。',
    needDownload: false,
  },
  asr: {
    name: 'SenseVoice 语音识别（离线）',
    size: '约 239 MB',
    desc: '视频里说的话转字幕（中英日韩粤），CPU 就能跑，完全离线。',
    needDownload: true,
  },
  tts: {
    name: 'Ming-3.0 情感配音（离线）',
    size: '约 1.5 GB',
    desc: '中英双语 44.1kHz，能按情绪、语速、音高演，也能克隆自己的声音。完全离线。',
    needDownload: true,
  },
}

const LM_DIR = path.join(P.HOME, '系统', '本地模型')
const TTS_DIR = path.join(LM_DIR, '语音', 'weights')

/** 目录里所有文件加起来多少 MB */
function dirMB(dir) {
  let total = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name)
      if (e.isDirectory()) total += dirMB(f)
      else if (e.isFile()) { try { total += fs.statSync(f).size } catch (_) {} }
    }
  } catch (_) { /* 目录不在就是 0 */ }
  return total / 1048576
}

/**
 * 系统音色：用 audio.systemVoices 的实测结果，不是「假定有」。
 * ★ systemVoices 是 async（要跑 /usr/bin/say -v ?）。第一版当同步读，
 *   拿到的是 Promise 包着的空对象，于是这块永远报「没有中文音色」——
 *   而实际上有 8 个。凡是 await 过的东西，调用方也必须 await。
 */
async function systemTts() {
  let good = []
  try {
    const v = await require('./audio').systemVoices()
    good = (v && v.good) || []
  } catch (_) { good = [] }
  const n = good.length
  return {
    ...PKGS.system_tts,
    state: n > 0 ? 'ready' : 'error',
    step: n > 0 ? ('系统里有 ' + n + ' 个中文音色：' + good.slice(0, 3).map(x => x.name).join('、')) : '系统没有可用的中文音色',
    voices: good.map(x => x.name),
    used_mb: 0,
    path: '',
  }
}

/** ASR：直接问 asr.js。ready 就是权重真在盘上且能建识别器 */
function asrState() {
  let st = { ready: false }
  try { st = require('./asr').status() } catch (_) {}
  if (st.ready) {
    let mb = 0
    try {
      const f = path.join(st.weightsDir, 'model.int8.onnx')
      if (fs.existsSync(f)) mb = fs.statSync(f).size / 1048576
    } catch (_) {}
    return { ...PKGS.asr, state: 'ready', step: '离线识别可用', used_mb: Math.round(mb), path: st.weightsDir }
  }
  return { ...PKGS.asr, state: 'none', step: '还没下载权重', used_mb: 0, path: st.weightsDir || '' }
}

/** TTS 神经配音：只有目录里有真权重才算装好（旧版只看 config.json 就标 ready，是假的） */
function ttsState() {
  const dir = path.join(TTS_DIR, 'ming-tts')
  const alt = path.join(TTS_DIR, 'mlx-audio')
  const has = (d) => { try { return fs.existsSync(d) && dirMB(d) > 100 } catch (_) { return false } }
  if (has(dir) || has(alt)) {
    const d = has(dir) ? dir : alt
    return { ...PKGS.tts, state: 'ready', step: '本机已装', used_mb: Math.round(dirMB(d)), path: d }
  }
  // 没有安装状态文件，所以这里不可能出现「安装中」——不假装在装
  return { ...PKGS.tts, state: 'none', step: '还没下载权重（约 1.5GB）', used_mb: 0, path: '' }
}

async function status() {
  const out = {
    system_tts: await systemTts(),
    asr: asrState(),
    tts: ttsState(),
  }
  const total = Object.values(out).reduce((s, x) => s + (x.used_mb || 0), 0)
  out._meta = { total_mb: Math.round(total), dir: LM_DIR }
  return out
}

/**
 * 安装。旧版把这件事转发给「配音·语音」页的同一条链路（那里有真正的下载器）。
 * 新工程还没有 mlx-audio 那套下载器，所以：
 *  - asr：权重已经在随包数据里，不需要下载 —— 如实说，不假装在装
 *  - tts：还没有下载实现，如实说清楚，不给一个转圈骗人
 */
async function install(kind) {
  if (!PKGS[kind]) throw new Error('不支持的本地模型类型：' + kind)
  if (kind === 'system_tts') throw new Error('系统音色不用安装，macOS 自带')
  if (kind === 'asr') {
    const s = asrState()
    if (s.state === 'ready') return { ok: true, state: 'ready', note: '语音识别权重已经在盘上，可以直接用' }
    return {
      ok: false,
      error: '语音识别权重要放在 ' + s.path + '（现在没有）。这一步需要联网下载，本版还没有做下载器。',
    }
  }
  return {
    ok: false,
    error: '神经配音的权重约 1.5GB，需要单独下载。本版还没有做下载器，先把系统音色用好。',
  }
}

function uninstall(kind) {
  if (kind === 'system_tts') throw new Error('系统音色是 macOS 自带的，删不掉')
  if (kind === 'asr') {
    throw new Error('语音识别权重是随数据一起装的，删了字幕功能就没了。要腾空间请手动删 ' +
      path.join(TTS_DIR, 'sense-voice'))
  }
  const d = path.join(TTS_DIR, 'ming-tts')
  if (!fs.existsSync(d)) throw new Error('本机没有装神经配音，不用卸载')
  return { ok: true, note: '这个版本还没有做卸载。要腾空间请手动删 ' + d }
}

function reveal() {
  fs.mkdirSync(LM_DIR, { recursive: true })
  return { ok: true, path: LM_DIR }
}

/** 清理全部：只删可再下载的权重。asr 的 sense-voice 也删（用户明确要求腾空间） */
function purge(confirmText) {
  if (String(confirmText || '') !== '清理全部') {
    throw new Error('要输入「清理全部」才能执行')
  }
  let freed = 0
  const removed = []
  if (fs.existsSync(TTS_DIR)) {
    for (const e of fs.readdirSync(TTS_DIR, { withFileTypes: true })) {
      const f = path.join(TTS_DIR, e.name)
      try {
        const mb = e.isDirectory() ? dirMB(f) : fs.statSync(f).size / 1048576
        fs.rmSync(f, { recursive: true, force: true })
        freed += mb
        removed.push(e.name)
      } catch (_) {}
    }
  }
  return { ok: true, freed_mb: Math.round(freed), removed }
}

module.exports = { PKGS, status, install, uninstall, reveal, purge, LM_DIR }
