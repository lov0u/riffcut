// 渲染：timeline.json → composition HTML → MP4。
// hyperframes 是**本地依赖**，不走 npx（npx 首次要下 25MB，用户以为卡死）。
// 它只借渲染引擎，界面/工程格式/素材路径全是我们的。
const { join, basename, extname, dirname } = require('node:path')
const { existsSync, statSync, rmSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } = require('node:fs')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')
const T = require('./timeline')

/** 渲染子进程的环境：必须显式指路 ffmpeg —— 它只认这两个变量，不认 PATH。 */
function env() {
  const e = { ...process.env }
  const dir = dirname(P.FFMPEG)
  const ff = join(dir, 'ffmpeg'), fp = join(dir, 'ffprobe')
  if (existsSync(ff)) e.HYPERFRAMES_FFMPEG_PATH = ff
  if (existsSync(fp)) e.HYPERFRAMES_FFPROBE_PATH = fp
  // PATH 也要给：Chrome 子进程和内部再 fork 的 node 靠它
  const parts = (e.PATH || '').split(':')
  for (const d of [dir, dirname(nodeBin())]) {
    if (d && !parts.includes(d)) parts.unshift(d)
  }
  e.PATH = parts.join(':')
  e.CI = '1'
  e.NO_COLOR = '1'
  e.HYPERFRAMES_NO_UPDATE_CHECK = '1'
  return e
}

/** 跑 hyperframes 要用「真的 node」。
 *  ★ 不能用 process.execPath：打包后它是 RiffCut影创.app/Contents/MacOS/velora，
 *    那是 Electron 可执行文件，把它当 node 用跑 .mjs 什么都不会输出 ——
 *    症状是 hyperframes 版本永远「(未知)」、ready() 判为环境没好，
 *    界面上就是设置页「FFmpeg 一直读取中」。
 *    内核自带一份 node，打包时一起搬进包，直接用它最稳。 */
function nodeBin() {
  const cands = [
    join(P.ROOT, 'kernel', 'dsh', 'node'),
    join(__dirname, '..', '..', 'kernel', 'dsh', 'node'),
  ]
  for (const c of cands) if (existsSync(c)) return c
  return process.execPath // 开发环境有真 node，兜底
}

function bin() {
  const p = join(__dirname, '..', 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs')
  if (!existsSync(p)) throw new Error('hyperframes 没装（缺 ' + p + '）。请在 app 目录跑 npm i hyperframes')
  return p
}

/** 从 CLI 输出里挖出第一个完整 JSON。不能用贪婪正则：会吞掉后面的提示行。 */
function extractJson(out) {
  if (!out) return null
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (ch !== '{' && ch !== '[') continue
    try {
      // 简单括号配平扫描（不引第三方解析器）
      const close = ch === '{' ? '}' : ']'
      let depth = 0, inStr = false, escNext = false
      for (let j = i; j < out.length; j++) {
        const c = out[j]
        if (inStr) {
          if (escNext) escNext = false
          else if (c === '\\') escNext = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') { inStr = true; continue }
        if (c === ch) depth++
        else if (c === close) {
          depth--
          if (depth === 0) {
            const obj = JSON.parse(out.slice(i, j + 1))
            if (obj && typeof obj === 'object') return obj
            break
          }
        }
      }
    } catch { /* 换下一个起点 */ }
  }
  return null
}

/** 跑一条 hyperframes 命令，把输出喂给任务日志。 */
async function hf(args, cwd, opts = {}) {
  const timeout = opts.timeout || 900_000
  const node = nodeBin()
  const r = await E.run(node, [bin(), ...args], {
    cwd, env: env(), timeout,
    onLine: opts.onLine,
  })
  if (opts.tid) {
    // 调用方给任务日志留了钩子
    for (const line of String(r.stdout || '').split('\n')) {
      if (line.trim()) opts.tid(line.slice(0, 400))
    }
  }
  return r
}

/** 环境体检：缺什么直接说清楚。 */
/* ★ 必须缓存，否则每次调用都起一个 hyperframes 子进程。
   踩过的大祸：/api/deps 每次刷新都调 ready()，而 ready() 每次都 spawn
   一次 `hyperframes --version` + 一次 ffmpeg -encoders（后者要加载几百个编码器）。
   界面一刷新、或者多个页面同时请求 → 几十个 node 进程同时在跑，
   直接把机器拖到无响应（用户原话：开了好几十个进程，把电脑干死机）。
   这类「探测环境」的结果在一个进程生命周期内不会变，缓存它天经地义。
   失败也缓存 30 秒 —— 别让一个坏环境变成无限的进程喷泉。 */
let _readyCache = null
let _readyAt = 0
let _readyFlight = null
const READY_TTL = 5 * 60 * 1000
const READY_FAIL_TTL = 30 * 1000

async function ready(force) {
  const now = Date.now()
  if (!force && _readyCache && now - _readyAt < (_readyCache.ok ? READY_TTL : READY_FAIL_TTL)) {
    return _readyCache
  }
  /* 并发合并：同一时刻十个请求只起一个子进程，其余等它的结果 */
  if (_readyFlight) return _readyFlight
  _readyFlight = (async () => {
    try {
      const v = await _probeReady()
      _readyCache = v
      _readyAt = Date.now()
      return v
    } finally {
      _readyFlight = null
    }
  })()
  return _readyFlight
}

/** 真去探测一次。只在 ready() 决定要探的时候跑。 */
async function _probeReady() {
  const r = await hf(['--version'], P.ROOT, { timeout: 30_000 })
  const ffOk = existsSync(P.FFMPEG), fpOk = existsSync(P.FFPROBE)
  const enc = E.encoders()
  return {
    ok: r.ok && ffOk && fpOk,
    hyperframes: (r.stdout || '').trim() || '(未知)',
    node: process.version,
    ffmpeg: ffOk ? P.FFMPEG : '',
    ffprobe: fpOk ? P.FFPROBE : '',
    hardware: enc.has('h264_videotoolbox'),
    libx264: enc.has('libx264'),
    hint: !ffOk ? '缺 ffmpeg：请先安装 —— brew install ffmpeg（或把 ffmpeg 放到 tools/）'
      : !fpOk ? '缺 ffprobe：请先安装 —— brew install ffmpeg（或把 ffprobe 放到 tools/）'
        : !enc.has('h264_videotoolbox') && !enc.has('libx264') ? '这份 ffmpeg 既没有硬件编码也没有 libx264，出不了片'
          : '',
  }
}

/**
 * 渲一个剪辑工程。
 * final=false → 落 产出/预览/（AI 自己看的，不算成片）
 * final=true  → 落 产出/视频/（只有用户点「导出成片」才走）
 *
 * 为什么分两个目录：「AI 可以把一个视频做得非常好，但他一定不能做成成片 ——
 * 需要人工审核，他做出来的一定是一个工程可以编辑的东西」。
 */
async function renderProject(name, opts = {}) {
  const _t0 = Date.now()
  const final = !!opts.final
  if (T.isInternal(name)) {
    throw new Error(`「${name}」是软件的临时预览空间，不是你的作品，不能导出。先新建一个工程，把要用的素材/模板装进去再导出。`)
  }
  await T.writeComposition(name)
  const dir = T.projDir(name)
  const outdir = final ? C.custPaths().videos : C.custPaths().previews
  P.ensureDir(outdir)

  let stem = String(opts.out || `${name}-${P.stamp()}`).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80)
  if (stem.toLowerCase().endsWith('.mp4')) stem = stem.slice(0, -4)
  const target = join(outdir, stem + '.mp4')

  const args = ['render', '-o', target]
  if (opts.quality) args.push('-q', opts.quality)
  if (opts.workers) args.push('-w', String(opts.workers))

  let r = await hf(args, dir, { timeout: opts.timeout || 3_600_000, onLine: opts.onLine, tid: opts.log })

  // 偶发失败重试：`ERR_ABORTED` / `reading 'timeline'` 是引擎起本地服务时脚本请求被中断，
  // 不是片子写错。不重试代价很大 —— AI 会以为时间线不对，把片段删了重建。
  let flaky = /ERR_ABORTED|reading 'timeline'|Failed to download|script_load/.test(r.stdout || '')
  for (let i = 1; i <= 2 && flaky; i++) {
    if (r.ok && existsSync(target)) break
    // 必须清 .hyperframes 编译缓存，否则第二次复用坏的打包产物，重试等于没试
    try { rmSync(join(dir, '.hyperframes'), { recursive: true, force: true }) } catch {}
    await new Promise(res => setTimeout(res, 1500 * i))
    r = await hf(args, dir, { timeout: opts.timeout || 3_600_000, onLine: opts.onLine, tid: opts.log })
    flaky = /ERR_ABORTED|reading 'timeline'|Failed to download|script_load/.test(r.stdout || '')
  }

  if (!r.ok || !existsSync(target)) {
    // 完整输出留一份：报错只截 600 字，真正原因（哪个资源 404）常在被截掉那段
    try { writeFileSync('/tmp/hf_render_fail.log', r.stdout || '', 'utf8') } catch {}
    throw new Error(`渲染失败（退出码 ${r.code}）：${String(r.stdout || '').slice(-600)}`)
  }
  const p = await E.probe(target)
  // ok: true 必须有 —— 调用方全是按 `r.ok` 判成功的。这个模块的约定是
  // 「成功返回结果、失败抛异常」，但 tools.js 那边按返回值判，两边不一致的
  // 结果就是片子渲成了、界面却报「渲染失败：undefined」。别删。
  return {
    ok: true,
    ms: Date.now() - _t0,
    path: target, name: basename(target),
    duration: p ? p.duration : 0,
    size: statSync(target).size,
    width: p ? p.width : 0, height: p ? p.height : 0,
    log_tail: String(r.stdout || '').slice(-800),
  }
}

/**
 * 渲一张图/一段素材成独立 mp4（AI 自己换路时用）。
 * 比整工程渲染轻得多：一条 ffmpeg 命令，几秒出片。
 */
async function renderClip(src, opts = {}) {
  const out = opts.out || join(C.custPaths().previews, `clip-${P.stamp()}.mp4`)
  P.ensureDir(dirname(out))
  const w = opts.width || 1080, h = opts.height || 1920, fps = opts.fps || 30
  const dur = opts.duration || 3
  const codec = E.pickVideoCodec({ quality: opts.quality || 'balanced' })
  const ext = extname(src).toLowerCase()
  const isImage = P.IMAGE_EXT.has(ext)

  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=${opts.fit === 'contain' ? 'decrease' : 'increase'}`,
    `crop=${w}:${h}`,
    `fps=${fps}`,
    `setsar=1`,
  ].join(',')
  const args = []
  if (isImage) args.push('-loop', '1', '-t', String(dur), '-i', src)
  else args.push('-i', src)
  args.push('-vf', vf, '-an', '-c:v', codec.name, ...codec.args, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', out)
  await E.ffmpeg(args, { timeout: opts.timeout || 600_000 })
  const p = await E.probe(out)
  return { ok: true, path: out, name: basename(out), duration: p ? p.duration : 0, width: w, height: h }
}

// ── 模板（本地 registry，不联网）──────────────────────
/** 装一个模板进工程，装完变成本地 compositions/<name>.html，可随意改。 */
async function addTemplate(project, name, opts = {}) {
  const dir = T.projDir(project)
  // 本地模板库：registry 直接从 数据/模板库/registry 拷，不经 https、不联网。
  // 旧软件要起自签 HTTPS 服务骗过 CLI 的 registry 校验，那是它只能走 https 造成的。
  const src = findTemplateDir(name)
  if (!src) throw new Error(`模板库里没有「${name}」。先用 templates 搜关键词`)

  const comps = join(dir, 'compositions')
  P.ensureDir(comps)
  const dst = join(comps, name + '.html')
  if (!existsSync(dst)) copyFileSync(join(src, name + '.html'), dst)

  /* 模板自己的 lib/ 和 assets/ 必须一起搬。
     ★ 第一版只拷了 components/ —— 模板正文里引用的 lib/liquid-glass.iife.js、
       assets/xxx.svg 全都不在工程里，预览是黑屏、渲染时资源 404。
       这些路径是相对 compositions/<模板>.html 写的，所以原样落到 compositions/ 下。 */
  for (const f of require('node:fs').readdirSync(src)) {
    if (f === name + '.html' || f === 'registry-item.json' || f.startsWith('.')) continue
    const from = join(src, f), to = join(comps, f)
    if (!existsSync(from)) continue
    if (existsSync(to)) continue
    try {
      const st = require('node:fs').statSync(from)
      if (st.isDirectory()) require('node:fs').cpSync(from, to, { recursive: true })
      else copyFileSync(from, to)
    } catch { /* 单个附属文件失败不该让「装模板」整体失败 */ }
  }

  /* 挂进主时间线：必须真的往时间线里写一条 type:'template' 的片段。
       只把文件拷进 compositions/ 是不够的 —— 渲染层靠 data-composition-src 找子合成，
       没有那个 div，模板文件在工程目录里躺着，渲出来什么都没有。 */
  const meta = require('./templates').itemMeta(name)
  /* ★ 2026-11-20：放开 component 类模板也能挂轨。
     原来只认 hyperframes:block，导致 logo-brand-close（component，本体是完整独立
     HTML，能单独渲染）拷进 compositions 却挂不上 g1，还返回 ok:true —— agent 被骗
     连调 4 次白烧 token。component 和 block 都作为 type:'template' clip 挂进时间线。 */
  const isBlock = !!(meta && (meta.type === 'hyperframes:block' || meta.type === 'hyperframes:component'))

  /* 画幅补丁要按「工程画布」算缩放比 —— 先读一眼工程尺寸（工程还不存在就按模板原画幅）。
     放在这里而不是挂片段之后：模板文件在拷贝时就要一次性把补丁写对。 */
  {
    let host = null
    try { const d0 = T.load(project); if (d0) host = { w: d0.width, h: d0.height, fit: opts.fit } } catch (e) {}
    if (host && host.w && host.h) applyFitPatch(dst, meta, host, name)
  }

  let mounted = false
  let clipId = ''
  if (isBlock) {
    const d = T.load(project) || T.blank(project)
    const tr = T.ensureTrack(d, 'g1')
    const at = Math.max(0, Number(opts.at) || 0)
    /* ★ 不传 dur 时用模板自己的设计时长，不写死 3 秒。
       写死 3 秒的后果：19 秒的动画被切到 3 秒，观众只看到开头就切走了 ——
       而且画面是「一半的动效」，看起来像渲染坏了。 */
    const dur = Math.max(0.2, Number(opts.dur) || Number(meta && meta.duration) || 3)
    const c = {
      id: 'tpl-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000),
      type: 'template',
      name,
      src: 'compositions/' + name + '.html',
      start: at,
      duration: dur,
    }
    if (opts.vars && typeof opts.vars === 'object') c.vars = opts.vars
    tr.clips.push(c)
    T.save(project, d)
    mounted = true
    clipId = c.id
  }
  /* ★ ok 字段：调用方（tools.js）按 r.ok 判成功。漏了它，
     加模板成功也会报「❌ undefined」—— 错误信息里连原因都没有。 */
  return { ok: true, name, written: [dst], mounted, clip: clipId, dir: dst }
}

/**
 * 给装进工程的模板 HTML 打「画幅自适应」补丁。
 *
 * 实测结论（这几条都试过，别再走回头路）：
 *   · 把容器宽高改成目标画幅 → 模板内部仍按自己的 1920 算坐标，文字往右溢出被硬切。
 *   · 给容器加 transform:scale / zoom → 子合成按实测宽度重算，越缩越窄，反而更糟。
 *   · 容器保持原画幅 → 内容排得对，但铺满整个画布，左右被裁（竖屏塞横屏就切掉两边）。
 *
 * 所以唯一稳的做法：容器保持模板原画幅（它内部坐标系不变、排版完全正确），
 * 再在模板自己体内加一层 #hf-stage 做整体缩放 + 居中。
 * 缩放比由宿主画布（--hf-w / --hf-h）算出来：contain 保完整，cover 铺满裁边。
 */
function applyFitPatch(htmlFile, meta, host, tplName) {
  try {
    if (!existsSync(htmlFile)) return { ok: false, reason: '文件不在' }
    let s = readFileSync(htmlFile, 'utf8')
    const dim = (meta && meta.dimensions) || {}
    const tw = Number(dim.width) || 1920
    const th = Number(dim.height) || 1080
    /* 宿主画布尺寸直接写死进补丁 —— 不依赖 getComputedStyle 一路往上找。
       子合成在 iframe 里，--hf-w/--hf-h 未必继承得到（实测拿不到，缩放就等于没做）。 */
    const hw = Math.max(1, Math.round(Number(host && host.w) || tw))
    const hh = Math.max(1, Math.round(Number(host && host.h) || th))
    const cover = String((host && host.fit) || 'contain').toLowerCase() === 'cover'
    const k = cover ? Math.max(hw / tw, hh / th) : Math.min(hw / tw, hh / th)
    const ratio = Math.round(k * 10000) / 10000
    const ox = Math.round(((hw - tw * ratio) / 2) * 100) / 100
    const oy = Math.round(((hh - th * ratio) / 2) * 100) / 100
    // 已经是同一画幅比例的，不用缩放，直接返回（不打补丁，模板原样最保险）
    if (Math.abs(ratio - 1) < 1e-3) return { ok: true, skipped: true, reason: '画幅一致' }

    if (s.includes('__HF_FIT_PATCH__')) {
      // 已打过补丁但宿主画幅变了（工程改了尺寸）→ 换掉旧的一段
      s = s.replace(/<style id="__HF_FIT_PATCH__">[\s\S]*?<\/style>/, fitPatchBlock(tw, th, ratio, ox, oy))
      writeFileSync(htmlFile, s, 'utf8')
      return { ok: true, tw, th, ratio }
    }
    s = /<\/head>/i.test(s)
      ? s.replace(/<\/head>/i, fitPatchBlock(tw, th, ratio, ox, oy) + '\n</head>')
      : fitPatchBlock(tw, th, ratio, ox, oy) + s
    writeFileSync(htmlFile, s, 'utf8')
    return { ok: true, tw, th, ratio }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

/** 画幅补丁本体：只加 CSS，不加包裹层。
 *
 * ★ 为什么不能包一层 div：HyperFrames 会把子合成「内联展开」到父文档里
 *   （markFlattenedInnerRoot），展开时子合成根节点的 id 会被**剥掉**、
 *   改打 data-hf-inner-root="true" 标记。所以任何依赖 #id 的包裹层在渲染时都失效。
 *   实测证实：包 #hf-stage、给 body 加 zoom、给 html 加 zoom，三种写法渲出来一模一样 —— 全没生效。
 *   唯一还认的是「子合成自己的根节点」，也就是那个带 data-composition-id 的 div，
 *   展开后它变成 [data-hf-inner-root="true"]。缩放只能打在这个节点上。
 */
function fitPatchBlock(tw, th, ratio, ox, oy) {
  /* 定位口径：子合成根节点展开后是普通绝对定位元素（父容器是画布）。
     用「左上角 50%/50% + translate(-50%,-50%)」把它中心对准画布中心，
     再用 scale 缩放 —— 这是唯一不依赖父级尺寸的写法（canvas 尺寸可以是任意值）。 */
  const bw = Math.round(tw * ratio), bh = Math.round(th * ratio)
  return `<style id="__HF_FIT_PATCH__">
/* 模板画幅自适应（自动生成，勿手改）
   模板内部保持 ${tw}x${th} 坐标系不重排，只在它的根节点上整体等比缩放到 ${bw}x${bh}，并对准画布中心。 */
[data-hf-inner-root="true"]{
  position:absolute!important;
  left:50%!important;top:50%!important;
  width:${tw}px!important;height:${th}px!important;
  margin:0!important;
  transform-origin:center center!important;
  transform:translate(-50%,-50%) scale(${ratio})!important;
}
</style>`
}

function findTemplateDir(name) {
  const reg = join(P.RES_TEMPLATES, 'registry')
  for (const d of ['blocks', 'components']) {
    const p = join(reg, d, name)
    if (existsSync(join(p, name + '.html'))) return p
  }
  return null
}

module.exports = { env, ready, hf, extractJson, renderProject, renderClip, addTemplate, findTemplateDir }
