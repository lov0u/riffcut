'use strict'
/**
 * 平台发布：抖音 / 小红书 / 快手 / 视频号 / B站。
 *
 * 为什么是「驱动」不是「API」
 * ──────────────────────
 * 这几个平台**都没有开放的个人发布 API**。企业号有若干开放平台，但都要资质、
 * 审核、按次计费，而且能力比网页版还少（比如小红书根本没有）。
 * 业界能用的办法只有一个：用浏览器把创作者后台当成人在操作。
 *
 *   Chrome（独立 profile，开调试端口，已登录一次）
 *       ↓ CDP（见 cdp.js）
 *   创作者后台 → 找到上传框 → 塞文件 → 填标题正文 → 点发布 → 读结果
 *
 * 为什么默认 dry-run
 * ─────────────────
 * 真发出去是**不可撤回**的（抖音/小红书发出去只能删，删了还会掉权重）。
 * 所以默认只走到「填完所有字段、停在发布按钮前」，截图给你看，你说行才真发。
 *
 * 各平台的坑都是实测踩出来的，改选择器前先读注释。
 */

const path = require('path')
const { existsSync, mkdirSync } = require('fs')
const P = require('./paths')
const C = require('./core')
const CDP = require('./cdp')

const LOGIN_TEXTS = ['扫码登录', '验证码登录', '密码登录', '立即登录', '登录后查看']

// ══════════════ 平台定义 ══════════════
const DRIVERS = {
  douyin: {
    label: '抖音',
    loginUrl: 'https://creator.douyin.com/',
    publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    loggedIn: 'div[class*="card-container-creator-layout"], div[class*="creator-header"]',
    needLogin: 'div[class*="login-scan"], form[class*="login"]',
    fileInput: 'div[class*="drag-upload"] input[type="file"]',
    fileFallback: 'input[type="file"]',
    uploading: '[class*="uploading-container"]',
    titleInput: 'input[placeholder*="作品标题"]',
    // 简介是 contenteditable，不是 textarea
    descInput: 'div[data-placeholder*="作品简介"][contenteditable="true"], div.editor-kit-container[contenteditable="true"]',
    // 会自动弹「推荐封面」，不处理会挡住发布按钮
    coverPopup: 'div[class*="recommendCoverContainer"]',
    coverPick: 'div[class*="recommendCoverContainer"] > div:first-child',
    coverOk: 'div.semi-modal-footer button.semi-button-primary',
    publishBtn: 'button[class*="button-dhlUZE"], div[class*="content-confirm"] button',
    publishBtnText: ['发布'],
    toast: 'span[class*="semi-toast-content-text"]',
    uploadTimeout: 480,
    aspect: '9:16',
    titleMax: 30,   // 前端会静默截断，所以要先在我们这边拦
    notes: '上传框是隐藏 input，只能 DOM.setFileInputFiles；转码最长 8 分钟，超时设短了会误判失败',
  },
  xiaohongshu: {
    label: '小红书',
    loginUrl: 'https://creator.xiaohongshu.com/',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    loggedIn: 'div.creator-tab, div.upload-content',
    needLogin: 'div[class*="login"], .login-container',
    fileInput: '.upload-input',
    fileFallback: 'input[type="file"]',
    uploading: '.img-preview-area, [class*="uploading"]',
    videoTab: ['文字', '上传视频'],     // 必须先进创作者中心，再切「上传视频」tab
    titleInput: 'div.d-input input, input[placeholder*="标题"]',
    descInput: 'div.ql-editor',        // 正文是 quill
    // 话题要从这个容器里选 —— 手打 # 不会变成真话题
    topicContainer: '#creator-editor-topic-container',
    publishBtn: 'xhs-publish-btn, .publish-page-publish-btn button.bg-red',
    publishBtnText: ['发布'],
    toast: '[class*="toast"], [class*="message"]',
    uploadTimeout: 600,
    aspect: '3:4 或 9:16',
    titleMax: 20,   // 全角字上限
    notes: '需要外网；话题必须从容器里选；标题超过 20 全角字会截断',
  },
  kuaishou: {
    label: '快手',
    loginUrl: 'https://cp.kuaishou.com/',
    publishUrl: 'https://cp.kuaishou.com/article/publish/video',
    loggedIn: 'div[class*="upload"], div[class*="publish"]',
    needLogin: 'div[class*="login"], [class*="qrcode"]',
    fileInput: 'div[class*="upload"] input[type="file"]',
    fileFallback: 'input[type="file"]',
    uploading: '[class*="uploading"], [class*="progress"]',
    titleInput: 'input[placeholder*="标题"], textarea[placeholder*="标题"]',
    descInput: 'div[contenteditable="true"], textarea[placeholder*="描述"], textarea[placeholder*="介绍"]',
    publishBtn: 'div[class*="publish"] button, button[class*="submit"]',
    publishBtnText: ['发布', '立即发布'],
    toast: '[class*="toast"], [class*="message"]',
    uploadTimeout: 480,
    aspect: '9:16',
    titleMax: 500,
    notes: '页面结构比抖音简单，上传框是普通 input[type=file]',
  },
  'weixin-channels': {
    label: '视频号',
    loginUrl: 'https://channels.weixin.qq.com/platform',
    publishUrl: 'https://channels.weixin.qq.com/platform/post/list',
    loggedIn: 'div[class*="finder-home"], div[class*="post-list"], a[class*="post-create"]',
    needLogin: 'div[class*="login"], [class*="qrcode"]',
    fileInput: 'input[type="file"]',
    fileFallback: 'input[type="file"]',
    uploading: '[class*="uploading"], [class*="progress"]',
    preStep: '发表视频',              // 先点这个才进编辑页
    titleInput: 'input[placeholder*="描述"], div[placeholder*="描述"]',
    descInput: 'div[contenteditable="true"], textarea',
    publishBtn: 'button[class*="weui-desktop-btn_primary"]',
    publishBtnText: ['发表', '发布'],
    toast: '[class*="toast"], [class*="weui-desktop-toast"]',
    uploadTimeout: 600,
    aspect: '9:16',
    titleMax: 22,   // 全平台最短
    notes: '必须微信扫码登录，且登录态 7 天过期，是最需要常重登的',
  },
  bilibili: {
    label: 'B站',
    loginUrl: 'https://member.bilibili.com/platform/home',
    publishUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    loggedIn: 'div[class*="user-info"], [class*="upload-video"], div[class*="nav"]',
    needLogin: 'div[class*="login"], [class*="qrcode"]',
    fileInput: 'input[type="file"]',
    fileFallback: 'input[type="file"]',
    uploading: '[class*="upload-progress"], [class*="progress"]',
    titleInput: 'input[placeholder*="标题"]',
    descInput: 'div[class*="ql-editor"], div[contenteditable="true"]',
    publishBtn: 'div[class*="submit-add"], button[class*="submit"]',
    publishBtnText: ['立即投稿', '投稿'],
    toast: '[class*="toast"], [class*="message"]',
    uploadTimeout: 900,
    aspect: '16:9',
    titleMax: 80,
    notes: '有官方投稿接口但要 biliup（Rust CLI），这里走网页版兜底；分区 + 标签必填',
  },
}

const ALIAS = {
  '抖音': 'douyin', dy: 'douyin', douyin: 'douyin',
  '小红书': 'xiaohongshu', xhs: 'xiaohongshu', rednote: 'xiaohongshu', xiaohongshu: 'xiaohongshu',
  '快手': 'kuaishou', ks: 'kuaishou', kuaishou: 'kuaishou',
  '视频号': 'weixin-channels', '微信视频号': 'weixin-channels', channels: 'weixin-channels',
  weixin: 'weixin-channels', 'weixin-channels': 'weixin-channels',
  'b站': 'bilibili', bilibili: 'bilibili', '哔哩哔哩': 'bilibili',
}

function platformKey(name) {
  const k = String(name || '').trim().toLowerCase()
  if (DRIVERS[k]) return k
  return ALIAS[k] || ALIAS[String(name || '').trim()] || ''
}

function platforms() {
  return Object.entries(DRIVERS).map(([key, v]) => ({
    key, label: v.label, aspect: v.aspect, titleMax: v.titleMax,
    loginUrl: v.loginUrl, notes: v.notes,
  }))
}

/** 截图落「产出/图片」—— 界面显示要走 /gen/<文件名> 静态路由，写 /tmp 浏览器取不到。 */
function shotDir() {
  try {
    const d = C.custPaths().images
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  } catch { return '/tmp' }
}

function shotUrl(p) {
  if (!p) return ''
  try {
    const dir = path.resolve(C.custPaths().images)
    const abs = path.resolve(p)
    if (abs.startsWith(dir + path.sep)) return '/gen/' + path.basename(abs)
    return ''
  } catch { return '' }
}

// ══════════════ 登录探测 ══════════════
/**
 * 以「能不能看到上传框」为准判定登录，不看 class。
 * 2026-11-15 实测：抖音没登录时停在扫码页，页面上依然有
 * `div[class*="creator-header"]` 这类骨架元素，按 class 判断会得到「已登录」，
 * 然后第 5 步找不到上传框才失败 —— 错误位置报错，用户看到的是「改版了」，
 * 实际是「没登录」。
 */
async function probeLogin(s, d) {
  let txt = ''
  try {
    txt = String(await s.js("document.body?document.body.innerText.slice(0,4000):''", { awaitPromise: false }) || '')
  } catch {}
  const hasPrompt = LOGIN_TEXTS.some(t => txt.includes(t))
  let hasInput = false
  for (const sel of [d.fileInput, d.fileFallback, 'input[type="file"]']) {
    if (!sel) continue
    try { if (await s.exists(sel)) { hasInput = true; break } } catch {}
  }
  if (hasInput) return ['in', '看到上传框']
  if (hasPrompt) return ['out', '页面上有登录入口（扫码/验证码/密码）']
  if (d.loggedIn) {
    try {
      if (await s.exists(d.loggedIn)) return ['unknown', '有骨架元素但没有上传框，可能是加载中']
    } catch {}
  }
  return ['unknown', '既没上传框也没登录入口']
}

/**
 * 检查某平台是否已登录。不自动登录 —— 只告诉你「要登」并把页面开出来。
 */
async function loginCheck(platform, opts = {}) {
  const key = platformKey(platform)
  if (!key) return { ok: false, error: `不认识的平台：${platform}` }
  const d = DRIVERS[key]
  const port = Number(opts.port) || CDP.DEFAULT_PORT
  const a = await CDP.alive(port)
  if (!a.ok) {
    return {
      ok: false, needOpen: true, platform: key, label: d.label,
      error: 'Chrome 没开调试端口，先在「发布中心」点「打开浏览器」',
    }
  }
  const host = d.loginUrl.split('//')[1].split('/')[0]
  let s = null
  try { s = await CDP.connect({ port, urlPart: host }) } catch {}
  if (!s) {
    if (!opts.openIfNeeded) {
      return { ok: true, platform: key, label: d.label, loggedIn: false, note: '没开着这个页面，无法判断。要检查就加 openIfNeeded' }
    }
    s = await CDP.connect({ port, new: d.loginUrl, timeout: 40000 })
  }
  try {
    await s.goto(d.loginUrl, 4500)
    const [state, why] = await probeLogin(s, d)
    return {
      ok: true, platform: key, label: d.label,
      loggedIn: state === 'in', state, evidence: why, url: await s.url(),
      note: state === 'in'
        ? '已登录，可以直接发'
        : `未登录：${why}。在这个窗口里扫码登录一次，状态会留在软件的独立 profile 里，以后不用再登`,
    }
  } finally { s.close() }
}

// ══════════════ 发布主流程 ══════════════
/**
 * 把一条内容发到某平台。
 * exec=false（默认）只填不点发布，截一张图给你看。exec=true 才真点。
 */
async function publish(platform, opts = {}) {
  const key = platformKey(platform)
  if (!key) {
    return { ok: false, error: `不认识的平台：${platform}（支持：${Object.values(DRIVERS).map(d => d.label).join('、')}）` }
  }
  const d = DRIVERS[key]
  const video = String(opts.video || '')
  const title = String(opts.title || '')
  const body = String(opts.body || '')
  const tags = (opts.tags || []).map(t => String(t).trim().replace(/^#/, '')).filter(Boolean)
  const exec = !!opts.exec
  const port = Number(opts.port) || CDP.DEFAULT_PORT

  if (!video) return { ok: false, platform: key, label: d.label, error: '没给视频文件' }
  if (!existsSync(video)) return { ok: false, platform: key, label: d.label, error: `找不到文件：${video}` }
  if (title.length > d.titleMax) {
    return {
      ok: false, platform: key, label: d.label, stage: '规格检查',
      error: `标题 ${title.length} 字，超过 ${d.label} 的 ${d.titleMax} 字上限（超了会被前端静默截断）`,
    }
  }

  const a = await CDP.alive(port)
  if (!a.ok) return { ok: false, platform: key, label: d.label, needOpen: true, error: 'Chrome 没开，先在「发布中心」点「打开浏览器」' }

  const steps = []
  const note = (t) => { steps.push(t) }
  let s = null
  try {
    const host = d.loginUrl.split('//')[1].split('/')[0]
    try { s = await CDP.connect({ port, urlPart: host }) } catch { s = await CDP.connect({ port, new: d.publishUrl, timeout: 40000 }) }
    note('连上浏览器')

    await s.goto(d.publishUrl, 60000)
    await CDP.sleep(2500)
    note('打开投稿页')

    const [state, why] = await probeLogin(s, d)
    if (state === 'out') {
      return { ok: false, platform: key, label: d.label, stage: '登录检查', needLogin: true, error: `没登录：${why}` }
    }
    note(`登录状态：${state}（${why}）`)

    // 视频号：先点「发表视频」才进编辑页
    if (d.preStep) {
      try { await s.clickText('button, div[role="button"], span', d.preStep); note('点了「' + d.preStep + '」'); await CDP.sleep(2000) } catch {}
    }
    // 小红书：切到「上传视频」tab
    if (d.videoTab) {
      for (const t of d.videoTab) {
        try { await s.clickText('span, div, button', t); note('切到「' + t + '」'); await CDP.sleep(1500); break } catch {}
      }
    }

    // ── 上传 ──
    let uploaded = false
    for (const sel of [d.fileInput, d.fileFallback, 'input[type="file"]']) {
      if (!sel) continue
      try {
        await s.upload(sel, [video])
        uploaded = true
        note('塞进上传框：' + sel)
        break
      } catch {}
    }
    if (!uploaded) {
      try { await s.uploadVisible([video]); uploaded = true; note('塞进可见的上传框') } catch {}
    }
    if (!uploaded) {
      return { ok: false, platform: key, label: d.label, stage: '上传', steps, error: '页面上找不到能塞文件的地方（可能是页面改版了，也可能是没登录）' }
    }

    // 等转码：上传中的元素消失才算完
    if (d.uploading) {
      const gone = await s.waitGone(d.uploading, d.uploadTimeout * 1000, 1500)
      note(gone ? '上传转码完成' : `上传等了 ${d.uploadTimeout} 秒还没结束（继续往下走，可能只是慢）`)
    } else {
      await CDP.sleep(8000)
    }

    // ── 填标题 ──
    let titleFilled = false
    if (d.titleInput && title) {
      try { await s.fill(d.titleInput, title); titleFilled = true; note('填了标题') } catch (e) { note('标题没填进去：' + e.message) }
    }
    // ── 填正文/简介 ──
    let bodyFilled = false
    if (d.descInput && body) {
      try { await s.typeIntoEditable(d.descInput, body); bodyFilled = true; note('填了正文') }
      catch (e) {
        try { await s.fill(d.descInput, body); bodyFilled = true; note('填了正文（用 value 方式）') }
        catch { note('正文没填进去：' + e.message) }
      }
    }
    // ── 话题 ──
    if (tags.length) {
      if (d.topicContainer) {
        for (const t of tags.slice(0, 10)) {
          try {
            await s.focus(d.descInput)
            await s.insertText('#' + t)
            await CDP.sleep(1200)
            await s.press('Enter')
            note('加了话题 #' + t)
          } catch { note('话题 #' + t + ' 没加上（要从容器里选，手打 # 不算）') }
        }
      } else {
        try {
          await s.typeIntoEditable(d.descInput, '\n' + tags.map(t => '#' + t).join(' '), false)
          note('正文里补了话题：' + tags.map(t => '#' + t).join(' '))
        } catch {}
      }
    }

    // 抖音会弹「推荐封面」挡住发布按钮
    if (d.coverPopup) {
      try {
        if (await s.exists(d.coverPopup)) {
          await s.click(d.coverPick).catch(() => {})
          await s.click(d.coverOk).catch(() => {})
          note('处理了推荐封面弹窗')
          await CDP.sleep(1200)
        }
      } catch {}
    }

    // ── 截图（停在发布按钮前）──
    const shot = path.join(shotDir(), `发布-${key}-${P.stamp()}.png`)
    let shotPath = ''
    try { shotPath = await s.screenshot(shot, false); note('截了一张当前画面') } catch (e) { note('截图失败：' + e.message) }

    if (!exec) {
      note('到这里停住 —— 没点发布（真发出去撤不回来）')
      return {
        ok: true, platform: key, label: d.label, dryRun: true, steps,
        shot: shotPath, shotUrl: shotUrl(shotPath),
        titleFilled, bodyFilled,
        note: '确认没问题就把「真发」打开再发一次',
      }
    }

    // ── 真发 ──
    const since = Date.now()
    let clicked = false
    for (const sel of String(d.publishBtn).split(',').map(x => x.trim())) {
      try { await s.click(sel); clicked = true; note('点了发布按钮：' + sel); break } catch {}
    }
    if (!clicked) {
      for (const t of d.publishBtnText) {
        try { await s.clickText('button, div[role="button"], span', t, true); clicked = true; note('点了「' + t + '」'); break } catch {}
      }
    }
    if (!clicked) {
      return { ok: false, platform: key, label: d.label, stage: '发布', steps, shot: shotPath, shotUrl: shotUrl(shotPath), error: '找不到发布按钮（页面可能改版了）' }
    }

    // 读结果：先看 toast，再看网络回执
    await CDP.sleep(3500)
    let toast = ''
    try { toast = String(await s.textOf(d.toast) || '').trim().slice(0, 200) } catch {}
    const posts = s.netFind('/publish', { since, method: 'POST' })
    const okReq = posts.find(r => r.status >= 200 && r.status < 300)
    const shot2 = path.join(shotDir(), `发布-${key}-结果-${P.stamp()}.png`)
    let shotPath2 = ''
    try { shotPath2 = await s.screenshot(shot2, false) } catch {}

    const success = !!okReq || /成功|已发布|发布成功/.test(toast)
    note(success ? '发布成功' : '没看到成功回执' + (toast ? `（页面提示：${toast}）` : ''))
    return {
      ok: success, platform: key, label: d.label, dryRun: false, steps,
      toast, requests: posts.map(r => `${r.method} ${r.status} ${r.url.slice(0, 100)}`),
      shot: shotPath2, shotUrl: shotUrl(shotPath2),
      error: success ? '' : '没看到发布成功的回执，去平台上确认一下（可能还在审核）',
    }
  } catch (e) {
    return { ok: false, platform: key, label: d.label, stage: '异常', steps, error: String((e && e.message) || e) }
  } finally {
    if (s && !opts.keepOpen) s.close()
  }
}

/** 给 AI 看的一句话摘要。 */
function brief(r) {
  if (!r) return '没有结果'
  if (!r.ok) return `✗ ${r.label || r.platform}：${r.error || '失败'}`
  if (r.dryRun) return `✓ ${r.label}：已填好，停在发布按钮前（截图可看）`
  return `✓ ${r.label}：已发布`
}

module.exports = {
  DRIVERS, ALIAS, LOGIN_TEXTS,
  platformKey, platforms, loginCheck, publish, brief, probeLogin,
  shotDir, shotUrl,
}
