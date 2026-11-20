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

/* ══════════ 权重下载源（国内优先，逐个降级） ══════════ */
/* 魔搭的 API 接口形如 /api/v1/models/{owner}/{repo}/repo?Revision=master&FilePath={file}，
   实测支持 Range 续传（206）；直接用 /models/.../resolve/ 那个地址是 302 到 CDN，
   Node 的 https 不自动跟，所以统一走 API 口。 */
const SOURCES = {
  ming_tts: {
    label: 'Ming-3.0 情感配音',
    size_mb: 1662,
    files: [
      {
        name: 'ming-3.0-tts-0.5b-q8_0.gguf',
        urls: [
          'https://modelscope.cn/api/v1/models/audio-cpp/Ming-3.0-TTS-0.5B-GGUF/repo?Revision=master&FilePath=ming-3.0-tts-0.5b-q8_0.gguf',
          'https://hf-mirror.com/audio-cpp/Ming-3.0-TTS-0.5B-GGUF/resolve/main/ming-3.0-tts-0.5b-q8_0.gguf',
          'https://huggingface.co/audio-cpp/Ming-3.0-TTS-0.5B-GGUF/resolve/main/ming-3.0-tts-0.5b-q8_0.gguf',
        ],
        target: 'ming-tts',
      },
    ],
  },
  asr: {
    label: 'SenseVoice 语音识别',
    size_mb: 155,
    /* 官方只在 GitHub Release 发整包（tar.bz2，155MB，解开是 model.int8.onnx 155MB + tokens.txt 309KB）。
       HF 上的 FunAudioLLM/SenseVoiceSmall 只有 model.pt（936MB），不是 onnx 版，不能直接用。
       魔搭没有这个 repo。所以这里只有一个源，下完用系统 tar 解。 */
    archive: {
      urls: [
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
      ],
      /* 包里那一层目录名 */
      dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
      /* 要挑出来的文件 */
      pick: ['model.int8.onnx', 'tokens.txt'],
      target: 'sense-voice',
    },
  },
}

/* 安装任务的进度状态。键是 kind（asr / ming_tts）。
   界面每 1.2s 轮询 /api/voicemodels?action=status，从这儿读 progress。 */
const JOBS = new Map()

function jobOf(kind) {
  return JOBS.get(kind) || null
}

/** 进度百分比（0-100），按已下字节 / 总字节算 */
function progressOf(kind) {
  const j = JOBS.get(kind)
  if (!j) return 0
  if (j.state === 'ready') return 100
  if (!j.total) return 5
  return Math.min(99, Math.max(5, Math.round(j.done / j.total * 100)))
}

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
  /* 装到一半要显示「安装中」+ 进度，不能还报「还没下载权重」——
     否则用户点了安装，界面毫无变化，以为按钮坏了。 */
  const j = JOBS.get('asr')
  if (j && j.state === 'installing') {
    return { ...PKGS.asr, state: 'installing', step: j.step, progress: progressOf('asr'), used_mb: 0, path: st.weightsDir || '' }
  }
  if (j && j.state === 'error') {
    return { ...PKGS.asr, state: 'error', step: '下载失败', error: j.error, used_mb: 0, path: st.weightsDir || '' }
  }
  return { ...PKGS.asr, state: 'none', step: '还没下载权重（约 155MB）', used_mb: 0, path: st.weightsDir || '' }
}

/** TTS 神经配音：只有目录里有真权重才算装好（旧版只看 config.json 就标 ready，是假的） */
function ttsState() {
  const dir = path.join(TTS_DIR, 'ming-tts')
  const alt = path.join(TTS_DIR, 'mlx-audio')
  /* ★ 不能只看「目录体积 > 100MB」。下载中的 .part 文件就能超过 100MB，
     于是下到 200MB 时界面就报「本机已装」，用户以为装完了，一点合成还是没声。
     判据改成「权重文件名对上，且大小接近完整值」。 */
  const MING_FILE = 'ming-3.0-tts-0.5b-q8_0.gguf'
  const MING_MIN = 1500 * 1048576   /* 完整是 1662MB，留点余量 */
  const hasMing = () => {
    const f = path.join(dir, MING_FILE)
    try {
      const st = fs.lstatSync(f)
      if (st.isSymbolicLink()) return true          /* 软链指向包内，信任它 */
      return st.size >= MING_MIN
    } catch (_) { return false }
  }
  const hasAlt = () => {
    try { return fs.existsSync(alt) && dirMB(alt) > 100 } catch (_) { return false }
  }
  if (hasMing() || hasAlt()) {
    const d = hasMing() ? dir : alt
    return { ...PKGS.tts, state: 'ready', step: '本机已装', used_mb: Math.round(dirMB(d)), path: d }
  }
  const j = JOBS.get('ming_tts')
  if (j && j.state === 'installing') {
    return { ...PKGS.tts, state: 'installing', step: j.step, progress: progressOf('ming_tts'), used_mb: 0, path: '' }
  }
  if (j && j.state === 'error') {
    return { ...PKGS.tts, state: 'error', step: '下载失败', error: j.error, used_mb: 0, path: '' }
  }
  return { ...PKGS.tts, state: 'none', step: '还没下载权重（约 1.6GB）', used_mb: 0, path: '' }
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
/* 两个调用方用的是两套 kind 命名：
   localmodels 自己叫 tts，voicemodels.kindOf() 叫 ming_tts。
   以前没做映射，点「安装 Ming」直接报「不支持的本地模型类型：ming_tts」——
   报错还写得很合理，排查时容易以为是参数没传对。统一在这儿归一。 */
function normKind(kind) {
  const s = String(kind || '')
  if (s === 'ming_tts' || s === 'tts' || s === 'ming' || s === 'ming-tts') return 'tts'
  if (s === 'asr' || s === 'sense-voice' || s === 'sensevoice') return 'asr'
  if (s === 'system_tts' || s === 'system' || s === 'macos-system') return 'system_tts'
  return s
}

async function install(rawKind) {
  const kind = normKind(rawKind)
  if (!PKGS[kind]) throw new Error('不支持的本地模型类型：' + rawKind)
  if (kind === 'system_tts') throw new Error('系统音色不用安装，macOS 自带')

  const key = kind === 'asr' ? 'asr' : 'ming_tts'

  /* 已经在装就别再开一个 —— 两个下载器往同一个文件写会互相踩 */
  const cur = JOBS.get(key)
  if (cur && cur.state === 'installing') {
    return { ok: true, state: 'installing', step: cur.step, progress: progressOf(key), note: '已经在下载了，进度见卡片' }
  }

  const st = key === 'asr' ? asrState() : ttsState()
  if (st.state === 'ready') {
    return { ok: true, state: 'ready', note: '权重已经在盘上，可以直接用（约 ' + st.used_mb + ' MB）' }
  }

  /* 后台跑，立刻返回「安装中」—— 1.6GB 下完要几分钟，HTTP 请求不能干等 */
  const job = {
    kind: key, state: 'installing', step: '准备下载…',
    done: 0, total: 0, started: Date.now(), error: '', ctl: new AbortController(),
  }
  JOBS.set(key, job)
  runInstall(key, job).catch(() => {})   /* 错误已经写进 job，不往外抛 */
  return { ok: true, state: 'installing', step: job.step, progress: 5, note: '已开始下载，关掉这个窗口也会继续' }
}

/** 真正的下载流程。所有异常都写进 job，不抛。 */
async function runInstall(key, job) {
  const D = require('./download')
  const E = require('./exec')
  const src = SOURCES[key]
  try {
    if (src.archive) {
      /* 整包下载 → 解开 → 挑文件 */
      const a = src.archive
      const tmp = path.join(TTS_DIR, '_dl_' + key + '.tar.bz2')
      job.step = '下载 ' + src.label + '（' + src.size_mb + 'MB）…'
      await D.fetchFromMirrors(a.urls, tmp, {
        signal: job.ctl.signal,
        onProgress: (d, t) => { job.done = d; job.total = t; job.step = '下载 ' + Math.round(d / 1048576) + ' / ' + Math.round(t / 1048576) + ' MB' },
      })

      job.step = '解压…'
      const outDir = path.join(TTS_DIR, '_dl_' + key)
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.mkdirSync(outDir, { recursive: true })
      /* 用系统 tar（macOS 自带，认 bz2）。-C 指定解到哪儿。
         ★ runAsync 返回的是 {child, promise}，不是 Promise —— 直接 await 它拿到的是那个对象，
           r.code 是 undefined，于是「解压失败」永远成立。必须 await .promise。 */
      const r = await E.runAsync('/usr/bin/tar', ['-xjf', tmp, '-C', outDir], { timeout: 300000 }).promise
      if (!r.ok) throw new Error('解压失败：' + (r.stderr || '').slice(0, 200))

      job.step = '安装文件…'
      const dest = path.join(TTS_DIR, a.target)
      fs.mkdirSync(dest, { recursive: true })
      const inner = path.join(outDir, a.dir)
      const from = fs.existsSync(inner) ? inner : outDir
      for (const f of a.pick) {
        const s1 = path.join(from, f)
        if (!fs.existsSync(s1)) throw new Error('包里没有 ' + f)
        const d1 = path.join(dest, f)
        /* 目标是软链（指向 app 包内）时先删掉，不然写到只读的包里去 */
        try { if (fs.lstatSync(d1).isSymbolicLink()) fs.unlinkSync(d1) } catch (_) {}
        fs.copyFileSync(s1, d1)
      }
      fs.rmSync(tmp, { force: true })
      fs.rmSync(outDir, { recursive: true, force: true })
    } else {
      /* 逐文件下载 */
      const destDir = path.join(TTS_DIR, src.files[0].target)
      fs.mkdirSync(destDir, { recursive: true })
      const totalMB = src.size_mb
      for (let i = 0; i < src.files.length; i++) {
        const f = src.files[i]
        const dest = path.join(TTS_DIR, f.target, f.name)
        try { if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest) } catch (_) {}
        await D.fetchFromMirrors(f.urls, dest, {
          signal: job.ctl.signal,
          onProgress: (d, t) => {
            job.done = d; job.total = t
            job.step = '下载 ' + f.name + ' · ' + Math.round(d / 1048576) + ' / ' + Math.round((t || 0) / 1048576) + ' MB'
          },
        })
      }
    }

    /* 校验：真在盘上且够大才算成功 */
    const after = key === 'asr' ? asrState() : ttsState()
    if (after.state !== 'ready') throw new Error('下完了但没认出来，检查 ' + TTS_DIR)
    job.state = 'ready'
    job.step = '已就绪（' + after.used_mb + ' MB）'
  } catch (e) {
    job.state = 'error'
    job.error = String(e.message || e)
    job.step = '下载失败'
  }
}

/** 取消正在进行的安装 */
function cancelInstall(rawKind) {
  const kind = normKind(rawKind)
  const key = kind === 'asr' ? 'asr' : 'ming_tts'
  const j = JOBS.get(key)
  if (!j || j.state !== 'installing') return { ok: false, error: '没有正在进行的下载' }
  j.ctl.abort()
  j.state = 'error'
  j.error = '已取消（半截文件保留，下次接着下）'
  j.step = '已取消'
  return { ok: true, note: '已取消，已下载的部分保留' }
}

function uninstall(rawKind) {
  const kind = normKind(rawKind)
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

module.exports = { PKGS, SOURCES, normKind, status, install, cancelInstall, progressOf, jobOf, uninstall, reveal, purge, LM_DIR, TTS_DIR }
