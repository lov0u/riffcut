'use strict'
/**
 * 对话记录 —— 直接读 DSH 内核的会话，不再自己造一套存储。
 *
 * 为什么：内核自带完整的会话持久化（`<HOME>/sessions/<cwd 转义>/<sessionId>/session.v4.jsonl.zstd`），
 * 里面已经记了每一轮用户说了什么、AI 回了什么、调了哪些工具。旧版自己
 * 在 配置/对话.json 里维护一份，结果是两套记录互相打架 —— 界面上看到的
 * 和内核实际跑的不是同一件事。
 *
 * 格式：每行一条 JSON 事件，第一行是 `{type:"session", version:4, id, cwd, createdAt}`，
 * 后面全是 `{type, seq, time, data}`。真正有内容的是这几类：
 *   user/message      → data.content（用户说的话）
 *   assistant/message → data.content（AI 的回答）
 *   turn/start|end    → 一轮的边界
 *   model/selection   → 当时用的是哪个模型
 * 文件是 zstd 压缩的，Node 26 自带 zstdDecompressSync，不用外部依赖。
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const P = require('./paths')

const SESSIONS = path.join(P.HOME, 'sessions')

/** 内核把 cwd 里的 `/` 换成 `-` 再加前后 `--` 当目录名。 */
function cwdKey(cwd) {
  return '--' + String(cwd || '').replace(/\//g, '-') + '--'
}

function readEvents(file) {
  let raw
  try { raw = fs.readFileSync(file) } catch { return [] }
  let text
  if (/\.zstd$/i.test(file)) {
    try { text = zlib.zstdDecompressSync(raw).toString('utf8') } catch { return [] }
  } else text = raw.toString('utf8')
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch {}
  }
  return out
}

/** 从一串事件里抽出：标题、时间、消息条数、模型、工具调用数。 */
function summarize(events, meta) {
  const head = events.find((e) => e.type === 'session') || {}
  let userCount = 0, aiCount = 0, toolCount = 0
  let title = '', firstAt = 0, lastAt = 0, model = ''
  const models = new Set()
  for (const e of events) {
    const t = Number(e.time) || 0
    if (t) { if (!firstAt || t < firstAt) firstAt = t; if (t > lastAt) lastAt = t }
    if (e.type === 'model/selection' && e.data) {
      models.add(`${e.data.provider}/${e.data.model}`)
      model = `${e.data.provider}/${e.data.model}`
    }
    if (!e.data) continue
    if (e.type === 'user/message') {
      const c0 = contentText(e.data.content)
      if (isInjectedContext(c0)) continue   // 内核注入的运行时上下文，不算用户发的话
      const c = stripInjected(c0)
      userCount++
      if (c && !title) title = c.slice(0, 60)
    } else if (e.type === 'assistant/message') {
      aiCount++
    } else if (/^tool\//.test(e.type) && /result/.test(e.type)) {
      toolCount++
    }
  }
  return {
    id: head.id || meta.id,
    title: title || meta.title || '（还没有对话内容）',
    cwd: head.cwd || meta.cwd || '',
    created: head.createdAt || firstAt || meta.mtime || 0,
    updated: lastAt || meta.mtime || 0,
    messages: userCount + aiCount,
    userTurns: userCount,
    aiTurns: aiCount,
    tools: toolCount,
    model,
    models: [...models],
    size: meta.size || 0,
    file: meta.file,
  }
}

/**
 * 内核每轮会把「当前运行时上下文」当成一条 user 消息插进会话里，
 * 内容是 `Current runtime context. This snapshot supersedes ...` 那种。
 * 它出现在会话里是对的（内核要靠它），但界面上把它当用户说的话显示出来，
 * 用户会以为自己在什么时候打过这么一大段 —— 所以显示层要挡掉。
 *
 * 判据用开头那句英文字：内核换了措辞就会失效，所以再加一条
 * 「长度超过 400 且没有中文」兜底（真用户不会这么打字）。
 */
function isInjectedContext(text) {
  const t = String(text || '')
  // 内核每轮注入的运行时上下文，开头固定是这句英文
  if (/^Current runtime context/i.test(t)) return true
  if (/^Current (working directory|DSH file policy)/i.test(t)) return true
  // 兜底：又长又全英文的，真用户不会这么打字
  if (t.length > 400 && !/[\u4e00-\u9fa5]/.test(t)) return true
  return false
}

/**
 * 内核还会把「本轮已启用能力」清单拼在用户消息前面，形如
 * 
 * 这是给模型看的授权说明，不是用户打的字 —— 显示前把这层皮剥掉，
 * 否则会话列表标题全变成同一段能力清单，一条都认不出来。
 */
function stripInjected(text) {
  let t = String(text || "")
  // 只有出现在最开头才剥；中途出现的方括号内容可能是用户自己写的
  const m = t.match(/^【本轮已启用能力：[\s\S]*?】\s*\n?\s*/)
  if (m) t = t.slice(m[0].length)
  return t.trim()
}
/** content 可能是字符串、也可能是 [{type:'text',text}] 的分块数组。 */
function contentText(c) {
  if (!c) return ''
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    // ★ 只取 type==='text' 的块。数组里还混着 reasoning（模型思考过程，英文几十行）
    //   和 tool-call，一起拼进来会让人以为软件在说胡话。没有 type 字段的老数据
    //   才退回按 text 字段取。
    return c
      .filter((b) => typeof b === 'string' || !b || !b.type || b.type === 'text')
      .map((b) => (typeof b === 'string' ? b : (b && (b.text || b.content)) || ''))
      .join(' ')
      .trim()
  }
  if (typeof c === 'object') return String(c.text || c.content || '').trim()
  return ''
}

/** 列出全部会话（按最近活跃排序）。scope=all 时包含所有工作区。 */
function list(opts = {}) {
  const out = []
  if (!fs.existsSync(SESSIONS)) return out
  const wantKey = opts.cwd ? cwdKey(opts.cwd) : ''
  for (const dirName of fs.readdirSync(SESSIONS)) {
    if (!dirName.startsWith('--')) continue
    if (wantKey && dirName !== wantKey) continue
    const dir = path.join(SESSIONS, dirName)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const sid of fs.readdirSync(dir)) {
      const sdir = path.join(dir, sid)
      if (!fs.statSync(sdir).isDirectory()) continue
      // 优先读最高版本
      const cands = fs.readdirSync(sdir).filter((x) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(x))
      if (!cands.length) continue
      cands.sort((a, b) => Number(b.match(/v(\d+)/)[1]) - Number(a.match(/v(\d+)/)[1]))
      const file = path.join(sdir, cands[0])
      const st = fs.statSync(file)
      const events = readEvents(file)
      out.push(summarize(events, { id: sid, file, size: st.size, mtime: Math.round(st.mtimeMs) }))
    }
  }
  out.sort((a, b) => b.updated - a.updated)
  return out
}

/** 读一条会话的完整对话（只保留人说的话和 AI 的回答，工具调用折叠成一行）。 */
function detail(id) {
  const all = list()
  const one = all.find((x) => x.id === id || x.id.includes(id))
  if (!one) return { ok: false, error: '找不到这个对话：' + id }
  const events = readEvents(one.file)
  const msgs = []
  for (const e of events) {
    if (!e.data) continue
    if (e.type === 'user/message') {
      const t = contentText(e.data.content)
      if (t && !isInjectedContext(t)) msgs.push({ who: '用户', text: stripInjected(t), at: e.time })
    } else if (e.type === 'assistant/message') {
      // ★ 只取 type==='text' 的块。content 里还混着 reasoning（模型思考过程，
      //   英文、几十行），一起拼进来会让人以为软件在说胡话。
      const t = contentText(e.data.content)
      if (t) msgs.push({ who: 'AI', text: t, at: e.time })
    } else if (e.type === 'tool/call' || e.type === 'tool/result') {
      const name = e.data.name || e.data.tool || ''
      if (name && e.type === 'tool/call') msgs.push({ who: '工具', text: name, at: e.time })
    }
  }
  return { ok: true, ...one, messages_list: msgs }
}

/** 拼成人读的清单。 */
function listText(opts = {}) {
  const items = list(opts)
  if (!items.length) return '还没有任何对话记录。内核跑起来之后会自动记。'
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }).slice(0, 16) : '—')
  const L = [`【对话记录】共 ${items.length} 条（直接读内核会话，不是另存一份）`, '']
  for (const x of items.slice(0, 40)) {
    L.push(`- ${x.title}`)
    L.push(`  ${fmt(x.updated)} · ${x.userTurns} 轮 · ${x.tools} 次工具 · ${x.model || '未记模型'} · ${(x.size / 1024).toFixed(0)}KB`)
    L.push(`  id: ${x.id}`)
  }
  if (items.length > 40) L.push(`…还有 ${items.length - 40} 条`)
  return L.join('\n')
}

function detailText(id) {
  const d = detail(id)
  if (!d.ok) return '❌ ' + d.error
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }).slice(0, 16) : '—')
  const L = [`【${d.title}】`, `${fmt(d.created)} → ${fmt(d.updated)} · ${d.messages} 条 · 模型 ${d.models.join(' / ') || '未记'}`, '']
  for (const m of d.messages_list) {
    const tag = m.who === '用户' ? '你' : m.who === 'AI' ? 'AI' : '·'
    L.push(`${tag} ${String(m.text).slice(0, 600)}`)
    L.push('')
  }
  return L.join('\n')
}

module.exports = { SESSIONS, cwdKey, readEvents, summarize, contentText, isInjectedContext, stripInjected, list, detail, listText, detailText }
