/**
 * 子智能体登记簿。
 *
 * 内核的 SDK 通道会发两个通知：`subagent.started` / `subagent.finished`。
 * 内核本身不提供「列出当前在跑的子智能体」的请求 —— 只能从通知里自己记账。
 * 所以这里是一个进程内的环形簿：主进程在 `_notify` 里把通知喂进来，
 * 界面通过 /api/agents 读。
 *
 * ★ 为什么不用文件：子智能体的生命周期就是这一轮任务（几十秒到几分钟），
 *   进程一重启它们必然全没了。落盘反而会留下「上次在跑、其实早没了」的假记录。
 *   所以内存 + 上限 40 条，重启即清空 —— 这是如实，不是省事。
 */
const MAX = 40
const BOOK = new Map() // id -> {id, sessionId, parent, name, task, started, ended, ok, note}

let seq = 0

/** 从通知里取子智能体的标识。字段名随内核版本可能变，所以多路兜底 */
function idOf(p) {
  return String(p.subagentId || p.id || p.agentId || p.childSessionId || '') ||
    ('sub-' + (++seq))
}

function started(sessionId, p = {}) {
  const id = idOf(p)
  BOOK.set(id, {
    id,
    sessionId: String(sessionId || p.sessionId || ''),
    parent: String(p.parentSessionId || sessionId || ''),
    name: String(p.name || p.agent || p.title || '子智能体'),
    task: String(p.task || p.prompt || p.description || '').slice(0, 400),
    started: Date.now(),
    ended: 0,
    ok: null,
    note: '',
  })
  trim()
  return BOOK.get(id)
}

function finished(sessionId, p = {}) {
  const id = idOf(p)
  const one = BOOK.get(id) || started(sessionId, p)
  one.ended = Date.now()
  one.ok = p.ok === undefined ? (p.error ? false : true) : !!p.ok
  one.note = String(p.error || p.note || p.summary || p.result || '').slice(0, 600)
  return one
}

/** 上限。超了扔最老的已经结束的；全都还在跑就不扔（宁可多留几条，不能弄丢在跑的） */
function trim() {
  if (BOOK.size <= MAX) return
  const done = [...BOOK.values()].filter((x) => x.ended).sort((a, b) => a.ended - b.ended)
  for (const x of done) {
    if (BOOK.size <= MAX) break
    BOOK.delete(x.id)
  }
}

function list() {
  const items = [...BOOK.values()].sort((a, b) => b.started - a.started)
  const running = items.filter((x) => !x.ended)
  return {
    items,
    total: items.length,
    running: running.length,
    done: items.filter((x) => x.ended && x.ok).length,
    failed: items.filter((x) => x.ended && !x.ok).length,
  }
}

function clear() { BOOK.clear(); return { ok: true } }

module.exports = { started, finished, list, clear, MAX }
