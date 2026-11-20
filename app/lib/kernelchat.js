'use strict'
/**
 * 首页对话 → 内核。
 *
 * 为什么单独一层而不是直接调 T.call：内核是按会话跑的，一轮对话要
 *   ①拿（或建）一条会话 ②发 prompt ③等 idle ④把这一轮所有事件汇总成
 *   「回答 + 步骤」。界面要的是「一句话回答 + 一串可见的动手记录」，
 *   内核给的是原始事件流 —— 中间这层做翻译。
 *
 * 另一个理由：旧版前端每 700ms 轮询 /api/steps 拿进度，所以这里必须把
 * 步骤按 step_id 塞进一个总线，不能让请求原地等 90 秒（浏览器会超时）。
 */
const path = require('node:path')
const { Kernel } = require('./kernel')
const Pr = require('./profile')
const Turn = require('./turn')
const P = require('./paths')

let _k = null
let _prof = null
let _seq = 0
const BUS = new Map()   // stepId → {seq, steps[], done, text, started}
const MAIN_SID = 'velora-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)

/* 同一条会话的发送排队。
   主管那一轮没跑完，用户又发了一句 —— 直接往内核里再 prompt 会撞「会话忙」。
   排队保证顺序，而**返回是立刻的**：前端不需要等，进度靠 /api/steps 拿。 */
const SENDQ = new Map() // sid → promise 链
function enqueue(sid, fn) {
  const prev = SENDQ.get(sid) || Promise.resolve()
  const next = prev.then(fn, fn)
  SENDQ.set(sid, next.catch(() => {}))
  return next
}
function busy(sid) {
  const p = SENDQ.get(sid)
  if (!p) return false
  let done = false
  p.then(() => { done = true }, () => { done = true })
  return !done
}

/**
 * 认领主进程已经起好的内核。
 *
 * 为什么必须这么做：软件开机时 main.js 已经起了一个内核（界面上那个「内核在跑」
 * 就是它）。这里如果再起一个，两个内核抢同一个 home/配置/port.txt 里的端口，
 * 后来那个直接 code=1 退出 —— 症状是「对话永远连不上模型」，而单独跑脚本又正常，
 * 极难查。所以内核全进程只允许一个，谁先起谁负责，这边只认领。
 */
function adopt(k) {
  if (k) _k = k
  return _k
}

async function kernel() {
  if (_k && _k.child) return _k
  /* ★★ homeDir（= 内核的 DSH_HOME）和 cwd 是两件事，以前混成了一个（2026-11-20）。
     homeDir 决定内核把 profiles/sessions/storages 写哪；
     cwd 决定 AI 眼里的「当前目录」是什么 —— 它 `ls` 看到的第一层就是这个。
     以前两个都传 P.HOME，于是内核状态（profiles/sessions/storages/logs）
     和业务数据（客户/资源/模板库/配置）挤在同一层，
     再加上 Electron 的 Chromium 缓存目录也在那儿，AI 一 ls 就是二十几个
     Cache/GPUCache/Local Storage —— 它当然会去翻那些目录，
     这不是它不听话，是环境没收拾干净。
     现在：DSH_HOME → HOME/内核/（AI 看不见），cwd → HOME/（全是人话目录）。 */
  const kernelHome = P.KERNEL_HOME
  const workDir = P.HOME
  _prof = Pr.buildProfile({ homeDir: kernelHome, profile: 'velora' })
  const k = new Kernel({ homeDir: kernelHome, profile: 'velora' })
  k.on('event', () => {})            // 事件在这一层按 stepId 分发，见 chat()
  await k.start({ provider: _prof.provider, model: _prof.model, cwd: workDir, env: _prof.env })
  _k = k
  return k
}

function status() {
  return { running: !!(_k && _k.child), provider: _prof && _prof.provider, model: _prof && _prof.model, ui: _k ? _k.uiUrl : null }
}

/** 从内核事件里取真实 token 用量。
 *  实测格式（会话日志里就是这个）：
 *    data.usage = { inputTokens, outputTokens, totalTokens, cacheReadTokens }
 *  以前这里写死 {in:0, out:0} —— 首页每条回答底部「模型 · token · 耗时」
 *  永远是 0，用量统计里也看不到对话的消耗，看起来像「不记账」。 */
function usageOf(ev) {
  const u = ev && ev.data && ev.data.usage
  if (!u || typeof u !== 'object') return null
  const i = Number(u.inputTokens) || 0
  const o = Number(u.outputTokens) || 0
  const c = Number(u.cacheReadTokens) || 0
  if (!i && !o && !c) return null
  return { in: i, out: o, cached: c }
}

/** 把一轮的 token 记进用量表（模型管理页的统计吃这里）。 */
function bookUsage(modelName, usage, ms) {
  if (!usage) return
  try {
    const M = require('./models')
    M.recordUsage({
      at: P.now(), model: modelName || 'AI 导演', kind: 'chat',
      ok: true, ms: Number(ms) || 0,
      in: usage.in || 0, out: usage.out || 0, cached: usage.cached || 0, price: 0,
    })
  } catch (e) { /* 记账失败不能影响对话本身 */ }
}
/* ══════════ 工具名 → 人话（用户在屏幕上要看到"他在干嘛"，不是 JSON） ══════════ */
const TOOL_CN = {
  web_search: '上网找资料', stock_search: '找免费素材', stock_fetch: '下载素材',
  templates: '翻模板库', template_vars: '看模板可改的字', capabilities: '看这台机器能干什么',
  deps: '体检环境', skills: '查技能手册', kb_search: '查知识库',
  storyboard: '列分镜方案', edit_timeline: '改时间线', timeline: '读时间线',
  generate: '出片', render_clip: '出片', make_slideshow: '多图成片',
  make_image: '生成图片', make_video: '生成视频', image_prompt: '写画面提示词',
  image_review: '检查图片', add_music: '配乐', addtext: '加字幕', add_voiceover: '配音',
  assets: '看素材库', projects: '看工程列表', probe_media: '看素材', probe: '探查',
  verify_media: '核实成片', transcribe_media: '转字幕', add_caption: '烧字幕',
  ls: '看目录', read: '读文件', write: '写文件', grep: '搜内容',
  working_directory: '确认工作目录', list_mcp_resources: '列出可用能力',
  list_mcp_resource_templates: '列出能力模板', read_mcp_resource: '读能力说明',
  models: '看模型', render_status: '检查渲染环境', script: '写脚本',
  gate: '过审', gate_check: '过审检查', plan_check: '查方案', film_check: '查成片',
}

/** 从工具参数里挑一句"他在干什么"，比 JSON 好读。 */
function argHin(args) {
  if (!args || typeof args !== 'object') return ''
  /* queries / keywords 可能是数组（stock_fetch 就是），也要能显示 */
  const pick = args.query || args.queries || args.q || args.keywords || args.prompt
    || args.text || args.path || args.project || args.goal
    || args.name || args.template || args.action || ''
  let s = ''
  if (Array.isArray(pick)) s = pick.slice(0, 2).map((x) => String(x || '')).join(' / ')
  else s = String(pick || '')
  s = s.trim()
  if (!s) return ''
  /* 纯 action 名（如 "list" / "get"）没信息量，别显示 */
  if (/^[a-z_]{1,14}$/i.test(s) && Object.values(args).length <= 2) s = ''
  return s.length > 46 ? s.slice(0, 46) + '…' : s
}

function stepOf(ev) {
  if (!ev || !ev.type) return null
  const t = String(ev.type)
  /* ★ 内核实际发 `tool/call`（斜杠），同时认连字符写法。
     ★ 只回「开始」这一步，结果由 onEv 合并进同一条 —— 以前 call 和 result
       各生成一条，屏幕上每个工具都显示两行（一行 JSON 参数、一行"完成"），
       看着像满屏乱码。 */
  if (t === 'tool/call' || t === 'tool-call' || t === 'tool/start') {
    const name = String((ev.data && (ev.data.name || ev.data.tool)) || ev.name || '').replace(/^mcp__velora-video__/, '')
    let dt = (ev.data && (ev.data.arguments || ev.data.args)) || {}
    if (typeof dt === 'string') { try { dt = JSON.parse(dt) } catch (e) { dt = {} } }
    return {
      ok: true, running: true,
      tool: name, what: TOOL_CN[name] || name || '操作',
      hint: argHin(dt),
      callId: String((ev.data && ev.data.callId) || ''),
    }
  }
  return null
}

/**
 * 发一句话给内核。
 * @returns {Promise<{ok, data:{text, steps, ms, model, step_id}}>}
 */
async function chat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = messages.filter((m) => m && m.role === 'user').slice(-1)[0]
  const text = String((last && (last.content || last.text)) || body.text || '').trim()
  if (!text) return { ok: false, error: '没说话' }

  const stepId = String(body.step_id || ('s' + (++_seq)))
  const rec = { seq: 0, steps: [], done: false, text: '', started: Date.now(), storyboardProjects: [], error: '', pending: true, usage: { in: 0, out: 0, cached: 0 } }
  BUS.set(stepId, rec)

  /* 会话 id 必须每次启动唯一。
     写死 'velora-main' 的话，同一个 DSH_HOME 下第二次发话就报
     `session "velora-main" already exists` —— 内核把会话持久化在
     home/sessions 里，跨启动还在。这里给每次进程启动一个新的后缀。 */
  let sid = body.session_id || MAIN_SID
  try{ require("node:fs").appendFileSync("/tmp/sid.log", new Date().toISOString()+" sid="+sid+" body_sid="+(body.session_id||"(无)")+"\n") }catch(e){}
  const k = await kernel()
  const t0 = Date.now()

  // 把这一轮所有文本事件收起来；reasoning 一律丢掉（英文思考过程给用户看是噪音）
  const texts = []
  const onEv = (sessionId, ev) => {
    if (sessionId && sid && sessionId !== sid) return
    /* 真实 token：内核每步都会带 data.usage，一轮里多步要累加
       （agent 跑几轮工具就是几趟模型，只取最后一步会严重少算）。 */
    const u = usageOf(ev)
    if (u) { rec.usage.in += u.in; rec.usage.out += u.out; rec.usage.cached += u.cached }
    const s = stepOf(ev)
    if (s) { rec.steps.push(s); rec.seq++ }
    /* ★ 工具结果合并进刚才那条（按 callId 找，找不到就并到最后一条还在跑的）。
       以前 call / result 各生成一条 → 界面上每个工具占两行：
       一行是原始 JSON 参数、一行是"完成"，满屏重复，用户看不出在干啥。 */
    if (String(ev.type) === 'tool/result') {
      const cid = String((ev.data && ev.data.callId) || '')
      let hit = null
      for (let i = rec.steps.length - 1; i >= 0; i--) {
        const st = rec.steps[i]
        if (!st || !st.running) continue
        if (cid && st.callId && st.callId === cid) { hit = st; break }
        if (!hit) hit = st          // 没 callId 就倒退着找最近一个还在跑的
      }
      if (hit) {
        hit.running = false
        hit.ok = !(ev.data && ev.data.isError)
        const out = String((ev.data && ev.data.text) || '').trim()
        // 结果只留一句摘要，正文太长没意义（用户要的是"做完没"）
        hit.done = out ? out.replace(/\s+/g, ' ').slice(0, 90) : ''
        if (!hit.ok && !hit.done) hit.done = '没成功'
        rec.seq++
      }
    }
    // 捕获 storyboard 调用：把工程名带给前端去渲染「分镜审核卡」。
    // approve 不算（那是审核动作，不该再弹一次卡）。
    /* ★ 事件类型是 `tool/call`（斜杠），不是 `tool-call`（连字符）。
       实测内核会话日志里只有 tool/call 和 tool/result，没有 tool-call。
       以前这里判断 tool-call / tool/start，两个都不匹配 ——
       storyboardProjects 永远是空数组，前端拿不到工程名就不渲染审核卡，
       于是 AI 说「请点同意，开始生成」，而界面上根本没有那个按钮，
       用户只能手动打字回「同意」。这是整条审核流程断掉的直接原因。 */
    const evType = String((ev && ev.type) || '')
    const nm = String((ev && ev.data && (ev.data.name || ev.data.tool)) || (ev && ev.name) || '').replace(/^mcp__velora-video__/, '')
    if (nm === 'storyboard' && (evType === 'tool/call' || evType === 'tool-call' || evType === 'tool/start')) {
      const args = (ev && ev.data && (ev.data.arguments || ev.data.args)) || {}
      if (typeof args === 'string') { try { Object.assign(args, JSON.parse(args)) } catch (e) {} }
      if (args.action !== 'approve' && args.project) {
        if (rec.storyboardProjects.indexOf(String(args.project)) < 0) rec.storyboardProjects.push(String(args.project))
      }
    }
    if (ev && ev.type === 'assistant/message') {
      const t = Turn.textOf(ev.data && ev.data.message)
      if (t) { texts.push(t); rec.text = texts.join('\n').trim() }   // 边跑边可读 —— 前端轮询就能看到字在长
      /* ★ 这里原来还会从 message.content 里再解析一遍 toolCalls 并 push 进 rec.steps：
           for (const c of Turn.toolCallsOf(...)) rec.steps.push({what:c.name, detail:JSON.stringify(args)})
         `tool/call` 事件已经记过一次了，于是**同一个工具被记两遍**：
           第一行是旧的原始 JSON（what=web_search、detail='{"query":...}'）
           第二行才是新的中文（上网找资料 · 咖啡 短视频 拍摄 技巧）
         界面上就是每个工具占两行、满屏乱码 —— 怎么改 stepOf 都没用，
         因为坏数据是这条旁路塞进来的。现在只认 tool/call 事件这一条路。 */
    }
  }
  k.on('event', onEv)

  /* 一轮真正的跑法。不管是等还是不等，最后都要走到这里收尾。 */
  const runTurn = async () => {
    /* ★★ 把前文一起交给内核。
       踩过的大坑：这里原来只有 `k.prompt(sid, text)` —— 只发当前这一句。
       DSH 内核确实自己存会话历史，但 MAIN_SID 每次进程启动都换一个新的
       （不换会撞 "session already exists"），所以上一个进程的对话接不上；
       同一个进程里内核虽能记住，可用户一旦重开软件，上下文就断得干干净净。
       实测：说"我叫阿泽"→"我叫什么"能答对；再来一句"我是谁"，
       模型居然从工作目录 /Users/lov0u 去推断名字 —— 说明它根本没看到前文。
       现在把前几轮问答按「你/用户」的形式铺在正式问题前面，
       而且明确告诉它这是本次对话的历史。 */
    /* ★ 2026-11-20 用户驳正（m04568）：
       「啰嗦跟上下文没有关系，上下文越长越好，智力水平越高。关键是他应该知道
        他干什么，不要去限制他的上下文的长度和几条。」
       所以这里不再截断：一条都不丢、一个字都不砍。上下文长了由内核的
       compaction-basic 自动压缩（阈值 contextWindow*0.8 = 163840 token）。
       之前我改成 slice(-6)/160 字是错的方向，判断力问题不该用削字数解决。
       只保留一个清理：剥掉「本轮已启用能力」那段系统注入 —— 那不是用户说的话。 */
    const stripCapPrefix = (t) => String(t || '').replace(/^【本轮已启用能力：[\s\S]*?】\s*\n?\s*/, '')
    const hist = messages
      .filter((m) => m && m.role && m.content
        && !(m.role === 'user' && String(m.content).trim() === text))
      .map((m) => ({ role: m.role, content: stripCapPrefix(m.content) }))
      .filter((m) => String(m.content || '').trim())
    let full = text
    if (hist.length) {
      const lines = []
      for (const m of hist) {
        const who = m.role === 'user' ? '用户' : '你'
        const t = String(m.content || '').trim()
        if (t) lines.push(who + '：' + t)
      }
      if (lines.length) {
        full = '【本次对话之前的内容，用于理解上下文】\n' + lines.join('\n')
          + '\n\n【用户刚才说】\n' + text
      }
    }
    /* ★ 用 promptSafely 而不是 prompt：会话 id 在 home/sessions 里已经存在时
       （用户重开软件、或切回旧对话），裸 prompt 会走 agents.create() 抛
       `session "conv-xxx" already exists`，界面显示「这一轮收尾不完整」且每句都失败。
       promptSafely 先 resume 再发，旧对话能正常接着聊。 */
    await k.promptSafely(sid, full)
    await k.wait(sid, 30 * 60 * 1000)
    // 等 idle 之后管道里可能还压着收尾文本，给它一点时间落地
    await new Promise((r) => setTimeout(r, 600))
    rec.text = texts.join('\n').trim() || rec.text
    /* 账要记进用量表，否则「模型使用量」里看不到对话消耗 */
    bookUsage((_prof && _prof.model) || '', rec.usage, Date.now() - t0)
  }

  /* ★ 监理模式（默认）：立刻回，把这一轮丢到后台收尾。
     以前这里 await 到整轮结束才返回 —— 主对话被一路长活钉住，用户想说第二句
     只能干等或者打断重来。现在返回的是「受理单」，进度走 /api/steps。
     body.wait === true 才走老路径（脚本、一次性调用还需要）。 */
  if (body.wait !== true) {
    enqueue(sid, async () => {
      try { await runTurn(); rec.done = true; rec.pending = false }
      catch (e) { rec.error = '内核出错：' + String((e && e.message) || e); rec.done = true; rec.pending = false }
      finally { try { k.removeListener('event', onEv) } catch (e) {} }
    })
    return {
      ok: true,
      data: {
        pending: true, text: '', steps: [], ms: Date.now() - t0,
        model: (_prof && _prof.model) || '', step_id: stepId,
        storyboard_projects: [],
        workers: (() => { try { return require('./workers').snapshot() } catch (e) { return { running: 0, items: [] } } })(),
        usage: { ...rec.usage },
      },
    }
  }

  try {
    await enqueue(sid, runTurn)
    rec.done = true
    rec.pending = false
    return {
      ok: true,
      data: {
        text: rec.text, steps: rec.steps, ms: Date.now() - t0,
        model: (_prof && _prof.model) || '', step_id: stepId,
        storyboard_projects: rec.storyboardProjects,
        usage: { ...rec.usage },
      },
    }
  } catch (e) {
    rec.done = true
    rec.pending = false
    return { ok: false, error: '内核出错：' + String((e && e.message) || e), step_id: stepId }
  } finally {
    try { k.removeListener('event', onEv) } catch (e) { /* 没有 removeListener 就留着，stepId 不同会跳过 */ }
  }
}

/** 轮询进度（界面每 700ms 一次）。也是「边跑边出字」的唯一通道。 */
function steps(id) {
  const r = BUS.get(String(id))
  if (!r) return { seq: -1, steps: [], done: true, text: '', workers: { running: 0, items: [] } }
  let wk = { running: 0, items: [] }
  try { wk = require('./workers').snapshot() } catch (e) {}
  return {
    seq: r.seq, steps: r.steps, done: r.done, pending: !!r.pending,
    text: r.text, error: r.error || '',
    storyboard_projects: r.storyboardProjects || [],
    workers: wk,
    usage: r.usage || { in: 0, out: 0, cached: 0 },
    model: (_prof && _prof.model) || '',
    ms: Date.now() - r.started,
  }
}

function stop() { if (_k) { _k.stop(); _k = null } }

module.exports = { chat, steps, status, stop, kernel, adopt, busy, stepOf, TOOL_CN }
