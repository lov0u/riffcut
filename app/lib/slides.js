/**
 * 演示稿视频（PPT 视频 / 口播 PPT）。
 *
 * 为什么单独一层：这类片子不需要逐帧编程，它是「一页内容 + 一段话 + 一个转场」
 * 重复 N 次。用模板系统做反而绕远 —— 4 页要配 4 个模板，改一句文案要动 HTML。
 * 这里直接把「大纲」翻译成时间线：每页 = 一张底图 + 一组文字 + 一段配音。
 *
 * 三条设计决定（都是踩过的）：
 *
 * ① 页长由配音决定，不由字数估算。
 *    先合成配音、量出真实秒数，再定这一页多长。反过来做（按字数算时长）
 *    结果一定是「话还没说完画面就切了」，或者「说完了干等三秒」。
 *
 * ② 底图用 ffmpeg 现场生成，不用模板库。
 *    演示稿的底就是一层渐变或纯色。用模板会引入字号/边距/字体全都不受控的
 *    CSS，一页一个样。自己生成 12KB 一张，颜色可参数化，永远一致。
 *
 * ③ 文字裸排（plate:"0"）。
 *    字幕那套「半透明黑底衬」在深色画面上是对的，在浅色演示稿上会显脏。
 *
 * 页型（kind）：
 *   cover    封面：大标题 + 副标题，居中
 *   points   要点：标题 + 若干条要点，左对齐（PPT 最常用的一页）
 *   quote    金句：一句大字，居中，无标题
 *   section  章节：小标号 + 章节名
 *   end      结尾：一句收尾 + 落款
 */
const fs = require('node:fs')
const path = require('node:path')
const { join, dirname, basename } = path

const P = require('./paths')
const C = require('./core')
const E = require('./exec')
const T = require('./timeline')

const W = 1080
const H = 1920

/** 主题：底色 → 文字色。演示稿只有两件事：读得清、不花。 */
const THEMES = {
  light: { bg1: '0xF7F9FC', bg2: '0xE8F1EE', ink: '#1E2430', ink2: '#5A6272', accent: '#1B8B7E', name: '浅色' },
  dark: { bg1: '0x14181D', bg2: '0x0C1013', ink: '#F2F5F8', ink2: '#A7B0BC', accent: '#2AA99A', name: '深色' },
  paper: { bg1: '0xFBFAF7', bg2: '0xEFEAE1', ink: '#22201C', ink2: '#6B655C', accent: '#B4763A', name: '纸感' },
  brand: { bg1: '0x0E2B28', bg2: '0x071A18', ink: '#EAF6F3', ink2: '#8FB8B1', accent: '#4FD1BE', name: '青绿' },
}
const THEME_ALIAS = {
  浅色: 'light', 白色: 'light', 亮: 'light',
  深色: 'dark', 黑色: 'dark', 暗: 'dark',
  纸质: 'paper', 纸感: 'paper', 暖: 'paper',
  品牌: 'brand', 青绿: 'brand', velora: 'brand',
}
function themeKey(t) {
  const s = String(t || '').trim()
  if (!s) return 'light'
  if (THEMES[s]) return s
  if (THEME_ALIAS[s]) return THEME_ALIAS[s]
  const low = s.toLowerCase()
  for (const k of Object.keys(THEMES)) if (low.includes(k)) return k
  return 'light'
}

/**
 * 把一段自由文本切成页。
 *
 * 认三种写法，因为用户写大纲的方式就这三种：
 *   ① 显式分隔：--- 或 ==== 或连续空行
 *   ② 标题式：# 一级标题 / ## 二级标题（markdown）
 *   ③ 一行一句：每行就是一条要点，第一行当标题
 *
 * 不做「智能理解」—— 猜错了要用户返工，不如把规则写清让他一眼看懂。
 */
function parseOutline(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!raw) return []

  // ① 显式分隔
  if (/\n\s*(?:-{3,}|={3,})\s*\n/.test(raw)) {
    return splitPages(raw.split(/\n\s*(?:-{3,}|={3,})\s*\n/).map((s) => s.trim()).filter(Boolean).map(blockToPage))
  }
  // ② markdown 标题
  const hasHead = /^\s*#{1,2}\s+\S/m.test(raw)
  if (hasHead) {
    const pages = []
    let cur = null
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*#{1,2}\s+(.*)$/)
      if (m) { if (cur) pages.push(cur); cur = { title: m[1].trim(), bullets: [] } }
      else if (cur) { const s = line.replace(/^\s*[-*·•]\s*/, '').trim(); if (s) cur.bullets.push(s) }
    }
    if (cur) pages.push(cur)
    return splitPages(pages.map((p) => normalizePage(p)))
  }
  // ③ 每行一条：第一行当标题，其余当要点
  const lines = raw.split('\n').map((s) => s.replace(/^\s*[-*·•]\s*/, '').trim()).filter(Boolean)
  if (!lines.length) return []
  if (lines.length === 1) return [normalizePage({ title: lines[0], bullets: [] })]
  return splitPages([normalizePage({ title: lines[0], bullets: lines.slice(1) })])
}

/**
 * 自动分页：一页放不下就拆。
 *
 * 为什么必须有：AI 一次给 20 条要点时，如果全塞进一页，y 从 0.45 挤到 0.86，
 * 行距只剩 0.024 屏高 —— 40px 字带 1.5 行高要 0.031，必然重叠成一坨。
 * 观众看到的是糊在一起的字，不是「要点很多」。宁可多翻几页。
 *
 * 三条拆分依据，按优先级：
 *   ① 显式页码标记：「第 X 页」「Page X」「X.」「一、」
 *   ② 一级要点（无缩进、不以 - 开头）当新页标题
 *   ③ 都没有就按条数等分，每页最多 MAX_PER_PAGE 条
 */
const MAX_PER_PAGE = 6

function splitPages(pages) {
  const out = []
  for (const p of pages) {
    const bs = p.bullets || []
    if (bs.length <= MAX_PER_PAGE) { out.push(p); continue }

    // ① 页码标记
    const marks = []
    bs.forEach((b, i) => { if (/^(?:第\s*[一二三四五六七八九十\d]+\s*[页章节部分]|page\s*\d+|[一二三四五六七八九十]+[、.]|\d+[.、])\s*\S/i.test(b)) marks.push(i) })
    if (marks.length >= 2) {
      const starts = marks.slice(1)
      const cuts = []
      let prev = 0
      for (const m of starts) { cuts.push([prev, m]); prev = m }
      cuts.push([prev, bs.length])
      for (const [a, b] of cuts) {
        const seg = bs.slice(a, b)
        if (!seg.length) continue
        const isMark = /^(?:第\s*[一二三四五六七八九十\d]+\s*[页章节部分]|page\s*\d+|[一二三四五六七八九十]+[、.]|\d+[.、])/i.test(seg[0])
        out.push(normalizePage({
          title: isMark ? seg[0] : p.title,
          bullets: isMark ? seg.slice(1) : seg,
        }))
      }
      continue
    }

    // ② 没标记：第一页留标题，其余按 MAX 切
    let rest = bs.slice()
    let first = true
    while (rest.length) {
      const take = first ? Math.min(MAX_PER_PAGE - 1, rest.length) : Math.min(MAX_PER_PAGE, rest.length)
      const seg = rest.slice(0, take)
      rest = rest.slice(take)
      out.push(normalizePage({ title: first ? p.title : p.title + "（续）", bullets: seg }))
      first = false
    }
  }
  return out
}

function blockToPage(block) {
  // 分隔线切出来的块里，标题行可能还带 markdown 的 # —— 和标题式解析共用一套剥离规则，
  // 否则两种写法混用时页面上会残留一个「#」。
  const lines = block.split('\n')
    .map((s) => s.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*·•]\s*/, '').trim())
    .filter(Boolean)
  if (!lines.length) return null
  return normalizePage({ title: lines[0], bullets: lines.slice(1) })
}

/** 猜页型 + 清理文字。 */
function normalizePage(p) {
  const title = String(p.title || '').trim()
  const bullets = (p.bullets || []).map((s) => String(s || '').trim()).filter(Boolean)
  let kind = String(p.kind || '').trim()
  if (!kind) {
    if (bullets.length >= 1) kind = 'points'
    else if (title.length <= 18 && /^(谢谢|完|结尾|结束|感谢)/.test(title)) kind = 'end'
    else if (title.length <= 24) kind = 'cover'
    else kind = 'quote'
  }
  return { kind, title, bullets, note: String(p.note || '').trim() }
}

/** 逐页配音稿：标题 + 要点连起来念，读起来像人说的话，不是念目录。 */
function scriptOf(page) {
  if (page.note) return page.note
  const t = String(page.title || '').replace(/[：:]$/, '')
  const bs = page.bullets || []
  if (!bs.length) return t
  const join2 = bs.join('；')
  return `${t}。${join2}。`
}

/** 生成一张底图。12KB 一张，比任何模板都快且稳。 */
async function makeBackdrop(th, out) {
  P.ensureDir(dirname(out))
  // gradients 滤镜第一帧就是完整渐变，不用等动画收敛
  const r = await E.run(P.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${th.bg1}:c1=${th.bg2}:x0=0:y0=0:x1=${Math.round(W * 0.7)}:y1=${H}`,
    '-frames:v', '1', out], { timeout: 60_000 })
  if (!r.ok || !fs.existsSync(out)) {
    // 兜底纯色：渐变滤镜在个别构建上不支持时不能整条链断掉
    await E.run(P.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${th.bg1}:s=${W}x${H}`, '-frames:v', '1', out], { timeout: 60_000 })
  }
  return out
}

/** 一页的时长：配音 + 呼吸。太快显得赶，太慢观众走了。 */
function pageSeconds(voiceSec, opts = {}) {
  const pad = Number(opts.pad === undefined ? 0.55 : opts.pad)
  const min = Number(opts.minSec || 1.8)
  const max = Number(opts.maxSec || 14)
  return Math.max(min, Math.min(max, Number(voiceSec || 0) + pad))
}

/**
 * 造一条演示稿时间线。
 *
 * @param {object} o {customer, name, pages[], theme, voice, rate, bgm, withVoice, withCaption}
 * @returns 工程名 + 每页真实秒数 + 配音文件
 */
async function build(o = {}) {
  const customer = String(o.customer || C.currentCustomer())
  const name = String(o.name || '').trim() || `演示稿-${P.stamp()}`
  const th = THEMES[themeKey(o.theme)]
  const pages = (o.pages || []).filter(Boolean)
  if (!pages.length) throw new Error('一页都没有。给一份大纲：每行一条，或每页用 --- 隔开')

  const dir = join(P.HOME, '缓存', '演示稿', name.replace(/[\/\\:\s]/g, '_'))
  P.ensureDir(dir)

  const A = require('./audio')
  const withVoice = o.withVoice !== false
  const rate = parseInt(o.rate || C.settings().voice_rate || 175, 10)

  // ★ 先配音再定时长 —— 顺序反了就是「话没说完画面就切了」
  const items = []
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i]
    const line = scriptOf(pg)
    let voicePath = ''
    let voiceSec = 0
    if (withVoice && line) {
      try {
        const r = await A.tts(line, { voice: o.voice, rate, out: join(dir, `p${i + 1}.wav`) })
        voicePath = r.path
        voiceSec = Number(r.duration) || 0
      } catch (e) {
        // 配音失败不能整片作废 —— 记下来，这一页按文字长度给个保守时长
        items.push({ page: pg, line, error: '配音失败：' + String((e && e.message) || e) })
      }
    }
    const last = items[items.length - 1]
    if (last && last.error && !last.voicePath) { last.voicePath = voicePath; last.voiceSec = voiceSec }
    else items.push({ page: pg, line, voicePath, voiceSec })
  }

  // 定稿时长
  for (const it of items) {
    if (!it.desired) it.desired = pageSeconds(it.voiceSec || estimateSeconds(it.line), o)
  }

  // 造时间线
  const doc = T.blank(name, W, H, 30, 1)
  const bgTrack = T.ensureTrack(doc, 'v1')
  const txTrack = T.ensureTrack(doc, 't1')
  const auTrack = T.ensureTrack(doc, 'a1')

  let t = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const pg = it.page
    const dur = Math.round(it.desired * 100) / 100

    const bgFile = join(dir, `bg-${i + 1}.png`)
    await makeBackdrop(th, bgFile)
    const imp = T.importAsset(name, bgFile)
    const rel = (imp && imp.src) ? imp.src : String(imp)
    bgTrack.clips.push(T.mediaClip({ src: rel, type: 'image', start: t, dur, fit: 'cover' }))

    for (const c of layoutOf(pg, th, t, dur)) txTrack.clips.push(c)

    if (it.voicePath) {
      const vimp = T.importAsset(name, it.voicePath)
      const vrel = (vimp && vimp.src) ? vimp.src : String(vimp)
      auTrack.clips.push(T.mediaClip({ src: vrel, type: 'audio', start: t, dur: Math.min(dur, it.voiceSec || dur), volume: 1 }))
    }
    it.start = t
    it.dur = dur
    t = Math.round((t + dur) * 1000) / 1000
  }

  doc.duration = t
  T.save(name, doc)

  // 配乐（可选）：现场合成铺底，音量压到 -21dB 以下，不能盖过人声
  let bgmPath = ''
  if (o.bgm) {
    try {
      bgmPath = join(dir, 'bgm.m4a')
      await A.makeBgm(bgmPath, Math.max(1, t), { mood: String(o.bgm === true ? '轻快' : o.bgm) })
    } catch (e) { bgmPath = '' }
  }

  C.history('生成演示稿', `${name} · ${items.length} 页 · ${t.toFixed(1)} 秒`)
  return {
    ok: true,
    name,
    path: T.projDir(name),
    dir,
    theme: th.name,
    pages: items.map((x, i) => ({
      n: i + 1, kind: x.page.kind, title: x.page.title, bullets: x.page.bullets,
      line: x.line, start: x.start, dur: x.dur, voiceSec: x.voiceSec,
      voice: x.voicePath ? basename(x.voicePath) : '', error: x.error || '',
    })),
    total: t,
    voice: withVoice,
    bgm: bgmPath ? basename(bgmPath) : '',
    note: items.some((x) => x.error)
      ? '有 ' + items.filter((x) => x.error).length + ' 页配音没合成出来（其余正常），时长按字数保守给的'
      : '',
  }
}

/** 没配音时的兜底：中文口播约每秒 4.9 字（plan.js 里线性拟合出来的常数）。 */
function estimateSeconds(line) {
  const n = String(line || '').replace(/\s/g, '').length
  return Math.max(1.6, 0.5 + n / 4.9)
}

/**
 * 一页的文字排版。
 *
 * 所有位置用「占画面高度的比例」，不用像素 —— 竖屏 1080x1920 和横屏
 * 1920x1080 共用一套规则才改得动。
 */
function layoutOf(pg, th, start, dur) {
  const out = []
  const kind = pg.kind
  const base = { plate: '0', height: H, anim: 'fade' }
  const T1 = (extra) => T.textClip({ ...base, start: start + 0.15, dur: dur - 0.3, ...extra })

  if (kind === 'cover') {
    out.push(T1({ text: pg.title, size: 88, color: th.ink, weight: 700, y: 0.44, lineHeight: 1.25, maxWidth: Math.round(W * 0.78) }))
    if (pg.bullets.length) {
      out.push(T1({ text: pg.bullets.join('\n'), size: 40, color: th.ink2, y: 0.58, lineHeight: 1.6, maxWidth: Math.round(W * 0.74), align: 'center' }))
    }
    // 一条短横线做视觉锚，纯文字页面容易显得空
    out.push(T1({ text: '———', size: 30, color: th.accent, y: 0.515 }))
    return out
  }

  if (kind === 'section') {
    out.push(T1({ text: pg.title, size: 76, color: th.ink, weight: 700, y: 0.48, maxWidth: Math.round(W * 0.8) }))
    if (pg.bullets.length) {
      out.push(T1({ text: pg.bullets.join('\n'), size: 38, color: th.ink2, y: 0.6, lineHeight: 1.55, maxWidth: Math.round(W * 0.78) }))
    }
    return out
  }

  if (kind === 'quote') {
    out.push(T1({ text: pg.title, size: 72, color: th.ink, weight: 600, y: 0.46, lineHeight: 1.5, maxWidth: Math.round(W * 0.8) }))
    if (pg.bullets.length) {
      out.push(T1({ text: pg.bullets.join('\n'), size: 34, color: th.ink2, y: 0.62, lineHeight: 1.6, maxWidth: Math.round(W * 0.74) }))
    }
    return out
  }

  if (kind === 'end') {
    out.push(T1({ text: pg.title, size: 80, color: th.ink, weight: 700, y: 0.47, maxWidth: Math.round(W * 0.8) }))
    if (pg.bullets.length) {
      out.push(T1({ text: pg.bullets.join('\n'), size: 36, color: th.accent, y: 0.59, lineHeight: 1.6, maxWidth: Math.round(W * 0.76) }))
    }
    return out
  }

  // points（默认）：标题在上，要点左对齐往下排
  const bullets = pg.bullets.length ? pg.bullets : []
  out.push(T1({ text: pg.title, size: 68, color: th.ink, weight: 700, y: 0.27, lineHeight: 1.3, maxWidth: Math.round(W * 0.8) }))
  out.push(T1({ text: '———', size: 26, color: th.accent, y: 0.345 }))
  if (bullets.length) {
    // 要点逐条出现，间隔按剩余时长均分 —— 一次全冒出来观众来不及读
    const n = bullets.length
    const span = Math.max(0.6, dur - 0.9)
    const per = span / n
    const size = n <= 3 ? 54 : n <= 5 ? 46 : 40
    // 竖向间距按「可用高度 / 条数」算，不写死 —— 3 条和 7 条要铺满同一块区域
    const top = 0.45
    const bottom = 0.86
    const step = n > 1 ? Math.min(0.11, (bottom - top) / (n - 1)) : 0
    for (let i = 0; i < n; i++) {
      out.push(T.textClip({
        ...base,
        text: '· ' + bullets[i],
        start: Math.round((start + 0.5 + i * per * 0.55) * 1000) / 1000,
        dur: Math.round((dur - 0.5 - i * per * 0.55) * 1000) / 1000,
        size,
        color: th.ink2,
        weight: 400,
        x: 0.5,
        y: Math.round((top + i * step) * 1000) / 1000,
        align: 'left',
        lineHeight: 1.5,
        maxWidth: Math.round(W * 0.74),
        anim: 'up',
      }))
    }
  }
  return out
}

/** 人读的页目录，给 AI 和界面看「到底分了哪些页」。 */
function brief(r) {
  if (!r || !r.pages) return ''
  const rows = r.pages.map((p) => {
    const bs = p.bullets.length ? '：' + p.bullets.join(' / ') : ''
    return `${String(p.n).padStart(2)}. [${p.kind}] ${p.start.toFixed(1)}–${(p.start + p.dur).toFixed(1)}s  ${p.title}${bs}${p.error ? '  ⚠ ' + p.error : ''}`
  })
  return [
    `演示稿「${r.name}」 ${r.pages.length} 页 · ${r.total.toFixed(1)} 秒 · 主题 ${r.theme}`,
    ...rows,
    `工程：${r.path}`,
    r.note ? '⚠ ' + r.note : '',
  ].filter(Boolean).join('\n')
}

module.exports = { THEMES, themeKey, splitPages, normalizePage, MAX_PER_PAGE, parseOutline, scriptOf, estimateSeconds, pageSeconds, makeBackdrop, build, brief, layoutOf }
