'use strict'
/**
 * 媒体探测与校验 —— 回答「这个文件到底是什么」「它真的能播吗」。
 *
 * 为什么要单独一层：模型报的路径常常是它自己拼的（素材夹/生成的/xxx.mp4），
 * 不能因为路径不对就判「文件不存在」——按文件名去产出目录再找一次，
 * 找到就说明文件真在。反过来，模型说「已经生成了」时也必须能当场证伪，
 * 否则用户拿到一条空壳视频还以为成了。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

const AV_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic'])

/** 读图片尺寸。ffprobe 对某些格式会回 0,0，用 sips 兜一次。 */
function imageSize(file) {
  try {
    const out = require('node:child_process').execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8', timeout: 30_000 })
    const nums = (out.match(/:\s*(\d+)/g) || []).map((x) => Number(x.replace(/\D/g, '')))
    if (nums.length >= 2) return [nums[0], nums[1]]
  } catch {}
  return [0, 0]
}

/** 在客户产出目录里按文件名找（模型自己拼路径时用）。 */
function findByName(name, customer) {
  const base = path.basename(String(name || ''))
  if (!base) return ''
  const roots = [C.custPaths(customer).videos, C.custPaths(customer).images, C.custPaths(customer).voice, C.custPaths(customer).previews]
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue
    const hit = path.join(r, base)
    if (fs.existsSync(hit)) return hit
    try {
      const f = fs.readdirSync(r).find((x) => x === base || x.endsWith('-' + base))
      if (f) return path.join(r, f)
    } catch {}
  }
  return ''
}

/**
 * 报一个文件（或一整个文件夹）的真实参数。
 *
 * 文件夹里可能全是视频。旧版只找图片，找不到就报「没有图片文件」——
 * AI 想看一个视频素材夹，得到的回答是「没有图片」，它就以为里面是空的。
 */
async function probeMedia(target, customer) {
  const raw = String(target || '').trim()
  if (!raw) throw new Error('要给一个文件或文件夹路径')
  let p = path.isAbsolute(raw) ? raw : path.resolve(raw)
  if (!fs.existsSync(p)) {
    const hit = findByName(raw, customer)
    if (hit) p = hit
  }
  if (!fs.existsSync(p)) throw new Error('找不到这个文件：' + raw)

  if (fs.statSync(p).isDirectory()) {
    const vids = fs.readdirSync(p).map((x) => path.join(p, x)).filter((x) => fs.statSync(x).isFile() && AV_EXT.has(path.extname(x).toLowerCase())).sort()
    if (vids.length) {
      const lines = [`文件夹：${p}（${vids.length} 个音视频）`]
      for (const v of vids.slice(0, 40)) {
        try {
          const m = await E.probe(v)
          lines.push(`  · ${path.basename(v)}  ${(m.duration || 0).toFixed(2)} 秒  ${m.width}x${m.height}${m.hasAudio ? '' : '  无音轨'}`)
        } catch { lines.push(`  · ${path.basename(v)}  （读不出来）`) }
      }
      if (vids.length > 40) lines.push(`  …还有 ${vids.length - 40} 个`)
      lines.push('要看某一个的详细参数，把它的路径传进来。')
      return lines.join('\n')
    }
    const img = fs.readdirSync(p).map((x) => path.join(p, x)).find((x) => IMG_EXT.has(path.extname(x).toLowerCase()))
    if (!img) throw new Error('这个文件夹里既没有图片也没有音视频：' + p)
    p = img
  }

  const ext = path.extname(p).toLowerCase()
  const size = fs.statSync(p).size
  const info = [`文件：${p}`, `大小：${(size / 1048576).toFixed(1)} MB`]

  if (IMG_EXT.has(ext)) {
    info.push('类型：静态图片')
    let [w, h] = [0, 0]
    try {
      const m = await E.probe(p)
      w = m.width; h = m.height
    } catch {}
    // 本机 ffmpeg 对 png/webp 有时回 0，用 sips 兜一次 ——
    // 尺寸是 AI 判断素材能不能用的依据，不能把假的 0x0 交给它
    if (!w || !h) [w, h] = imageSize(p)
    if (w && h) info.push(`尺寸：${w}×${h}`)
    return info.join('\n')
  }

  const m = await E.probe(p)
  if (!m || !m.duration) throw new Error('这个文件读不出来（可能不是音视频）：' + path.basename(p))
  info.push('探测：')
  info.push(`  codec_type=video  codec_name=${m.vcodec || '—'}  width=${m.width}  height=${m.height}`)
  if (m.hasAudio) info.push(`  codec_type=audio  codec_name=${m.acodec || '—'}`)
  info.push(`  duration=${Number(m.duration).toFixed(3)}`)
  if (!m.hasAudio) info.push('  （没有音轨）')
  return info.join('\n')
}

/**
 * 校验一条片子是不是真的存在、真的能播。
 *
 * 只解一帧就够：空壳/半截文件在这一步就会失败，几秒的片子也就几百毫秒。
 * 不解码的话，一个 0 字节的 mp4 从元数据看也能有「时长」。
 */
async function verifyMedia(target, customer) {
  const raw = String(target || '').trim()
  let p = raw
  if (!fs.existsSync(p)) {
    const hit = findByName(raw, customer)
    if (hit) p = hit
  }
  if (!fs.existsSync(p)) return { ok: false, verdict: '这个文件不存在，不能对用户说已生成', path: raw }

  const m = await E.probe(p)
  const problems = []
  if (!m || (!m.hasVideo && !m.hasAudio)) problems.push('读不出任何音视频轨道')
  if (m && m.hasVideo && (!m.width || !m.height)) problems.push('读不出有效分辨率（可能不是真画面）')
  const dur = (m && m.duration) || 0
  if (dur <= 0.5 || dur > 3600) problems.push(`时长不合理：${dur.toFixed(2)} 秒`)

  let decoded = ''
  if (m && m.hasVideo) {
    const r = await E.run(P.FFMPEG, ['-v', 'error', '-i', p, '-frames:v', '1', '-f', 'null', '-'], { timeout: 30_000 })
    if (!r.ok) problems.push('首帧解码失败：' + String(r.stderr || '').trim().slice(0, 120))
    else decoded = '首帧可解码'
  }
  return {
    ok: problems.length === 0,
    verdict: problems.length === 0 ? '文件真实存在且检查通过' : '文件存在但有问题',
    path: p,
    width: m && m.width, height: m && m.height,
    duration: dur,
    kinds: m ? [m.hasVideo && 'video', m.hasAudio && 'audio'].filter(Boolean) : [],
    decoded,
    problems,
  }
}

/** 把上面的结构摊成人读的一段话。 */
function verifyReport(r) {
  if (!r.path || (r.problems && r.problems[0] && r.problems[0].includes('不存在'))) return '❌ ' + r.verdict
  const head = `${r.ok ? '✅' : '⚠️'} ${r.verdict}：${r.path}`
  const line2 = `分辨率 ${r.width ? `${r.width}×${r.height}` : '读不出'} · 时长 ${(r.duration || 0).toFixed(2)} 秒 · 轨道 ${(r.kinds || []).join('、') || '读不出'}${r.decoded ? ' · ' + r.decoded : ''}`
  return [head, line2, r.ok ? '各项检查通过' : (r.problems || []).join('；')].join('\n')
}

/**
 * 图墙 —— 把一条片子等间隔抽帧拼成一张联络表，一次看完整体。
 *
 * 为什么要拼一张而不是逐帧看：逐帧看只能确认「某一帧对」，看不出
 * 「整条片子的节奏和连贯」。拼成一张，五秒就能看出哪一段画面重复、
 * 哪一段色调跳了、哪里画面其实是黑的。
 */
async function contactSheet(video, opts = {}) {
  const maxTiles = Math.max(4, Math.min(64, Number(opts.maxTiles) || 30))
  const m = await E.probe(video)
  const dur = (m && m.duration) || 0
  if (dur <= 0) throw new Error('读不出这条片子的时长：' + path.basename(video))
  const n = Math.min(maxTiles, Math.max(4, Math.round(dur)))
  const cols = Math.min(6, Math.ceil(Math.sqrt(n * 1.6)))
  const rows = Math.ceil(n / cols)
  const tw = 320

  const out = opts.out || path.join(C.custPaths(customer()).images, `图墙-${P.stamp()}.jpg`)
  P.ensureDir(path.dirname(out))
  // fps 抽帧要均匀：用 select 按时间间隔挑，比 fps 滤镜更可控
  const step = dur / n
  const sel = Array.from({ length: n }, (_, i) => i).map((i) => `between(t,${(i * step).toFixed(3)},${(i * step + 0.05).toFixed(3)})`).join('+')
  // 固定宽度、高度按 -2 自适应（-2 保证偶数，yuv420p 硬要求）。
  // 不用 pad：force_original_aspect_ratio=decrease 的舍入会让输出偶尔
  // 比 pad 大 1 像素，直接报 "Padded dimensions cannot be smaller than input dimensions"。
  const vf = `select='${sel}',scale=${tw}:-2:flags=lanczos,setsar=1,tile=${cols}x${rows}:padding=4:margin=4`
  const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', vf, '-frames:v', '1', '-q:v', '3', '-y', out], { timeout: 180_000 })
  if (!r.ok || !fs.existsSync(out)) throw new Error('拼图墙失败：' + String(r.stderr || '').slice(0, 200))
  return { path: out, tiles: n, cols, rows, span: dur, step }
}

/**
 * 把多张图片拼成一张图墙。
 * 和 contactSheet 的区别：contactSheet 是「从一个视频里按时间抽帧」，
 * 这个是「把 N 个不同文件并排」，给「这批素材都是什么」这种一次问完的场合用。
 * ★ 用 concat 输入 + tile 滤镜：每张先统一缩放到同一尺寸再 tile，
 *   否则 tile 会按第一张的尺寸硬拼，后面的要么被裁要么留黑块。
 */
async function tileImages(files, opts = {}) {
  const list = (files || []).filter((f) => f && fs.existsSync(f))
  if (!list.length) throw new Error("没有可拼的图片")
  const n = list.length
  const cols = Math.max(1, Math.min(6, Number(opts.cols) || Math.ceil(Math.sqrt(n * 1.4))))
  const rows = Math.ceil(n / cols)
  const tw = Math.max(160, Math.min(480, Number(opts.tileWidth) || 320))
  const out = opts.out || path.join(C.custPaths(opts.customer || C.currentCustomer()).cache, "图墙-" + P.stamp() + ".jpg")
  P.ensureDir(path.dirname(out))

  /* concat demuxer 需要一张清单文件；每行 file 后面必须接时长，
     否则 concat 只有一帧的图片会报 "Non-monotonous DTS"。 */
  const listFile = out + ".txt"
  const lines = []
  for (const f of list) {
    lines.push("file '" + f.replace(/'/g, "'\\''") + "'")
    lines.push("duration 0.04")
  }
  // 最后一张再写一遍：concat 对图片流的常见怪癖，不加最后一帧会丢
  lines.push("file '" + list[list.length - 1].replace(/'/g, "'\\''") + "'")
  fs.writeFileSync(listFile, lines.join("\n"))

  const vf = "scale=" + tw + ":-2:flags=lanczos,setsar=1,tile=" + cols + "x" + rows + ":padding=4:margin=4"
  const r = await E.run(P.FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", vf, "-frames:v", "1", "-q:v", "3", "-y", out], { timeout: 120000 })
  try { fs.unlinkSync(listFile) } catch (e) {}
  if (!r.ok || !fs.existsSync(out)) throw new Error("拼图墙失败：" + String(r.stderr || "").slice(0, 200))
  return { path: out, tiles: n, cols, rows }
}

function customer() { return C.currentCustomer() }

module.exports = { AV_EXT, IMG_EXT, imageSize, findByName, probeMedia, verifyMedia, verifyReport, contactSheet, tileImages }
