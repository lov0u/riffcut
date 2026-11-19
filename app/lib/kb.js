'use strict'
/**
 * 知识库 —— 软件自己的记忆，跟工作台知识库同一套思路但更轻。
 *
 * 一条 = 一个 md 文件，落在 <HOME>/知识库/notes/<分类>/KB-NNN-标题.md，
 * 带 front matter（id / title / category / tags / updated / source）。
 * INDEX.md 由程序重建，**不要手改**（手改的内容下次生成会丢）。
 *
 * 为什么要有：经验库存的是「一句话判断」，一条经验只该是一两行；
 * 知识库存的是「有结构的一篇」，带怎么做、怎么验证。两种东西混在一个库里，
 * 会互相污染 —— 经验被写成文章就选不准，知识被压成一句话就丢了步骤。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')

const KB = path.join(P.HOME, '知识库')
const NOTES = path.join(KB, 'notes')
const INDEX = path.join(KB, 'INDEX.md')
const CATS = ['01-客户偏好', '02-项目经验', '03-剪辑技法', '04-素材与素材库', '05-品牌与模板', '06-软件问题排查']

const FM = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/

function files() {
  if (!fs.existsSync(NOTES)) return []
  const out = []
  const walk = (d) => {
    for (const x of fs.readdirSync(d).sort()) {
      const full = path.join(d, x)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (/^KB-.*\.md$/.test(x)) out.push(full)
    }
  }
  walk(NOTES)
  return out.sort()
}

function parse(file) {
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return null }
  const fm = {}
  let body = txt
  const m = txt.match(FM)
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    body = m[2]
  }
  const tags = (fm.tags || '').replace(/^\[|\]$/g, '')
  return {
    id: fm.id || path.basename(file).split('-').slice(0, 2).join('-'),
    title: fm.title || path.basename(file, '.md'),
    category: fm.category || path.basename(path.dirname(file)),
    tags: tags.split(',').map((x) => x.trim()).filter(Boolean),
    updated: fm.updated || '',
    source: fm.source || '',
    body: body.trim(),
    path: file,
    rel: path.relative(KB, file).split(path.sep).join('/'),
  }
}

const list = () => files().map(parse).filter(Boolean)

function nextId() {
  let mx = 0
  for (const d of list()) {
    const m = String(d.id || '').match(/KB-(\d+)/)
    if (m) mx = Math.max(mx, parseInt(m[1], 10))
  }
  return 'KB-' + String(mx + 1).padStart(3, '0')
}

/**
 * 新增一条。标题高度相似时自动改成更新，避免重复条目。
 *
 * 为什么必须查重：同一个坑排两次，AI 每次都会「学到」一遍，标题只差几个字，
 * 半年后库里有六篇讲同一件事的东西，互相之间还有细微矛盾。
 */
function add(opts = {}) {
  const title = String(opts.title || '').trim()
  const body = String(opts.body || '').trim()
  if (!title) return { ok: false, error: '知识库条目要有标题' }
  if (!body) return { ok: false, error: '知识库条目要有正文' }
  let cat = String(opts.category || '02-项目经验').trim()
  if (!CATS.includes(cat)) cat = CATS.find((c) => c.includes(cat) || cat.includes(c)) || '02-项目经验'
  let tags = opts.tags
  if (typeof tags === 'string') tags = tags.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean)
  tags = (tags || []).map(String).slice(0, 5)

  const norm = (s) => String(s || '').replace(/[^\w\u4e00-\u9fa5]/g, '').toLowerCase()
  const nt = norm(title)
  let dup = null
  for (const d of list()) {
    const nd = norm(d.title)
    if (!nd) continue
    if (nd === nt || (nt.length > 6 && (nd.includes(nt) || nt.includes(nd)))) { dup = d; break }
  }

  let id, file
  if (dup) {
    id = dup.id
    file = dup.path
    tags = [...new Set([...(dup.tags || []), ...tags])].slice(0, 5)
  } else {
    id = nextId()
    const safe = title.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || '条目'
    file = path.join(NOTES, cat, `${id}-${safe}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }

  const head = ['---', `id: ${id}`, `title: ${title}`, `category: ${cat}`, `tags: [${tags.join(', ')}]`,
    `updated: ${new Date().toISOString().slice(0, 10)}`, `source: ${opts.source || 'AI'}`]
  if (opts.customer) head.push(`customer: ${opts.customer}`)
  head.push('---')
  fs.writeFileSync(file, head.join('\n') + '\n\n' + body + '\n', 'utf8')
  buildIndex()
  return { ok: true, id, title, category: cat, updated: !!dup, file }
}

/** 重建 INDEX.md：最近更新 + 分类表 + 标签反查。 */
function buildIndex() {
  const items = list()
  fs.mkdirSync(KB, { recursive: true })
  const tagsMap = new Map()
  for (const d of items) for (const t of d.tags) {
    if (!tagsMap.has(t)) tagsMap.set(t, [])
    tagsMap.get(t).push(d.id)
  }
  const byCat = new Map()
  for (const d of items) {
    if (!byCat.has(d.category)) byCat.set(d.category, [])
    byCat.get(d.category).push(d)
  }
  const L = ['# 知识库索引', '', '> 这个文件由程序自动重建，**不要手改**（手改的内容下次生成会丢）。', '', `共 ${items.length} 条。`, '']
  L.push('## 按分类', '')
  for (const c of CATS) {
    const arr = byCat.get(c) || []
    L.push(`### ${c}（${arr.length}）`, '')
    if (!arr.length) L.push('（空）', '')
    for (const d of arr) L.push(`- **${d.id}** ${d.title}${d.tags.length ? `  \`${d.tags.join('` `')}\`` : ''}`)
    L.push('')
  }
  const recent = [...items].sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 15)
  if (recent.length) {
    L.push('## 最近更新', '')
    for (const d of recent) L.push(`- ${d.updated || '—'}  ${d.id} ${d.title}`)
    L.push('')
  }
  if (tagsMap.size) {
    L.push('## 按标签', '')
    for (const [t, ids] of [...tagsMap.entries()].sort()) L.push(`- \`${t}\` → ${ids.join(' ')}`)
    L.push('')
  }
  fs.writeFileSync(INDEX, L.join('\n'), 'utf8')
  return { ok: true, count: items.length }
}

/**
 * 搜索。纯关键词计数 + 整串命中加权 —— 不调模型、不建索引。
 *
 * 条目是几十到几百条量级，直接扫全文就够了；上向量库是为了解决
 * 「几万条语义相似」的问题，这里没有那个问题。
 */
function search(query, limit = 8) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: '要给 query' }
  const lim = Math.max(1, Math.min(30, Number(limit) || 8))
  const words = q.split(/[\s,，、]+/).filter(Boolean)
  const scored = []
  for (const d of list()) {
    const hay = (d.title + ' ' + d.tags.join(' ') + ' ' + d.body).toLowerCase()
    let s = 0
    for (const w of words) s += hay.split(w.toLowerCase()).length - 1
    if (hay.includes(q.toLowerCase())) s += 5
    if (s) scored.push({ s, d })
  }
  scored.sort((a, b) => b.s - a.s)
  return { ok: true, query: q, hits: scored.slice(0, lim), total: scored.length }
}

function searchText(query, limit) {
  const r = search(query, limit)
  if (!r.ok) return '❌ ' + r.error
  if (!r.hits.length) return `知识库里没找到「${r.query}」。可以把它当新知识记下来（note）。`
  const L = [`找到 ${Math.min(r.total, r.hits.length)} 条（相关度排序）：`]
  for (const { d } of r.hits) {
    L.push(`- ${d.id} ${d.title}  [${d.category}]  ${d.body.slice(0, 80).replace(/\s+/g, ' ')}\n  路径：${d.path}`)
  }
  L.push('', '读全文就对上面给的「路径」用 read，别自己拼文件名。')
  return L.join('\n')
}

module.exports = { KB, NOTES, INDEX, CATS, files, parse, list, nextId, add, buildIndex, search, searchText }
