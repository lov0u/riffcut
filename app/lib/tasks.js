'use strict'
/**
 * 任务队列。
 *
 * 三个 worker 而不是一个 —— 这不是性能调优，是防死锁：
 * 一个 worker 时，AI 在 agent 里派生出「出草稿」这种子任务，而它自己那个
 * agent 任务正占着唯一的 worker，子任务永远排在「排队中」，AI 轮询十几次
 * 拿到都是 progress 0，最后只能说「还在生成」。三个够用：出片吃 CPU/ffmpeg，
 * 再多人机都在抢同一块磁盘。
 *
 * 重启即判失败：上次进程退出时还在跑的任务，这次起来就没有人在跑了。
 * 以前它们永远停在「运行中」，模型轮询十几次拿到的都是同一句「还在跑，
 * 没有任何产物路径」，既不知道卡住了，也不敢重来。进程一没，任务就是断了。
 */

const { EventEmitter } = require('events')
const P = require('./paths')
const C = require('./core')

const MAX_HISTORY = 200
const MAX_LOGS = 200
const WORKERS = 3
const STATES = { QUEUED: '排队中', RUNNING: '运行中', DONE: '已完成', FAILED: '失败', CANCELLED: '已取消' }

class TaskCancelled extends Error {
  constructor(msg = '用户取消了任务') { super(msg); this.name = 'TaskCancelled' }
}

const bus = new EventEmitter()
bus.setMaxListeners(64)

let _seq = 0
const _tasks = []          // 历史（含刚建的），前 MAX_HISTORY 条
const _queue = []          // [{tid, fn}]
const _cancel = new Map()  // tid -> true
const _depth = []          // 现在这段代码在几层任务里（下标即层）
let _timer = null
let _started = false

function _load() {
  const raw = P.load('tasks', [])
  // 任务文件必须是数组。文件被写脏（测试、手改、旧版本残留）时静默丢弃，
  // 而不是让「会话列表 → 对话流程状态 → 找任务」这条链路整个崩掉 ——
  // 一条坏数据不该让侧栏几十条对话一条都看不到。
  const list = Array.isArray(raw) ? raw : []
  return list.filter(t => t && typeof t === 'object' && t.id)
}

function _persist() {
  P.save('tasks', _tasks.slice(-MAX_HISTORY))
}

/** 上次进程退出时还在跑的任务 → 照实写「中断」，让它能重新发起。 */
function _recoverInterrupted() {
  let dirty = false
  for (const t of _tasks) {
    if (t.state === STATES.QUEUED || t.state === STATES.RUNNING) {
      t.state = STATES.FAILED
      t.finished = t.finished || P.now()
      t.error = '软件重启时这个任务还没跑完，已经断了'
      t.logs = (t.logs || []).concat(`[${_hhmmss()}] 断在这里：进程重启，任务没有接着跑`)
      dirty = true
    }
  }
  if (dirty) _persist()
}

function _hhmmss() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function _inWorker() {
  return _depth.length > 0
}

/** 起 worker 循环。幂等 —— 重复调用不会起两套。 */
function start() {
  if (_started) return
  _started = true
  for (const t of _load()) _tasks.push(t)
  _recoverInterrupted()
  _timer = setInterval(_tick, 250)
  if (_timer.unref) _timer.unref()
  let running = 0
  _tick = () => {
    if (running >= WORKERS) return
    const item = _queue.shift()
    if (!item) return
    const t = find(item.tid)
    if (!t || isCancelled(item.tid)) return
    running++
    _execute(t, item.fn)
      .catch(() => {})
      .finally(() => { running-- })
  }
}
let _tick = () => {}

/**
 * 提交一个任务。
 *
 * fn(tid) 是任务体，同步或 async 都行；返回 {ok:false, error} 会被判失败。
 * retries 是**额外**重试次数（默认 1 = 失败后再试一次）。
 */
function submit(name, fn, meta = null, retries = 1) {
  start()
  _seq = (_seq + 1) % 10000
  const t = {
    id: `t${P.stamp()}-${String(_seq).padStart(4, '0')}`,
    name: String(name || '未命名任务'),
    state: STATES.QUEUED,
    progress: 0,
    logs: [],
    created: P.now(),
    started: '',
    finished: '',
    error: '',
    meta: meta || {},
    cost: 0,
    result: null,
    retries: Math.max(0, Number(retries) || 0),
  }
  _tasks.push(t)
  if (_tasks.length > MAX_HISTORY * 2) _tasks.splice(0, _tasks.length - MAX_HISTORY)
  _persist()
  bus.emit('new', t)

  if (_inWorker()) {
    // 任务里派任务：直接当场跑完，不排队。
    // 「出草稿」本身是个任务，而 AI 派它的时候自己也正跑在一个任务里。
    // 光加 worker 治不了根 —— 排队/等待是同一条链上的两环，只要中间还隔着
    // 一次「交出去再等回来」，就会把自己等死。
    // ★ 这里会阻塞调用方等结果，因为调用方本来就是同步等结果的。
    return _inWorkerRun(t, fn)
  }
  _queue.push({ tid: t.id, fn })
  return t
}

/** 异步版当场执行（不阻塞调用方）。给 UI 层的「立即跑」用。 */
async function submitNow(name, fn, meta = null, retries = 0) {
  start()
  _seq = (_seq + 1) % 10000
  const t = {
    id: `t${P.stamp()}-${String(_seq).padStart(4, '0')}`,
    name: String(name || '未命名任务'), state: STATES.QUEUED, progress: 0, logs: [],
    created: P.now(), started: '', finished: '', error: '',
    meta: meta || {}, cost: 0, result: null, retries: Math.max(0, Number(retries) || 0),
  }
  _tasks.push(t)
  _persist()
  bus.emit('new', t)
  await _execute(t, fn)
  return t
}

function _inWorkerRun(t, fn) {
  // 为什么同步等：调用方（AI 的工具）本来就是同步等结果的。
  // 为什么不在调用者线程里直接跑：调用链可能已经是 runAgent → 工具 → 出草稿
  // → 每段渲染 → subprocess，再往下几层就撞 JS 的栈上限。
  // Node 里没有「起一条新线程跑同步函数」这种廉价做法（worker_threads 要序列化
  // 闭包，拿不到），所以这里靠显式深度计数 + await 让事件循环自然摊开，
  // 真正的同步等待交给调用方自己去 await 返回值。
  _depth.push(t.id)
  const done = _execute(t, fn).finally(() => {
    const i = _depth.lastIndexOf(t.id)
    if (i >= 0) _depth.splice(i, 1)
  })
  return done
}

async function _execute(t, fn) {
  if (!t || isCancelled(t.id)) return t
  update(t.id, { state: STATES.RUNNING, started: P.now(), progress: 2 })
  log(t.id, `开始：${t.name}`)
  const attemptMax = Math.max(0, Number(t.retries) || 0) + 1
  let ok = false, last = ''

  for (let attempt = 1; attempt <= attemptMax && !ok; attempt++) {
    try {
      checkCancelled(t.id)
      _depth.push(t.id)
      const res = await fn(t.id)
      _depth.pop()
      checkCancelled(t.id)
      t.result = res
      // 任务体返回 {ok:false} 也算失败 —— 不让「函数没抛异常但里面失败了」
      // 被记成「已完成」，那会让 AI 以为片子出来了其实没有。
      if (res && typeof res === 'object' && res.ok === false) {
        last = resultError(res)
        update(t.id, { state: STATES.FAILED, finished: P.now(), error: last, result: res })
        log(t.id, `失败：${last}`)
        return t
      }
      ok = true
      update(t.id, { state: STATES.DONE, progress: 100, finished: P.now(), result: res, error: '' })
      log(t.id, `完成：${JSON.stringify(res ?? null).slice(0, 200)}`)
    } catch (e) {
      _depth.pop()
      if (e instanceof TaskCancelled) {
        update(t.id, { state: STATES.CANCELLED, finished: P.now(), error: '用户取消了任务' })
        log(t.id, '已取消，后续步骤不再执行')
        return t
      }
      last = (e && e.message) ? String(e.message).slice(0, 400) : String(e)
      log(t.id, `第 ${attempt} 次失败：${last}`)
      if (attempt < attemptMax) await sleep(800)
    }
  }
  if (!ok) {
    update(t.id, { state: STATES.FAILED, finished: P.now(), error: last })
    log(t.id, `最终失败：${last}`)
  }
  return t
}

function resultError(res) {
  if (!res || typeof res !== 'object') return ''
  return String(res.error || res.text || '任务返回失败').slice(0, 180)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function find(tid) {
  if (!tid) return null
  // ★ 用 t.id 而不是 t['id']（等于一样，但这里刻意容忍脏数据）
  return _tasks.find(x => x && x.id === tid) || null
}

function update(tid, kw) {
  const t = find(tid)
  if (!t) return null
  Object.assign(t, kw)
  _persist()
  bus.emit('update', t)
  return t
}

function log(tid, line) {
  const t = find(tid)
  if (!t) return
  t.logs = (t.logs || []).concat(`[${_hhmmss()}] ${line}`)
  if (t.logs.length > MAX_LOGS) t.logs = t.logs.slice(-MAX_LOGS)
  _persist()
  bus.emit('log', { id: tid, line })
}

function progress(tid, pct, note) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))
  update(tid, { progress: p })
  if (note) log(tid, note)
}

/** 当前在跑的是哪个任务（工具里要写日志时用）。 */
function current() {
  return _depth.length ? _depth[_depth.length - 1] : ''
}

function isCancelled(tid) { return !!_cancel.get(tid) }

function cancel(tid) {
  _cancel.set(tid, true)
  const i = _queue.findIndex(x => x.tid === tid)
  if (i >= 0) _queue.splice(i, 1)
  const t = find(tid)
  if (t && (t.state === STATES.QUEUED)) {
    update(tid, { state: STATES.CANCELLED, finished: P.now(), error: '用户取消了任务' })
    log(tid, '用户取消了任务')
  }
  return t
}

function checkCancelled(tid) {
  if (isCancelled(tid)) throw new TaskCancelled()
}

/** 任务列表（新的在前）。stats 里的 counts 是各状态计数。 */
function list(opts = {}) {
  start()
  const limit = Math.max(1, Math.min(MAX_HISTORY, Number(opts.limit) || 40))
  const state = opts.state ? String(opts.state) : ''
  let items = _tasks.slice()
  if (state) items = items.filter(t => t.state === state)
  items = items.slice(-limit).reverse()
  const counts = {}
  for (const t of _tasks) counts[t.state] = (counts[t.state] || 0) + 1
  return { items, counts, total: _tasks.length, running: _depth.length, queued: _queue.length }
}

/** 给前端轮询用：只返回比 since 新的日志（省流量）。 */
function tail(tid, since = 0) {
  const t = find(tid)
  if (!t) return null
  const logs = (t.logs || []).slice(Math.max(0, Number(since) || 0))
  return {
    id: t.id, name: t.name, state: t.state, progress: t.progress,
    error: t.error, result: t.result, logs, next: (t.logs || []).length,
    created: t.created, started: t.started, finished: t.finished, meta: t.meta,
  }
}

/** 等一个任务跑完（轮询）。超时返回任务本身，由调用方看 state 判断。 */
async function waitFor(tid, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0)
  while (Date.now() < deadline) {
    const t = find(tid)
    if (!t) return null
    if (t.state === STATES.DONE || t.state === STATES.FAILED || t.state === STATES.CANCELLED) return t
    await sleep(400)
  }
  return find(tid)
}

/** 清掉已结束的历史（不动在跑的）。 */
function clear(keep = 40) {
  const keepN = Math.max(0, Number(keep) || 0)
  const active = _tasks.filter(t => t.state === STATES.QUEUED || t.state === STATES.RUNNING)
  const done = _tasks.filter(t => t.state !== STATES.QUEUED && t.state !== STATES.RUNNING)
  /* ★ keepN=0 时不能写 done.slice(-keepN)：-0 === 0，slice(0) 返回全部，
     「清空」反而一条没删（实测 15 条清完还是 15 条）。keep=0 就是全清。 */
  const rest = keepN > 0 ? done.slice(-keepN) : []
  const removed = done.length - rest.length
  _tasks.length = 0
  _tasks.push(...rest, ...active)
  _persist()
  return { kept: _tasks.length, removed }
}

module.exports = {
  STATES, TaskCancelled, bus,
  start, submit, submitNow, find, update, log, progress, current,
  cancel, isCancelled, checkCancelled, list, tail, waitFor, clear,
}
