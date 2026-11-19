'use strict'
/**
 * 后台工位（worker）—— 主对话的「分包工」。
 *
 * 为什么要有这一层
 * ────────────────
 * 内核的 `session/wait` 是**按会话**阻塞的，而一路对话把活全干完（搜文案 →
 * 写分镜 → 渲片，动辄几分钟），主对话就一直被占着：用户想中途改一句意见，
 * 只能等它跑完，或者把整轮打断重来。
 *
 * 所以这里给每件长活单开一条内核会话（自己的 sessionId），丢进去自己跑。
 * 主会话只负责「听懂 → 拆活 → 派给谁 → 收结果 → 跟你汇报」，永远秒回。
 * 你在前面接着说、加意见、改需求，后面几个工位照旧干自己的，互不踩。
 *
 * 边界（如实写清，不假装）
 * ────────────────────────
 * · 内核的 SDK 通道只暴露 prompt / resume / wait，**没有取消**。所以「停」只能
 *   做界面层的止损：标记停止、不再跟踪它的输出。那一轮内核自己会收尾，
 *   不会真的被杀掉 —— 这一点不糊弄用户。
 * · 工位是进程内记账，重启就没了（跟 agents.js 同一个理由：不落假记录）。
 */
const MAX = 24

const BOOK = new Map() // id -> rec
const ORDER = []       // 创建顺序，用于上限淘汰
let seq = 0

function nid() { return 'w' + Date.now().toString(36) + '-' + (++seq) }

/** 内核事件 → 一行能看懂的动作记录（口径跟 kernelchat.stepOf 保持一致） */
function stepOf(ev) {
  if (!ev || !ev.type) return null
  const nm = (d) => String((d && (d.name || d.tool)) || '').replace(/^mcp__velora-video__/, '')
  /* ★ 内核实际发 `tool/call`（斜杠）。以前只认 `tool-call`（连字符），
     于是后台工位的动作记录一条都收不到，界面上永远显示「还没开始」——
     哪怕 AI 已经在跑十几个工具了。两种写法都认。 */
  const t = String(ev.type)
  if (t === 'tool/call' || t === 'tool-call' || t === 'tool/start') {
    let dt = (ev.data && (ev.data.arguments || ev.data.args)) || {}
    if (typeof dt === 'string') { try { dt = JSON.parse(dt) } catch (e) { dt = {} } }
    /* 用中文说法，别把 web_search / stock_search 这种裸工具名甩给用户 */
    let cn = ''
    try { cn = require('./kernelchat').TOOL_CN[nm(ev.data)] || '' } catch (e) {}
    const hint = String(dt.query || dt.q || dt.prompt || dt.text || dt.project || dt.path || '').slice(0, 42)
    return { ok: true, what: cn || nm(ev.data) || '工具', hint, detail: hint }
  }
  if (t === 'tool/result') {
    const ok = !(ev.data && ev.data.isError)
    return { ok, what: ok ? '完成' : '失败', detail: String((ev.data && ev.data.text) || '').slice(0, 160) }
  }
  return null
}

function textOf(ev) {
  try {
    const Turn = require('./turn')
    return Turn.textOf(ev && ev.data && ev.data.message) || ''
  } catch { return '' }
}

/** 淘汰：只扔已经结束的老工位，在跑的一个都不动 */
function trim() {
  while (ORDER.length > MAX) {
    const id = ORDER.find((x) => { const r = BOOK.get(x); return r && r.ended })
    if (!id) break
    BOOK.delete(id)
    ORDER.splice(ORDER.indexOf(id), 1)
  }
}

function view(r, full) {
  const v = {
    id: r.id, title: r.title, kind: r.kind, status: r.status,
    started: r.started, ended: r.ended, last: r.last,
    stepCount: r.steps.length, error: r.error || '',
    text: full ? r.text : String(r.text || '').slice(-400),
    project: r.project || '',
  }
  if (full) v.steps = r.steps.slice(-40)
  return v
}

/**
 * 派一件活给新工位。
 * @param {{title?:string, brief:string, kind?:string, project?:string}} job
 *   brief 是这一路的完整交代 —— 工位之间不共享上下文，少一句它就得多问你一次。
 */
function spawn(job = {}) {
  const brief = String(job.brief || '').trim()
  if (!brief) throw new Error('工位没有任务描述（brief）—— 派活必须写清楚要它干什么')
  const id = nid()
  const sid = 'velora-w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
  const rec = {
    id, sid,
    title: String(job.title || brief.slice(0, 24) || '后台任务').slice(0, 60),
    kind: String(job.kind || '通用').slice(0, 16),
    brief,
    project: String(job.project || ''),
    status: 'running',
    steps: [],
    last: '已派工，正在理解任务…',
    text: '',
    started: Date.now(),
    ended: 0,
    error: '',
    stopped: false,
  }
  BOOK.set(id, rec)
  ORDER.push(id)
  trim()
  run(rec).catch((e) => { rec.status = 'failed'; rec.error = String((e && e.message) || e); rec.ended = Date.now() })
  return view(rec, true)
}

/** 一个工位的一次「跑到底」。中途追加意见走 say()，不重开这个函数。 */
async function run(rec) {
  const KC = require('./kernelchat')
  let k
  try { k = await KC.kernel() } catch (e) {
    rec.status = 'failed'; rec.error = '内核没起来：' + String((e && e.message) || e); rec.ended = Date.now()
    return
  }
  const onEv = (sessionId, ev) => {
    if (sessionId !== rec.sid) return
    const s = stepOf(ev)
    if (s) {
      rec.steps.push(s)
      if (rec.steps.length > 80) rec.steps.shift()
      rec.last = s.what + (s.detail ? ' · ' + s.detail : '')
    }
    if (ev && ev.type === 'assistant/message') {
      const t = textOf(ev)
      if (t) { rec.text += (rec.text ? '\n' : '') + t; rec.last = t.replace(/\s+/g, ' ').slice(0, 60) }
    }
  }
  k.on('event', onEv)
  try {
    await k.prompt(rec.sid, rec.brief)
    await k.wait(rec.sid, 30 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 500))
    rec.status = rec.stopped ? 'stopped' : 'done'
  } catch (e) {
    if (rec.stopped) rec.status = 'stopped'
    else { rec.status = 'failed'; rec.error = String((e && e.message) || e) }
  } finally {
    rec.ended = Date.now()
    try { k.removeListener('event', onEv) } catch (e) { /* 不同 sid 会自己跳过 */ }
  }
}

/**
 * 给某个工位补一句意见。它接着自己那条会话往下干，不打断前面的活。
 * 已经结束的工位也能补 —— 等于让它接着上次的成果继续改。
 */
async function say(id, text) {
  const rec = BOOK.get(id)
  if (!rec) throw new Error('没有这个工位：' + id)
  const t = String(text || '').trim()
  if (!t) throw new Error('要补的话是空的')
  const KC = require('./kernelchat')
  // 复位成在跑，这样界面上它又亮起来
  rec.status = 'running'
  rec.ended = 0
  rec.stopped = false
  rec.error = ''
  const k = await KC.kernel()
  const onEv = (sessionId, ev) => {
    if (sessionId !== rec.sid) return
    const s = stepOf(ev)
    if (s) { rec.steps.push(s); if (rec.steps.length > 80) rec.steps.shift(); rec.last = s.what }
    if (ev && ev.type === 'assistant/message') {
      const x = textOf(ev)
      if (x) { rec.text += (rec.text ? '\n' : '') + x; rec.last = x.replace(/\s+/g, ' ').slice(0, 60) }
    }
  }
  k.on('event', onEv)
  try {
    await k.prompt(rec.sid, t)
    await k.wait(rec.sid, 30 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 400))
    rec.status = rec.stopped ? 'stopped' : 'done'
  } catch (e) {
    rec.status = rec.stopped ? 'stopped' : 'failed'
    if (!rec.stopped) rec.error = String((e && e.message) || e)
  } finally {
    rec.ended = Date.now()
    try { k.removeListener('event', onEv) } catch (e) {}
  }
  return view(rec, true)
}

/** 界面层止损：不再跟踪。内核那一轮会自己收尾（SDK 没有取消口子，不骗人）。 */
function stop(id) {
  const rec = BOOK.get(id)
  if (!rec) throw new Error('没有这个工位：' + id)
  rec.stopped = true
  if (!rec.ended) { rec.status = 'stopped'; rec.last = '已叫停，不再跟踪（内核这一轮会自己收尾）' }
  return view(rec, true)
}

function one(id) {
  const rec = BOOK.get(id)
  return rec ? view(rec, true) : null
}

function list() {
  const items = ORDER.map((x) => BOOK.get(x)).filter(Boolean).sort((a, b) => b.started - a.started)
  const running = items.filter((x) => x.status === 'running')
  return {
    items: items.map((x) => view(x, false)),
    total: items.length,
    running: running.length,
    done: items.filter((x) => x.status === 'done').length,
    failed: items.filter((x) => x.status === 'failed').length,
  }
}

/** 主对话要汇报的：在跑的 + 刚结束还没汇报过的 */
function snapshot() {
  const l = list()
  return { running: l.running, items: l.items.slice(0, 8) }
}

function clear(id) {
  if (id) { BOOK.delete(String(id)); const i = ORDER.indexOf(String(id)); if (i >= 0) ORDER.splice(i, 1); return { ok: true } }
  // 全清：只清已结束的，在跑的不动
  for (const x of [...ORDER]) {
    const r = BOOK.get(x)
    if (r && r.ended) { BOOK.delete(x); ORDER.splice(ORDER.indexOf(x), 1) }
  }
  return { ok: true }
}

module.exports = { spawn, say, stop, one, list, snapshot, clear, MAX }
