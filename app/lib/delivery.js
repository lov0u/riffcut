'use strict'
/**
 * 交付层 —— 一条母版派生多份，别每个平台重渲。
 *
 * 重渲一次几分钟，重排只需几秒。这里三层：
 *   reframeVertical  横屏片重排成 9:16（模糊底铺满，不是缩一缩加黑边）
 *   exportPlatform   按平台规格导出交付档（竖屏档自动走模糊底）
 *   deliveryCheck    交付体检：这个文件能不能给客户、能不能传平台、能不能在网页里播
 *
 * 为什么不用 pad：1920x1080 缩进 1080 宽只剩 608 高，上下各 656 黑边，
 * 画面占不到三分之一 —— 观众第一眼看到的是两块黑，不是内容。
 * 竖屏平台上的正常做法是「背景铺满 + 前景一个窗口」。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

// 裁出来的宽高比（宽/高）：方形 1.0 最常用（1080x1080），
// 四比五 0.8 更竖，原比例 1.78 等于不裁只把黑边换成模糊底，
// 满屏 0.5625 就是裁满 9:16（只在主体本来就在画面中间时用）。
const VERTICAL_WINDOWS = { 方形: 1.0, 四比五: 0.8, 原比例: 16 / 9, 满屏: 9 / 16 }

// 各平台交付规格。数据来自 iamaanahmad/platform-export 那份表。
// max_s 时长上限（秒，0=不限），max_mb 文件大小上限（MB，0=不限）。
const PLATFORM_SPECS = {
  youtube: { w: 1920, h: 1080, max_s: 0, max_mb: 0, note: '16:9 长视频，浏览器/电视都能放' },
  shorts: { w: 1080, h: 1920, max_s: 60, max_mb: 0, note: 'YouTube Shorts，9:16，≤60 秒' },
  reels: { w: 1080, h: 1920, max_s: 90, max_mb: 4096, note: 'Instagram Reels / Facebook，9:16，≤90 秒' },
  tiktok: { w: 1080, h: 1920, max_s: 600, max_mb: 287, note: '抖音/TikTok，9:16，多数人静音刷 → 字幕必须烧进画面' },
  douyin: { w: 1080, h: 1920, max_s: 600, max_mb: 287, note: '抖音，同 TikTok' },
  视频号: { w: 1080, h: 1920, max_s: 1800, max_mb: 0, note: '微信视频号，9:16 优先' },
  小红书: { w: 1080, h: 1440, max_s: 0, max_mb: 0, note: '3:4 或 9:16，封面字要留平台 UI 安全区' },
  igfeed: { w: 1080, h: 1350, max_s: 60, max_mb: 0, note: 'Instagram feed 4:5，≤60 秒' },
  x: { w: 1280, h: 720, max_s: 140, max_mb: 512, note: 'X/Twitter，≤140 秒 <512MB' },
  linkedin: { w: 1920, h: 1080, max_s: 600, max_mb: 5120, note: '职场平台，多数静音观看 → 字幕重要' },
  web: { w: 1280, h: 720, max_s: 0, max_mb: 0, note: '自家网页，1280x720 边下边播' },
}

const PLATFORM_ALIAS = {
  油管: 'youtube', yt: 'youtube', 长视频: 'youtube',
  抖音: 'douyin', tk: 'tiktok', tiktokx: 'tiktok', 微信: '视频号', 视频号: '视频号',
  小红书: '小红书', xhs: '小红书', 红书: '小红书',
  ig: 'igfeed', instagram: 'igfeed', ins: 'igfeed', insfeed: 'igfeed',
  reel: 'reels', instagramreels: 'reels',
  twitter: 'x', 推特: 'x', 领英: 'linkedin',
  网页: 'web', 网站: 'web', 官网: 'web', 网页版: 'web',
}

/** 平台名 → 规范键。认不出来返回 null。 */
function platformKey(name) {
  const k = String(name || '').trim().toLowerCase().replace(/[\s\-_]/g, '')
  if (!k) return null
  if (k in PLATFORM_SPECS) return k
  if (k in PLATFORM_ALIAS) return PLATFORM_ALIAS[k]
  for (const [a, b] of Object.entries(PLATFORM_ALIAS)) if (k.includes(a)) return b
  return null
}

function platformList() {
  return Object.entries(PLATFORM_SPECS).map(([k, v]) => ({ key: k, ...v }))
}

/**
 * 把一条横屏片子重排成 9:16。
 *
 * 底 = 原画面放大裁满画布、高斯模糊、压暗降饱和（当材质用，不抢戏）
 * 前景 = 按 window 从源里裁一块矩形，缩放到画布宽，浮在上面
 *
 * focus 决定横向裁哪：0 左 / 0.5 中 / 1 右 —— 人物站在右边就取 0.8。
 */
async function reframeVertical(main, opts = {}) {
  const src = path.resolve(String(main || ''))
  if (!fs.existsSync(src)) throw new Error('找不到要转竖屏的片子：' + src)

  const info = await E.probe(src)
  const W0 = Number(info.width) || 0
  const H0 = Number(info.height) || 0
  if (!(W0 > 0 && H0 > 0)) throw new Error('读不出画面尺寸，没法重排：' + src)

  let win = opts.window === undefined ? '方形' : opts.window
  if (typeof win === 'string') win = VERTICAL_WINDOWS[String(win).trim()] || 1.0
  win = Number(win) || 1.0
  // 不能裁得比原片本身还宽 —— 那等于凭空造像素
  win = Math.max(0.3, Math.min(W0 / H0, win))

  const focus = Math.max(0, Math.min(1, Number(opts.focus) === undefined ? 0.5 : Number(opts.focus)))
  const blur = opts.blur === undefined ? 26.0 : Number(opts.blur)
  const dim = opts.dim === undefined ? -0.2 : Number(opts.dim)
  const sat = opts.sat === undefined ? 0.82 : Number(opts.sat)
  const crf = Number(opts.crf) || 20

  const fw = Math.max(2, Math.round(H0 * win))
  const fh = H0
  const fx = Math.round((W0 - fw) * focus)
  let fhOut = Math.round((1080.0 * fh) / fw)
  if (fhOut > 1920) fhOut = 1920

  let fy = Math.max(0, Math.floor((1920 - fhOut) / 2))
  if (String(opts.pos || '') === 'top') fy = Math.round(1920 * 0.08)
  else if (String(opts.pos || '') === 'bottom') fy = Math.max(0, 1920 - fhOut - Math.round(1920 * 0.12))

  const out = opts.out || src.replace(/(\.[a-z0-9]+)$/i, '') + '-竖屏.mp4'
  const fc = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,` +
      `gblur=sigma=${blur.toFixed(1)},eq=brightness=${dim.toFixed(2)}:saturation=${sat.toFixed(2)}[bg]`,
    `[0:v]crop=${fw}:${fh}:${fx}:0,setsar=1,scale=1080:${fhOut}[fg]`,
    `[bg][fg]overlay=0:${fy}:format=auto,format=yuv420p[v]`,
  ].join(';')

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-filter_complex', fc, '-map', '[v]', '-map', '0:a:0?',
  ]
  const codec = E.pickVideoCodec({ quality: 'high' })
  args.push('-c:v', codec.name, ...(codec.name === 'libx264' ? ['-preset', 'veryfast', '-crf', String(crf)] : codec.args))
  args.push('-pix_fmt', 'yuv420p', '-color_range', 'tv', '-c:a', 'copy', '-movflags', '+faststart', out)

  await E.ffmpeg(args, { timeout: 600_000 })
  if (!fs.existsSync(out)) throw new Error('转竖屏失败：没有生成文件')
  return { ok: true, path: out, window: win, focus, pos: String(opts.pos || 'center'), size: '1080x1920', fg: `1080x${fhOut}` }
}

/** 看 moov 原子是不是排在 mdat 前面（= +faststart）。只扫文件开头一小段就够。 */
function moovFirst(file, limit = 1 << 20) {
  let head
  try {
    const fd = fs.openSync(file, 'r')
    head = Buffer.alloc(limit)
    const n = fs.readSync(fd, head, 0, limit, 0)
    fs.closeSync(fd)
    head = head.subarray(0, n)
  } catch {
    return [-1, -1]
  }
  return [head.indexOf('moov'), head.indexOf('mdat')]
}

/**
 * 交付前体检：这个文件能不能给客户、能不能传平台、能不能在网页里播。
 *
 * 和 gateCheck 的分工：那个查「片子拍得对不对」（时长/分辨率/音轨对不对得上方案），
 * 这个查「文件本身合不合规」。一批参考仓库（video-qa / platform-export /
 * production-rules）都把 yuv420p、H.264+AAC、偶数尺寸、faststart、文件大小
 * 列为硬线 —— 这几项错一项，客户那边就打不开或者要等下完才播。
 *
 * 只报事实、逐项给状态，不替谁决定重不重做。
 */
async function deliveryCheck(file, opts = {}) {
  const res = { ok: true, checks: [], info: {} }
  const add = (name, state, msg) => {
    res.checks.push({ name, state, msg })
    if (state === 'fail') res.ok = false
  }

  const p = path.resolve(String(file || ''))
  if (!fs.existsSync(p)) {
    add('文件存在', 'fail', '文件不在：' + p)
    return res
  }

  let j = null
  try {
    const out = execFileSync(P.FFPROBE, [
      '-v', 'error', '-show_entries',
      'format=duration,size,format_name:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,sample_rate,channels',
      '-of', 'json', p,
    ], { encoding: 'utf8', timeout: 30_000 })
    j = JSON.parse(out || '{}')
  } catch (e) {
    add('能打开', 'fail', 'ffprobe 读不出这个文件：' + String(e.message || e).slice(0, 120))
    return res
  }

  const fmt = j.format || {}
  const streams = j.streams || []
  const vs = streams.find((s) => s.codec_type === 'video')
  const aud = streams.filter((s) => s.codec_type === 'audio')
  if (!vs) { add('有画面', 'fail', '没有视频流'); return res }

  const w = Number(vs.width) || 0
  const h = Number(vs.height) || 0
  const dur = Number(fmt.duration) || 0
  const size = Number(fmt.size) || 0
  res.info = {
    width: w, height: h, duration: Math.round(dur * 100) / 100,
    mb: Math.round((size / 1048576) * 100) / 100,
    vcodec: vs.codec_name, acodec: aud.length ? aud[0].codec_name : null,
    pix_fmt: vs.pix_fmt,
  }

  // 1) 偶数尺寸：yuv420p 的硬要求，奇数会直接编码失败或花屏
  if (w % 2 || h % 2) add('偶数尺寸', 'fail', `${w}x${h} 有奇数边，部分播放器会花屏`)
  else add('偶数尺寸', 'pass', `${w}x${h}`)

  // 2) 像素格式：不是 yuv420p 就闷声在网页/微信里放不出来
  const pf = String(vs.pix_fmt || '')
  if (pf !== 'yuv420p') add('像素格式', 'fail', `pix_fmt=${pf || '读不到'}，应为 yuv420p`)
  else add('像素格式', 'pass', 'yuv420p')

  // 3) 编码：H.264 + AAC 是通用播放的组合
  const vc = String(vs.codec_name || '')
  if (!['h264', 'hevc'].includes(vc)) add('视频编码', 'fail', `vcodec=${vc || '读不到'}，主流平台要 h264`)
  else add('视频编码', 'pass', vc)

  if (!aud.length) add('有音轨', 'fail', '整片没有音轨')
  else {
    const ac = String(aud[0].codec_name || '')
    if (ac !== 'aac') add('音频编码', 'warn', `acodec=${ac || '读不到'}，网页兼容最好用 aac`)
    else add('音频编码', 'pass', 'aac')
  }

  // 4) faststart：moov 在前，浏览器才能边下边播
  const [mo, md] = moovFirst(p)
  const fast = mo >= 0 && (md < 0 || mo < md)
  if (!fast) add('边下边播', 'fail', 'moov 排在 mdat 后面（没 faststart），网页要等整个文件下完才播')
  else add('边下边播', 'pass', 'moov 在文件头')

  // 5) 时长：跟方案对得上
  const exp = Number(opts.expected) || 0
  if (dur <= 0) add('时长', 'fail', '读不到时长，文件可能损坏')
  else if (exp && Math.abs(dur - exp) > Math.max(1.0, exp * 0.15)) add('时长', 'warn', `实测 ${dur.toFixed(1)}s，方案 ${exp.toFixed(1)}s`)
  else add('时长', 'pass', `${dur.toFixed(1)}s`)

  // 6) 文件大小：超平台上限就传不上去
  const maxMb = Number(opts.maxMb) || 0
  if (maxMb && size > maxMb * 1048576) add('文件大小', 'fail', `${(size / 1048576).toFixed(1)}MB 超过 ${maxMb}MB`)
  else add('文件大小', 'pass', `${(size / 1048576).toFixed(1)}MB`)

  return res
}

/** 交付体检报告（人读）。 */
function deliveryReport(res) {
  if (!res || !res.checks) return '体检没跑起来'
  const L1 = [`【交付体检】${res.ok ? '✓ 全过，能交' : '✗ 有问题，别急着交'}`]
  const mark = { pass: '✓', warn: '!', fail: '✗' }
  for (const c of res.checks) L1.push(` ${mark[c.state] || '?'} ${c.name}：${c.msg}`)
  return L1.join('\n')
}

/**
 * 把一条母版重排成某个平台的交付档，顺手跑交付体检。
 *
 * 竖屏档（9:16）走 reframeVertical 的模糊底铺满，不缩一缩加黑边；
 * 其余档用等比缩放 + 居中留边。音频统一 AAC，+faststart 保证网页边下边播。
 * `over` 列出超时长/超大小的项 —— 只报事实，改不改由调用方定。
 */
async function exportPlatform(main, platform, opts = {}) {
  const key = platformKey(platform)
  if (!key) throw new Error(`不认识这个平台：${platform}。可用：${Object.keys(PLATFORM_SPECS).join('、')}`)
  const spec = PLATFORM_SPECS[key]
  const src = path.resolve(String(main || ''))
  if (!fs.existsSync(src)) throw new Error('找不到母版：' + src)

  const W = spec.w
  const H = spec.h
  const out = opts.out || src.replace(/(\.[a-z0-9]+)$/i, '') + '-' + key + '.mp4'

  // 9:16 用模糊底铺满；其它比例等比缩放 + 留边（黑边在 4:5/16:9 很小可接受）
  const vertical = H > W && Math.abs(H / W - 16 / 9) < 0.2
  let srcUse = src
  let tmp = null
  if (vertical) {
    tmp = out + '.tmp.mp4'
    try {
      const r = await reframeVertical(src, { out: tmp, window: '方形', crf: Number(opts.crf) || 19 })
      srcUse = r.path
    } catch {
      srcUse = src
    }
  }

  try {
    const vf = [
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
    ].join(',')
    const codec = E.pickVideoCodec({ quality: String(opts.quality || 'high') })
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcUse, '-vf', vf]
    args.push('-c:v', codec.name, ...(codec.name === 'libx264' ? ['-preset', 'medium', '-crf', '19'] : codec.args))
    args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', out)
    await E.ffmpeg(args, { timeout: 900_000 })
  } finally {
    if (tmp && fs.existsSync(tmp)) { try { fs.unlinkSync(tmp) } catch {} }
  }

  const d = await deliveryCheck(out, { maxMb: spec.max_mb })
  const info = d.info || {}
  const over = []
  if (spec.max_s && info.duration > spec.max_s) over.push(`时长 ${info.duration}s 超过 ${spec.max_s}s`)
  if (spec.max_mb && info.mb > spec.max_mb) over.push(`大小 ${info.mb}MB 超过 ${spec.max_mb}MB`)
  return { ok: true, path: out, platform: key, spec, delivery: d, over }
}

module.exports = {
  VERTICAL_WINDOWS,
  PLATFORM_SPECS,
  PLATFORM_ALIAS,
  platformKey,
  platformList,
  reframeVertical,
  moovFirst,
  deliveryCheck,
  deliveryReport,
  exportPlatform,
}
