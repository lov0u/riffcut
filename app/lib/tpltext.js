// 模板正文文字：给「没声明 data-composition-variables 的模板」也能改字用。
//
// ★ 为什么需要这个模块
//   模板库 210 个 block 里只有 63 个声明了可改项（components 238 个里 184 个），
//   也就是三分之二的模板在剪辑台里点开只看到「这个模板没有可改项，内容是写死的」。
//   用户的原话是「只能改那一个模版吗？换个模版就没法改了啊」。
//   一条条去模板源码里补 data-composition-variables 是不可能的 —— 455 个目录，
//   补完下次模板库更新又回到原点，而且那些模板的作者根本没打算让它可改。
//
// ★ 做法
//   不去改模板源码，也不去求模板配合：直接把模板 HTML 里**看得见的文字节点**
//   扫出来，让用户覆盖原文；覆盖结果写进该片段专属的一份模板副本。
//   特效（GSAP 时间轴、CSS 动画、WebGL）全在 script/style 里，一个字都不碰，
//   所以「只换字不改特效」是天然成立的，不依赖模板自己声明的变量。
//
// ★ 为什么用「副本」而不是运行时替换
//   导出端 HyperFrames 会把子合成**内联展开**（markFlattenedInnerRoot），
//   展开时子合成根节点的 id 会被剥掉、改打 data-hf-inner-root 标记，
//   任何依赖运行时改 DOM 的方案在渲染时都不确定能不能跑到。
//   而「每个片段一份 HTML 副本、文字直接写死在副本里」在预览和导出两端走的是
//   同一份字节，不存在「预览对了成片不对」这种最难查的问题。
const { readFileSync, writeFileSync, existsSync } = require('node:fs')

/* 这些标签的内部不是「给人看的文字」，替换会破坏功能。 */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe',
  'noembed', 'noframes', 'plaintext', 'svg', 'math', 'template'])

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  '#39': "'", '#34': '"', '#38': '&' }

function unesc(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, k) => {
    if (ENT[k] != null) return ENT[k]
    if (k[0] === '#') {
      const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
      if (Number.isFinite(n) && n > 0 && n < 0x110000) { try { return String.fromCodePoint(n) } catch { return m } }
    }
    return m
  })
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 逐个标签扫描，把文档切成「标签」和「标签之间的文字」两类片段。 */
function segments(html) {
  const out = []
  const s = String(html || '')
  let i = 0
  let inRaw = null   // 在 script/style 这类原样文本标签里
  let cursor = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      if (inRaw === null && cursor < s.length) out.push({ kind: 'text', start: cursor, end: s.length, raw: s.slice(cursor) })
      break
    }
    if (lt > cursor && inRaw === null) {
      out.push({ kind: 'text', start: cursor, end: lt, raw: s.slice(cursor, lt) })
    }
    // 注释整段跳过：注释里也有看得见的字，但它不渲染，改了没意义还容易改坏
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4)
      cursor = e < 0 ? s.length : e + 3
      i = cursor
      continue
    }
    const gt = s.indexOf('>', lt)
    if (gt < 0) { cursor = s.length; break }
    const tag = s.slice(lt + 1, gt)
    const closing = tag[0] === '/'
    const name = (tag.replace(/^\//, '').match(/^[a-zA-Z][a-zA-Z0-9:-]*/) || [''])[0].toLowerCase()
    if (!closing && RAW.has(name)) inRaw = name
    else if (closing && inRaw === name) inRaw = null
    cursor = gt + 1
    i = cursor
  }
  return out
}

/* ★ 文字写在 JS 里的模板
   有一批模板（hw-*、yt-*、caption-* 等 37 个）HTML 里一个字都没有，文字是
   JS 里 `text: "..."`、`label: "..."`、`words: ["a","b"]` 这样写进去的。
   只扫 HTML 文字节点的话，这些模板在剪辑台里还是「没有可改项」。
   所以再扫一遍内联 script 里这些**明显是给人看的**键的字符串字面量。
   键名白名单是硬约束：不这么限就会把 url、路径、class 名、ease 曲线一起列出来。 */
const TEXT_KEYS = ['text', 'title', 'caption', 'label', 'headline', 'subline',
  'word', 'words', 'desc', 'description', 'name', 'prompt', 'message', 'tagline',
  'quote', 'sub', 'kicker', 'note', 'author', 'byline', 'cta', 'heading']
const TEXT_KEY_RE = new RegExp(
  '\\b(?:' + TEXT_KEYS.join('|') + ')\\s*:\\s*', 'g')
/* 只认「看起来是句子/短语」的值：含至少一个字母或汉字，且不是路径、URL、颜色、
   单字符、纯数字。这条过滤是给误报兜底的 —— 模板 JS 里 `name: "easeOut"` 这种
   技术字符串不少，放出去用户改了会把动画改坏。 */
function looksLikeCopy(v) {
  const t = String(v).trim()
  if (t.length < 2 || t.length > 200) return false
  if (/^(https?:|assets\/|\.\/|\/|\.\.\/)/.test(t)) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return false
  if (/^[\d.\s%pxems-]+$/.test(t)) return false
  if (/^[a-z][a-zA-Z0-9]*$/.test(t) && !/\s/.test(t)) return false   // 单个驼峰/短标识符
  return /[\p{L}]/u.test(t)
}

/** 在 HTML 里找出所有内联 script 的区间。 */
function scriptRanges(html) {
  const out = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue          // 外链脚本，没正文
    if (!m[2].trim()) continue
    out.push({ start: m.index + m[0].indexOf('>') + 1, end: m.index + m[0].length - '</script>'.length })
  }
  return out
}

/** 扫内联 script 里文字类键的字符串字面量，返回绝对位置。 */
function jsItems(html) {
  const items = []
  for (const r of scriptRanges(html)) {
    const body = html.slice(r.start, r.end)
    TEXT_KEY_RE.lastIndex = 0
    let m
    while ((m = TEXT_KEY_RE.exec(body))) {
      let i = m.index + m[0].length
      // 值是数组：words: ["a", "b"] —— 每个元素单独一条，用户能一句一句改
      if (body[i] === '[') {
        let j = i + 1
        while (j < body.length && body[j] !== ']') {
          const q = body[j]
          if (q === '"' || q === "'" || q === '`') {
            let k = j + 1
            let val = ''
            while (k < body.length) {
              const ch = body[k]
              if (ch === '\\') { val += body[k + 1] || ''; k += 2; continue }
              if (ch === q) break
              val += ch; k++
            }
            if (looksLikeCopy(val)) {
              items.push({ mode: 'jslit', quote: q, start: r.start + j + 1, end: r.start + k, text: val })
            }
            j = k + 1
            continue
          }
          j++
        }
        continue
      }
      // 值是单个字符串
      const q = body[i]
      if (q !== '"' && q !== "'" && q !== '`') continue
      let k = i + 1
      let val = ''
      while (k < body.length) {
        const ch = body[k]
        if (ch === '\\') { val += body[k + 1] || ''; k += 2; continue }
        if (ch === q) break
        val += ch; k++
      }
      if (looksLikeCopy(val)) {
        items.push({ mode: 'jslit', quote: q, start: r.start + i + 1, end: r.start + k, text: val })
      }
    }
  }
  return items
}

/**
 * 扫出模板里「看得见的文字」。
 * 返回 [{ key, text, tag, index }]，key 形如 t0/t1…（按文档顺序，重新扫描稳定）。
 * 只有纯空白、纯数字符号装饰的段会被跳过 —— 那些改了也没意义。
 */
function scan(html) {
  return items(html).map((it, i) => ({
    key: it.key, text: it.text, index: it.start, len: it.end - it.start,
    src: it.mode === 'jslit' ? 'js' : 'html',
  }))
}

/**
 * 统一的「可改文字项」列表，HTML 文字节点与 JS 字面量按文档位置合并排序。
 * key 规则：HTML 文字 t0/t1…、JS 字面量 j0/j1…
 * ★ key 必须只依赖**出现顺序**，不能依赖文字内容 —— 用户改了字以后还要能
 *   用同一个 key 再改一次，否则第二次点同一句话就会匹配不上（表现为没反应）。
 */
function items(html) {
  const out = []
  let n = 0
  for (const g of segments(html)) {
    const txt = unesc(g.raw).replace(/\s+/g, ' ').trim()
    if (!txt) continue
    out.push({ key: 't' + n, mode: 'htmltext', start: g.start, end: g.end, text: txt })
    n++
  }
  let j = 0
  for (const it of jsItems(html)) {
    it.key = 'j' + j
    out.push(it)
    j++
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

function scanFile(file) {
  try { return scan(readFileSync(file, 'utf8')) } catch { return [] }
}

/**
 * 用 edits（{t3:'新文字'}）覆盖文字，返回新 HTML 字符串。
 * 只改文字段的**内容**，前后空白保留（否则 inline 元素之间的空格会塌，排版会变）。
 */
function apply(html, edits) {
  if (!edits || !Object.keys(edits).length) return html
  const list = items(html)
  let out = ''
  let prev = 0
  let changed = false
  for (const it of list) {
    const nv = edits[it.key]
    if (nv == null) continue
    if (it.start < prev) continue          // 区间重叠，跳过（正常不会发生）
    if (it.mode === 'jslit') {
      /* JS 字面量：引号里的内容直接替换，引号本身和转义要守住。
         不做 HTML 转义 —— 这里不是 HTML 上下文，转了会把 & 写成 &amp;。 */
      const v = String(nv).replace(/\\/g, '\\\\').split(it.quote).join('\\' + it.quote)
      out += html.slice(prev, it.start) + v
      prev = it.end
      changed = true
    } else {
      /* HTML 文字：只换内容，前后空白保留，否则 inline 元素之间的空格会塌。 */
      const raw = html.slice(it.start, it.end)
      const lead = (raw.match(/^\s*/) || [''])[0]
      const tail = (raw.match(/\s*$/) || [''])[0]
      out += html.slice(prev, it.start) + lead + esc(String(nv)) + tail
      prev = it.end
      changed = true
    }
  }
  out += html.slice(prev)
  return changed ? out : html
}

/** 读源模板 → 覆盖文字 → 写到目的一份副本。 */
/* ★ 副本落地时必须一起做「离线化」：把模板里写死的 CDN 地址换成工程内的
   本地副本（详见 vendorize.js 顶部那段）。这一支覆盖「按原文改字」的副本，
   漏掉它就会出现「原模板离线了、改过字的那份还在联网」这种半离线状态 ——
   断网时同一时间线里有的片段有动画、有的没有，最难查。 */
function writeCopy(srcFile, dstFile, edits) {
  const html = readFileSync(srcFile, 'utf8')
  const next = apply(html, edits)
  let out = next
  try {
    const V = require('./vendorize')
    const projRoot = projectRootOf(dstFile)
    if (projRoot) out = V.vendorizeText(next, projRoot).html
  } catch { /* 离线化失败不该让改字整体失败：至少把改字结果写进去 */ }
  writeFileSync(dstFile, out, 'utf8')
  return next !== html
}

/* 从 compositions/xxx.html 往上找到工程根。
   dstFile 可能是 compositions/<名>.html，也可能在更深一层，所以按『compositions』
   这个目录名往上剥，剥不到就返回 null（调用方当无需离线化处理）。 */
function projectRootOf(dstFile) {
  let d = require('node:path').dirname(dstFile)
  for (let i = 0; i < 6; i++) {
    if (require('node:path').basename(d) === 'compositions') return require('node:path').dirname(d)
    const up = require('node:path').dirname(d)
    if (up === d) break
    d = up
  }
  // 本身就是 compositions 目录下第一层的情况
  if (require('node:path').basename(d) === 'compositions') return require('node:path').dirname(d)
  return null
}

/**
 * 把模板的时长改成 sec 秒，返回新 HTML。
 *
 * ★ 这一步是「模板能不能铺满整段」的总开关。
 *   HyperFrames 编译子合成时是这样定时长的（app/node_modules/hyperframes/dist/
 *   chunk-JGKI7FHX.js:14391）：
 *       const sceneDuration = sceneRoot?.getAttribute("data-duration")
 *                           ?? host.getAttribute("data-duration");
 *   也就是**模板自己的 data-duration 优先**。我们装模板时只写了时间线片段的
 *   dur（写到父文档那个 div 的 data-duration），从没改过模板 HTML，
 *   于是把片段拉到 60 秒也没用：模板拿自己的 5 秒，5 秒演完就停在最后一帧，
 *   后面 55 秒是死的。用户说「我 1 分钟的视频要知道用这个模板延长内容」，
 *   不修这条，任何延长都是空谈。
 *
 * ★ 只改根节点（带 data-composition-id 的那个）的 data-duration，以及
 *   子元素里「跟根节点同值的 data-duration」——模板把 data-duration 复制到
 *   canvas / 内部轨道上是常见写法（glass-hero 的 #gh-canvas 就是这样），
 *   只改根节点会让两者不一致。
 *   不碰 script 里的 duration 变量：那是模板自己的动画节奏，改了会变味。
 */
function setDuration(html, sec) {
  const v = Number(sec)
  if (!Number.isFinite(v) || v <= 0) return html
  const s = String(Math.round(v * 1000) / 1000)
  /* 找根节点那一段标签，读出它原来的 data-duration，再把同值的地方一起换掉。 */
  const rootTag = html.match(/<[a-zA-Z][^>]*data-composition-id\s*=\s*["'][^"']*["'][^>]*>/)
  if (!rootTag) return html
  const oldM = rootTag[0].match(/data-duration\s*=\s*["']([^"']*)["']/)
  const oldVal = oldM ? oldM[1] : null

  let out = html
  // 1) 根节点
  out = replaceDurationInTag(out, rootTag[0], s)
  // 2) 其它元素上与根节点同值的 data-duration（模板常把时长复制给内层 canvas）
  if (oldVal != null && oldVal !== '') {
    const esc1 = oldVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(<[a-zA-Z][^>]*?)\\sdata-duration\\s*=\\s*["\']' + esc1 + '["\']', 'g')
    out = out.replace(re, (m, head) => {
      if (/data-composition-id/.test(head)) return m   // 根节点已经处理过
      return head + ' data-duration="' + s + '"'
    })
  }
  return out
}

/** 把一个标签串里的 data-duration 换成 v（没有就补一个）。 */
function replaceDurationInTag(html, tag, v) {
  if (/data-duration\s*=\s*["'][^"']*["']/.test(tag)) {
    const fixed = tag.replace(/data-duration\s*=\s*["'][^"']*["']/, 'data-duration="' + v + '"')
    return html.replace(tag, fixed)
  }
  const fixed = tag.replace(/>$/, ' data-duration="' + v + '">')
  return html.replace(tag, fixed)
}

/** 读源模板 → 覆盖文字 + 改时长 → 写副本。同时有文字和时长需求时用它。 */
function writeCopyFull(srcFile, dstFile, edits, dur) {
  const html = readFileSync(srcFile, 'utf8')
  let next = apply(html, edits)
  if (dur != null) next = setDuration(next, dur)
  /* 同 writeCopy：改时长/改字的副本也要离线化，理由见那边注释。 */
  try {
    const V = require('./vendorize')
    const projRoot = projectRootOf(dstFile)
    if (projRoot) next = V.vendorizeText(next, projRoot).html
  } catch { /* 离线化失败不该让副本整体失败 */ }
  writeFileSync(dstFile, next, 'utf8')
  return next !== html
}

/** 只改时长（不动文字）：原地改一个已存在的模板副本。 */
function patchDuration(file, dur) {
  try {
    const html = readFileSync(file, 'utf8')
    const next = setDuration(html, dur)
    if (next === html) return false
    writeFileSync(file, next, 'utf8')
    return true
  } catch { return false }
}

module.exports = { scan, scanFile, apply, writeCopy, segments, items, jsItems, unesc, esc,
  setDuration, writeCopyFull, patchDuration }
