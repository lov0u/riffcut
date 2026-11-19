'use strict'
/**
 * 经验库 —— AI 自己进化的地方。
 *
 * 为什么不是「一个 md 文件末尾追加一行」
 * ────────────────────────────────────────
 * 早先是往「导演经验.md」末尾追加，启动时取前 3000 字注入。三个硬伤：
 *  1. 写满 3000 字后**新经验从尾部被切掉** —— 先写进去的留下，最近学到的丢了
 *  2. 没有验证环节。实测 AI 写了 5 条错经验（「本机不支持生成视频」），
 *     系统逐条回「✅ 已写入」，没有一条被拦下
 *  3. 只能追加不能删改，记错了没法自己纠正
 *
 * 现在的模型：
 *  · 一条经验 = 一个文件，落在 <HOME>/配置/经验库/<slug>.md，带 front matter
 *  · 开工时**按当前任务挑相关的几条**注入，而不是无脑塞前 N 字
 *  · 写入即验证：写盘 → 回读 → 确认能按当前任务被选中，否则如实报告
 *  · 有 forget，记错了能自己改
 *
 * 刻意不做：语义检索、调模型、建向量库。经验条目是几百条量级，
 * 关键词命中 + 前缀匹配足够用，而且完全确定性 ——
 * 要的是「它真的会进化」，不是「它看起来会进化」。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')

const EXP_DIRNAME = '经验库'
const INDEX_NAME = '索引.json'

/** 单条字数上限。超了说明它把「一条经验」写成了文章 —— 既选不准又占上下文。 */
const MAX_ONE = 600
/** 一次最多注入几条。多了会把提示词顶爆，相关度也稀释。 */
const MAX_INJECT = 8
/** 每条注入时的截断长度。 */
const MAX_LINE = 220

/**
 * 停用词。中文双/三字切片会把「的、了、用户、需要」这类泛词全提出来，
 * 结果「做画中画和分屏」能命中「add_music 可现场合成配乐」（都含「做/和」）。
 * 这些词对「这条经验和当前任务相关吗」没有任何区分力，必须剔掉。
 */
const STOP = new Set(`
的 了 在 是 和 与 或 及 也 都 就 还 要 会 能 可 以 这 那 有 没 不 为 从 到 对 把 被 让
一个 一些 这个 那个 我们 你们 他们 用户 需要 可以 应该 属于 正常 预期 不是 没有 不能
本机 现在 目前 已经 直接 如果 因为 所以 但是 而且 然后 时候 情况 问题 东西 地方
工具 技能 接口 配置 参数 文件 目录 系统 软件 功能 能力 支持 使用 进行 完成 记录 内容
`.trim().split(/\s+/))

function dir() {
  const d = path.join(P.HOME, '配置', EXP_DIRNAME)
  try { fs.mkdirSync(d, { recursive: true }) } catch {}
  return d
}

const idxPath = () => path.join(dir(), INDEX_NAME)

/**
 * 把一句话变成稳定的文件名。
 *
 * 只留中文、字母、数字，其余折下划线 —— 中文文件名在 macOS 上完全没问题，
 * 而且比拼音/哈希可读得多（出问题时能直接 ls 看出是哪条）。
 * 取前 24 字而不是整句：同一句话反复记要落到同一个 slug 上（这样重复写入
 * 会被识别成「更新」而不是长出新的近似条目）。
 */
function slugify(text) {
  let s = String(text || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '_')
  s = s.replace(/_+/g, '_').replace(/^_|_$/g, '')
  return s ? s.slice(0, 24).replace(/^_|_$/g, '') || '' : ''
}

/** 粗提关键词：中文按 2~3 字切片并去泛词，英文按单词。 */
function keywords(text) {
  const t = String(text || '')
  const kws = new Set()
  for (const w of t.match(/[A-Za-z][A-Za-z0-9_]{1,20}/g) || []) kws.add(w.toLowerCase())
  for (const run of t.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n)
        if (!STOP.has(g)) kws.add(g)
      }
    }
  }
  return [...kws].sort()
}

function readIndex() {
  try { const d = JSON.parse(fs.readFileSync(idxPath(), 'utf8')); return d && typeof d === 'object' ? d : {} } catch { return {} }
}
function writeIndex(d) {
  try { fs.writeFileSync(idxPath(), JSON.stringify(d, null, 2), 'utf8') } catch {}
}
const entryPath = (slug) => path.join(dir(), slug + '.md')
const safeInt = (v, d = 0) => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) ? n : d }

/** 读一条经验。返回 {slug,text,tags,hits,created,updated} 或 null。 */
function parse(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  const meta = {}
  let body = raw
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    body = m[2]
  }
  const text = body.split(/\s+/).filter(Boolean).join(' ').trim()
  if (!text) return null
  return {
    slug: path.basename(file, '.md'),
    text,
    tags: (meta.tags || '').split(/[,，\s]+/).filter(Boolean),
    // front matter 是纯文本，手改过、或某次写入中断都会留脏值；
    // 直接 Number('abc') 是 NaN，会让后面的排序全乱。
    hits: safeInt(meta.hits),
    created: meta.created || '',
    updated: meta.updated || '',
  }
}

function allEntries() {
  return fs.readdirSync(dir()).filter((x) => x.endsWith('.md')).sort()
    .map((x) => parse(path.join(dir(), x))).filter(Boolean)
}

/**
 * 写入前的反自贬检查 —— 这是那次事故的直接产物。
 *
 * AI 写下「本机不支持生成视频 / 不支持调色」，而这两个能力**都存在**。
 * 错的经验会被注入下一轮提示词，它从此真的不再试。所以宁可拦下来让它先查清楚，
 * 也不能让「我做不到」这种句子进库。
 *
 * 不判断对错（判断不了），只要求：说「做不到」时**必须带依据**
 * （工具名 / 文件 / 命令），否则一律拒收并指路让它去查。
 */
function looksWrong(text) {
  const t = String(text || '')
  if (!/(不支持|没有|无法|不能|做不到|不具备|暂无)/.test(t)) return ''
  // 带这些就是「查过了」：工具名、路径、命令、配置项。
  // 长的下划线标识符本身就算证据（transcribe_media / color_looks 这种），
  // 不要求它后面必须跟括号 —— 第一版加了括号要求，把
  // 「片子里没有说话声时，transcribe_media 返回 0 句是正常的」这种真话误判成自贬。
  if (/[a-z][a-z0-9]*_[a-z0-9_]{3,}|\baction=|\/|\.py\b|\.md\b|工具|技能|接口|配置|参数|正常|预期|属于|设计如此/.test(t)) return ''
  return '这条在说「做不到」，但没写你是查了哪里得出的结论。'
    + '上一轮就是这样写下了「本机不支持生成视频 / 不支持调色」，而 generate / color_looks 其实都在 —— '
    + '错的经验会被下一轮自动加载，你以后就真的不去试了。\n'
    + '要么补上依据（哪个工具、哪个文件、哪条命令），要么先调 capabilities 查清楚再写。'
}

/** 粗糙的重合度打分：命中的关键词个数 / 条目关键词总数。 */
function scoreEntry(entry, taskKeywords) {
  const own = keywords(entry.text).concat(entry.tags || [])
  if (!own.length) return 0
  const set = new Set(own)
  let hit = 0
  for (const k of taskKeywords) if (set.has(k)) hit++
  const inText = taskKeywords.some((k) => entry.text.includes(k)) ? 1 : 0
  return hit / Math.max(4, Math.min(12, own.length)) + inText * 0.5
}

/**
 * 按当前任务挑相关的几条经验。
 *
 * `count=false` 时只返回命中的，不做数量截断 —— 写入验证要用它。
 */
function select(task, opts = {}) {
  const taskKw = keywords(task)
  const entries = allEntries()
  if (!entries.length) return []
  const scored = entries.map((e) => ({ e, s: scoreEntry(e, taskKw) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  const picked = opts.count === false ? scored : scored.slice(0, MAX_INJECT)
  // 命中计数落盘（下次排序可以偏向被用过且没被删的）
  if (picked.length) {
    const idx = readIndex()
    for (const { e } of picked) {
      const rec = idx[e.slug] || { keywords: keywords(e.text).slice(0, 40), tags: e.tags }
      rec.hits = safeInt(rec.hits) + 1
      rec.lastUsed = new Date().toISOString().slice(0, 16).replace('T', ' ')
      idx[e.slug] = rec
    }
    writeIndex(idx)
  }
  return picked.map((x) => x.e)
}

/** 拼成注入用的那段文字（开工时塞进提示词）。 */
function injectText(task) {
  const picked = select(task)
  if (!picked.length) return ''
  return '【我记得的事】\n' + picked.map((e) => '- ' + e.text.slice(0, MAX_LINE)).join('\n')
}

/**
 * 写一条经验。
 *
 * ★ 写入即验证：写完立刻按「同一句话」去选，确认它能被选中并注入。
 *   选不中就是没进去 —— 不能像以前那样无脑回 ✅。
 */
function add(text, tags, replaceSlug) {
  const body = String(text || '').split(/\s+/).filter(Boolean).join(' ').trim()
  if (!body) return { ok: false, error: '内容为空' }
  if (body.length > MAX_ONE) {
    return { ok: false, error: `一条经验 ${body.length} 字，超过 ${MAX_ONE} 上限。经验是一句话判断，不是文章；把它拆成几条分别记。` }
  }
  const bad = looksWrong(body)
  if (bad) return { ok: false, error: bad }

  const slug = slugify(replaceSlug || body)
  if (!slug) return { ok: false, error: '这句话提不出可用的文件名，换个说法' }

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const file = entryPath(slug)
  const old = fs.existsSync(file) ? parse(file) : null
  const created = (old && old.created) || now

  const kw = keywords(body)
  const tg = (tags || []).map((x) => String(x).trim()).filter(Boolean)
  const fm = [
    '---',
    `slug: ${slug}`,
    `tags: ${tg.join(',')}`,
    `keywords: ${kw.slice(0, 40).join(',')}`,
    `created: ${created}`,
    `updated: ${now}`,
    `hits: ${safeInt(old && old.hits)}`,
    '---',
    body,
    '',
  ].join('\n')
  try { fs.writeFileSync(file, fm, 'utf8') } catch (e) { return { ok: false, error: '写盘失败：' + e.message } }

  const idx = readIndex()
  idx[slug] = { keywords: kw.slice(0, 40), tags: tg, updated: now, hits: safeInt(old && old.hits) }
  writeIndex(idx)

  // ── 验证：这条现在能不能被选出来 ──
  const back = parse(file)
  if (!back || back.text !== body) return { ok: false, error: '写进去了但回读内容对不上，可能被别的进程覆盖了' }
  const picked = select(body, { count: false })
  const verified = picked.some((e) => e.slug === slug)

  return {
    ok: true,
    slug,
    file,
    verified,
    replaced: !!old,
    total: allEntries().length,
    warning: verified ? '' : '⚠ 写进去了，但按这句话去选**选不中**它 —— 说明关键词提取出了问题，下一轮开工可能不会加载到。换个更具体的说法重记一次。',
  }
}

/** 删掉一条经验。记错了要能自己纠正，不能只能长胖。 */
function forget(slugOrText) {
  const key = String(slugOrText || '').trim()
  if (!key) return { ok: false, error: '要给 slug 或那句话里的关键词' }
  let hit = null
  const direct = entryPath(slugify(key))
  if (fs.existsSync(direct)) hit = direct
  else {
    const cands = allEntries().filter((e) => key.includes(e.slug) === false && (e.text.includes(key) || e.slug.includes(key)))
    const exact = allEntries().filter((e) => e.text.includes(key) || e.slug.includes(key))
    const list = exact.length ? exact : cands
    if (list.length > 1) return { ok: false, error: `命中 ${list.length} 条，说具体一点：${list.slice(0, 6).map((e) => e.slug).join('、')}` }
    if (list.length) hit = entryPath(list[0].slug)
  }
  if (!hit || !fs.existsSync(hit)) return { ok: false, error: '没找到这条经验' }
  const slug = path.basename(hit, '.md')
  const txt = (parse(hit) || {}).text || ''
  try { fs.unlinkSync(hit) } catch (e) { return { ok: false, error: '删不掉：' + e.message } }
  const idx = readIndex()
  delete idx[slug]
  writeIndex(idx)
  return { ok: true, slug, deleted: txt.slice(0, 120), total: allEntries().length }
}

function stats() {
  const list = allEntries()
  return { count: list.length, dir: dir() }
}

module.exports = { MAX_ONE, MAX_INJECT, MAX_LINE, dir, slugify, keywords, parse, allEntries, looksWrong, select, injectText, add, forget, stats }
