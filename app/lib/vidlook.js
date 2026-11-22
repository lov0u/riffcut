'use strict'
/**
 * 逐镜头读一条视频。
 *
 * ★ 和 review / look_folder 的区别（这是三个不同的问法，别混）：
 *   · look_folder —— 一整个文件夹里每条素材**抽 1 帧**，回答「这条大概是什么、能不能用」
 *   · review      —— 一条成片**等间隔抽 30 帧**，回答「结构上哪段太长、哪段黑屏」
 *   · readVideo   —— 一条视频**按真实镜头边界切段**，每镜取中间帧，回答
 *                    「第几个镜头出了什么问题」。前两个都定位不到「具体哪个镜头」。
 *
 * 为什么要按镜头而不是等间隔：等间隔抽帧会漏掉短镜头（一个 0.4 秒的闪切
 * 在 30 格里基本抽不到），而废片往往就是那一两个短镜头（黑场、错素材、乱码字）。
 *
 * 数据来源：
 *   · 镜头边界 —— study.detectScenes()（ffmpeg select='gt(scene,X)',metadata=print）
 *   · 每镜取帧 —— ffmpeg -ss <中点> 单帧
 *   · 拼图墙   —— media.tileImages()（多文件 concat + tile）
 *   · 判读     —— models.chat 直接问（不能套 guide.imageReviewPrompt，那是挑单图的）
 *
 * ★ 读过的片子要记账，否则同一部片被反复问就是反复烧钱。
 *   记账沿用 assets.js 里那套 velora_index 的思路（同一份客户内部缓存目录，
 *   绝不写进用户的素材文件夹 —— 那边只读），但对象从「整个素材目录」
 *   收紧到「一条片子 + 这组参数」，因为同一条片按不同 maxShots 读结论不同。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const E = require('./exec')
const C = require('./core')

/* ── 读片索引：一条片子一条记录，键里带参数指纹 ─────────────────
   为什么键要带 maxShots/longShot/threshold：同一条片，
   maxShots=12 看 12 段、maxShots=40 看 40 段，结论不一样，
   只按路径缓存会把「看得粗」的旧结果当成「看得细」的答案返回。
   为什么不带 mtime：用户重渲染同名成片时 mtime 必变，键就全失效，
   等于每次都重新问一遍。宁可偶尔读到旧结论，也不要常态性烧钱。
   要强制重读传 opts.fresh。 */
/* ★ 索引写在**视频文件所在的目录**里，不是软件内部缓存。
   理由：用户选的素材目录就是他自己的工作区，他翻文件夹时应该能直接看到
   「这条片子读过、第 3 镜是黑场不能用」，而不是必须开软件才知道。
   也不写在软件缓存里 —— 那样换了机器、重装软件，几百条片子的分析结论全丢。

   写法：同目录下开一个 `RiffCut-索引` 子目录，一条片子一个 json。
   为什么不直接散在视频旁边：一个 200 条素材的文件夹会被 200 个 json 淹没，
   用户自己都分不清哪个是他自己的文件。
   目录不可写（只读挂载/U 盘/网络盘）时退回软件内部缓存，而不是让读片整个失败。 */
function idxDir() {
  /* 索引统一落在**工作区根目录**下的 RiffCut-索引/，不是每条视频旁边各开一个。
     理由：用户选的素材根目录就是他干活的地方，翻文件夹时要能一眼看到；
     但按视频所在目录散开的话，一个「素材/2026/11月」的层级里会长出一堆
     RiffCut-索引 文件夹，越用越乱。统一在根下一个，按文件名 hash 区分片子。
     根目录不可写（只读挂载/U 盘/网络盘）时退回软件内部缓存，而不是让整个读片失败。 */
  const root = C.custPaths().root
  const near = path.join(root, 'RiffCut-索引')
  try {
    P.ensureDir(near)
    fs.accessSync(near, fs.constants.W_OK)
    return near
  } catch (e) {
    const d = C.custPaths().index
    P.ensureDir(d)
    return d
  }
}

function idxPath(video) {
  const key = require('node:crypto').createHash('md5')
    .update(path.basename(String(video))).digest('hex').slice(0, 12)
  /* 键只用文件名不用全路径：同一批素材整个文件夹搬走后，
     索引还能跟着走；而目录本身已经区分了不同文件夹下的同名文件。 */
  return path.join(idxDir(), '读片-' + key + '.json')
}

function readCache(video, sig) {
  try {
    const j = P.readJson(idxPath(video), null)
    if (!j || j.velora_video_index !== 1) return null
    if (String(j.sig) !== String(sig)) return null
    return j
  } catch (e) { return null }
}

function writeCache(video, sig, res) {
  try {
    P.writeJson(idxPath(video), {
      velora_video_index: 1,
      video: String(video),
      name: path.basename(video),
      sig: String(sig),
      model: res.model,
      duration: res.duration,
      shotCount: res.shotCount,
      looked: res.looked,
      bad: res.bad,
      shots: res.shots,
      at: P.now(),
    })
  } catch (e) { /* 缓存写不进去不该让整个读片失败 */ }
}

/** 一镜一帧：取镜头中点。取开头常是转场残影，取结尾常是下一镜的第一帧。 */
async function frameAt(video, at, out) {
  const r = await E.run(P.FFMPEG, ['-y', '-ss', String(Math.max(0, at)), '-i', video,
    '-frames:v', '1', '-q:v', '3', out], { timeout: 60_000 })
  return r.ok && fs.existsSync(out) ? out : ''
}

/**
 * 按镜头读。
 *
 * opts:
 *   maxShots  最多看几个镜头（默认 12，上限 40）。超出的镜头会在返回里明确报数，
 *             不许静默截断 —— 否则 AI 会拿前 12 个镜头的结论去回答整条片子。
 *   model     视觉模型 id
 *   threshold 镜头切分阈值（默认走 study 的 SCENE_THRESHOLD）
 *   customer  客户名
 */
async function readVideo(video, opts = {}) {
  if (!video || !fs.existsSync(video)) throw new Error('找不到这个视频：' + video)
  const S = require('./study')
  const Md = require('./media')
  const I = require('./image')

  const mid = String(opts.model || I.findVisionModel() || '')
  if (!mid) {
    throw new Error('这台机器上没配能读图的模型。到「模型管理」里加一个支持图片输入的（不是纯文本的），再回来。')
  }

  /* 这条片子读过没有？读过就直接给结论，不再烧一遍视觉模型。
     指纹 = 三条参数；不把 mtime 放进来（见文件头注释）。 */
  const sig = ['v1', Number(opts.maxShots) || 16, Number(opts.longShot) || 3,
    Number(opts.threshold) || 0.12].join('|')
  if (!opts.fresh) {
    const hit = readCache(video, sig)
    if (hit) {
      return {
        ok: true, video, model: hit.model, duration: hit.duration,
        shotCount: hit.shotCount, looked: hit.looked, truncated: 0,
        bad: hit.bad, wall: '', shots: hit.shots, notes: [],
        cached: true, cachedAt: hit.at,
      }
    }
  }

  const det = await S.detectScenes(video, { threshold: opts.threshold })
  if (!det.ok) throw new Error('切不出镜头：' + String(det.error || '读不出时长'))
  const all = det.scenes || []
  if (!all.length) throw new Error('这条片子里一个镜头都切不出来')

  /* ★ 长镜头要拆成几块看，不能一镜一帧。
     实测：一条 30 秒屏录片只切出 3 个镜头，其中第 2 镜 22.5 秒 ——
     只取中间那 1 帧，等于 22.5 秒里有什么全靠猜。屏录、PPT、慢运镜
     这类片子的 scene 分数天然很低，切不多，盲区比正常片子大得多。
     所以超过 LONG_SHOT 秒的镜头按 LONG_SHOT 米均分，每块各取中间帧，
     并标出这是「第几镜的第几段」。 */
  const LONG_SHOT = Number(opts.longShot) || 3
  const chunks = []
  for (let i = 0; i < all.length; i++) {
    const sc = all[i]
    const len = sc.end - sc.start
    const parts = len > LONG_SHOT * 1.6 ? Math.min(8, Math.ceil(len / LONG_SHOT)) : 1
    if (parts === 1) { chunks.push({ shot: i, part: 1, parts: 1, start: sc.start, end: sc.end }); continue }
    const step = len / parts
    for (let k = 0; k < parts; k++) {
      chunks.push({ shot: i, part: k + 1, parts, start: sc.start + k * step, end: sc.start + (k + 1) * step })
    }
  }
  const cap = Math.max(1, Math.min(60, Number(opts.maxShots) || 16))
  const pick = chunks.slice(0, cap)

  const cache = C.custPaths(opts.customer).cache
  P.ensureDir(cache)
  const stamp = Date.now().toString(36)
  const frames = []
  const notes = []
  try {
    for (let i = 0; i < pick.length; i++) {
      const ck = pick[i]
      const midAt = (ck.start + ck.end) / 2
      const tmp = path.join(cache, `镜-${stamp}-${i}.jpg`)
      const got = await frameAt(video, midAt, tmp)
      const tag = ck.parts > 1 ? `第${ck.shot + 1}镜第${ck.part}段` : `第${ck.shot + 1}镜`
      if (got) frames.push({ i, sc: ck, tag, file: tmp })
      else notes.push(`${tag}（${ck.start.toFixed(2)}s-${ck.end.toFixed(2)}s）：抽帧失败`)
    }
    if (!frames.length) throw new Error('一个镜头的帧都抽不出来：' + notes.join('；'))

    /* ★ 不能把所有段塞进一张图墙。
       实测：12 段挤一张墙，每格缩到约 320px 宽，模型对每一段都回
       「画面是AI助手界面，无问题，能用，内容清晰可辨」—— 完全一样，
       等于白问。图墙不是越大越好，格数一多每格就糊到没有信息量。
       所以按 BATCH=9 分批：每批单独拼墙、单独问。
       9 格时 4 列布局每格约 480px 宽，模型能看清字。 */
    const BATCH = 9
    const wallPaths = []
    const texts = []
    for (let b = 0; b < frames.length; b += BATCH) {
      const grp = frames.slice(b, b + BATCH)
      const sheet = await Md.tileImages(grp.map((x) => x.file), {
        cols: grp.length > 6 ? 3 : 3,
        tileWidth: 480,
        customer: opts.customer,
      })
      if (!sheet || !sheet.path) throw new Error('图墙拼不出来')
      wallPaths.push(sheet.path)

      const isFirst = b === 0
      const ask = (isFirst
        ? '这是一条视频按真实镜头切分后逐段取中间帧拼成的图墙，从左到右、从上到下依次是下面这些段。\n'
        : `（续第 ${b / BATCH + 1} 批）同一个视频的后续段落，图墙顺序如下。\n`)
        + grp.map((x) => `${x.tag} ${x.sc.start.toFixed(2)}s-${x.sc.end.toFixed(2)}s（${(x.sc.end - x.sc.start).toFixed(2)}秒）`).join('\n')
        + '\n\n逐段回答，**每段单独一行**，必须以「第N镜」或「第N镜第M段」开头，格式：'
        + '`第N镜第M段 —— 画面里是什么；有没有问题；能/勉强/不能用；为什么`。\n'
        + '特别检查这几类废帧：黑场或纯色、文字乱码或笔画崩坏、同一画面重复出现、跟前后段完全不搭。\n'
        + '★ 不许每一段都写同一句话。如果确实几段画面几乎一样，要写出「跟上一段相比变了什么/没变什么」；'
        + '看不清就写「看不清」。只说画面里真能看见的。'

      const raw = fs.readFileSync(sheet.path)
      const b64 = raw.toString('base64')
      const r = await require('./models').chat(mid, [{
        role: 'user',
        content: [
          { type: 'text', text: ask },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
        ],
      }], { maxTokens: 1800 })
      if (!r || !r.ok) throw new Error('视觉模型没回话：' + String((r && r.error) || ''))
      texts.push(String(r.text || ''))
    }
    const text = texts.join('\n')
    const wall = wallPaths[0] || ''

    const byIdx = new Map()
    const ordered = []
    /* 模型有时会照抄格式里的「—— 」再开始写，剥掉它，否则输出变成「—— —— 画面是…」 */
    const strip = (x) => String(x || '').replace(/^[—\-–:：\s]+/, '').trim()
    for (const ln of text.split(/\n+/)) {
      const m = ln.match(/^\s*第\s*(\d+)\s*镜(?:\s*第\s*(\d+)\s*段)?[：:、.)]?\s*(.+)$/)
      if (m) { byIdx.set(m[2] ? Number(m[1]) + '-' + Number(m[2]) : String(Number(m[1])), strip(m[3])); continue }
      const m2 = ln.match(/^\s*(\d+)[.、)：:]\s*(.+)$/)
      if (m2) ordered.push(strip(m2[2]))
    }
    const shots = frames.map((x, k) => {
      const key = x.sc.parts > 1 ? (x.sc.shot + 1) + '-' + x.sc.part : String(x.sc.shot + 1)
      const v = strip(byIdx.get(key) || (x.sc.parts > 1 ? byIdx.get(String(x.sc.shot + 1)) : '') || ordered[k]) || '（模型没提这一段）'
      return {
        index: k + 1,
        shot: x.sc.shot + 1,
        part: x.sc.part,
        parts: x.sc.parts,
        tag: x.tag,
        start: Math.round(x.sc.start * 100) / 100,
        end: Math.round(x.sc.end * 100) / 100,
        duration: Math.round((x.sc.end - x.sc.start) * 100) / 100,
        verdict: v,
      }
    })
    const bad = shots.filter((s) => /不能用/.test(s.verdict)).length
    /* ★ 解析失败的结果不许进缓存。
       模型偶尔不按「第N镜」开头（比如整段写成一段话），这时 verdict 全是
       「模型没提这一段」；一旦写进索引，下次再读同样的参数就直接返回这份废结果，
       而且看起来「有索引、很快」—— 比每次都重新问还糟。
       命中率低于 70% 就只返回不记账，让它下次重新问。 */
    const miss = shots.filter((s) => /模型没提/.test(s.verdict)).length
    if (miss * 10 <= shots.length * 3) {
      writeCache(video, sig, {
        model: mid, duration: det.duration, shotCount: all.length,
        looked: shots.length, bad, shots,
      })
    } else {
      notes.push(`这次 ${shots.length} 段里有 ${miss} 段模型没按格式回答，没记进索引（下次重问）`)
    }
    return {
      ok: true,
      video,
      model: mid,
      duration: det.duration,
      shotCount: all.length,
      looked: shots.length,
      truncated: all.length > shots.length ? all.length - shots.length : 0,
      bad,
      wall,
      shots,
      notes: notes.slice(0, 6),
    }
  } finally {
    for (const x of frames) { try { fs.unlinkSync(x.file) } catch (e) {} }
  }
}

/** 给 AI / 界面看的一行行文本。 */
function report(res) {
  if (!res || !res.ok) return '❌ ' + String((res && res.error) || '读不了')
  const cached = res.cached ? `（读的是 ${res.cachedAt} 那次的索引，参数没变；要重看就带 fresh）` : ''
  const head = `片长 ${res.duration}s，切出 ${res.shotCount} 个镜头，`
    + `长镜头已分段，共看了 ${res.looked} 段，其中判为不能用 ${res.bad} 个。`
  const lines = res.shots.map((s) =>
    `${s.tag} ${s.start}s-${s.end}s（${s.duration}s）—— ${s.verdict}`)
  let tail = ''
  if (res.truncated > 0) {
    /* ★ 必须明说还有多少没看。静默截断会让 AI 拿局部结论回答整条片子。 */
    tail = `\n\n⚠️ 还有 ${res.truncated} 个镜头没看（超过单次上限）。要看全就得分段读；`
      + `现在的结论只覆盖前 ${res.looked} 个镜头，别当成整条片子的结论。`
  }
  const notes = (res.notes && res.notes.length) ? '\n\n备注：\n' + res.notes.join('\n') : ''
  return head + cached + '\n' + lines.join('\n') + tail + notes
}

module.exports = { readVideo, report, frameAt }
