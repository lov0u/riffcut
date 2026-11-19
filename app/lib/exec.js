// 进程执行与 ffmpeg 封装。
// 旧软件每个模块自己拼 spawn + 自己判断错误，导致「失败原因看不懂」。
// 这里统一：错误翻译成人话、超时可取消、ffmpeg 一律走硬件编码。
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const P = require('./paths')

const DEFAULT_TIMEOUT = 120_000
const _active = new Map()

class ExecError extends Error {
  constructor(msg, { code, stderr, cmd } = {}) {
    super(msg)
    this.code = code
    this.stderr = stderr
    this.cmd = cmd
  }
}

/**
 * 跑一条命令。返回 {ok, stdout, stderr, code, ms}。
 * 超时会真的 kill 进程树，不只是放弃等待。
 */
function run(cmd, args = [], opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT
  const cwd = opts.cwd || P.HOME
  const env = { ...process.env, ...(opts.env || {}) }
  const t0 = Date.now()

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, stdout: opts.encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: String(e.message), code: -1, ms: 0, cmd: [cmd, ...args].join(' ') })
    }
    const key = Symbol('job')
    _active.set(key, child)

    const binary = opts.encoding === 'buffer'
    let out = binary ? [] : '', err = '', done = false
    const finish = (ok, code) => {
      if (done) return
      done = true
      _active.delete(key)
      clearTimeout(timer)
      const stdout = binary ? Buffer.concat(out) : out
      resolve({ ok, stdout, stderr: err, code, ms: Date.now() - t0, cmd: [cmd, ...args].join(' ') })
    }
    if (!binary) child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', d => { binary ? out.push(Buffer.from(d)) : (out += d) })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { err += '\n' + e.message; finish(false, -1) })
    child.on('close', code => finish(code === 0, code))

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      err += `\n[超时 ${timeout}ms，已终止]`
      finish(false, -2)
    }, timeout)
  })
}

/** 起一个长时任务（不等待），返回 {child, promise}。 */
function runAsync(cmd, args = [], opts = {}) {
  const cwd = opts.cwd || P.HOME
  const env = { ...process.env, ...(opts.env || {}) }
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  const promise = new Promise((res) => {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', d => { out += d; opts.onLine && opts.onLine(String(d)) })
    child.stderr.on('data', d => { err += d; opts.onLine && opts.onLine(String(d)) })
    child.on('error', e => res({ ok: false, stdout: out, stderr: err + e.message, code: -1 }))
    child.on('close', code => res({ ok: code === 0, stdout: out, stderr: err, code }))
  })
  return { child, promise }
}

// ── ffmpeg ────────────────────────────────────────────
const HW_ENCODERS = [
  { v: 'h264_videotoolbox', hevc: 'hevc_videotoolbox', prores: 'prores_videotoolbox' },
]

let _encCache = null
function encoders() {
  if (_encCache) return _encCache
  const r = _syncList('-encoders')
  _encCache = new Set(r)
  return _encCache
}

function _syncList(flag) {
  const { execFileSync } = require('node:child_process')
  try {
    const out = execFileSync(P.FFMPEG, ['-hide_banner', flag], { encoding: 'utf8', timeout: 15000 })
    const names = new Set()
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)/)
      if (m) names.add(m[1])
    }
    return names
  } catch {
    return new Set()
  }
}

/** 选编码器：优先硬件，退回 libx264。 */
function pickVideoCodec({ codec = 'h264', quality = 'balanced' } = {}) {
  const enc = encoders()
  if (codec === 'hevc' && enc.has('hevc_videotoolbox')) return { name: 'hevc_videotoolbox', hw: true, args: ['-b:v', '8M', '-allow_sw', '1'] }
  if (codec === 'prores' && enc.has('prores_videotoolbox')) return { name: 'prores_videotoolbox', hw: true, args: ['-profile:v', '3'] }
  if (enc.has('h264_videotoolbox')) {
    const bitrate = quality === 'high' ? '16M' : quality === 'small' ? '4M' : '8M'
    return { name: 'h264_videotoolbox', hw: true, args: ['-b:v', bitrate, '-allow_sw', '1'] }
  }
  if (enc.has('libx264')) {
    const crf = quality === 'high' ? '17' : quality === 'small' ? '24' : '20'
    return { name: 'libx264', hw: false, args: ['-preset', 'veryfast', '-crf', crf] }
  }
  throw new ExecError('这台机器上的 ffmpeg 既没有硬件 H.264 编码也没有 libx264，出不了片。')
}

/** 跑 ffmpeg。失败时把最后几行 stderr 抛成人话。 */
async function ffmpeg(args, opts = {}) {
  const r = await run(P.FFMPEG, ['-hide_banner', '-loglevel', opts.loglevel || 'error', ...args], {
    timeout: opts.timeout || 30 * 60_000,
    cwd: opts.cwd,
  })
  if (!r.ok) {
    const tail = (r.stderr || '').trim().split('\n').slice(-6).join('\n')
    throw new ExecError('ffmpeg 出片失败（退出码 ' + r.code + '）\n' + tail, { code: r.code, stderr: r.stderr, cmd: r.cmd })
  }
  return r
}

/** 跑 ffprobe，读真实参数。 */
async function probe(file) {
  const r = await run(P.FFPROBE, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ], { timeout: 30_000 })
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.stdout)
    const v = (j.streams || []).find(s => s.codec_type === 'video')
    const a = (j.streams || []).find(s => s.codec_type === 'audio')
    return {
      file,
      duration: Number(j.format && j.format.duration) || (v && Number(v.duration)) || 0,
      size: Number(j.format && j.format.size) || 0,
      width: v ? Number(v.width) : 0,
      height: v ? Number(v.height) : 0,
      fps: v && v.r_frame_rate ? evalFps(v.r_frame_rate) : 0,
      vcodec: v ? v.codec_name : null,
      acodec: a ? a.codec_name : null,
      hasAudio: !!a,
      hasVideo: !!v,
      raw: j,
    }
  } catch {
    return null
  }
}

function evalFps(s) {
  const m = String(s).match(/^(\d+)\/(\d+)$/)
  if (m) { const d = Number(m[2]) || 1; return Number(m[1]) / d }
  return Number(s) || 0
}

/** 合成音轨（多条音频按时间偏移混一起）。 */
function mixAudioArgs(tracks) {
  const inputs = [], filters = [], labels = []
  tracks.forEach((t, i) => {
    inputs.push('-i', t.file)
    const delay = Math.round((t.start || 0) * 1000)
    const vol = t.volume == null ? 1 : t.volume
    filters.push(`[${i}:a]volume=${vol},adelay=${delay}|${delay}[a${i}]`)
    labels.push(`[a${i}]`)
  })
  filters.push(`${labels.join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0[aout]`)
  return { inputs, filter: filters.join(';'), map: '[aout]' }
}

module.exports = { run, runAsync, ExecError, ffmpeg, probe, pickVideoCodec, encoders, mixAudioArgs, evalFps }
