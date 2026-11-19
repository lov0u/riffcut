'use strict'
/**
 * 独立 Chrome 的启动与登录态管理。
 *
 * 为什么必须是独立 profile：
 *   Chrome 只允许「同一 user-data-dir 有一个实例」，用用户日常那个 profile
 *   起不来调试端口 —— 除非把用户所有窗口关掉。用独立 profile 既能带调试端口，
 *   又完全不碰用户自己的登录态和书签。
 *
 * 为什么不做自动登录：
 *   扫码/短信验证码天然要人参与，脚本硬做只会把号搞风控。
 *   流程是「先开窗口 → 用户扫码 → 登录态留在这个 profile 里」，之后几个月不用再登。
 */

const { spawn } = require('child_process')
const { existsSync, mkdirSync } = require('fs')
const path = require('path')
const P = require('./paths')
const CDP = require('./cdp')

const PORT = Number(process.env.RiffCut_CDP_PORT || 9333)
const PROFILE = path.join(P.ROOT, 'runtime', 'browser-profile')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]

function chromePath() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p
  return ''
}

async function status() {
  const a = await CDP.alive(PORT)
  const bin = chromePath()
  return {
    ok: true,
    running: !!a.ok,
    browser: a.ok ? a.browser : '',
    port: PORT,
    profile: PROFILE,
    chrome: bin,
    installed: !!bin,
    hint: bin
      ? (a.ok ? '' : '点「打开浏览器」起一个独立窗口，登录各平台一次，之后不用再登')
      : '本机没装 Chrome：到 google.cn/chrome 装一个（Edge / Chromium 也能用）',
  }
}

/**
 * 起一个带调试端口的独立 Chrome。
 * ★ 不加 --headless：登录要人扫码，必须看得见窗口。
 * ★ 必须带 --user-data-dir：不带就是用户日常 profile，端口起不来。
 */
async function start(opts = {}) {
  const bin = chromePath()
  if (!bin) throw new Error('本机没装 Chrome，先装一个（Edge / Chromium 也能用）')
  const a = await CDP.alive(PORT)
  if (a.ok) return { ok: true, already: true, browser: a.browser, port: PORT }
  if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true })

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=' + (Number(opts.width) || 1440) + ',' + (Number(opts.height) || 900),
  ]
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()

  // 等端口起来（最多 20 秒）
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    await CDP.sleep(500)
    const v = await CDP.alive(PORT)
    if (v.ok) return { ok: true, already: false, browser: v.browser, port: PORT, pid: child.pid }
  }
  throw new Error('Chrome 起了但调试端口没开出来（20 秒超时）')
}

/** 关掉我们自己起的那个 Chrome（不动用户日常窗口 —— uid 是独立的）。 */
async function stop() {
  const a = await CDP.alive(PORT)
  if (!a.ok) return { ok: true, was: false }
  try {
    // 走 CDP 的 Browser.close 最干净
    const t = await CDP.findTarget(PORT, null, true)
    if (t) {
      const s = await CDP.Session.connect(t.webSocketDebuggerUrl)
      await s.call('Browser.close', {}, 5000).catch(() => {})
      s.close()
    }
  } catch {}
  return { ok: true, was: true }
}

module.exports = { PORT, PROFILE, chromePath, status, start, stop }
