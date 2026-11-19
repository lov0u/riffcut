'use strict'
/**
 * 极简 CDP 客户端（Chrome DevTools Protocol）。
 *
 * 为什么自己写而不装 puppeteer：我们只需要「连一个已经开着、已经登录过的
 * Chrome」——浏览器由用户在界面上点一下打开，登录态在独立 profile 里。
 * puppeteer 会自己带一份 Chromium、自己管生命周期，反而和「用你的登录态」
 * 这件事打架。这里只要 WebSocket + JSON-RPC，Node 26 自带 WebSocket，零依赖。
 *
 * 一堆「为什么这么写」的坑都是实测踩出来的，注释里逐条留着 —— 改的时候别顺手删。
 */

const http = require('http')
const { writeFileSync } = require('fs')

const DEFAULT_PORT = Number(process.env.RiffCut_CDP_PORT || 9333)

class CDPError extends Error {
  constructor(msg) { super(msg); this.name = 'CDPError' }
}

function _get(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch { resolve(buf) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => { req.destroy(new CDPError('连接 Chrome 超时')) })
  })
}

async function version(port = DEFAULT_PORT) {
  return _get(`http://127.0.0.1:${port}/json/version`, 3000)
}

async function listTargets(port = DEFAULT_PORT) {
  const r = await _get(`http://127.0.0.1:${port}/json/list`, 3000)
  return Array.isArray(r) ? r : []
}

async function newTab(url, port = DEFAULT_PORT) {
  // PUT 还是 GET：Chrome 新旧版本不一样，两个都试
  try {
    return await _get(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 8000)
  } catch {
    return _put(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 8000)
  }
}

function _put(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT' }, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve(buf) } })
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new CDPError('开新标签页超时')))
    req.end()
  })
}

async function findTarget(port = DEFAULT_PORT, urlPart = null, last = true) {
  const list = await listTargets(port)
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
  const hit = urlPart
    ? pages.filter(t => String(t.url || '').includes(urlPart))
    : pages
  if (!hit.length) return null
  return last ? hit[hit.length - 1] : hit[0]
}

async function closeTab(id, port = DEFAULT_PORT) {
  try { await _get(`http://127.0.0.1:${port}/json/close/${id}`, 3000) } catch {}
}

// ══════════════ Session ══════════════
class Session {
  constructor(ws, timeout = 60000) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.net = []
    this._timeout = timeout
    this._onEvent = null
  }

  static connect(wsUrl, timeout = 60000) {
    return new Promise((resolve, reject) => {
      let ws
      try { ws = new WebSocket(wsUrl) } catch (e) { return reject(new CDPError('WebSocket 建不起来：' + e.message)) }
      const s = new Session(ws, timeout)
      const t = setTimeout(() => { try { ws.close() } catch {}; reject(new CDPError('CDP 握手超时')) }, timeout)
      ws.addEventListener('open', () => { clearTimeout(t); resolve(s) })
      ws.addEventListener('error', ev => { clearTimeout(t); reject(new CDPError('CDP 连不上：' + (ev.message || 'error'))) })
      ws.addEventListener('message', ev => s._feed(ev.data))
      ws.addEventListener('close', () => {
        for (const [, p] of s.pending) p.reject(new CDPError('CDP 连接断了'))
        s.pending.clear()
      })
    })
  }

  _feed(data) {
    let msg
    try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')) } catch { return }
    if (msg.id != null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new CDPError(`${msg.error.message || 'CDP 报错'}（${p.method}）`))
      else p.resolve(msg.result || {})
      return
    }
    // 事件：留下网络证据（发布是否成功最终要看请求回执，不是看页面文字）
    const m = msg.method, p = msg.params || {}
    if (m === 'Network.requestWillBeSent' && p.request) {
      this.net.push({ id: p.requestId, url: p.request.url, method: p.request.method, at: Date.now(), status: 0 })
      if (this.net.length > 600) this.net.splice(0, this.net.length - 600)
    } else if (m === 'Network.responseReceived' && p.response) {
      const rec = this.net.find(x => x.id === p.requestId)
      if (rec) { rec.status = p.response.status; rec.type = p.response.mimeType }
    }
    if (this._onEvent) { try { this._onEvent(m, p) } catch {} }
  }

  call(method, params = {}, timeout = this._timeout) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new CDPError('CDP 没连上'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CDPError(`CDP ${method} 超时（${timeout}ms）`))
      }, Math.max(1000, timeout))
      this.pending.set(id, {
        method, resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(new CDPError('发送失败：' + e.message))
      }
    })
  }

  async enable() {
    await this.call('Page.enable', {}, 15000)
    await this.call('Runtime.enable', {}, 15000)
    await this.call('DOM.enable', {}, 15000)
    return this
  }

  async netOn() { try { await this.call('Network.enable', {}, 15000) } catch {} return this }

  netFind(urlPart, opts = {}) {
    const since = Number(opts.since || 0)
    let hit = this.net.filter(r => (!urlPart || r.url.includes(urlPart)) && r.at >= since)
    if (opts.method) hit = hit.filter(r => r.method === opts.method.toUpperCase())
    if (opts.minStatus) hit = hit.filter(r => r.status >= opts.minStatus)
    return hit
  }

  // ── 求值 ─────────────────────────────────────────────
  /**
   * 在页面里跑一段 JS。
   * ★ 报错必须带原始 message：CDP 的 exceptionDetails 里才是人话，
   *   只返回 result.value 会在语法错/抛异常时静悄悄拿到 undefined。
   */
  async js(expr, opts = {}) {
    const r = await this.call('Runtime.evaluate', {
      expression: String(expr),
      returnByValue: true,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: true,
    }, opts.timeout || this._timeout)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || '脚本报错'
      throw new CDPError(String(msg).split('\n')[0])
    }
    return r.result ? r.result.value : undefined
  }

  async exists(sel) {
    return !!(await this.js(`!!document.querySelector(${JSON.stringify(sel)})`))
  }

  async count(sel) {
    return Number(await this.js(`document.querySelectorAll(${JSON.stringify(sel)}).length`)) || 0
  }

  async textOf(sel, index = 0) {
    return await this.js(`(()=>{var e=document.querySelectorAll(${JSON.stringify(sel)})[${index}];return e?(e.innerText||e.textContent||''):''})()`)
  }

  async goto(url, timeout = 60000) {
    await this.call('Page.navigate', { url }, timeout)
    // 等 load 事件（最多 timeout），超时也继续 —— 有些页面永远不触发 load
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const st = await this.js('document.readyState', { awaitPromise: false }).catch(() => '')
      if (st === 'complete' || st === 'interactive') return true
      await sleep(300)
    }
    return true
  }

  async waitFor(sel, timeout = 30000, poll = 400) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (await this.exists(sel)) return true
      await sleep(poll)
    }
    // 超时把当前 URL 一起报出来 —— 否则只知道「没等到」，不知道是不是被踹去登录页了
    const u = await this.url().catch(() => '')
    throw new CDPError(`等「${sel}」超时（${Math.round(timeout / 1000)} 秒），当前页面：${u}`)
  }

  async waitGone(sel, timeout = 300000, poll = 800) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (!(await this.exists(sel))) return true
      await sleep(poll)
    }
    return false
  }

  async click(sel, index = 0) {
    const ok = await this.js(`(()=>{var e=document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`)
    if (!ok) throw new CDPError(`点不到元素：${sel} #${index}`)
    return true
  }

  async clickText(tag, text, exact = false) {
    const ok = await this.js(`(()=>{
      var want=${JSON.stringify(String(text))}, exact=${exact ? 'true' : 'false'};
      var es=[].slice.call(document.querySelectorAll(${JSON.stringify(tag)}));
      for(var i=0;i<es.length;i++){var e=es[i];
        var t=(e.innerText||e.textContent||'').trim();
        if((exact?t===want:t.indexOf(want)>=0)&&e.getClientRects().length){
          e.scrollIntoView({block:'center'});e.click();return true}}
      return false})()`)
    if (!ok) throw new CDPError(`页面上找不到文字「${text}」的 ${tag}`)
    return true
  }

  /**
   * 填表单。
   * ★ 必须走原生 setter 再派发 input/change：直接 `el.value = x` 不触发
   *   React/Vue 的 onChange，框里能看到字但提交时是空的（实测抖音/小红书都这样）。
   */
  async fill(sel, value, index = 0) {
    const ok = await this.js(`(()=>{
      var e=document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if(!e)return false;
      var d=Object.getOwnPropertyDescriptor(e.__proto__||{},'value');
      if(d&&d.set){d.set.call(e,${JSON.stringify(String(value))})}else{e.value=${JSON.stringify(String(value))}}
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      e.dispatchEvent(new Event('blur',{bubbles:true}));
      return true})()`)
    if (!ok) throw new CDPError(`填不进：${sel} #${index}`)
    return true
  }

  async focus(sel, index = 0) {
    const ok = await this.js(`(()=>{var e=document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if(!e)return false;e.focus();return true})()`)
    if (!ok) throw new CDPError(`聚焦不到：${sel}`)
    return true
  }

  /**
   * 给富文本编辑器（Quill / ProseMirror / Slate / contenteditable）输入文字。
   * 往 contenteditable 里塞 innerHTML 在 React 受控组件里会被清掉，
   * `Input.insertText` 是浏览器层真输入，各家编辑器都认。
   */
  async insertText(text) {
    await this.call('Input.insertText', { text: String(text) }, 30000)
    return true
  }

  async press(key, times = 1) {
    for (let i = 0; i < Math.max(1, Number(times) || 1); i++) {
      for (const type of ['keyDown', 'keyUp']) {
        await this.call('Input.dispatchKeyEvent', {
          type, key, code: key, windowsVirtualKeyCode: _vk(key), nativeVirtualKeyCode: _vk(key),
        }, 10000)
      }
    }
    return true
  }

  async typeIntoEditable(sel, value, clear = true) {
    await this.realClick(sel)
    if (clear) {
      // 全选再输入，比逐字退格稳
      await this.call('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4,
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      }, 10000).catch(() => {})
      await this.call('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4,
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      }, 10000).catch(() => {})
    }
    await this.insertText(value)
    return true
  }

  /**
   * 真鼠标点击（Input.dispatchMouseEvent）。
   * JS 的 el.click() 对 ProseMirror 这类富文本编辑器不够 —— 它靠真实的
   * mousedown/mouseup 定位光标，只 dispatch 一个 click 事件光标不会进去，
   * 后面 insertText 就打到别处去了。
   */
  async realClick(sel, index = 0) {
    const box = await this.js(`(()=>{
      var es=document.querySelectorAll(${JSON.stringify(sel)});var e=es[${index}];
      if(!e)return null;e.scrollIntoView({block:'center'});
      var r=e.getBoundingClientRect();
      return {x:r.left+Math.min(r.width/2,40), y:r.top+r.height/2}})()`)
    if (!box) throw new CDPError(`点不到元素：${sel} #${index}`)
    const { x, y } = box
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
    }, 10000)
    await sleep(50)
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
    }, 10000)
    return true
  }

  /**
   * 给 file input 塞文件。
   * ★ 必须走 DOM.setFileInputFiles —— JS 不能设 input.files（安全限制），
   *   而上传框通常还是隐藏的（display:none / 0×0），点也点不到，只能这么塞。
   */
  async upload(sel, paths) {
    const list = Array.isArray(paths) ? paths.map(String) : [String(paths)]
    const doc = await this.call('DOM.getDocument', { depth: -1, pierce: true }, 30000)
    const q = await this.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel }, 30000)
    if (!q.nodeId) throw new CDPError(`找不到上传框：${sel}`)
    await this.call('DOM.setFileInputFiles', { nodeId: q.nodeId, files: list }, 60000)
    return true
  }

  /**
   * 给**当前可见**的那个 file input 塞文件。
   * 为什么需要：头条/公众号这类编辑器页面上常同时挂好几个 input[type=file]
   * （正文插图一个、封面一个、还有隐藏的备用），直接拿第一个多半是错的。
   */
  async uploadVisible(paths, scope = '') {
    const sel = (scope ? scope + ' ' : '') + 'input[type=file]'
    const idx = await this.js(`(()=>{
      var es=[].slice.call(document.querySelectorAll(${JSON.stringify(sel)}));
      for(var i=0;i<es.length;i++){var e=es[i];
        if(e.offsetParent!==null||e.getClientRects().length){
          e.setAttribute('data-riffcut-file','1');return i}}
      if(es.length){es[0].setAttribute('data-riffcut-file','1');return 0}
      return -1})()`)
    if (idx == null || Number(idx) < 0) throw new CDPError(`页面上没有文件输入框：${sel}`)
    return this.upload('[data-riffcut-file="1"]', paths)
  }

  async url() { try { return String(await this.js('location.href', { awaitPromise: false })) } catch { return '' } }
  async title() { try { return String(await this.js('document.title', { awaitPromise: false })) } catch { return '' } }

  async screenshot(outPath, full = false) {
    const params = { format: 'png' }
    if (full) params.captureBeyondViewport = true
    const r = await this.call('Page.captureScreenshot', params, 30000)
    const buf = Buffer.from(String(r.data || ''), 'base64')
    if (!buf.length) throw new CDPError('截图返回空数据')
    writeFileSync(outPath, buf)
    return outPath
  }

  close() { try { this.ws.close() } catch {} }
}

function _vk(key) {
  const map = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32,
  }
  return map[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ══════════════ 便捷入口 ══════════════
/**
 * 连一个已有 tab；new="https://..." 则先开新 tab 再连。
 */
async function connect(opts = {}) {
  const port = Number(opts.port) || DEFAULT_PORT
  const timeout = Number(opts.timeout) || 60000
  if (opts.new) {
    let t
    try {
      t = await newTab(opts.new, port)
    } catch (e) {
      throw new CDPError(`开新标签页失败（Chrome 没起来？先在界面上点「打开浏览器」）：${e.message}`)
    }
    const ws = t && t.webSocketDebuggerUrl
    if (!ws) throw new CDPError('新标签页没给 websocket 地址')
    const s = await Session.connect(ws, timeout)
    return s.enable()
  }
  const t = await findTarget(port, opts.urlPart || null, true)
  if (!t) throw new CDPError(`没找到包含「${opts.urlPart || ''}」的标签页。先用 new= 参数开一个。`)
  const s = await Session.connect(t.webSocketDebuggerUrl, timeout)
  return s.enable()
}

async function alive(port = DEFAULT_PORT) {
  try { const v = await version(port); return { ok: true, browser: v.Browser, ws: v.webSocketDebuggerUrl } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
}

module.exports = {
  DEFAULT_PORT, CDPError, Session,
  version, listTargets, findTarget, newTab, closeTab, connect, alive, sleep,
}
