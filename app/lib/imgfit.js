'use strict'
/**
 * 生图尺寸不够时自动升档重出。
 *
 * 为什么需要它
 * ------------
 * Agnes 这类接口的 size 不是像素，是档位（1K/2K/3K/4K），宽高比走独立的
 * ratio 参数。传 size="1080x1920" 它不会给你 1080x1920，而是按它自己的
 * 档位给一个「差不多这么大」的图 —— 实测回来是 736x1312。
 *
 * 后果不是「图小一点」，是**渲染时被放大裁切**：竖屏成片画布 1080x1920，
 * 736x1312 的图要放大 1.47 倍再裁掉多余部分，边缘发虚、文字糊成一片。
 * 而这种损失在预览缩略图里看不出来，只有投到手机上看片才发现。
 *
 * 怎么办
 * ------
 * 出完立刻 ffprobe 真实尺寸，小于目标画布就按缺口算一个更高的档位重出一次，
 * 仍然不够就用当前最好的那张并如实说明还差多少。**不假装够。**
 *
 * 档位换算：短边像素按 1K≈768 / 2K≈1536 / 3K≈2304 / 4K≈3072 粗估，
 * 取能满足目标短边的最低档。
 */
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const P = require('./paths')

// 档位 → 短边像素（保守估计，宁高不低）
const TIERS = [['1K', 768], ['2K', 1536], ['3K', 2304], ['4K', 3072]]
const SIZE_RE = /^(\d{2,5})\s*[x*×]\s*(\d{2,5})$/

/** '1080x1920' → [1080,1920]；'2K' / '竖屏' 这类返回 null（不是像素串）。 */
function parseSize(size) {
  const m = SIZE_RE.exec(String(size || '').trim())
  return m ? [Number(m[1]), Number(m[2])] : null
}

/**
 * 读真实像素。读不到返回 [0,0]。
 *
 * 不用图片库：这条路径要在生图后立刻执行，失败就等于没检查。
 * ffprobe 是随包的，一定有。
 */
function probe(file) {
  const p = String(file || '')
  if (!p || !fs.existsSync(p)) return [0, 0]
  try {
    const out = execFileSync(P.FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', p,
    ], { encoding: 'utf8', timeout: 20_000 })
    if (out && out.includes('x')) {
      const [w, h] = out.trim().split('x')
      return [Number(w) || 0, Number(h) || 0]
    }
  } catch {}
  return [0, 0]
}

/**
 * 要满足目标画布，至少需要哪个档位。
 *
 * 用短边定档：竖屏 1080x1920 的短边是 1080，需要短边 >=1080 的图。
 * 目标 16:9 时短边是 1080（高），4:3 时短边是宽 —— 取 min(w,h) 这个口径，
 * 两种情况都对，也不会把 4K 需求估成 2K。
 */
function tierFor(targetW, targetH) {
  const need = Math.min(Number(targetW) || 0, Number(targetH) || 0)
  if (need <= 0) return ''
  for (const [name, short] of TIERS) if (short >= need) return name
  return TIERS[TIERS.length - 1][0]
}

/** 约分到最简，得到接口认的 ratio（9:16、16:9、1:1）。 */
function ratioOf(w, h) {
  let a = Math.abs(Number(w) || 0)
  let b = Math.abs(Number(h) || 0)
  if (!a || !b) return ''
  const gcd = (x, y) => (y ? gcd(y, x % y) : x)
  const g = gcd(a, b)
  return `${a / g}:${b / g}`
}

/** 图够不够用。返回 {ok,w,h,target_w,target_h,ratio,tier,why}。 */
function needUpgrade(file, targetW, targetH, tol = 0.98) {
  const [w, h] = probe(file)
  const tw = Number(targetW) || 0
  const th = Number(targetH) || 0
  const out = { ok: true, w, h, target_w: tw, target_h: th, ratio: ratioOf(tw, th), tier: '', why: '' }
  if (!w || !h || !tw || !th) { out.why = '读不到尺寸，不判'; return out }
  // 短边不够 = 必然放大；长边不够也算不够（裁切后连画幅都填不满）
  const shortOk = Math.min(w, h) >= Math.min(tw, th) * tol
  const longOk = Math.max(w, h) >= Math.max(tw, th) * tol
  if (shortOk && longOk) return out
  out.ok = false
  out.tier = tierFor(tw, th)
  out.why = `图是 ${w}x${h}，目标 ${tw}x${th} —— 短边差 ${Math.round(Math.max(0, (Math.min(tw, th) / Math.max(1, Math.min(w, h)) - 1) * 100))}%，渲染时会被放大裁切，边缘发虚、文字糊`
  return out
}

/** 把目标像素串换算成接口参数：够用的档位 + 最简宽高比。 */
function sizePlan(size, w, h) {
  let px = parseSize(size)
  if (!px && w && h) px = [Number(w), Number(h)]
  if (!px) return { send: size || '1024x1024', ratio: '', want_w: 0, want_h: 0 }
  const [tw, th] = px
  return { send: tierFor(tw, th), ratio: ratioOf(tw, th), want_w: tw, want_h: th }
}

module.exports = { TIERS, parseSize, probe, tierFor, ratioOf, needUpgrade, sizePlan }
