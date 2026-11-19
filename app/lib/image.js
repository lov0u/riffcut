'use strict'
/**
 * 生图层 —— 出图、给图叠字、看图审片。
 *
 * 为什么不自己实现「在画面里写字」：生图模型画中文必然出伪字（实测 'rondoo'、
 * '显霪碳毒'、'你退'），而且画出来的界面文字会和烧上去的字幕打架 ——
 * 两层字重叠，谁也读不清。文字是字幕系统的活，画面只给场景。
 * 所以 generateImage 默认硬约束「画面里不要出现任何文字」，
 * 要字就走 imageText 把干净图叠上真字。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')
const M = require('./models')
const F = require('./imgfit')

// 图片模型画中文必然出伪字。除非调用方明确要字，否则硬约束住。
const NO_TEXT = '\n\n[画面约束] 画面里不要出现任何文字、字母、数字、标签、按钮文字、界面 UI 文案。只画场景、人物、物体、光线。所有文字后期单独加。'
const WANTS_TEXT = ['文字', '标题字', '字幕', '写上', '标注', '封面字', '海报字', '招牌']

/** 找配置好的生图模型，优先用户指定的那个。 */
function findImageModel(explicit) {
  const ms = M.models()
  if (explicit && ms[explicit] && ms[explicit].kind === 'image') return explicit
  for (const [k, v] of Object.entries(ms)) {
    if (v.kind === 'image' && String(v.key || '').trim() && String(v.model || '').trim()) return k
  }
  return ''
}

/** 主题 → 安全文件名。 */
function safeTopic(text) {
  const first = String(text || '').split(/[，,。！!\n]/)[0].slice(0, 12)
  return (first || '素材').replace(/[^\w\u4e00-\u9fa5-]/g, '') || '素材'
}

/**
 * 用绑定的生图模型出一张图，直接落盘到产出目录。
 *
 * 生图走 /images/generations，和聊天的 /chat/completions 不是同一个接口。
 * 出完量真实尺寸：接口说 size 是多少不算数，落盘的文件多大才算 ——
 * 不够目标画布就升一档重出一次（只重出一次，防止接口不认档位时无限循环）。
 */
async function generateImage(opts = {}) {
  let prompt = String(opts.prompt || '').trim()
  if (!prompt) throw new Error('先写一句要生成什么，例如「科技感产品封面，深蓝背景」')

  if (!WANTS_TEXT.some((k) => prompt.includes(k))) prompt += NO_TEXT

  const mid = findImageModel(opts.model)
  if (!mid) throw new Error('还没有生图模型。到「模型」里添加，把类型选成「生图」。')
  const m = M.models()[mid]
  const key = String(m.key || '').trim()
  if (!key) throw new Error(`生图模型「${m.name || mid}」还没填 API Key`)

  // 默认给竖屏画布：这个软件交付的主要形态是竖屏，
  // 默认 1024x1024 方图到竖屏成片里必然要裁掉一半画面。
  let size = String(opts.size || '').trim()
  if (!size) {
    const o = (C.settings() || {}).output || {}
    size = o.width && o.height ? `${o.width}x${o.height}` : '1080x1920'
  }
  const plan = F.sizePlan(size)

  const base = String(m.url || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  const endpoint = base + '/images/generations'
  const headers = {
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    // 白鹿（Cloudflare 前置）没有浏览器 UA 会 403 error code: 1010，
    // 那是浏览器签名异常不是鉴权失败，换 key 没用。
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  }

  const post = async (payload) => {
    const r = await globalThis.fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload),
    })
    const txt = await r.text()
    if (!r.ok) {
      const err = new Error(`生图失败（HTTP ${r.status}）：${txt.slice(0, 200)}`)
      err.status = r.status
      err.body = txt
      throw err
    }
    try { return JSON.parse(txt) } catch { throw new Error('接口返回的不是 JSON：' + txt.slice(0, 160)) }
  }

  const pickImage = (j) => {
    let data = (j && (j.data || j.images)) || []
    if (!data.length && j && j.output && j.output.images) data = j.output.images
    if (data && !Array.isArray(data)) data = [data]
    const it = Array.isArray(data) && data.length ? data[0] : null
    let b64 = ''
    let url = ''
    if (it && typeof it === 'object') {
      b64 = it.b64_json || it.base64 || it.image || ''
      url = it.url || ''
    }
    if (!b64 && !url && j) {
      for (const k of ['b64_json', 'image', 'output', 'result']) {
        if (typeof j[k] === 'string' && j[k].length > 200) { b64 = j[k]; break }
      }
    }
    return { b64, url }
  }

  const toBytes = async (b64, url) => {
    if (b64) {
      const clean = String(b64).replace(/^data:image\/[^;]+;base64,/, '')
      return { raw: Buffer.from(clean, 'base64'), ext: '.png' }
    }
    if (url) {
      const r = await globalThis.fetch(url)
      if (!r.ok) throw new Error('下载生成的图失败：HTTP ' + r.status)
      const raw = Buffer.from(await r.arrayBuffer())
      const ext = /\.jpe?g(\?|$)/i.test(url) ? '.jpg' : '.png'
      return { raw, ext }
    }
    throw new Error('接口没返回图片内容（这个模型可能不支持 /images/generations，或返回的是它自己的私有格式）')
  }

  const body = { model: String(m.model || '').trim(), prompt, n: 1, size: plan.send }
  if (plan.ratio) body.ratio = plan.ratio

  const t0 = Date.now()
  let out = null
  try {
    let j
    try {
      j = await post({ ...body, response_format: 'b64_json' })
    } catch (e) {
      // 部分兼容接口不认 response_format，去掉再试一次
      if (e.status === 400 || e.status === 422) j = await post(body)
      else throw e
    }
    const { b64, url } = pickImage(j)
    const { raw, ext } = await toBytes(b64, url)
    if (!raw || raw.length < 200) throw new Error('接口返回的图片内容太小，可能不是图')

    // 成品第一步就写进产出目录，不经过临时目录
    const dir = C.custPaths().images
    P.ensureDir(dir)
    const file = path.join(dir, `${P.stamp()}-RiffCut-${safeTopic(prompt)}${ext}`)
    fs.writeFileSync(file, raw)
    out = { ok: true, path: file, name: path.basename(file), size: raw.length, model: mid, ms: Date.now() - t0 }

    // 量真实尺寸。不够目标画布就升一档重出一次。
    const up = F.needUpgrade(file, plan.want_w, plan.want_h)
    out.width = up.w
    out.height = up.h
    if (up.ok === false && up.tier) {
      const hot = { model: body.model, prompt, n: 1, size: up.tier }
      if (plan.ratio) hot.ratio = plan.ratio
      try {
        let j2
        try {
          j2 = await post({ ...hot, response_format: 'b64_json' })
        } catch (e2) {
          if (e2.status === 400 || e2.status === 422) j2 = await post(hot)
          else throw e2
        }
        const p2 = pickImage(j2)
        const r2 = await toBytes(p2.b64, p2.url)
        // 升档拿到的图先量再决定要不要覆盖 —— 有些接口不认档位，
        // 重出还是同一张，那就别拿它盖掉原来那张好的。
        const tmp = path.join(os.tmpdir(), `riffcut-up-${Date.now()}${r2.ext}`)
        fs.writeFileSync(tmp, r2.raw)
        const up2 = F.needUpgrade(tmp, plan.want_w, plan.want_h)
        if ((up2.w * up2.h) > (up.w * up.h)) {
          fs.renameSync(tmp, file)
          out.width = up2.w
          out.height = up2.h
          out.upgraded = up.tier
          out.stillShort = up2.ok === false
        } else {
          try { fs.unlinkSync(tmp) } catch {}
          out.stillShort = true
        }
      } catch (e) {
        out.upgradeError = String(e.message || e).slice(0, 160)
        out.stillShort = true
      }
    }
    // 出完自动进素材库 —— 排分镜时直接写这个文件名当 asset
    try {
      const A = require('./assets')
      A.ingest(file, C.currentCustomer())
      out.inLibrary = true
    } catch {}
    return out
  } catch (e) {
    M.recordUsage && M.recordUsage(mid, '生成图片', t0, false, String(e.message || e))
    throw e
  }
}

/**
 * 给一张静态图叠字，出一张新图。
 *
 * 为什么绕这么大一圈：libass 是给「随时间长出来的字幕」设计的，
 * 所以做法是把这张图循环成一小段流，让 ASS 在这一秒里把字画上去，
 * 再从中间截一帧 —— 这样钩子字/编辑字/卡片那几套样式、关键词高亮、
 * 淡入动画全都能原样复用，不用为静图再写一套排版。
 *
 * at 是取哪一帧（秒）。不能取 0：{\fad} 在起点那一帧是全透明的，
 * 截第 0 帧会得到一张干净的无字图，看起来像「叠字没生效」。
 */
async function imageText(src, text, opts = {}) {
  const Sub = require('./subtitle')
  const txt = String(text || '').trim()
  if (!fs.existsSync(src)) throw new Error('这个图片文件不在了：' + path.basename(src))
  if (!txt) throw new Error('要叠什么字？text 是空的。叠字要么给一句话，要么就别叠')

  const [w, h] = await Sub.probeWH(src)
  const W = Number(opts.width) || w
  const H = Number(opts.height) || h
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'riffcut_txt_'))
  try {
    const srt = path.join(tmpd, 't.srt')
    fs.writeFileSync(srt, `1\n00:00:00,000 --> 00:00:02,000\n${txt}\n`, 'utf8')
    const ass = Sub.srtToAss(srt, {
      outAss: path.join(tmpd, 't.ass'),
      preset: opts.preset || '钩子字',
      keywords: opts.keywords,
      color: opts.color,
      w: W, h: H,
      size: opts.size,
    })
    const assFile = ass.path
    let vf = `subtitles=${assFile.replace(/:/g, '\\:')}`
    // 带 VolenaScrim 标记的（钩子字）先叠顶部渐变，白字压白底才读得清
    let scrimUsed = false
    const head = fs.readFileSync(assFile, 'utf8').slice(0, 2000)
    const m = /VolenaScrim:\s*([0-9.]+)\s*,\s*([0-9.]+)/.exec(head)
    if (m) {
      vf = `${Sub.scrimVf(W, H, Number(m[1]), Number(m[2]))},${vf}`
      scrimUsed = true
    }
    const out = opts.out || path.join(C.custPaths().images, `${P.stamp()}-叠字-${Math.random().toString(16).slice(2, 6)}.jpg`)
    P.ensureDir(path.dirname(out))
    // 图上没有时间轴，但 libass 要一个时间才有帧可画：
    // 把图循环成 2 秒流，在 at 秒处截一帧。jpg 编码器在，png 不在。
    await E.ffmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-i', src, '-t', '2',
      '-vf', vf, '-ss', String(Math.max(0, Number(opts.at) || 0.5)),
      '-frames:v', '1', '-q:v', '2', '-y', out,
    ], { timeout: 120_000 })
    if (!fs.existsSync(out)) throw new Error('叠字失败：没有生成文件')
    return { ok: true, path: out, name: path.basename(out), text: txt, preset: opts.preset || '钩子字', width: W, height: H, cues: ass.cues, scrim: scrimUsed }
  } finally {
    try { fs.rmSync(tmpd, { recursive: true, force: true }) } catch {}
  }
}


/** 找能看图的视觉模型（优先用户指定的）。 */
function findVisionModel(explicit) {
  const ms = M.models()
  if (explicit && ms[explicit] && ms[explicit].kind === 'vision') return explicit
  for (const [k, v] of Object.entries(ms)) {
    if (v.kind === 'vision' && String(v.key || '').trim() && String(v.model || '').trim()) return k
  }
  return ''
}

/**
 * 把自己刚生成的图看一遍，按真实性/值得看两条轴打分，指出最差的一处。
 *
 * 生成完不看就交，是 prompt-only 流程卡在原地不动的根本原因。
 * 摄影师也是先拍再挑。这个函数就是那个「挑」。
 */
async function reviewImage(file, opts = {}) {
  const G = require('./guide')
  if (!fs.existsSync(file)) return { ok: false, report: '这个图片文件不在了：' + file }
  const mid = findVisionModel(opts.model)
  if (!mid) return { ok: false, report: '没有配视觉模型，看不了图。只能靠自己按契约那十段检查。' }

  const raw = fs.readFileSync(file)
  const b64 = raw.toString('base64')
  const ext = path.extname(file).toLowerCase()
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  const r = await M.chat(mid, [{
    role: 'user',
    content: [
      { type: 'text', text: G.imageReviewPrompt(opts.shot) },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
    ],
  }], { maxTokens: 1200 })
  if (!r || !r.ok) return { ok: false, report: '看不了：' + ((r && r.error) || '视觉模型没回话'), model: mid }
  return { ok: true, report: r.text, model: mid }
}

module.exports = { NO_TEXT, WANTS_TEXT, findImageModel, findVisionModel, safeTopic, generateImage, imageText, reviewImage }
