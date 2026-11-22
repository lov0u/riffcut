// 模板离线化：把模板 HTML 里硬编码的 CDN 地址换成工程内的本地副本。
//
// 为什么必须有这一步：
//   210 个 block + 239 个 component 里，有 179 个 HTML 直接写死了
//     <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js">
//   （grep 全库：gsap 3.14.2 命中 564 次）。渲染时 hyperframes 起的是本地
//   Chrome，它会真去外网拉这些文件。断网 / 弱网 / CDN 抽风时脚本 404，
//   GSAP 没加载 → 所有 timeline 调用抛 ReferenceError，动画一帧不动，
//   渲出来是一张静止画面。最坑的是它**不报错**，成片看着像"模板坏了"。
//
// 做法：
//   1. 装模板进工程时（render.addTemplate / tpltext.writeCopyFull），
//      把 HTML 里每个已知 CDN URL 换成 compositions/lib/cdn/<版本>/<文件>，
//      同时把 vendor/cdn 下对应文件拷进工程 —— 工程自此自成一体，
//      拷到别的机器、断网、三年后 CDN 下线都不影响。
//   2. 未知的 CDN 地址（模板作者临时引了别的东西）不改，但记一条警告，
//      让调用方知道这条片子仍然联网。
//
// 为什么不在渲染时改：工程里的 HTML 是用户/AI 能看能改的产物，
// 预览（uiserver 按 src 找文件）和导出（data-composition-src 指同一文件）
// 吃的是同一份。两份不同的 HTML 必然出现"预览对了成片不对"。

const { existsSync, readFileSync, copyFileSync, mkdirSync, statSync, readdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

const VENDOR = join(__dirname, 'vendor')
const CDN_DIR = join(VENDOR, 'cdn')

/* 映射表是构建期生成的 JSON（URL → cdn/ 下的相对路径）。
   读不到就当空表 —— 坏掉映射不该让装模板整体失败。 */
let _map = null
function map() {
  if (_map) return _map
  try {
    _map = JSON.parse(readFileSync(join(VENDOR, 'cdn-map.json'), 'utf8'))
  } catch {
    _map = {}
  }
  return _map
}

/* 一条 URL 可能带查询串或 hash（?v=1#x），匹配时允许尾部杂音。
   模板里还有 `async` / `defer` / `crossorigin` 混在同一行的情况，所以只按
   URL 本体替换，不动标签其余部分。 */
const TAIL = '([?#][^"\'\\s)]*)?'

/** 把相对定位算出来：工程里固定落在 compositions/lib/cdn/。
 *  用相对路径（而不是 /tpllib/... 这种绝对路由）是因为导出渲染时
 *  hyperframes 用的是工程目录当站点根，绝对路由在那儿不存在。
 *
 *  ★ ESM 的 import 规范比 <script src> 严得多：
 *    import ... from "lib/cdn/x.js"   → TypeError: Failed to resolve module specifier
 *                                       （相对引用必须以 "/"、"./" 或 "../" 开头）
 *    <script src="lib/cdn/x.js">      → 正常
 *    所以两个上下文不能给同一个字符串：
 *      · import / import() / export from  → "./lib/cdn/..."
 *      · src= / href= / url()             → "lib/cdn/..."
 *    实测踩过：整库改写后 glass-hero 渲染卡死 45 秒报 COMPOSITION_SETUP_TIMEOUT，
 *    隔离实验证明只把 three 的 import 还原成 CDN 就恢复 —— 就是少了 "./"。 */
function relOf(rel) {
  // 同样用站点绝对路径，理由见 relOfEsm。
  return '/compositions/lib/cdn/' + rel
}
function relOfEsm(rel) {
  // ★ 用站点绝对路径（/compositions/lib/cdn/...），不能用 "./lib/cdn/..."。
  //   原因：hyperframes 渲染时会把子合成里的 <script type="module"> 抽到根文档执行，
  //   此时相对基准变成工程根，"./lib/cdn/x.js" 被解析成 "/lib/cdn/x.js" → 404
  //   （实测日志 `[FileServer] 404 Not Found: /lib/cdn/three/0.184.0/three.esm.js`，
  //    而文件真实位置是 compositions/lib/cdn/...）。
  //   绝对路径 /compositions/... 在根文档和子文档（base=compositions/）下都成立。
  return '/compositions/lib/cdn/' + rel
}

/** 这条 URL 出现在什么上下文里？往前看一小段，判断是不是 import/export 语句。
 *  能认出的四种写法：
 *    import * as THREE from "URL"
 *    import "URL"                      （副作用导入）
 *    export { a } from "URL"
 *    import("URL")                     （动态导入）
 *  注意结尾要允许引号：pos 是 URL 起点，before 里已经含了左边那个引号。 */
function isEsmContext(text, pos) {
  const before = text.slice(Math.max(0, pos - 160), pos)
  return /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*\s*from\s*)?\(?\s*['"`]?\s*$/.test(before)
}

/**
 * 改写一段 HTML 文本里的 CDN 引用。
 * @param {string} html
 * @returns {{html: string, replaced: number, unknown: string[]}}
 */
function rewriteHtml(html) {
  const m = map()
  let out = String(html || '')
  let replaced = 0
  for (const [url, rel] of Object.entries(m)) {
    // 精确匹配（含可选的 ?query / #hash）
    const re = new RegExp(escapeRe(url) + TAIL, 'g')
    if (!re.test(out)) continue
    re.lastIndex = 0
    // ★ 必须按上下文分派：import/export 语句拿到裸路径会被浏览器拒绝解析，
    //   必须加 "./"；src=/href=/url() 反而是裸路径才正常。
    out = out.replace(re, (hit, _tail, offset) => {
      replaced++
      return isEsmContext(out, offset) ? relOfEsm(rel) : relOf(rel)
    })
  }
  // 还剩哪些外链？（只报，不改 —— 没见过的东西不动）
  const unknown = []
  const left = out.match(/https?:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|esm\.sh|cdn\.skypack\.dev)\/[^"'\s)]+/g) || []
  for (const u of left) if (!unknown.includes(u)) unknown.push(u)
  return { html: out, replaced, unknown }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 递归拷目录（用于 importmap 的目录前缀映射，例如 three/addons/）。
 * @returns {{files: number, bytes: number}}
 */
function copyDirRecursive(from, to) {
  let files = 0
  let bytes = 0
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const a = join(from, name)
    const b = join(to, name)
    if (statSync(a).isDirectory()) {
      const got = copyDirRecursive(a, b)
      files += got.files
      bytes += got.bytes
    } else if (!existsSync(b)) {
      copyFileSync(a, b)
      files++
      bytes += statSync(b).size
    } else {
      files++
    }
  }
  return { files, bytes }
}

/**
 * 把这条 HTML 用到的本地库拷进工程（按实际出现过的路径拷，不整目录搬）。
 * @param {string} html 已经 rewrite 过的 HTML
 * @param {string} projDirPath 工程根目录
 * @returns {{files: string[], bytes: number}}
 */
function copyLibs(html, projDirPath) {
  const files = []
  let bytes = 0
  const re = /lib\/cdn\/([A-Za-z0-9@._/-]+)/g
  const seen = new Set()
  let mm
  while ((mm = re.exec(String(html || '')))) {
    const rel = mm[1]
    if (seen.has(rel)) continue
    seen.add(rel)
    const from = join(CDN_DIR, rel)
    const to = join(projDirPath, 'compositions', 'lib', 'cdn', rel)
    if (!existsSync(from)) continue
    try {
      // addons 这类目录前缀（importmap 里 "three/addons/" 指向整个目录）
      // 要递归整目录搬，不能当文件拷。
      if (statSync(from).isDirectory()) {
        const got = copyDirRecursive(from, to)
        bytes += got.bytes
        // 目录映射只记一条，避免 files 里塞几百个 addon 路径
        files.push(rel.replace(/\/$/, '') + '/**')
        continue
      }
      mkdirSync(dirname(to), { recursive: true })
      if (!existsSync(to)) {
        copyFileSync(from, to)
        const sz = statSync(to).size
        bytes += sz
        files.push(rel)
      } else {
        files.push(rel)
      }
    } catch { /* 单个库拷失败不该让整条流程失败 */ }
  }
  return { files, bytes }
}

/** 一个 HTML 文件原地离线化（写回同一路径）。给 addTemplate 这类"文件已落地"的场景用。 */
function vendorizeFile(htmlFile, projDirPath) {
  try {
    if (!existsSync(htmlFile)) return { ok: false, reason: '文件不在', replaced: 0, unknown: [] }
    const raw = readFileSync(htmlFile, 'utf8')
    const { html, replaced, unknown } = rewriteHtml(raw)
    if (replaced) require('node:fs').writeFileSync(htmlFile, html, 'utf8')
    const libs = copyLibs(html, projDirPath)
    return { ok: true, replaced, unknown, libs: libs.files, bytes: libs.bytes }
  } catch (e) {
    return { ok: false, reason: e.message, replaced: 0, unknown: [] }
  }
}

/** 只算文本，不落盘 —— tpltext.writeCopyFull 那种"内容在内存里"的场景用。 */
function vendorizeText(html, projDirPath) {
  const r = rewriteHtml(html)
  const libs = copyLibs(r.html, projDirPath)
  return { html: r.html, replaced: r.replaced, unknown: r.unknown, libs: libs.files, bytes: libs.bytes }
}

/** 体检：映射表里哪些文件实际缺失（打包时漏搬会在这里暴露）。 */
function audit() {
  const m = map()
  const missing = []
  let total = 0
  for (const rel of Object.values(m)) {
    const f = join(CDN_DIR, rel)
    if (!existsSync(f)) missing.push(rel)
    else total += statSync(f).size
  }
  return { entries: Object.keys(m).length, missing, mb: +(total / 1048576).toFixed(2) }
}

module.exports = { rewriteHtml, vendorizeFile, vendorizeText, copyLibs, audit, CDN_DIR, map }
