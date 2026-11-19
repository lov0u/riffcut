'use strict'
/**
 * 只换开头 —— 一条片子已经能转化时，唯一该动的是开头。
 *
 * 投放侧做 A/B 就是拿同一支片配三个不同的前三秒，比哪个留人。
 * 如果顺手把主体也重编一遍（改音乐、改调色、「顺便优化」），
 * 两个变量同时变，测出来的差异跟开头没关系了。
 *
 * 做法是两段拼：
 *   前段 = 新开头，重编码成跟成片完全一样的规格（分辨率/帧率/像素格式/编码参数）
 *   后段 = 成片从 take 秒起，**原样搬过来**（-c copy，不解码不编码）
 * 先造前段、再 concat demuxer 带 -c copy 拼。这样主体是真的没动过。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const E = require('./exec')

async function swapHook(main, hook, opts = {}) {
  const srcMain = path.resolve(main)
  const srcHook = path.resolve(hook)
  if (!fs.existsSync(srcMain)) throw new Error('成片不在了：' + srcMain)
  if (!fs.existsSync(srcHook)) throw new Error('新开头不在了：' + srcHook)

  const mi = await E.probe(srcMain)
  const hi = await E.probe(srcHook)
  const W = mi.width || 1920
  const H = mi.height || 1080
  const fps = mi.fps || 30
  const mdur = mi.duration || 0
  const hdur = hi.duration || 0
  const take = Number(opts.hookSeconds) || hdur
  if (!(take > 0)) throw new Error('新开头没有时长，读不出来')
  if (take >= mdur - 0.2) {
    throw new Error(`要替换的 ${take.toFixed(2)} 秒几乎等于整条片子（${mdur.toFixed(2)} 秒），那样就没有主体了`)
  }

  const out = opts.out || path.join(path.dirname(srcMain), path.basename(srcMain, path.extname(srcMain)) + '_新开头' + path.extname(srcMain))
  const tmp = path.join(P.ROOT, 'runtime', 'hook-' + Date.now())
  fs.mkdirSync(tmp, { recursive: true })

  // 前段：新开头裁到 take、规整成成片的规格，按成片参数重编码，这样后面 -c copy 拼得上去。
  // 补静音 / 补最后一帧，避免两端对不齐。
  const head = path.join(tmp, 'head.mp4')
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`
  const crf = Number(opts.crf) || 18
  const r1 = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', srcHook, '-t', take.toFixed(3), '-vf', vf,
    '-af', `apad=whole_dur=${take.toFixed(3)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', head], { timeout: 600_000 })
  if (!r1.ok || !fs.existsSync(head)) throw new Error('新开头没能规整成成片的规格：' + String(r1.stderr || '').slice(0, 180))

  // 后段：成片从 take 起原样搬。
  //
  // ★★ `-ss` 必须放在 `-i` **之前**（输入侧 seek）。放在 `-i` 之后（输出侧 seek）
  //    配 `-c copy` 会出大事：实测同一条 10 秒片，take=2.0 时
  //      · `-i main -ss 2.0 -c copy` → 视频只有 1.67 秒 / 50 帧，音频却是 7.98 秒
  //      · `-ss 2.0 -i main -c copy` → 视频 8.00 秒 / 240 帧，音频 8.00 秒 ✓
  //    原因是输出侧 seek 只丢包不解码，视频流停在「take 之前的那个关键帧」上，
  //    而音频帧小、几乎每帧都能切 —— 结果就是画面短了一大截、声音对不上。
  //    这个坑旧版 Python 就有（`swap_hook` 里也是输出侧 -ss），等于这个功能
  //    出来的片子一直是音画不同步的。
  const body = path.join(tmp, 'body.mp4')
  const r2 = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-ss', take.toFixed(3), '-i', srcMain, '-c', 'copy', body], { timeout: 600_000 })
  if (!r2.ok || !fs.existsSync(body)) throw new Error('成片后半段没切出来：' + String(r2.stderr || '').slice(0, 180))

  // ★★ concat demuxer 会引入最多 1 帧的时间推后 —— 它按「最长流」累加时间轴，
  //    head 的音频（AAC 有编码器预填充）和视频长度差一点，body 的起点就被
  //    推后半帧到一帧。实测 10 秒 30fps 片、take=2.0 时，接缝后的画面整体
  //    晚 1 帧：main@3.0 的画面出现在新片的 3.0333 处，PSNR 只有 25 dB，
  //    看起来像「主体被重编码了」，其实只是错位。
  //    所以拼完先量一次，偏了就按偏移重切 body 再拼一次 —— 量出来的，不是猜的。
  const concatOnce = async (bodyFile) => {
    const lst = path.join(tmp, 'list.txt')
    fs.writeFileSync(lst, `file '${head}'\nfile '${bodyFile}'\n`, 'utf8')
    const r = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', out], { timeout: 600_000 })
    if (!r.ok || !fs.existsSync(out)) throw new Error('两段没拼上：' + String(r.stderr || '').slice(0, 180))
    return out
  }

  // 量「原片 refStart 处的画面」与「新片 newStart 处的画面」差多少。
  // ★ 用 trim 滤镜，不用 -t：实测 -t 会连 psnr 的汇总行一起吞掉，只能拿到 -1。
  const psnrAt = async (newFile, newStart, refStart, dur) => {
    const pr = await E.run(P.FFMPEG, ['-hide_banner', '-i', srcMain, '-i', newFile,
      '-lavfi', `[0:v]trim=start=${refStart.toFixed(3)}:duration=${dur.toFixed(2)},setpts=PTS-STARTPTS[a];`
        + `[1:v]trim=start=${newStart.toFixed(3)}:duration=${dur.toFixed(2)},setpts=PTS-STARTPTS[b];[a][b]psnr`,
      '-an', '-f', 'null', '-'], { timeout: 180_000 })
    const mm = [...String(pr.stderr || '').matchAll(/PSNR y:([\w.]+)/g)].map((x) => x[1])
    if (!mm.length) return -1
    const last = mm[mm.length - 1]
    return last === 'inf' || last === 'nan' ? 99 : Number(last)
  }

  const probeSec = Math.min(2, Math.max(0.5, (mdur - take) / 3))
  const fr = fps > 0 ? 1 / fps : 1 / 30
  await concatOnce(body)
  let psnr = await psnrAt(out, take, take, probeSec)
  let shift = 0
  if (psnr < 40) {
    // 在 ±3 帧里找真正对齐的位置
    let best = { off: 0, psnr }
    for (let k = -3; k <= 3; k++) {
      if (!k) continue
      const q = await psnrAt(out, take + k * fr, take, probeSec)
      if (q > best.psnr) best = { off: k, psnr: q }
    }
    if (best.psnr > 40 && best.off !== 0) {
      shift = best.off
      const take2 = take + shift * fr
      if (take2 > 0.05 && take2 < mdur - 0.05) {
        const body2 = path.join(tmp, 'body2.mp4')
        const rb = await E.run(P.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
          '-ss', take2.toFixed(4), '-i', srcMain, '-c', 'copy', body2], { timeout: 600_000 })
        if (rb.ok && fs.existsSync(body2)) {
          await concatOnce(body2)
          psnr = await psnrAt(out, take, take, probeSec)
        }
      }
    }
  }

  const got = await E.probe(out)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

  const aligned = psnr >= 40
  const notes = []
  if (shift) notes.push(`拼接后主体偏了 ${shift} 帧（${Math.round(shift * fr * 1000)}ms），已按实测偏移回补对齐`)
  notes.push(aligned
    ? `主体原样搬过来（PSNR ${psnr.toFixed(1)} dB，${psnr >= 50 ? '肉眼与编码层面都看不出来' : '基本无差别'}）`
    : `⚠ 接缝后和原片对不上（PSNR ${psnr.toFixed(1)} dB）—— 主体可能被重编码或错位，这样的 A/B 就不只差开头`)

  return { ok: true, path: out, replaced: take, duration: got.duration, size: got.size, psnr, untouched: aligned, shift, notes }
}

module.exports = { swapHook }
