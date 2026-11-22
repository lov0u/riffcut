// 内核客户端：跟 DSH 内核说话的唯一通道。
//
// 为什么不用 Python 桥：Electron 主进程就是 Node，能直接 spawn 内核并说
// stdio JSON-RPC（已实测）。少一层进程就少一类 bug。
//
// 协议（换行分隔 JSON-RPC 2.0）：
//   请求  initialize / session/prompt / session/resume / session/wait /
//         session/working-directory/get|set / shutdown
//   通知  session.event / session.status / subagent.started / subagent.finished
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { EventEmitter } = require('node:events')

// 内核位置：优先环境变量，其次随包带的 <软件根>/kernel/dsh。
// 以前默认值写死在旧 App 的 .app 包里 —— 新工程一跑就跑去用旧内核，
// 打包到别人机器上更是直接找不到（那个路径根本不存在）。
const { join: _join, dirname: _dirname } = require('node:path')
const ROOT_DIR = process.env.RiffCut_ROOT || _join(__dirname, '..', '..')
const KERNEL_DIR = process.env.RiffCut_KERNEL || _join(ROOT_DIR, 'kernel', 'dsh')
const PROFILE = 'velora'
const INIT_TIMEOUT = 60_000

class KernelError extends Error {}

/**
 * 内核会话。一个实例对应一个子进程，多个会话共用（DSH 自己按 sessionId 隔离）。
 */
class Kernel extends EventEmitter {
  constructor({ kernelDir = KERNEL_DIR, homeDir, profile = PROFILE } = {}) {
    super()
    this.kernelDir = kernelDir
    this.homeDir = homeDir
    this.profile = profile
    this.child = null
    this.buf = ''
    this.seq = 0
    this.pending = new Map()
    this.ready = false
    this.webUrl = null
    this.debug = !!process.env.RiffCut_DEBUG
  }

  get entry() { return join(this.kernelDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js') }

  /**
   * 带 token 的界面地址。内核起来后会往 stdout 打一行
   *   `dsh web: http://127.0.0.1:PORT/?token=xxx`
   * 那是唯一能进的地址 —— 直接访问 / 会 401（防止随便谁开个浏览器就能操作你的机器）。
   */
  get uiUrl() { return this.webUrl || null }
  get nodeBin() { return join(this.kernelDir, 'node') }

  /** 内核在不在、什么版本。启动前先自检，别等用户点发送了才报错。 */
  static probe(kernelDir = KERNEL_DIR) {
    const node = join(kernelDir, 'node')
    const entry = join(kernelDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const pkg = join(kernelDir, 'node_modules/@deepseek-ai/dsh/package.json')
    if (!existsSync(node) || !existsSync(entry)) return { ok: false, reason: '内核文件缺失' }
    let version = '?'
    try { version = JSON.parse(require('node:fs').readFileSync(pkg, 'utf8')).version } catch {}
    return { ok: true, path: kernelDir, version }
  }

  /**
   * 起进程。
   * @param {{provider:string, model:string, cwd:string, reasoningEffort?:string, env?:object}} opts 模型路由与工作目录
   */
  async start({ provider, model, cwd, reasoningEffort, env = {} }) {
    if (this.child) throw new KernelError('内核已经在跑了')
    if (!existsSync(this.entry)) throw new KernelError('内核不在：' + this.entry)
    // ★ homeDir 忘了传会让 DSH_HOME 变成字符串 "undefined"，内核直接 code=1 退出，
    //   而 stderr 只报一句无关的话 —— 排查起来要绕一大圈。这里提前拦住。
    if (!this.homeDir) throw new KernelError('Kernel 少了 homeDir —— 内核的 DSH_HOME 指不到地方')

    this.child = spawn(this.nodeBin, [this.entry, '--profile', this.profile], {
      cwd: this.kernelDir,
      env: { ...process.env, ...env, DSH_HOME: this.homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (d) => this._feed(d))
    this.child.stderr.on('data', (d) => this.emit('stderr', d))
    this.child.on('exit', (code) => {
      this.ready = false
      this.emit('exit', code)
      for (const { reject } of this.pending.values()) reject(new KernelError('内核退出了 code=' + code))
      this.pending.clear()
    })

    /* ★ 2026-11-22 照 DSH：initialize 带 reasoningEffort，SDK server 存下来后
       每个 createSession 都传给 agentOptions，模型才按 high 走思考链。
       以前只传 {cwd,provider,model}，模型默认 effort 时有时无思考 —— 表现为
       「带工具调用的轮次有思考、纯回答的轮次没思考」。 */
    const init = await this.call('initialize', { cwd, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }, INIT_TIMEOUT)
    const name = init?.serverInfo?.name
    if (name !== 'deepseek-harness-sdk-runtime') {
      throw new KernelError('握手失败，返回：' + JSON.stringify(init))
    }
    this.ready = true
    this.emit('ready', init.serverInfo)
    return init.serverInfo
  }

  _feed(chunk) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch {
        // 不是 JSON 的是内核自己的控制台输出。其中最有价值的一行是
        //   `dsh web: http://127.0.0.1:PORT/?token=xxx`
        // —— 这是唯一带 token 的界面地址（直接请求 / 会 401）。
        // 以前这里直接 continue 把它扔了，结果只能拿裸端口去猜，永远 401。
        const m = line.match(/dsh web:\s+(http:\/\/\S+)/)
        if (m) { this.webUrl = m[1]; this.emit('web', m[1]) }
        else if (this.debug) this.emit('log', line)
        continue
      }
      if (msg.method) { this._notify(msg); continue }
      const slot = this.pending.get(msg.id)
      if (!slot) continue
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new KernelError(msg.error.message || JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
    }
  }

  _notify(msg) {
    if (msg.method === 'session.event') {
      const { sessionId, event } = msg.params || {}
      this.emit('event', sessionId, event)
      this.emit('event:' + (event?.type || '?'), sessionId, event)
      return
    }
    this.emit('notify', msg.method, msg.params)
  }

  /** 发一条请求，等它的响应（不等任务做完）。 */
  call(method, params, timeout = 0) {
    if (!this.child) return Promise.reject(new KernelError('内核没起'))
    const id = ++this.seq
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (timeout > 0) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new KernelError(`${method} 超时 ${timeout}ms`))
        }, timeout)
      }
    })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }

  /** 提交一句话，返回 {messageId}（消息收据，不阻塞）。
   *  ★ 2026-11-22：chat 要发图片给模型看（DSH 的多模态），所以这里除了字符串
   *  还接受 contentBlocks 数组。字符串仍包成单个 text block —— openapi.js /
   *  workers.js 那几个老调用点签名不变，不会受影响。
   *  图片 block 的形状照内核 dsh-sdk-jsonrpc-server 的 encodedImage()：
   *    { type:'image', data:'<base64 裸串>', mimeType:'image/png' }
   *  内核会把 data/mimeType 交给 admitEncodedImages 存成 attachment，
   *  再转成 { type:'image', attachment:ref }。durable 层认的是 mimeType，不是 mediaType。 */
  async prompt(sessionId, textOrBlocks) {
    const contentBlocks = Array.isArray(textOrBlocks)
      ? textOrBlocks
      : [{ type: 'text', text: String(textOrBlocks || '') }]
    return this.call('session/prompt', { sessionId, contentBlocks })
  }

  /** 恢复一个已经存在的内核会话。
   *  ★ 2026-11-20 实测的坑：`session/prompt` 在会话首次出现时走
   *    getOrCreateSession → openSession(sid, false) → agents.create()，
   *    而 agents.create() 内部是 sessionStore.prepare(id)，**id 已存在就抛**
   *    `session "xxx" already exists`。
   *    但会话是持久化到 home/sessions 的 —— 用户重开软件、或者切回一个
   *    旧对话，这个 id 天然就已经存在了。于是界面报
   *    「这一轮收尾不完整：内核出错：session "conv-xxx" already exists」，
   *    而且每一句都失败、无法自愈（只能手动点「新会话」绕开）。
   *    正确路径是先 `session/resume`（它走 agents.resume() 读盘恢复），
   *    再 prompt。这里由 promptSafely 自动做这件事。 */
  resume(sessionId) {
    return this.call('session/resume', { sessionId }, INIT_TIMEOUT)
  }

  /** 发话；会话已在盘上就自动 resume 后再发。
   *  只对「already exists / already open」这一类可恢复错误兜底，
   *  其它错误照样抛给上层 —— 不吞真错。
   *  第二个参数原样透传给 prompt —— 可以是字符串，也可以是 contentBlocks 数组（含图片）。 */
  async promptSafely(sessionId, textOrBlocks) {
    try {
      await this.resume(sessionId)
    } catch (e) {
      const m = String(e && e.message || '')
      /* 「already open」说明内核里这个会话还活着，直接发就行；
         其它 resume 失败（会话真不存在）也不影响后面的 prompt —— 那次会新建。 */
      if (!/already open|already exists|unknown SDK session/i.test(m)) {
        if (this.debug) this.emit('log', '[kernel] resume 失败（继续尝试 prompt）: ' + m)
      }
    }
    return this.prompt(sessionId, textOrBlocks)
  }

  /** 阻塞到这一轮彻底 idle（含子智能体）。 */
  wait(sessionId, timeout = 0) {
    return this.call('session/wait', { sessionId }, timeout)
  }

  setCwd(sessionId, path) {
    return this.call('session/working-directory/set', { sessionId, path })
  }

  stop() {
    if (!this.child) return
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'shutdown', params: {} }) + '\n') } catch {}
    const c = this.child
    this.child = null
    setTimeout(() => { try { c.kill('SIGTERM') } catch {} }, 1500)
  }
}

module.exports = { Kernel, KernelError, KERNEL_DIR, PROFILE }
