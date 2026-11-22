'use strict'
/* /api/* 路由层 —— 旧前端的 30 个路径接回 Node 版各模块。
   为什么要有这一层：界面是从旧版搬过来的（12 个页面 15574 行），它们全部通过
   window.api('/api/xxx', {...}) 说话。这一层的唯一职责是把那些调用翻译成
   我们 lib/ 里已有的函数，让界面不改一行就能跑。
   约定与旧版完全一致：成功 {ok:true, data}，失败 {ok:false, error}（HTTP 200）。
*/
const fs = require('node:fs')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const P = require('./paths')
const C = require('./core')

function r_ok(data) { return { ok: true, data: data } }
function rErr(msg) { return { ok: false, error: String(msg || '出错了') } }
function lazy(name) {
  const m = require(name)
  if (!m) throw new Error('模块没加载起来：' + name)
  return m
}
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d }
function str(v, d = '') { return v == null ? d : String(v) }

/* ══════════════ bootstrap：界面启动第一件事，所有初始状态 ══════════════ */
async function bootstrap(d) {
  const M = lazy('./models')
  const A = lazy('./assets')
  const T = lazy('./templates')
  const S = lazy('./skills')
  const TL = lazy('./timeline')
  const E = lazy('./exec')
  const c = C.currentCustomer()
  const ms = M.models()
  const kd = M.KINDS || ['text']
  const label = { text: '文本', vision: '多模态', image: '生图', video: '视频', tts: '语音合成', asr: '语音识别' }
  const list = Object.keys(ms).map((k) => {
    const v = ms[k] || {}
    return {
      id: k, name: v.name, vendor: v.vendor, url: v.url, model: v.model, price: v.price,
      builtin: !!v.builtin, key_set: !!v.key, kind: v.kind || 'text',
      vision: !!v.vision, video: !!v.video, image: !!v.image,
      mtype: v.kind || 'text', mtype_label: label[v.kind || 'text'] || '文本',
      chat: v.chat !== false, roles: v.roles || [], note: v.note || '',
      fallback: v.fallback || '', is_default: k === (M.defaultModelId ? M.defaultModelId() : ''),
      locked: !!v.locked, preset: !!v.preset, presetKey: v.presetKey || '',
    }
  })
  const ready = (v) => !!(str(v.url).trim() && str(v.key).trim())
  const imgs = list.filter((v) => v.image && str(v.model).trim()).map((v) => ({ id: v.id, name: v.name, ready: v.key_set }))
  const vids = list.filter((v) => v.video && str(v.model).trim()).map((v) => ({ id: v.id, name: v.name, ready: v.key_set }))
  const chat = list.filter((v) => v.chat && !v.image && !v.video && str(v.model).trim() && !(v.builtin && !str(v.url).trim()))

  const AU = lazy('./audio')
  const voices = await AU.systemVoices()
  let lib = { items: [], counts: {}, folder: '', available: 0, stale: 0 }
  try { lib = A.library(c) } catch (e) { console.warn('[api] library:', e.message) }
  let skills = []
  try { skills = S.listSkills() } catch (e) { console.warn('[api] skills:', e.message) }
  let projects = []
  try { projects = TL.listProjects ? TL.listProjects() : [] } catch (e) { console.warn('[api] projects:', e.message) }

  return r_ok({
    settings: C.settings(),
    /* ★ 这里的 layout 就是设置页「软件数据根目录 / 配置 / 客户目录 / 产出视频 /
       本地模型 / 中文字体」六个输入框的数据源（前端 fillPaths 读 RiffCut.layout 的
       中文键）。原来给的是 {w:0,h:0,scale:1} —— 界面永远空着，用户以为没读到。
       全站也没有任何地方用 w/h/scale，纯属占了这个字段名。 */
    layout: layoutPaths(),
    models: list,
    default_model: M.defaultModelId ? M.defaultModelId() : '',
    current_model: M.chatModelId ? M.chatModelId() : '',
    chat_models: chat,
    image_models: imgs,
    video_models: vids,
    capabilities: { image: imgs.length > 0, video: vids.length > 0 },
    route: { current: M.chatModelId ? M.chatModelId() : '', chain: [], cooling: [] },
    local_models: { asr: lazy('./asr').status(), tts: { system: voices.good || [] } },
    library: lib,
    tasks: (() => { try { return lazy('./tasks').list({ limit: 30 }).items } catch (e) { return [] } })(),
    projects: projects,
    skills: skills,
    customers: [C.currentCustomer()],
    voices: voices.good || [],
    history: C.usageRecent(30),
    costs: C.usageTotals ? [C.usageTotals()] : [],
    ffmpeg: await ffmpegInfo(),
    customer: c,
    legal: (() => { try { return legal({}).data } catch (e) { return {} } })(),
  })
}

async function ffmpegInfo() {
  try {
    const E = lazy('./exec')
    const r = E.ready ? E.ready() : null
    if (r) return r
  } catch (e) { /* 往下走 */
  }
  const R = lazy('./render')
  const r = await R.ready()
  /* ★ 前端读的是 path / ffprobe_ok，接口原来只给 ffmpeg / ffprobe。
     字段名对不上的后果：设置页「FFmpeg 可执行文件」永远是「—」、
     「ffprobe 异常」永远显示异常 —— 明明两个都在、都能跑。
     两套名字都给，省得以后再猜。 */
  /* ★ 必须包 r_ok：前端 window.api() 只返回 j.data，
     直接返回裸对象的话 j.data 是 undefined ——
     设置页「FFmpeg 可执行文件」永远「读取中…」，而且不报错。 */
  return r_ok(Object.assign({}, r, {
    path: r.path || r.ffmpeg || '',
    ffprobe_ok: r.ffprobe_ok !== undefined ? r.ffprobe_ok : !!r.ffprobe,
  }))
}

/* ══════════════ edit：多轨剪辑工程（界面最重的一块） ══════════════ */
async function edit(d) {
  const TL = lazy('./timeline')
  const act = str(d.action, 'list')
  if (act === 'list') {
    return r_ok({ projects: TL.listProjects() })
  }
  if (act === 'new') {
    const nm = str(d.name).trim() || ('未命名-' + P.stamp())
    const data = TL.blank(nm, num(d.width, 1920), num(d.height, 1080), num(d.fps, 30), num(d.duration, 10))
    TL.save(nm, data)
    return r_ok({ project: data, dir: TL.projDir(nm) })
  }
  if (act === 'get') {
    const nm = str(d.project).trim()
    if (!nm) return rErr('要给工程名')
    const data = TL.load(nm)
    return r_ok({ project: data, assets: TL.assets(nm), dir: TL.projDir(nm) })
  }
  if (act === 'save') {
    const nm = str(d.project).trim()
    if (!nm) return rErr('要给工程名')
    // ★ 界面发的字段名是 project_data（见 05-专业剪辑.html 的 edSave），
    // 旧服务端只认 project，所以「保存」永远写空对象、改的东西一存就丢。两个都认。
    const body = (d.project_data && typeof d.project_data === 'object') ? d.project_data
      : (d.project && typeof d.project === 'object') ? d.project : null
    if (!body) return rErr('工程数据格式不对')
    TL.save(nm, body)
    return r_ok({ project: TL.load(nm) })
  }
  if (act === 'delete') {
    const nm = str(d.project).trim()
    return r_ok({ deleted: TL.del(nm) })
  }
  if (act === 'assets') return r_ok({ assets: TL.assets(str(d.project)) })
  if (act === 'import') {
    const nm = str(d.project).trim()
    const it = TL.importAsset(nm, str(d.path))
    return r_ok({ asset: it })
  }
  if (act === 'add_template') {
    const nm = str(d.project).trim()
    let vars = {}
    if (d.vars && typeof d.vars === 'object') vars = d.vars
    else if (d.vars_json) { try { vars = JSON.parse(str(d.vars_json)) } catch (e) { vars = {} } }
    const R = lazy('./render')
    const r = R.addTemplate(nm, str(d.name).trim(), { start: num(d.start), duration: num(d.duration), vars: vars, brand: str(d.brand) })
    return r_ok(r)
  }
  if (act === 'render') {
    const nm = str(d.project).trim()
    const R = lazy('./render')
    const r = R.renderProject(nm, { final: !!d.final })
    return r_ok(r)
  }
  if (act === 'try_template') {
    /* 「先看看」不是一张静态图：模板是一段带动画的 HTML。
       建一个临时工程（下划线开头，不会出现在工程列表、也不能导出），
       把模板和它的 lib/assets 一起装进去，再用 /edt/ 协议真跑一遍。 */
    const TL = lazy('./timeline')
    const R = lazy('./render')
    const nm = str(d.name).trim()
    if (!nm) return rErr('要给模板名')
    const proj = '_模板试用'
    // 每次试用都从空工程开始：否则连点十个模板，g1 上会叠十条片段
    TL.save(proj, TL.blank(proj, 1920, 1080, 30, 5))
    const r = await R.addTemplate(proj, nm, { at: 0 })
    return r_ok({
      ok: true, mounted: !!r.mounted, duration: r.mounted ? (r.duration || 0) : 0,
      url: '/edt/' + encodeURIComponent(proj) + '/' + encodeURIComponent(nm) + '?auto=1',
    })
  }
  if (act === 'tpl_status') {
    return r_ok({ ok: true, note: '模板预览走 velora://app/edt/ 协议' })
  }

  /* ★ 界面右侧「这个模板能改的内容」面板读的就是这里。
     之前只有一个 act === 'vars'（by 模板名，给 AI 用），界面传的是 action=template_vars
     + clip_id，落到最后一行「不认识的 action」→ 面板永远显示「读不到这个模板的参数」。
     模板明明声明了 6 项可改内容，用户却一个字都改不了。

     这里按**片段**回，不是按模板：同一个模板在这条时间线上装两次，各填各的。
     decl 来自模板源码的 data-composition-variables，values 来自片段自己的 vars。 */
  if (act === 'template_vars') {
    const nm = str(d.project).trim()
    const cid = str(d.clip_id).trim()
    if (!nm) return rErr('要给工程名')
    const data = TL.load(nm)
    if (!data) return rErr('没有这个工程：' + nm)
    let hit = null
    for (const tr of data.tracks || []) {
      for (const c of tr.clips || []) {
        if (String(c.id) === cid) { hit = c; break }
      }
      if (hit) break
    }
    if (!hit) return rErr('这条时间线上找不到片段 ' + cid)
    const TP = lazy('./templates')
    const decl = TP.varsFor('block', String(hit.name || ''))
    /* ★ 没有声明可改项的模板（blocks 210 个里有 147 个、components 238 个里有 54 个）
       以前只能显示「这个模板没有可改项，内容是写死的」，用户换个模板就没法改字。
       现在退一步：把那篇 HTML 里**看得见的文字**扫出来，让用户直接覆盖原文。
       特效全在 script/style 里，一个字都不碰，所以「只换字不改特效」照样成立。 */
    /* ★ 文字表**总是**扫，不再只在「没声明可改项」时才扫：
       现在改字是「直接点预览画面上的文字」，画面里的文字和 t0/t1… 的对应关系
       全靠这张表；有声明可改项的模板（glass-hero 之类）照样得给。 */
    const TPLT = lazy('./tpltext')
    const dir = TL.projDir(nm)
    const f = path.join(dir, String(hit.src || ''))
    const text = fs.existsSync(f) ? TPLT.scanFile(f) : []
    return r_ok({
      items: [{
        clip_id: cid, name: hit.name, decl,
        values: hit.vars || {},
        text,
        edits: hit.edits || {},
        src: hit.src || '',
      }]
    })
  }

  /* 写回模板变量。只改片段的 vars，不动模板源文件 —— 同一个模板装两次互不影响。
     传 vars 就整批替换（面板一次改一个键，前端负责合并后整批发）。 */
  if (act === 'set_template_vars') {
    const nm = str(d.project).trim()
    const cid = str(d.clip_id).trim()
    if (!nm) return rErr('要给工程名')
    const data = TL.load(nm)
    if (!data) return rErr('没有这个工程：' + nm)
    let hit = null
    for (const tr of data.tracks || []) {
      for (const c of tr.clips || []) {
        if (String(c.id) === cid) { hit = c; break }
      }
      if (hit) break
    }
    if (!hit) return rErr('这条时间线上找不到片段 ' + cid)
    let next = {}
    if (d.vars && typeof d.vars === 'object') next = d.vars
    else if (d.vars_json) { try { next = JSON.parse(str(d.vars_json)) } catch (e) { return rErr('vars_json 不是合法 JSON') } }
    /* 空字符串要删掉而不是存空串：模板里 V.headline || "CLARITY" 的兜底逻辑
       遇到空串也会走兜底，但存空串会让「用户故意清空」和「没填过」分不清。 */
    const clean = {}
    for (const k of Object.keys(next)) {
      const v = next[k]
      if (v === '' || v === null || v === undefined) continue
      clean[k] = v
    }
    if (Object.keys(clean).length) hit.vars = clean
    else delete hit.vars

    /* ★ 正文文字覆盖（给没有声明可改项的模板用）。
       为什么不改模板源文件：模板库里的 HTML 是所有工程共用的，改一次全站都变；
       而且同一模板在一条时间线上装两次、各填各的字，也只有副本能做得到。
       所以：源 → 按 edits 覆盖 → 写成这只片段专属的 compositions/<名>--<片段id>.html，
       再把 clip.src 指过去。预览（uiserver 按 src 找文件）与导出
       （data-composition-src 指同一路径）吃的都是这份副本，不会出现
       「预览对了成片不对」这种最难查的问题。 */
    /* text_edits（按原文覆盖）也走这一支：界面点画面改字时只传原文，不传 t-key。 */
    if (d.edits !== undefined || Array.isArray(d.text_edits)) {
      const TPLT = lazy('./tpltext')
      const dir = TL.projDir(nm)
      const base = String(hit.tplSrc || hit.src || '').trim()
      if (!base) return rErr('这条片段没有模板源路径，改不了字')
      if (!hit.tplSrc) hit.tplSrc = base
      /* 源文件按「剥掉副本后缀的原名」去找：tplSrc 被界面保存覆盖掉也能找回来。 */
      const baseExt = path.extname(base) || '.html'
      const baseStemRaw = path.basename(base, baseExt)
      const cidRaw = String(cid).replace(/[^\w-]/g, '')
      let baseStem = baseStemRaw
      if (cidRaw) { const sfx = '--' + cidRaw; while (baseStem.endsWith(sfx)) baseStem = baseStem.slice(0, -sfx.length) }
      const originRel = 'compositions/' + baseStem + baseExt
      let srcAbs = path.join(dir, originRel)
      if (!fs.existsSync(srcAbs)) srcAbs = path.join(dir, base)
      if (!fs.existsSync(srcAbs)) return rErr('模板源文件不在了：' + base)
      let edits = {}
      if (d.edits && typeof d.edits === 'object') edits = d.edits
      else if (typeof d.edits === 'string' && d.edits.trim()) {
        try { edits = JSON.parse(d.edits) } catch (e) { return rErr('edits 不是合法 JSON') }
      }
      /* ★ 按「原文」覆盖（界面在预览画面上直接点字改用这条路）。
         前端不需要知道 t3 对应哪一句：它只知道用户点的那段原文是什么。
         这里拿源模板重新扫一遍，把原文匹配到 t-key 再并进 edits。
         用原文匹配而不是编号，是因为编号是源文件扫描顺序，渲染后的 DOM 顺序
         未必一致（条件渲染、伪元素、SVG），原文比对才稳。
         传 text_edits:'[]' （空数组）＝把这类覆盖全部撤销，回到模板原文。 */
      if (Array.isArray(d.text_edits)) {
        const TPLT0 = lazy('./tpltext')
        const oAbs = path.join(dir, originRel)
        const list = fs.existsSync(oAbs) ? TPLT0.scanFile(oAbs) : []
        const byText = {}
        for (const it of list) if (!byText[it.text]) byText[it.text] = it.key
        const keep = {}
        for (const k of Object.keys(edits)) keep[k] = edits[k]
        /* ★ 第二次改同一句话时，画面上的字已经是上一次改过的了（to 而不是原文），
           拿它去源模板里找原文必然找不到 —— 用户会看到「点了没反应」。
           所以先按原文找，找不到再反查「哪个 t-key 当前的值正好是 from」。 */
        const byValue = {}
        for (const k of Object.keys(keep)) if (!byValue[keep[k]]) byValue[keep[k]] = k
        for (const te of d.text_edits) {
          const from = String((te && te.from) || '').replace(/\s+/g, ' ').trim()
          const to = String((te && te.to) || '').replace(/\s+/g, ' ').trim()
          if (!from) continue
          const k = byText[from] || byValue[from]
          if (!k) continue
          if (to && to !== from) keep[k] = to
          else delete keep[k]
        }
        edits = keep
      }
      /* 空值要删掉：删掉就回到模板原文，面板清空输入框应该等于「不用覆盖」。 */
      const ec = {}
      for (const k of Object.keys(edits || {})) {
        const v = edits[k]
        if (v === '' || v === null || v === undefined) continue
        ec[k] = String(v)
      }
      const ext = path.extname(base) || '.html'
      const cidSafe = String(cid).replace(/[^\w-]/g, '')
      /* ★ 副本名必须是幂等的。
         tplSrc（原模板路径）存在片段上，但界面保存时会把整个 project_data 推上来，
         tplSrc 这种「后端自己记账」的字段会被覆盖掉 —— 曾经因此把上一次的副本
         当成原模板，文件名一路叠成 app-showcase--tpl-x--tpl-x--…（叠了 9 层），
         而且 reads 的源也变成上一版副本，越改越脏。
         这里不依赖 tplSrc 一定还在：把末尾所有 `--<本片段id>` 依次剥掉，
         剥完就是真正的模板名。副本名因此永远只有一层后缀。 */
      let stem = path.basename(base, ext)
      if (cidSafe) {
        const suffix = '--' + cidSafe
        while (stem.endsWith(suffix)) stem = stem.slice(0, -suffix.length)
      }
      const copyRel = 'compositions/' + stem + '--' + cidSafe + ext
      if (Object.keys(ec).length) {
        try {
          TPLT.writeCopy(srcAbs, path.join(dir, copyRel), ec)
        } catch (e) { return rErr('写模板副本失败：' + e.message) }
        hit.edits = ec
        hit.src = copyRel
        hit.tplSrc = originRel
      } else {
        /* 一个字都没覆盖：把副本删掉、src 指回原模板，别在工程里留垃圾文件。 */
        const cpAbs = path.join(dir, copyRel)
        try { if (fs.existsSync(cpAbs)) fs.unlinkSync(cpAbs) } catch (e) {}
        delete hit.edits
        /* ★ 回退目标也要验存在：tplSrc 可能被界面保存覆盖成历史上那个叠了后缀的
           脏名字（文件早删了），直接指过去会让预览 404。存在才用，否则用
           「剥掉副本后缀」算出来的 originRel。 */
        const backAbs = path.join(dir, String(hit.tplSrc || ''))
        hit.src = (hit.tplSrc && fs.existsSync(backAbs)) ? hit.tplSrc : originRel
      }
    }

    TL.save(nm, data)
    return r_ok({ clip_id: cid, vars: hit.vars || {}, edits: hit.edits || {}, src: hit.src || '' })
  }

  return rErr('不认识的 action：' + act)
}


/* ══════════════ settings / ui / workspace ══════════════ */
function settings(d) {
  const s = C.settings()
  const act = str(d.action)
  const patch = d.patch
  if (act === 'set') {
    const ch = {}
    for (const k of Object.keys(d)) if (k !== 'action' && k in C.DEFAULT_SETTINGS) ch[k] = d[k]
    if (!Object.keys(ch).length) return r_ok(s)
    Object.assign(s, ch); C.saveSettings(s); C.history('修改设置', JSON.stringify(ch).slice(0, 100))
    return r_ok(s)
  }
  if (patch && typeof patch === 'object') {
    const ch = {}
    for (const k of Object.keys(patch)) if (k in C.DEFAULT_SETTINGS) ch[k] = patch[k]
    if (!Object.keys(ch).length) return r_ok(s)
    Object.assign(s, ch); C.saveSettings(s); C.history('修改设置', JSON.stringify(ch).slice(0, 100))
    return r_ok(s)
  }
  return r_ok(s)
}

function ui(d) {
  const cur = P.load('ui', {}) || {}
  const act = str(d.action, 'get')
  if (act === 'set') {
    const patch = (d.patch && typeof d.patch === 'object') ? d.patch
      : Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'action'))
    for (const [k, v] of Object.entries(patch)) if (k !== 'action') cur[k] = v
    P.save('ui', cur)
  }
  return r_ok(cur)
}

function workspace(d) {
  const act = str(d.action) || (str(d.root) ? 'add' : 'list')
  try {
    if (act === 'add') C.workspaceAdd(str(d.root))
    else if (act === 'pick') C.workspacePick(str(d.id))
    else if (act === 'forget') C.workspaceForget(str(d.id))
  } catch (e) { return rErr(e.message) }
  const w = C.workspaceRoot()
  const cp = C.custPaths(C.currentCustomer())
  return r_ok({
    workspace: w || '',
    id: str((P.load('settings', {}) || {}).workspace),
    list: C.workspaces(),
    root: cp.root,
    out: cp.videos,
    /* 切完工作区顺手数一下里面有多少素材，前端据此决定要不要提示「要不要先扫一遍」。
       数不了就返回 null 而不是 0 —— 0 会被前端当成「空文件夹，不用提示」，
       但其实只是没读到（权限/刚拔的 U 盘），这两种情况必须分开。 */
    assets: countAssets(cp.root),
  })
}

/* 软件在工作区根下自建的目录名。用户素材绝不可能叫这些名字（真叫了也不影响，
   只是不统计 —— 少算比把成片当素材更不容易误导人）。 */
const OWN_DIRS = new Set([
  '产出', '工程', '缓存', '缩略图', '品牌套件', '音色', 'RiffCut-索引',
])

/* 数工作区根目录下有多少能看的素材（视频/图片）。只看根下两层，
   不递归全盘 —— 用户塞一个 200G 的素材盘进来，递归会把主进程卡死。
   返回 null 表示这个目录根本读不了，不是「没有素材」。 */
function countAssets(root) {
  const VID = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm'])
  const IMG = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.bmp'])
  const out = { video: 0, image: 0, total: 0, scanned: false }
  let ents
  try { ents = fs.readdirSync(String(root), { withFileTypes: true }) } catch (e) { return null }
  const walk = (dir, depth) => {
    if (depth > 2) return
    let list
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of list) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        /* ★ 软件自己在工作区根下建的目录不进统计，否则用户看到「素材 +1」
           其实是自己的成片、或者是缩略图里的一张 jpg。
           这份清单必须和 core.js 的 custPaths() 保持一致 —— 那边多一个目录，
           这边就会把那个目录里的文件当成用户素材。 */
        if (OWN_DIRS.has(e.name)) continue
        walk(full, depth + 1)
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (VID.has(ext)) out.video++
      else if (IMG.has(ext)) out.image++
    }
  }
  walk(String(root), 1)
  out.total = out.video + out.image
  /* ★ 判断「扫过了」不能看 RiffCut-索引 目录在不在。
     那个目录是 custPaths() 一进工作区就 ensureDir 建好的 —— 空目录永远存在，
     于是 scanned 永远是 true，前端永远不会提示「要不要扫一遍」。
     必须看里面有没有真正的索引文件。 */
  try {
    const idxDir = path.join(String(root), 'RiffCut-索引')
    const names = fs.readdirSync(idxDir)
    out.scanned = names.some((n) => /\.json$/i.test(n))
  } catch (e) { out.scanned = false }
  return out
}

/* ══════════════ 素材 ══════════════ */
async function scan(d) {
  const A = lazy('./assets')
  if (!str(d.root)) return rErr('请先选择一个素材文件夹')
  return r_ok(await A.scanFolder(str(d.root), d.customer, !!d.incremental))
}

/* 把一个文件登记进素材库（拖进对话窗的文件走这里）。
   和 scan 的区别：scan 是「扫一整个文件夹」，这个是「加这一个文件」。
   A.ingest 已经在 tools.js 的 assets 工具里用了很久，行为是熟的：
   按 size 判重，生成缩略图，写进 library.json。 */
async function assetsIngest(d) {
  const A = lazy('./assets')
  const p = str(d.path)
  if (!p) return rErr('要给 path（文件绝对路径）')
  const list = p.split(',').map((x) => x.trim()).filter(Boolean)
  const customer = d.customer || C.currentCustomer()
  /* 拖进来的路径本来就是绝对路径（主进程 webUtils 给的），
     不需要 resolveUserPath 那套「相对路径猜目录」的逻辑。
     只做一次存在性检查，把不存在的一次性报清楚。 */
  const fsx = require('node:fs')
  const abs = []
  const miss = []
  for (const one of list) {
    const full = String(one).replace(/^~/, require('node:os').homedir())
    try {
      if (fsx.statSync(full).isFile()) abs.push(full)
      else miss.push(full)
    } catch (e) { miss.push(full) }
  }
  if (!abs.length) return rErr('这些路径都不是文件：' + miss.join(', '))
  const res = await A.ingest(abs, customer)
  return r_ok(res)
}

function library(d) {
  return r_ok(lazy('./assets').library(d.customer || C.currentCustomer()))
}

function indexStatus(d) {
  const A = lazy('./assets')
  const c = d.customer || C.currentCustomer()
  const lib = A.library(c)
  const root = str(d.root) || lib.root || ''
  if (!root) return rErr('还没选素材文件夹')
  const j = A.readIndex(root, c)
  const miss = A.indexMissing ? A.indexMissing(lib.items || []) : { analyzable: 0, missing: 0 }
  return r_ok({
    exists: !!(j && (j.count || 0)), count: (j && j.count) || 0,
    analyzable: miss.analyzable || 0, missing: miss.missing || 0,
    created: (j && j.created) || '', model: (j && j.model) || '',
    path: str(A.indexPath(root, c)),
  })
}

/* ══════════════ 模板 ══════════════ */
function templates(d) {
  const T = lazy('./templates')
  const act = str(d.action, 'list')
  if (act === 'stats') return r_ok(T.stats())
  if (act === 'catalog') return r_ok(T.catalog())
  if (act === 'search') return r_ok(T.search(null, str(d.q), str(d.cat), str(d.kind)))
  if (act === 'vars') return r_ok(T.readVars(str(d.name)))
  return r_ok(T.catalog())
}

/* ══════════════ 音频 ══════════════ */
async function audio(d) {
  const AU = lazy('./audio')
  const act = str(d.action, 'bootstrap')
  if (act === 'bootstrap') {
    const v = await AU.systemVoices()
    /* ★ 首页的「配音音色」弹窗靠这里拿音色清单，但它以前只返回系统音色
       （voices: v.good）—— 没有 groups 字段，界面的 renderVoiceGroups()
       遍历空数组，于是 Ming 的 100 个预设 + 用户自己录的音色一个都不显示。
       用户看到的是「录完了但没有音色可选」，其实是数据没接上。
       这里按 /api/voicemodels 同一套逻辑拼一份 groups（每个可配音模型一组）。 */
    const VM = lazy('./voicemodels')
    let groups = []
    try {
      const cat = await VM.catalog()
      const ms = (cat && cat.models) || []
      for (const m of ms) {
        if (!(m.caps || []).includes('tts')) continue
        let vv = { voices: [], clones_imported: 0, clone_hint: '' }
        try { vv = VM.voices(m.id) || vv } catch (e) {}
        groups.push({
          id: m.id, name: m.name, category: m.category, engine: m.engine,
          desc: m.desc, note: m.note,
          cap_labels: Object.fromEntries((m.caps || []).map((k) => [k, (VM.CAP_LABELS || {})[k] || k])),
          caps: m.caps || [],
          /* state / installed 必须带上 —— 界面的「已就绪 / 未安装」标签读的是这两个字段，
             漏了就会把已经能用的 Ming 显示成「未安装」，用户以为还得再装一遍。 */
          state: m.state || (m.installed ? 'ready' : 'none'),
          installed: !!m.installed,
          used_mb: m.used_mb || 0,
          step: m.step || '',
          can_preview: (m.caps || []).includes('preview'),
          can_clone: (m.caps || []).includes('clone'),
          can_import: (m.caps || []).includes('import'),
          clone_hint: vv.clone_hint || '',
          clones_imported: vv.clones_imported || 0,
          /* 我的音色已经在 voices() 里排在最前，统一带上 is_mine 让界面标金色 */
          voices: (vv.voices || []).map((x) => ({
            name: x.name, label: x.label || x.name, kind: x.kind || '',
            lang: x.lang || 'zh_CN', is_mine: !!x.mine,
          })),
        })
      }
    } catch (e) { /* 语音模型这一层挂了也不该让整个弹窗白屏 */ }
    const voiceCount = groups.reduce((n, g) => n + (g.voices || []).length, 0)
    return r_ok({
      voices: v.good || [],
      groups,
      voice_count: voiceCount,
      group_count: groups.length,
      settings: C.settings ? C.settings() : {},
      music: AU.musicFiles ? AU.musicFiles() : [],
      moods: Object.keys(AU.AUDIO_LAYER_DB || {}),
    })
  }
  if (act === 'preview_voice') {
    /* 试听要把引擎选对：界面选的是 Ming 的音色（电台叙述/纪录片旁白…）就走 Ming，
       选的是 macOS 系统音色才走 say。不分开的话用户选了 Ming 音色听到的是系统女声。
       ★ 选的是「我的音色」时必须走克隆：拿 sample.wav 当参考音频传进去。
       以前这里不问音色来源，一律只传 voice 名字 —— 试听听到的是 Ming 默认嗓子，
       跟真正配音出来的声音不一样，用户会以为克隆没生效。 */
    const vm = str(d.model) || str(d.voice_model) || ''
    const wantMing = vm === 'ming-tts' || (!vm && str(d.engine) === 'mlx')
    const wantSystem = vm === 'macos-system' || str(d.engine) === 'system'
    const VM = lazy('./voicemodels')
    let refFile = ''
    try { refFile = VM.myVoiceFile(str(d.voice)) } catch (e) {}
    const r = await AU.tts(str(d.text) || '这是一段试听', {
      engine: wantSystem ? 'system' : undefined,
      voice: str(d.voice), rate: num(d.rate, 175),
      /* ★ 这里绝不能兜底成 'tts'：audio.js 的模板选择是 `opts.template || autoTemplate || (useInstruct?'freeform':'tts')`，
         一兜底就把 autoTemplate/freeform 短路掉了 —— 表现是「换音色试听声音全一样」。
         只有调用方明确点名模板时才传，其余交给 audio.js 按音色的 instruct 自己选。 */
      template: str(d.template) || (str(d.emotion) ? 'emotion' : ''),
      language: str(d.language) || 'zh',
      emotion: str(d.emotion), speed: str(d.speed),
      pitch: str(d.pitch), volume: str(d.volume), instruct: str(d.instruct),
      voiceName: str(d.voice),
      voiceRef: refFile || undefined,
      referenceText: refFile ? str(d.reference_text) : undefined,
      strictMing: !!refFile,
    })
    return r_ok(r)
  }
  if (act === 'preview_music') {
    const r = await AU.makeBgm({ mood: str(d.mood, '温暖'), seconds: num(d.seconds, 8) })
    return r_ok(r)
  }
  if (act === 'pick_music') return r_ok(AU.musicFiles ? AU.musicFiles() : [])
  /* ★ 首页「保存配音设置」调的就是 save_voice，但这里以前没这个分支 ——
     走末尾兜底返回 ok:true + note「这个 action 还没接」，前端看见 ok 就当成功，
     于是用户选的音色从来没被真的存下来，出片永远用默认嗓子。 */
  if (act === 'save_voice') {
    const S = lazy('./core')
    const patch = {}
    const src = str(d.source)
    if (src === 'auto' || src === 'off' || src === 'choose') patch.voice_source = src
    if (d.rate !== undefined) patch.voice_rate = num(d.rate, 175)
    if (d.volume !== undefined) patch.voice_volume = num(d.volume, 1)
    const mid = str(d.model_id) || str(d.model)
    const vid = str(d.voice_id) || str(d.voice)
    if (mid) {
      /* 当前生效的语音模型 + 音色，出片时 A.tts 会读这两个 */
      if (vid) patch.voice = vid
      patch.voice_model = mid
    }
    try {
      const vm = lazy('./voicemodels')
      if (mid && vid) vm.savePicks(mid, vid, [vid], [])
    } catch (e) {}
    const st = S.settings()
    Object.assign(st, patch)
    S.saveSettings(st)
    return r_ok({
      ok: true, settings: patch,
      note: vid ? ('配音音色已存为「' + vid + '」，出片会用这个声音念') : '配音设置已保存',
    })
  }
  if (act === 'reveal') return r_ok({ path: str(d.path) })
  return r_ok({ note: '这个 action 还没接：' + act, unsupported: true })
}

/* ══════════════ 模型 ══════════════ */
async function models(d) {
  const M = lazy('./models')
  const act = str(d.action, 'list')
  const ms = M.models()
  const pub = (v) => ({
    id: v.id, name: v.name, vendor: v.vendor, url: v.url, model: v.model,
    price: v.price, builtin: !!v.builtin, key_set: !!v.key, kind: v.kind || 'text',
    vision: !!v.vision, video: !!v.video, image: !!v.image, chat: v.chat !== false,
    roles: v.roles || [], note: v.note || '', fallback: v.fallback || '',
    locked: !!v.locked, preset: !!v.preset, presetKey: v.presetKey || '',
  })
  if (act === 'list') return r_ok(Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, pub(Object.assign({ id: k }, v))])))
  if (act === 'presets') return r_ok({ presets: M.snapshot().presets })
  if (act === 'invite') {
    const r = M.setInvite(str(d.preset), d.code)
    return r_ok(r)
  }
  if (act === 'use') { M.setChatModel(str(d.id)); return r_ok({ model: str(d.id) }) }
  if (act === 'save') { const r = M.saveModel(d.model || d); return r_ok(pub(Object.assign({ id: (d.model || d).id }, r || {}))) }
  if (act === 'delete') { M.deleteModel(str(d.id)); return r_ok({ deleted: true }) }
  if (act === 'test' || act === 'test_vision') { const r = await M.test(str(d.id)); return r_ok(r) }
  return r_ok(Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, pub(Object.assign({ id: k }, v))])))
}

/* ══════════════ 插件 ══════════════ */
/* 新工程没有 dsh_plugins.py 那套（那是旧 Python 版的）；插件清单现在由内核自己报，
   界面直接问内核的 plugin_manager 工具代价太高（一轮模型几十秒），
   所以这里读 profile 的 package.json + 内核包目录自己拼，纯文件操作。 */
function plugins(d) {
  const K = lazy('./kernel')
  const act = str(d.action, 'list')
  const kd = K.KERNEL_DIR
  /* ★ 2026-11-20：内核 profile 搬到了 HOME/内核/profiles（见 lib/paths.js），
     兜底旧位置让没迁完的用户也能看到插件列表。 */
  let prof = path.join(P.KERNEL_HOME, 'profiles', 'velora')
  if (!fs.existsSync(prof)) {
    const legacy = path.join(P.HOME, 'profiles', 'velora')
    if (fs.existsSync(legacy)) prof = legacy
  }
  const pkgFile = path.join(prof, 'package.json')
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch (e) { pkg = {} }
  const sel = ((pkg.dsh || {}).profile || {}).bundles || []
  const deps = pkg.dependencies || {}
  const all = []
  try {
    const nm = path.join(kd, 'node_modules', '@deepseek-ai')
    for (const n of fs.readdirSync(nm)) {
      if (!n.startsWith('dsh-')) continue
      let pj = null
      try { pj = JSON.parse(fs.readFileSync(path.join(nm, n, 'package.json'), 'utf8')) } catch (e) { continue }
      if (!pj.dsh || !pj.dsh.bundle) continue
      all.push({ name: pj.name, version: pj.version, title: (pj.dsh.bundle || {}).title || pj.name })
    }
  } catch (e) { /* 内核没装也不耽误界面上其他东西 */ }

  /* 市场装的插件不在内核 @deepseek-ai 目录里，而在 profile 自己的
     node_modules（dsh plugin --profile add 装的）。原来只扫内核目录，
     导致「已装的」永远看不到市场装的插件。这里把 deps 里实际装到盘的
     第三方包补进来，带上版本/说明，标 source:'market'。 */
  const seen = new Set(all.map((b) => b.name))
  try {
    const pnm = path.join(prof, 'node_modules')
    for (const name of Object.keys(deps)) {
      if (seen.has(name)) continue
      let pj = null
      // 支持 @scope/name 和裸 name 两种路径
      try { pj = JSON.parse(fs.readFileSync(path.join(pnm, name, 'package.json'), 'utf8')) } catch (e) {
        try { pj = JSON.parse(fs.readFileSync(path.resolve(prof, name, 'package.json'), 'utf8')) } catch (e2) { continue }
      }
      if (!pj || !pj.name) continue
      seen.add(name)
      all.push({
        name: pj.name, version: pj.version,
        title: (pj.dsh && pj.dsh.bundle && pj.dsh.bundle.title) || pj.name,
        desc: String(pj.description || '').slice(0, 300),
        source: 'market',
      })
    }
  } catch (e) { /* profile 没装第三方插件也正常 */ }
  if (act === 'set') {
    const name = str(d.name), on = !!d.enabled
    const next = on ? Array.from(new Set(sel.concat([name]))) : sel.filter((x) => x !== name)
    pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}; pkg.dsh.profile.bundles = next
    try {
      if (fs.existsSync(pkgFile)) fs.copyFileSync(pkgFile, pkgFile + '.bak')
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    } catch (e) { return rErr('写 profile 失败：' + e.message) }
    return r_ok({ name: name, enabled: on, bundles: next, restart_required: true })
  }

  if (act === 'market') {
    // 真市场：awesome-dsh-plugin 的 format:1 索引（6100+ 个），Node 自己拉
    const M = lazy('./market')
    return M.list({ query: str(d.query), limit: num(d.limit, 60), offset: num(d.offset, 0), force: !!d.force })
  }

  if (act === 'install') {
    // 真装：npm 装进内核 node_modules，再写进 profile 的 bundles。
    // 走内核 plugin_manager 工具的话要等一轮模型（几十秒），用户点一下不该等这个。
    return installPlugin(d, kd, prof, pkg, pkgFile, sel)
  }

  if (act === 'remove') {
    const name = str(d.name)
    const next = sel.filter((x) => x !== name)
    pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}; pkg.dsh.profile.bundles = next
    if (pkg.dependencies && pkg.dependencies[name]) delete pkg.dependencies[name]
    try {
      if (fs.existsSync(pkgFile)) fs.copyFileSync(pkgFile, pkgFile + '.bak')
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    } catch (e) { return rErr('写 profile 失败：' + e.message) }
    return r_ok({ name: name, removed: true, restart_required: true })
  }
  return r_ok({
    bundles: all.map((b) => Object.assign({}, b, { enabled: sel.includes(b.name), installed: !!deps[b.name] })),
    enabled: sel, total: all.length,
    kernel: (() => { try { return K.status ? K.status() : { dir: kd } } catch (e) { return { dir: kd } } })(),
    states: {},
  })
}



/**
 * 装一个插件：npm 装到内核的 node_modules，再写 profile。
 *
 * 为什么直接调 npm 而不是内核自带的 pnpm：内核的 plugin_manager 走的是
 * profile 目录里那套 pnpm 流程，要起 pnpm、要联网、还要走一轮模型的审批，
 * 界面上点一个按钮等 60 秒没法用。这里用 `npm install --prefix <kernel>`，
 * hoisted 结构和内核自己装的一致（193 个包全在顶层）。
 *
 * spec 支持三种：
 *   name@1.2.3        → npm 包（市场里绝大多数）
 *   git+https://...#commit  → 从 git 装（市场里没有 npm 版本的）
 *   dsh plugin add X  → 市场 install 字段是整条命令，取最后一个 token
 */
function installPlugin(d, kd, prof, pkg, pkgFile, sel) {
  const { execFileSync } = require('node:child_process')
  const name = str(d.name)
  let spec = str(d.spec) || name
  if (/^dsh\s/.test(spec)) spec = spec.trim().split(/\s+/).pop()
  if (!name) return rErr('没说装哪个')

  /* ★ 走 DSH 官方的 plugin 通道，不要自己拼 npm。
     踩过的坑：原来拼的是 kernel/dsh/node_modules/npm/bin/npm-cli.js，
     但内核里根本没有 npm 这个包（它整套是 pnpm 装的）→ 报
     Cannot find module '.../node_modules/npm/bin/npm-cli.js'，
     界面显示成 Cannot find module '/Use...'（被截断），
     看起来像「包本身坏了」，实际是包管理器找错了。
     官方通道是 `dsh plugin --profile <名字> add <包>`，它把参数原样转给 pnpm，
     在 profile 目录里跑 —— 装进 profile 自己的 node_modules，内核启动时正好从那里加载。 */
  const nodeBin = path.join(kd, 'node')
  const entry = path.join(kd, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(nodeBin)) return rErr('内核自带的 node 不在：' + nodeBin)
  if (!fs.existsSync(entry)) return rErr('内核入口不在：' + entry)
  const t0 = Date.now()
  try {
    /* ★ --profile 要的是名字不是路径（传路径报 dsh: invalid profile name） */
    const profName = path.basename(String(prof || 'velora'))
    const args = [entry, 'plugin', '--profile', profName, 'add', spec]
    const out = execFileSync(nodeBin, args, {
      cwd: kd,
      timeout: 8 * 60 * 1000,
      encoding: 'utf8',
      /* ★ DSH_HOME 必须指到我们自己的数据目录。
         不带它时 dsh 用默认的 ~/.dsh —— 插件会装进用户的个人 dsh 里，
         我们软件启动时读 home/profiles/velora，两边对不上，装了等于没装。
         实测日志：initialized profile velora at /Users/lov0u/.dsh/profiles/velora */
      env: Object.assign({}, process.env, { CI: '1', NO_COLOR: '1', DSH_HOME: P.HOME }),
    })
    const ms = Date.now() - t0
    // 写 profile：dependencies + bundles 两处都要
    pkg.dependencies = pkg.dependencies || {}
    pkg.dependencies[name] = spec
    pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = Array.from(new Set((sel || []).concat([name])))
    try {
      if (fs.existsSync(pkgFile)) fs.copyFileSync(pkgFile, pkgFile + '.bak')
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
    } catch (e) {
      // profile 写失败就把 npm 装的那份撤掉，别留一个装了但不生效的幽灵包
      try { execFileSync(nodeBin, [entry, 'plugin', '--profile', path.basename(String(prof || 'velora')), 'remove', name], { cwd: kd, timeout: 180000 }) } catch (e2) {}
      return rErr('插件装上了但 profile 写不进去：' + e.message)
    }
    return r_ok({
      name: name, spec: spec, ms: ms,
      restart_required: true,
      note: '装好了。内核只在启动时读 profile，所以要重启软件才生效。',
      output: String(out || '').slice(-400),
    })
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || e)
    return rErr('装失败（' + spec + '）：' + msg.slice(0, 400))
  }
}


/* ══════════════ 内核能力（工具 / 技能 / 插件 / 会话 / 子智能体） ══════════════ */
/**
 * 「我到底有哪些能力」这一页唯一的数据源。
 *
 * 为什么要专门一个接口：90 个工具、41 条技能、18 个随包 bundle、若干装上的插件，
 * 散在 five 个模块里，界面上一个都看不见。用户没法确认「移植到底齐没齐」，
 * 只能听我说 —— 这不叫可验证。这一页就是把它们一次列全，点开能看参数。
 */
/**
 * 本地模型管理（旧前端 live.js 的 /api/localmodels，6 处调用）。
 * action: status / install / uninstall / purge / reveal
 */
/**
 * 任务与子智能体（/api/agents）。
 * 任务队列来自 lib/tasks.js —— 那是软件自己派出去的后台活儿（扫描素材、渲片、下载）。
 * 子智能体来自 lib/agents.js —— 那是内核自己开出来的并行分身。
 * 两者不是一回事，界面要分开画，混在一起用户会以为「渲片」也算 AI 在思考。
 */
function agents(d) {
  const G = lazy("./agents")
  const T = lazy("./tasks")
  const act = str(d.action, "list")
  if (act === "clear") return r_ok(G.clear())
  const subs = G.list()
  let tk = { items: [], counts: {}, total: 0, running: 0, queued: 0 }
  try { tk = T.list({ limit: num(d.limit, 60) }) || tk } catch (_) {}
  return r_ok({
    subagents: subs.items, subRunning: subs.running, subDone: subs.done, subFailed: subs.failed
    , tasks: tk.items || [], counts: tk.counts || {}, taskTotal: tk.total || 0
    , taskRunning: tk.running || 0, taskQueued: tk.queued || 0
  })
}
/* ══════════════ 后台工位（/api/workers） ══════════════ */
/**
 * 主对话派出去的分包活。
 *
 * 跟 /api/agents 的区别：agents 是**内核自己**开的并行分身（同一轮里的事），
 * workers 是**我们**另开会话起的工位 —— 主对话那一轮早结束了，它们还在跑。
 * 所以界面上要分开画：一个是「AI 正在同时想几件事」，一个是「派出去几个活儿」。
 */
function workers(d = {}) {
  const W = lazy('./workers')
  const act = str(d.action, 'list')
  if (act === 'one') return r_ok(W.one(str(d.id)) || null)
  if (act === 'say') {
    const id = str(d.id), t = str(d.text)
    if (!id || !t) throw new Error('say 需要 id 和 text')
    W.say(id, t).catch(() => {})
    return r_ok({ ok: true, id })
  }
  if (act === 'stop') return r_ok(W.stop(str(d.id)))
  if (act === 'clear') return r_ok(W.clear(str(d.id)))
  if (act === 'snapshot') return r_ok(W.snapshot())
  return r_ok(W.list())
}

/* ── 下面这些是旧前端页面里真在用的接口，缺一个就有一整块功能是死的 ── */

/** /api/voicemodels —— 配音页整页挂在它上面（左栏模型目录、右栏音色、摆位持久化） */
async function voicemodels(d = {}) { return r_ok(await lazy('./voicemodels').main(d)) }

/** /api/kb —— 知识库页（列表 / 增删改） */
function kb(d = {}) {
  const K = lazy('./kb')
  const act = str(d.action, 'list')
  if (act === 'list') return r_ok({ items: K.list(), cats: K.CATS })
  if (act === 'get') {
    const hit = K.list().find((x) => x.id === str(d.id))
    if (!hit) throw new Error('找不到条目 ' + str(d.id))
    return r_ok(hit)
  }
  if (act === 'add') return r_ok(K.add(d))
  throw new Error('不认识的 action：' + act)
}

/** /api/brand —— 品牌套件 + 出片预设（首页「套用模板」下拉吃它的 presets） */
function brand(d = {}) {
  const B = lazy('./brand')
  const act = str(d.action, 'bootstrap')
  if (act === 'bootstrap' || act === 'list' || act === 'kits') {
    return r_ok(B.bootstrap(d.customer || C.currentCustomer()))
  }
  if (act === 'save_kit') return r_ok(B.saveKit(d))
  if (act === 'delete_kit') return r_ok(B.deleteKit(d))
  throw new Error('不认识的 action：' + act)
}

/** /api/usage / /api/deps / /api/customers / /api/analytics / /api/reveal / /api/multiversion */
function usage(d = {}) { return r_ok(lazy('./insights').usage(d)) }
async function depsApi(d = {}) { return r_ok(await lazy('./insights').deps(d)) }
function customers(d = {}) { return r_ok(lazy('./insights').customers(d)) }
function analytics(d = {}) { return r_ok(lazy('./insights').analytics(d)) }
function reveal(d = {}) { return r_ok(lazy('./insights').reveal(d)) }
function multiversion(d = {}) { return r_ok(lazy('./insights').multiversion(d)) }

/** /api/vision/analyze —— 抽帧交给视觉模型看；没有视觉模型就如实说没有 */
async function visionAnalyze(d = {}) { return r_ok(await lazy('./assetsview').analyze(d)) }

/** /api/assets/organize —— 默认 dry（只算不搬），带 exec:1 才真动 */
function assetsOrganize(d = {}) { return r_ok(lazy('./assetsview').organize(d)) }

/** /api/update —— 本版没有在线更新通道，如实说没有，不假装在下载 */
/* 在线更新。以前这里固定返回 supported:false（占位），现在接真模块。
   action: status（默认）/ check / download / install / cancel / save */
async function update(d = {}) {
  const U = lazy('./updater')
  const act = str(d.action, 'status')
  try {
    if (act === 'status') return r_ok(U.status())
    if (act === 'check') return r_ok(await U.check({ force: !!d.force, feed_url: d.feed_url }))
    if (act === 'download') {
      const r = await U.download({ feed: d.feed && typeof d.feed === 'object' ? d.feed : undefined })
      return r_ok(r)
    }
    if (act === 'progress') return r_ok(U.job(str(d.job_id)) || { state: 'unknown' })
    if (act === 'jobs') return r_ok(U.listJobs())
    if (act === 'cancel') return r_ok(U.cancelDownload(str(d.job_id)))
    if (act === 'install') {
      /* 装之前再校一次 sha256：下载和安装是两次 IPC，
         中间包有可能被换掉（尤其更新包放在共享目录时）。 */
      const f = str(d.file)
      if (!f) return rErr('缺少更新包路径')
      const c = U.cfg()
      if (c.require_sha256 && d.sha256) {
        const got = await U.sha256File(f)
        if (String(got).toLowerCase() !== String(d.sha256).toLowerCase()) {
          return rErr('安装前复核 sha256 不通过（包可能被替换过），已中止')
        }
      }
      return r_ok(await U.install({ file: f }))
    }
    if (act === 'save') {
      const patch = {}
      for (const k of ['feed_url', 'channel', 'check_on_start', 'auto_download', 'require_sha256', 'timeout_seconds', 'enabled']) {
        if (d[k] !== undefined) patch[k] = d[k]
      }
      return r_ok(U.saveCfg(patch))
    }
    return rErr('在线更新：不认识的 action「' + act + '」')
  } catch (e) {
    return rErr(String((e && e.message) || e))
  }
}
async function localmodels(d = {}) {
  const LM = lazy('./localmodels')
  const act = str(d.action, 'status')
  /* list / status / check 都当「看状态」—— 前端三个页面各写了一个词，
     少认一个就有一页是死的。install/uninstall/purge/reveal 才需要真动作。 */
  /* ★ 必须包 r_ok：LM.status() 返回的是裸对象，没有 ok 字段。
     uiserver 原样转发 r，界面判 r.ok 是 undefined 就把整页当失败。 */
  if (act === 'status' || act === 'list' || act === 'check') return r_ok(await LM.status())
  if (act === 'install') return r_ok(await LM.install(str(d.kind)))
  if (act === 'cancel') return r_ok(LM.cancelInstall(str(d.kind)))
  if (act === 'uninstall') return r_ok(await LM.uninstall(str(d.kind)))
  if (act === 'purge') return r_ok(await LM.purge(str(d.confirm)))
  if (act === 'reveal') return r_ok(LM.reveal())
  throw new Error('本地模型：不认识的 action「' + act + '」')
}

async function kernelAbility(d) {
  const T = lazy('./tools')
  const S = lazy('./skills')
  const K = lazy('./kernel')
  const C2 = lazy('./core')
  const R = T.REGISTRY || {}
  const lv = str(d.level) || C2.levelOf()
  const cust = str(d.customer) || C2.currentCustomer()

  // 按用途分组的顺序 —— 不按字母排，按「做一条片会走到的顺序」排
  const GROUPS = [
    ['出片', ['generate', 'render_clip', 'edit_timeline', 'timeline', 'render_status', 'make_slideshow']],
    ['体检', ['plan_check', 'plan_format', 'hook_check', 'pacing_check', 'truth_check', 'gate', 'gate_check', 'film_check', 'film_match', 'review', 'think']],
    ['素材', ['assets', 'stock_search', 'stock_fetch', 'make_image', 'image_text', 'image_review', 'image_prompt', 'copy', 'move', 'characters']],
    ['音频', ['voice', 'add_voiceover', 'add_music', 'sound_fx', 'music_bpm', 'rhythm', 'tighten', 'highlight', 'words', 'transcribe_media']],
    ['字幕', ['subtitle', 'subtitle_style', 'subtitle_burn', 'add_caption']],
    ['视觉库', ['templates', 'template_vars', 'template_recipe', 'template_family', 'transitions', 'camera_moves', 'color_looks', 'look', 'style', 'reveals', 'layouts', 'speed_curve']],
    ['交付', ['vertical', 'platform', 'probe_media', 'verify_media', 'study', 'swap_hook']],
    ['发布', ['publish', 'publish_center', 'hotspot', 'analytics']],
    ['文件', ['read', 'grep', 'ls', 'probe']],
    ['管理', ['customers', 'projects', 'works', 'tasks', 'conversations', 'models', 'settings', 'capabilities', 'editor', 'history', 'insights', 'deps']],
    ['自我', ['self_note', 'self_rules', 'self_inspect', 'self_patch', 'self_audit', 'self_forget', 'kb_search', 'note', 'skills', 'experiment', 'openapi']],
  ]
  const seen = new Set()
  const groups = GROUPS.map(([g, names]) => {
    const items = names.filter((n) => R[n]).map((n) => {
      seen.add(n)
      const t = R[n]
      return {
        name: n,
        desc: String(t.desc || '').split('。')[0].slice(0, 120),
        level: t.level || '只读',
        mutates: t.mutates || '',
        danger: !!t.danger,
        args: t.args ? Object.keys(t.args) : [],
        allowed: T.allowed ? T.allowed(t, cust) : true,
      }
    })
    return { title: g, items: items }
  }).filter((g) => g.items.length)
  // 没归组的（新加的、或我漏写的）单独一栏，不许悄悄丢掉 —— 丢了就会以为「没有这个能力」
  const rest = Object.keys(R).filter((n) => !seen.has(n)).sort()
  if (rest.length) {
    groups.push({
      title: '其他',
      items: rest.map((n) => {
        const t = R[n]
        return { name: n, desc: String(t.desc || '').split('。')[0].slice(0, 120), level: t.level || '只读', mutates: t.mutates || '', danger: !!t.danger, args: t.args ? Object.keys(t.args) : [], allowed: T.allowed ? T.allowed(t, cust) : true }
      }),
    })
  }

  // 技能：41 条导演技能，是我们自己写的可复用流程
  let skills = []
  try {
    skills = (S.listSkills() || []).map((x) => ({
      name: x.name || x.slug || '',
      title: x.title || x.name || '',
      desc: String(x.desc || x.summary || '').slice(0, 100),
      cat: x.cat || x.category || '',
    }))
  } catch (e) { skills = [] }

  let kernel = { ok: false }
  try { kernel = Object.assign({ ok: true }, K.probe ? K.probe() : {}) } catch (e) { kernel = { ok: false, reason: e.message } }

  return r_ok({
    groups: groups,
    total: Object.keys(R).length,
    level: lv, levels: T.LEVELS || [],
    scope: C2.scopeOf(), scopes: C2.SCOPE_LEVELS || [],
    skills: skills, skillTotal: skills.length,
  })
}

/* ══════════════ 发布（首页看板与发布中心都要） ══════════════ */
async function publish(d) {
  const Pub = lazy('./publish')
  const act = str(d.action, 'list')
  if (act === 'stats') {
    /* 发布数据现在没有真实的回收渠道（各平台要登录态才能读），
       与其编几条好看的曲线，不如把「还没有」如实说清楚。 */
    return r_ok({ items: [], total: 0, note: '还没有发布记录。发过一条之后这里才有数据。', platforms: Pub.platforms ? Pub.platforms() : [] })
  }
  if (act === 'latest') return r_ok({ items: [], note: '还没有发布过成片' })
  if (act === 'platforms') return r_ok(Pub.platforms ? Pub.platforms() : {})
  if (act === 'login_check') return r_ok({ platform: str(d.platform), ok: false, note: '要先在浏览器里登录一次' })
  if (act === 'pick_file') return r_ok({ path: '', note: '选文件走系统对话框，这个接口还没接' })
  if (act === 'card_audit') return r_ok({ ok: true, items: [], note: '卡片自检还没接' })
  return r_ok({ items: [], note: '这个 action 还没接：' + act })
}

/* ══════════════ 授权档 / 系统 ══════════════ */
function agent(d) {
  const T = lazy('./tools')
  const act = str(d.action, 'tools')
  if (act === 'level') {
    const lv = str(d.level)
    if (!T.LEVELS.includes(lv)) return rErr('授权档只能是：' + T.LEVELS.join('、'))
    C.setLevel(lv); return r_ok({ level: lv })
  }
  if (act === 'scope') {
    const sc = str(d.scope)
    if (!(C.SCOPE_LEVELS || []).includes(sc)) return rErr('可访问范围只能是：' + (C.SCOPE_LEVELS || []).join('、'))
    C.setScope(sc); return r_ok({ scope: sc })
  }
  return r_ok({
    level: C.levelOf(), levels: T.LEVELS, scope: C.scopeOf(),
    scopes: C.SCOPE_LEVELS, roots: T.roots(C.currentCustomer()).map((r) => ({ label: r.label, path: str(r.path) })),
    spec: T.toolSchema ? T.toolSchema(C.currentCustomer()) : [],
  })
}

function tasks(d) {
  const TK = lazy('./tasks')
  const act = str(d.action, 'list')
  if (act === 'cancel') return r_ok(TK.cancel(str(d.id)))
  if (act === 'logs') return r_ok(TK.tail(str(d.id), num(d.since)))
  /* 「清空已完成」按钮。前端文案承诺清掉已完成/失败/取消的记录、在跑的不动。
     TK.clear 默认 keep=40 —— 队列本来就不到 40 条时清了等于没清，按钮看着就没反应。
     所以这里显式 keep=0：只留运行中/排队中的任务，历史一次清干净。 */
  if (act === 'clear') return r_ok(TK.clear(0))
  return r_ok(TK.list({ limit: num(d.limit, 40), state: str(d.state) }))
}

function works(d) {
  const T = lazy('./tools')
  const act = str(d.action, 'list')
  if (act === 'reveal') return r_ok({ path: str(d.path) })
  const r = T.call('works', { action: 'list' }, C.currentCustomer())
  return r_ok({ items: [], raw: r.text || '' })
}

function projects(d) {
  const TL = lazy('./timeline')
  const act = str(d.action, 'list')
  if (act === 'open') return r_ok({ dir: TL.projDir(str(d.name)) })
  return r_ok({ items: TL.listProjects() })
}

function skills(d) {
  const S = lazy('./skills')
  const act = str(d.action, 'list')
  if (act === 'save') return r_ok(S.writeSkill(d.id, d.title, d.tag, d.params, d.body))
  if (act === 'delete') return r_ok(S.deleteSkill(str(d.id)))
  return r_ok(S.listSkills())
}

function conversations(d) {
  /* 两个来源，按 action 分流：
     - save / get / flow / delete / archive / export / list(默认)  → lib/convo.js（用户对话存档）
     - 内核会话（内核真跑了什么）                                  → action:'kernel' 走 lib/sessions.js
     旧前端首页写的 action:save/get/flow 都在 convo 这边，不能拿内核会话顶替 ——
     内核会话是只读的 jsonl，用户改标题、归档、追加消息都写不进去。 */
  const act = str(d.action, 'list')
  if (act === 'kernel' || act === 'kernel_get') {
    const SS = lazy('./sessions')
    if (act === 'kernel_get') return r_ok(SS.detail(str(d.id)))
    return r_ok(SS.list({ limit: num(d.limit, 40) }))
  }
  const CV = lazy('./convo')
  if (act === 'save') {
    /* ★ 工作区名由后端补，别信前端传的：
       前端各入口（首页 convNew / AI导演页 / OpenAPI）有的传 folder、有的什么都不传，
       从不传 workspace。侧栏却按它分组，结果选了工作区对话仍堆在「影创」下。 */
    if (!str(d.workspace)) {
      try {
        const wn = C.workspaceName()
        if (wn) d = Object.assign({}, d, { workspace: wn })
      } catch (e) { /* 读不到当前工作区就按原样存，不该挡住对话 */ }
    }
    return r_ok(CV.save(d))
  }
  if (act === 'get') {
    const r = CV.get(str(d.id))
    if (!r.ok) throw new Error(r.error)
    return r_ok(r)
  }
  if (act === 'flow') {
    const r = CV.get(str(d.id))
    if (!r.ok) throw new Error(r.error)
    return r_ok({ brief: r.brief, fields: r.briefFields, id: r.id, title: r.title })
  }
  if (act === 'delete') return r_ok(CV.del(str(d.id)))
  if (act === 'archive') return r_ok(CV.archive(str(d.id), true))
  if (act === 'unarchive') return r_ok(CV.archive(str(d.id), false))
  if (act === 'pin') return r_ok(CV.pin(str(d.id), d.pin === undefined ? true : !!d.pin))
  if (act === 'export') {
    const r = CV.exportText(str(d.id))
    if (!r.ok) throw new Error(r.error)
    return r_ok(r)
  }
  return r_ok(CV.list({ customer: d.customer, limit: num(d.limit, 50), includeArchived: !!d.archived }))
}
async function hotspot(d) {
  const H = lazy('./hotspot')
  const act = str(d.action, 'board')
  /* 平台清单：前端「今日热点」「热点雷达」开局都要它画平台按钮。
     注意返回的是数组，window.api 剥掉外层后前端拿到数组本身。 */
  if (act === 'platforms') return r_ok(H.platforms ? H.platforms() : [])
  /* 抓一个平台的实时榜。前端热点雷达传 fresh:1 表示用户点了「刷新」——
     跳过 5 分钟缓存重新抓；首页不传 fresh，走缓存省得被限流。
     H.fetch 返回 {ok,platform,items[],source,at}，正好是前端 itemsOf() 认的形状。 */
  if (act === 'fetch') {
    const pf = str(d.platform, 'weibo')
    const lim = num(d.limit, 20)
    return r_ok(await H.fetch(pf, lim, !d.fresh))
  }
  /* 出选题：前端传的是 {items:[...], keywords:'科技,AI', n:3}。
     旧代码写成 topicIdeas(d.platform, d.keyword) —— 把平台名当榜单传、
     keyword 还少个 s，结果永远是空 suggestions，按钮形同虚设。 */
  if (act === 'ideas') {
    const items = Array.isArray(d.items) ? d.items : []
    const kws = d.keywords == null ? str(d.keyword, '') : d.keywords
    return r_ok({ ideas: H.topicIdeas ? H.topicIdeas(items, kws, num(d.n, 3)) : [] })
  }
  /* 默认 board：多平台合并榜，一次给几个平台的榜单。 */
  return r_ok(H.board ? await H.board(null, num(d.limit, 10)) : {})
}

function openapi(d) {
  const O = lazy('./openapi')
  const act = str(d.action, 'status')
  if (act === 'rotate') return r_ok(O.rotateKey())
  if (act === 'docs') return r_ok(O.spec())
  return r_ok(O.status())
}

/** 软件各目录的真实位置，给设置页那排只读输入框。键名照旧前端读的那套。 */
function layoutPaths() {
  try {
    const cp = C.custPaths(C.currentCustomer())
    return {
      '数据根目录': P.HOME,
      '配置': path.join(P.HOME, '配置'),
      '客户目录': cp.root,
      '产出视频': cp.videos,
      '本地模型': path.join(P.HOME, '系统', '本地模型'),
      '中文字体': fontName(),
    }
  } catch (e) {
    console.warn('[api] 取目录布局失败:', e.message)
    return {}
  }
}

/** 本机硬件与编码器：真读，读不到就如实说未知，不编。 */
function hardwareInfo() {
  const os = require('node:os')
  const out = {
    arch: os.arch(), platform: os.platform(),
    cpu: (os.cpus()[0] || {}).model || '未知',
    memory_gb: Math.round(os.totalmem() / 1073741824),
    disk_free_gb: null, encoders: [], hardware_encode: false,
  }
  try {
    const st = require('node:fs').statfsSync(P.HOME)
    out.disk_free_gb = Math.round((st.bavail * st.bsize) / 1073741824)
  } catch (e) { /* 老系统没有 statfsSync 就不报磁盘 */ }
  try {
    /* ★ encoders() 返回的是 Set，不是数组 —— 对 Set 调 .some() 直接抛
       TypeError，而这个 try/catch 会把异常静默吞掉，症状就是「编码器列表永远空、
       硬件加速永远显示不可用」，其实本机 videotoolbox 三个都在。 */
    const encs = Array.from(require('./exec').encoders() || [])
    // 只列剪辑台真能选的几个，全部编码器有几百个没法显示
    out.encoders = ['libx264', 'libx265', 'h264_videotoolbox', 'hevc_videotoolbox', 'prores_videotoolbox']
      .filter((k) => encs.includes(k))
    out.hardware_encode = out.encoders.some((k) => k.includes('videotoolbox'))
  } catch (e) { /* 读不到就留空数组，界面显示「未读到编码器」 */ }
  return out
}

/* ★ 不要用 system_profiler 查字体：它要 6.4 秒、输出几 MB（还 ENOBUFS），
   而它嵌在 /api/legal 里同步跑 —— 启动时界面就干等六秒。
   字体名本来就能从文件存在性判断，几十毫秒的事。 */
const FONT_CACHE = { v: null }
function fontName() {
  if (FONT_CACHE.v) return FONT_CACHE.v
  const fs2 = require('node:fs')
  const cands = [
    ['/System/Library/Fonts/PingFang.ttc', 'PingFang SC'],
    ['/System/Library/Fonts/STHeiti Medium.ttc', 'Heiti SC'],
    ['/System/Library/Fonts/Supplemental/Songti.ttc', 'Songti SC'],
    ['/System/Library/Fonts/Hiragino Sans GB.ttc', 'Hiragino Sans GB'],
  ]
  for (const [f, name] of cands) {
    try { if (fs2.existsSync(f)) { FONT_CACHE.v = name; return name } } catch (e) {}
  }
  FONT_CACHE.v = 'PingFang SC'
  return FONT_CACHE.v
}

function legal(d) {
  /* 旧前端读的是 d.consent.current（不是 accepted）：没有 current 就每次启动
     都弹「使用前请阅读并同意协议」，挡住整个界面。这里按它的字段名给全。 */
  const CFG = path.join(P.HOME, '配置', '授权同意.json')
  let rec = null
  try { rec = JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch (e) { rec = null }
  /* ★ 协议清单不再硬编码在代码里。
     踩过的坑（2026-11-20）：这里原来写死两份旧协议
     `许可协议.md` / `隐私说明.md`，标题还是「软件许可与反逆向声明」。
     后来五份新协议（AGPL-3.0 双许可那套）落在 home/资源/法律/ 下，
     代码没跟着改 —— 结果界面显示「文件缺失」，点开正文还写着
     「禁止逆向、破解、绕过授权校验」，与开源许可证自相矛盾。
     现在唯一事实源是 协议清单.json：加一份协议只改 JSON，不用碰代码。 */
  /* 清单可能在三处：随包 资源/法律/、构建时拷进用户目录 配置/协议/、
     仓库源码树 home/资源/法律/。按这个顺序找，第一个存在的算数。 */
  /* ★ 打包后 P.ROOT 是 Contents/Resources（paths.js 里 join(__dirname,'..','..')），
     不是仓库根。所以随包数据在 P.ROOT/seed-home/ 下，不在 P.ROOT/home/ 下。
     这个区别踩过一次：源码态跑得好好的，一打包全变「文件缺失」。 */
  const MANIFEST_FILE = [
    path.join(P.HOME, '配置', '协议', '协议清单.json'),
    path.join(P.HOME, '资源', '法律', '协议清单.json'),
    path.join(P.ROOT, 'seed-home', '配置', '协议', '协议清单.json'),
    path.join(P.ROOT, 'home', '资源', '法律', '协议清单.json'),
  ].find((f) => { try { return existsSync(f) } catch (e) { return false } }) || ''
  let MANIFEST = null
  try {
    if (MANIFEST_FILE && existsSync(MANIFEST_FILE)) MANIFEST = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
  } catch (e) { MANIFEST = null }
  const VER = str((MANIFEST && MANIFEST.version) || '2026-11-20-1')
  const DOCS = (MANIFEST && Array.isArray(MANIFEST.docs) && MANIFEST.docs.length)
    ? MANIFEST.docs
    : [
        { id: 'license', title: '开源许可与商业授权说明', file: '01-开源许可与商业授权.md', key: true },
        { id: 'terms', title: '服务条款', file: '02-服务条款.md', key: true },
        { id: 'privacy', title: '隐私政策', file: '03-隐私政策.md', key: true },
        { id: 'ip', title: '知识产权声明', file: '04-知识产权声明.md', key: false },
        { id: 'disclaimer', title: '免责声明', file: '05-免责声明.md', key: true },
      ]
  /* 协议文件可能落在两处：随包数据 资源/法律/，或用户目录 配置/协议/。
     先查用户目录（允许用户自己改），没有再回落到随包目录。 */
  const docFile = (name) => {
    const cands = [
      path.join(P.HOME, '配置', '协议', name),
      path.join(P.HOME, '资源', '法律', name),
      path.join(P.ROOT, 'seed-home', '配置', '协议', name),
      path.join(P.ROOT, 'home', '资源', '法律', name),
    ]
    for (const f of cands) { try { if (existsSync(f)) return f } catch (e) { /* 下一个 */ } }
    return cands[0]
  }
  const act = str(d.action, 'bootstrap')
  if (act === 'consent') {
    rec = { version: VER, time: new Date().toISOString().slice(0, 19).replace('T', ' '), machine: '' }
    try {
      fs.mkdirSync(path.dirname(CFG), { recursive: true })
      fs.writeFileSync(CFG, JSON.stringify(rec, null, 2))
    } catch (e) { console.warn('[api] 写授权记录失败:', e.message) }
    return r_ok({ consent: { current: true, time: rec.time, machine: '' } })
  }
  if (act === 'revoke') {
    try { fs.unlinkSync(CFG) } catch (e) { /* 本来就没有 */ }
    return r_ok({ consent: { current: false } })
  }
  if (act === 'doc') {
    const hit = DOCS.find((x) => x.id === str(d.id)) || DOCS[0]
    /* ★ 以前这里是死代码：docs 数组里 body 写死成 ''，接口永远返回
       「（协议正文还没放进来）」—— 用户点开只看到一个空框，以为软件坏了。
       现在真的去读盘：配置/协议/<文件名> → 资源/法律/<文件名>。读不到就如实说缺失。 */
    const f = docFile(hit.file)
    let body = ''
    let exists = false
    try {
      if (existsSync(f)) { body = readFileSync(f, 'utf8'); exists = true }
    } catch (e) { /* 读不了就当没有 */ }
    return r_ok({
      /* path 给前端用：点「查看」能直接在右侧文档标签页里打开，不用另做一套弹窗 */
      path: exists ? f : '',
      title: hit.title, file: hit.file, exists, size: body.length,
      body: body || ('协议文件还没装上：' + f + '\n\n（安装包里的 seed-home/配置/协议/ 应带有这个文件）'),
    })
  }
  return r_ok({
    legal_version: VER,
    /* ★ 软件版本必须读真包里的，不能写死。
       踩过的坑：这里原来是 '1.0.0' 字符串，而 package.json 是 0.1.0 ——
       界面上「软件 1.0.0」和「本机 0.1.0（已打包）」并排出现，用户不知道信哪个。
       现在读 package.json，读不到再退回 0.0.0。 */
    software_version: (() => {
      try {
        const pj = JSON.parse(readFileSync(path.join(P.ROOT, 'app', 'package.json'), 'utf8'))
        return String(pj.version || '0.0.0')
      } catch (e) { return '0.0.0' }
    })(),
    /* ★ layout / hardware 必须一起给。
       系统设置页有二十多个字段（数据根目录、配置夹、客户目录、产出、本地模型、
       硬件检测、可用编码器…）全靠这两个对象填。不给的话它们永远停在「读取中…」，
       用户看到的是「这台机器缺东西」—— 明明全都装好了。 */
    layout: layoutPaths(),
    hardware: hardwareInfo(),
    consent: { current: !!(rec && rec.version === VER), time: (rec && rec.time) || '', machine: '' },
    /* docs 必须真的探一遍盘：以前这里 exists 写死 false、size 写死 0，
       界面永远显示「文件缺失」，哪怕文件就在那儿。 */
    docs: DOCS.map((x) => {
      const f = docFile(x.file)
      let size = 0
      let exists = false
      try {
        if (existsSync(f)) { size = fs.statSync(f).size; exists = size > 0 }
      } catch (e) { /* 读不了就当没有 */ }
      return { id: x.id, key: !!x.key, title: x.title, file: x.file, exists, size }
    }),
    integrity: { ok: true, baseline: false, checked: 0, changed: [] },
    codesign: { signed: null },
    runtime: { suspicious: false, hits: [] },
    audit_check: { ok: true, count: 0 },
    policy_note: '',
    manifest: { todo: [] },
  })
}

function integrity(d) {
  return r_ok({ ok: true, items: [], note: '完整性自检还没接' })
}

async function chat(d) {
  const KC = lazy('./kernelchat')
  return KC.chat(d)
}

function stepsPoll(d) {
  const KC = lazy('./kernelchat')
  return r_ok(KC.steps(d.id || ''))
}

function kernelState() {
  const KC = lazy('./kernelchat')
  return r_ok(KC.status())
}


/* ══════════════ 首页 · 方案 / 渲染 / 时间线 / 多版本 ══════════════ */

/** 文件 → 素材类型（timeline 只认 video / image / audio）。 */
function kindOfFile(file) {
  const ext = path.extname(String(file || '')).toLowerCase()
  if (P.IMAGE_EXT && P.IMAGE_EXT.has(ext)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) return 'audio'
  return ''
}

/** 需求里写的「30 秒 / 1 分钟」优先；没写就按素材数量给一个能看完的长度。 */
function wantSeconds(requirement, count) {
  const s = String(requirement || '')
  const m = s.match(/(\d+(?:\.\d+)?)\s*(分钟|分|min|秒|s)/i)
  if (m) {
    let n = Number(m[1]) || 0
    if (/分|min/i.test(m[2])) n *= 60
    return Math.max(3, Math.min(300, n))
  }
  return Math.max(6, Math.min(60, Math.max(1, count) * 3))
}

/** 从已扫描的素材库挑能用的画面。没有就先扫一遍用户选中的文件夹。 */
async function mediaForPlan(root, customer) {
  const A = lazy('./assets')
  const items0 = (A.library(customer).items || [])
    .filter((it) => it && it.full && fs.existsSync(it.full) && ['视频', '图片'].includes(it.kind))
    .filter((it) => !root || String(it.full).startsWith(root))
  if (items0.length) return items0
  if (!root) throw new Error('先选择素材文件夹，才能按里面的素材生成视频')
  const r = await A.scanFolder(root, customer, { incremental: false })
  return (r.items || []).filter((it) => it && it.full && ['视频', '图片'].includes(it.kind))
}

/**
 * 按真实素材排一份可执行的方案。
 * 不调模型也能出 —— 首页的「生成方案」首先得是一条走得通的路；
 * 模型没配、断网、key 失效都不该让按钮变成死的。
 */
function makePlan(d, items) {
  const requirement = str(d.requirement).trim() || '自动成片'
  const usable = (items || []).filter((it) => it && it.full)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.name).localeCompare(String(b.name)))
  if (!usable.length) throw new Error('这个文件夹里没有可用的视频或图片')

  const target = wantSeconds(requirement, usable.length)
  const maxShots = Math.max(1, Math.min(usable.length, 20))
  const chosen = usable.slice(0, maxShots)
  const per = target / chosen.length

  const shots = []
  for (const it of chosen) {
    const isVideo = it.kind === '视频'
    const have = Number(it.duration) || 0
    let dur = per
    if (isVideo && have > 0) dur = Math.min(per, have)
    dur = Math.max(0.8, Math.min(8, dur))
    shots.push({
      asset: String(it.full),
      scene: String(it.name || '').replace(/\.[^.]+$/, ''),
      duration: Math.round(dur * 100) / 100,
      caption: '',
      source_duration: have || undefined,
    })
  }

  const r = String(requirement)
  const vertical = !/横屏|16:9|电脑|宽屏/i.test(r)
  const square = /方图|1:1|方形/i.test(r)
  const width = square ? 1080 : vertical ? 1080 : 1920
  const height = square ? 1080 : vertical ? 1920 : 1080
  const duration = Math.round(shots.reduce((a, s) => a + s.duration, 0) * 100) / 100

  return {
    title: requirement.slice(0, 20) || '自动成片',
    summary: `按现有素材自动粗排：${shots.length} 个镜头，约 ${duration.toFixed(1)} 秒。`
      + '确认后会生成一条可编辑的工程并开始出片。',
    requirement,
    shots,
    output: { width, height, fps: 30, aspect: square ? '1:1' : vertical ? '9:16' : '16:9' },
    duration,
    target_duration: duration,
    created: P.now(),
  }
}

/** 把方案变成真工程：素材复制进 assets/，分镜落到 v1，字幕落到 t1。 */
async function projectFromPlan(plan, name, root) {
  const TL = lazy('./timeline')
  const p = plan && typeof plan === 'object' ? plan : {}
  const shots = Array.isArray(p.shots) ? p.shots : []
  if (!shots.length) throw new Error('方案里没有分镜')
  const out = p.output || {}
  const w = num(out.width, 1080) || 1080
  const h = num(out.height, 1920) || 1920
  const fps = num(out.fps, 30) || 30

  const base = TL.safeName(str(name) || p.title || '未命名')
  let projName = base
  const exists = new Set(TL.listProjects().map((x) => x.name))
  if (exists.has(projName)) projName = TL.safeName(base + '-' + P.stamp())

  const doc = TL.blank(projName, w, h, fps, 1)
  doc.plan = p
  const v1 = TL.ensureTrack(doc, 'v1')
  const t1 = TL.ensureTrack(doc, 't1')
  let t = 0
  let used = 0

  for (const sh of shots) {
    const raw = str(sh.asset || sh.path || sh.src).trim()
    if (!raw) continue
    let abs = raw.replace(/^~/, require('node:os').homedir())
    if (!path.isAbsolute(abs)) {
      const cands = root ? [path.join(root, abs), path.join(root, 'assets', abs)] : []
      abs = cands.find((x) => fs.existsSync(x)) || abs
    }
    if (!fs.existsSync(abs)) continue
    const kind = kindOfFile(abs)
    if (kind !== 'video' && kind !== 'image') continue

    const imported = TL.importAsset(projName, abs)
    let dur = Math.max(0.5, num(sh.duration, 3))
    if (kind === 'video') {
      const have = num(sh.source_duration, 0)
      if (have > 0.05) dur = Math.min(dur, have)
    }
    const clip = TL.mediaClip({
      src: imported.src,
      type: kind,
      start: t,
      dur,
      fit: 'cover',
      volume: kind === 'video' ? 0 : undefined,
    })
    v1.clips.push(clip)
    const caption = str(sh.caption || sh.字幕).trim()
    if (caption) {
      t1.clips.push(TL.textClip({
        text: caption, start: t, dur, size: Math.round(h * 0.035),
        y: 0.86, height: h, anim: 'fade',
      }))
    }
    t += dur
    used++
  }

  if (!used) throw new Error('方案里的素材都不在了，没法排进工程')
  doc.duration = Math.round(Math.max(1, t) * 1000) / 1000
  TL.save(projName, doc)
  return { project: projName, doc, duration: doc.duration }
}

/** 渲染并回报成片与质检结果（任务中心按 files 对象列文件）。 */
async function renderPlan(plan, name, root, conversationId) {
  const R = lazy('./render')
  const PL = lazy('./plan')
  const built = await projectFromPlan(plan, name, root)
  const r = await R.renderProject(built.project, { final: true })
  let qc = null
  try { qc = PL.planCheck(plan) } catch (e) { qc = { ok: false, error: e.message } }
  const summary = qc && qc.ok
    ? `方案 ${qc.segments} 段 · 成片 ${(r.duration || built.duration).toFixed(1)} 秒 · ${r.width}×${r.height}`
    : `成片 ${(r.duration || built.duration).toFixed(1)} 秒 · ${r.width}×${r.height}`
  return {
    ok: true,
    project: built.project,
    conversation_id: conversationId || '',
    name: r.name,
    path: r.path,
    files: { 成片: r.path },
    file: r.path,
    duration: r.duration,
    width: r.width,
    height: r.height,
    size: r.size,
    ms: r.ms,
    qc: { ok: !!(qc && qc.ok), summary, plan: qc },
  }
}

function planApi(d = {}) {
  const TK = lazy('./tasks')
  const requirement = str(d.requirement).trim() || '自动成片'
  const root = str(d.root).trim()
  const customer = d.customer || C.currentCustomer()
  const task = TK.submit('生成方案：' + requirement.slice(0, 16), async () => {
    const items = await mediaForPlan(root, customer)
    const plan = makePlan({ requirement }, items)
    plan.model = str(d.model)
    plan.conversation_id = str(d.conversation_id)
    plan.root = root
    plan.preset_id = str(d.preset_id)
    return plan
  }, { kind: 'plan', requirement, root, model: str(d.model), preset_id: str(d.preset_id), conversation_id: str(d.conversation_id) }, 0)
  return r_ok({ task_id: task.id })
}

function renderApi(d = {}) {
  const TK = lazy('./tasks')
  let plan = d.plan
  if (typeof plan === 'string') {
    try { plan = JSON.parse(plan) } catch (e) { throw new Error('方案不是合法 JSON：' + e.message) }
  }
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) throw new Error('没有可渲染的方案（plan.shots 为空）')
  const root = str(d.root).trim()
  const name = str(d.name) || plan.title || '未命名'
  const task = TK.submit('出片：' + name.slice(0, 16), async () => {
    return renderPlan(plan, name, root, str(d.conversation_id))
  }, { kind: 'render', root, conversation_id: str(d.conversation_id) }, 0)
  return r_ok({ task_id: task.id })
}

/** 多版本：同一条素材池，换不同的开场镜头，各出一条预览片。 */
function multiVersionTask(d = {}) {
  const TK = lazy('./tasks')
  const n = Math.max(2, Math.min(5, num(d.count, 3)))
  const root = str(d.root).trim()
  const requirement = str(d.requirement).trim() || '多版本'
  const customer = d.customer || C.currentCustomer()
  const task = TK.submit(`出 ${n} 个版本`, async (tid) => {
    const items = await mediaForPlan(root, customer)
    const files = {}
    const errors = []
    for (let i = 0; i < n; i++) {
      const rotated = items.slice(i).concat(items.slice(0, i))
      const plan = makePlan({ requirement }, rotated)
      try {
        const r = await renderPlan(plan, `${plan.title}-V${i + 1}`, root, str(d.conversation_id))
        files['版本 ' + (i + 1)] = r.path
      } catch (e) {
        errors.push('V' + (i + 1) + '：' + (e.message || e))
      }
    }
    if (!Object.keys(files).length) return { ok: false, error: errors.join('；') || '一个版本都没渲出来' }
    return { ok: true, files, errors, count: Object.keys(files).length }
  }, { kind: 'multiversion', root, conversation_id: str(d.conversation_id) }, 0)
  return r_ok({ task_id: task.id })
}

/* ── 时间线编辑（底部时间线 / 剪辑台的共用真实数据）── */
function undoFile(name) { return path.join(lazy('./timeline').projDir(name), '.undo.json') }
function readUndo(name) {
  try {
    const j = JSON.parse(fs.readFileSync(undoFile(name), 'utf8'))
    return { past: Array.isArray(j.past) ? j.past : [], future: Array.isArray(j.future) ? j.future : [] }
  } catch { return { past: [], future: [] } }
}
function writeUndo(name, st) {
  const past = st.past.slice(-20), future = st.future.slice(-20)
  try { fs.writeFileSync(undoFile(name), JSON.stringify({ past, future })) } catch (e) {}
}
function snap(doc) {
  return JSON.parse(JSON.stringify({ width: doc.width, height: doc.height, fps: doc.fps, duration: doc.duration, tracks: doc.tracks, plan: doc.plan }))
}
function applySnap(doc, s) {
  if (!s || typeof s !== 'object') return doc
  for (const k of ['width', 'height', 'fps', 'duration', 'tracks', 'plan']) {
    if (s[k] !== undefined) doc[k] = JSON.parse(JSON.stringify(s[k]))
  }
  return doc
}
function videoClipOf(doc, id) {
  const arr = Array.isArray(doc.tracks) ? doc.tracks : []
  for (const tr of arr) {
    const i = (tr.clips || []).findIndex((c) => c && c.id === id)
    if (i >= 0) return { tr, i, c: tr.clips[i] }
  }
  return null
}
function clipDur(c) {
  if (!c) return 0
  if (c.type === 'image' || c.type === 'text' || c.type === 'template') return Math.max(0, num(c.duration, 0))
  return Math.max(0, num(c.out, 0) - num(c.in, 0))
}
function projectNameFor(d) {
  const TL = lazy('./timeline')
  const want = str(d.project).trim()
  if (want) return TL.safeName(want)
  const list = TL.listProjects()
  return list.length ? list[0].name : ''
}
function timelineView(name) {
  const TL = lazy('./timeline')
  if (!name) return { project: '', title: '', segments: [], duration: 0, note: '还没有生成过工程，先在上面输入需求生成方案' }
  let doc
  try { doc = TL.load(name) } catch (e) { return { project: '', title: '', segments: [], duration: 0, note: e.message } }
  const vtr = (doc.tracks || []).find((t) => t && t.kind === 'video') || (doc.tracks || [])[0]
  const clips = (vtr && vtr.clips) || []
  const texts = []
  for (const tr of doc.tracks || []) for (const c of tr.clips || []) if (c && c.type === 'text') texts.push(c)
  const segments = clips
    .filter((c) => c && (c.type === 'video' || c.type === 'image'))
    .slice()
    .sort((a, b) => num(a.start) - num(b.start))
    .map((c, i) => {
      const start = num(c.start)
      const dur = clipDur(c)
      const file = String(c.src || '').split('/').pop()
      const cap = texts.find((t) => {
        const ts = num(t.start)
        return ts >= start - 0.01 && ts < start + Math.max(0.1, dur)
      })
      return {
        id: c.id,
        no: i + 1,
        asset: c.src || '',
        start: Math.round(start * 1000) / 1000,
        duration: Math.round(dur * 1000) / 1000,
        thumb: !file ? '' : (c.type === 'image'
          ? '/ed/' + encodeURIComponent(name) + '/' + encodeURIComponent(file)
          : '/edthumb/' + encodeURIComponent(name) + '/' + encodeURIComponent(file)),
        caption: cap ? String(cap.text || '') : '',
      }
    })
  const st = readUndo(name)
  return {
    project: name,
    title: (doc.plan && doc.plan.title) || doc.name || name,
    segments,
    duration: Math.round(Math.max(0, TL.tail(doc)) * 1000) / 1000,
    note: segments.length ? '' : '这个工程里还没有画面段',
    can_undo: st.past.length > 0,
    can_redo: st.future.length > 0,
    undoable: st.past.length > 0,
    redoable: st.future.length > 0,
  }
}
function timeline(d = {}) {
  const TL = lazy('./timeline')
  const act = str(d.action, 'load')
  const name = projectNameFor(d)

  // 分镜审核：读分镜给前端看 / 用户点同意后放行出片闸门。
  if (act === 'storyboard_get') {
    if (!name) return rErr('还没有分镜工程')
    let doc
    try { doc = TL.load(name) } catch (e) { return rErr(e.message) }
    const plan = doc.plan || {}
    return r_ok({
      name, title: plan.title || name,
      shots: Array.isArray(plan.shots) ? plan.shots : [],
      requirement: plan.requirement || '', research: plan.research || '',
      hook: plan.hook || '', script: plan.script || '',
      approved: plan.storyboard_approved === true,
      status: plan.storyboard_status || 'pending',
      md: require('node:fs').existsSync(require('node:path').join(TL.projDir(name), 'storyboard.md')),
    })
  }
  if (act === 'storyboard_approve') {
    if (!name) return rErr('还没有分镜工程')
    let doc
    try { doc = TL.load(name) } catch (e) { return rErr(e.message) }
    if (!doc.plan || !Array.isArray(doc.plan.shots) || !doc.plan.shots.length) return rErr('这个工程还没有分镜')
    doc.plan.storyboard_approved = true
    doc.plan.storyboard_status = 'approved'
    doc.plan.storyboard_approved_at = new Date().toISOString()
    TL.save(name, doc)
    const fs = require('node:fs'), path = require('node:path')
    const md = path.join(TL.projDir(name), 'storyboard.md')
    try { if (fs.existsSync(md)) fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace('状态：**待你审核**', '状态：**已同意 ✓**'), 'utf8') } catch (e) {}
    return r_ok({ name, approved: true, shots: doc.plan.shots.length })
  }

  if (act === 'load') return r_ok(timelineView(name))
  if (!name) return rErr('还没有片子可编辑')
  let doc
  try { doc = TL.load(name) } catch (e) { return rErr(e.message) }
  const st = readUndo(name)

  if (act === 'undo' || act === 'redo') {
    if (act === 'undo') {
      if (!st.past.length) return r_ok(Object.assign(timelineView(name), { note: '没有可撤销的操作' }))
      st.future.push(snap(doc))
      applySnap(doc, st.past.pop())
    } else {
      if (!st.future.length) return r_ok(Object.assign(timelineView(name), { note: '没有可重做的操作' }))
      st.past.push(snap(doc))
      applySnap(doc, st.future.pop())
    }
    doc.duration = Math.max(1, TL.tail(doc))
    TL.save(name, doc)
    writeUndo(name, st)
    return r_ok(timelineView(name))
  }

  const before = snap(doc)
  const id = str(d.id)
  let note = ''
  if (act === 'duration') {
    const hit = videoClipOf(doc, id)
    if (!hit) return rErr('找不到这一段')
    const dur = Math.max(0.5, num(d.duration, 3))
    if (hit.c.type === 'image') hit.c.duration = dur
    else hit.c.out = num(hit.c.in) + dur
    note = `第 ${id} 段改为 ${dur.toFixed(1)} 秒`
  } else if (act === 'delete') {
    const hit = videoClipOf(doc, id)
    if (!hit) return rErr('找不到这一段')
    hit.tr.clips.splice(hit.i, 1)
    note = '已删除这一段，可以撤销'
  } else if (act === 'duplicate') {
    const hit = videoClipOf(doc, id)
    if (!hit) return rErr('找不到这一段')
    const copy = JSON.parse(JSON.stringify(hit.c))
    copy.id = 'c' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 999)
    copy.start = num(copy.start) + clipDur(hit.c)
    hit.tr.clips.splice(hit.i + 1, 0, copy)
    note = '已复制这一段'
  } else if (act === 'split') {
    const hit = videoClipOf(doc, id)
    if (!hit) return rErr('找不到这一段')
    const c = hit.c, total = clipDur(c)
    let at = num(d.at, total / 2)
    if (!(at > 0.05 && at < total - 0.05)) return rErr('切点不在这一段里')
    const right = JSON.parse(JSON.stringify(c))
    right.id = 'c' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 999)
    right.start = num(c.start) + at
    if (c.type === 'image' || c.type === 'text' || c.type === 'template') {
      c.duration = at
      right.duration = total - at
    } else {
      const in0 = num(c.in)
      const speed = Math.max(0.1, num(c.speed, 1))
      c.out = in0 + at * speed
      right.in = c.out
    }
    hit.tr.clips.splice(hit.i + 1, 0, right)
    note = '已在 ' + at.toFixed(2) + ' 秒处切开'
  } else {
    return rErr('不认识的时间线动作：' + act)
  }

  st.past.push(before)
  st.future = []
  writeUndo(name, st)
  doc.duration = Math.max(1, TL.tail(doc))
  TL.save(name, doc)
  const out = timelineView(name)
  out.note = note
  return r_ok(out)
}

/* ── 模板库状态 / 同步 / 目录（剪辑页「模板库」悬浮框）── */
function dirSizeMb(dir) {
  let total = 0
  const walk = (d) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const f = path.join(d, e.name)
      try { if (e.isDirectory()) walk(f); else total += fs.statSync(f).size } catch {}
    }
  }
  walk(dir)
  return Math.round((total / 1048576) * 10) / 10
}
function seedRegistryRoot() {
  const cands = [
    path.join(P.ROOT, 'seed-home', '模板库', 'registry'),
    path.join(P.ROOT, 'RiffCut影创.app', 'Contents', 'Resources', 'seed-home', '模板库', 'registry'),
  ]
  return cands.find((x) => fs.existsSync(x)) || ''
}
function hyperframes(d = {}) {
  const T = lazy('./templates')
  const act = str(d.action, 'catalog')
  const reg = T.registryRoot()
  if (act === 'tpl_status') {
    const count = (() => { try { return T.catalog(true).length } catch { return 0 } })()
    return r_ok({
      ok: count > 0, count, size_mb: count ? dirSizeMb(reg) : 0,
      path: reg, seed: seedRegistryRoot(),
      note: count ? '本地模板库已就绪，装模板不用联网' : '还没有本地模板库',
    })
  }
  if (act === 'tpl_sync') {
    const TK = lazy('./tasks')
    const src = seedRegistryRoot()
    const task = TK.submit('同步模板库', async (tid) => {
      if (!src) {
        if (fs.existsSync(reg) && T.catalog(true).length) {
          return { ok: true, count: T.catalog(true).length, note: '本地模板库已经完整，不需要再下一份' }
        }
        return { ok: false, error: '安装包里没有模板库备份，这一版没法离线同步' }
      }
      const n0 = (() => { try { return T.catalog(true).length } catch { return 0 } })()
      if (n0 >= 100) return { ok: true, count: n0, note: '本地模板库已经完整（' + n0 + ' 个），没有重复复制' }
      P.ensureDir(path.dirname(reg))
      fs.cpSync(src, reg, { recursive: true, force: false, errorOnExist: false })
      const n = T.catalog(true).length
      return { ok: true, count: n, size_mb: dirSizeMb(reg) }
    }, { kind: 'templates' }, 0)
    return r_ok({ task_id: task.id })
  }
  const items = T.search(T.catalog(), str(d.query), str(d.cat), str(d.kind))
  const stats = T.stats(items)
  const order = T.CATS.map((x) => x[0]).filter((k) => stats[k])
  for (const k of Object.keys(stats)) if (!order.includes(k)) order.push(k)
  return r_ok({ items: items.slice(0, num(d.limit, 400)), cats: stats, cat_order: order, total: items.length })
}

/* ── 联网测试：真发一次查询，不通就直说 ── */
async function websearch(d = {}) {
  const t0 = Date.now()
  const act = str(d.action, 'probe')
  const q = str(d.query) || 'OpenAI'
  if (act !== 'probe' && act !== 'search') return rErr('联网搜索只支持 probe / search')
  try {
    const r = await globalThis.fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12000),
    })
    const txt = await r.text()
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const n = (txt.match(/result__a/g) || []).length
    if (!n) throw new Error('拿到的页面里没有结果（可能被反爬拦了）')
    return r_ok({ ok: true, status: 'ok', provider: 'duckduckgo', provider_label: 'DuckDuckGo', n, ms: Date.now() - t0 })
  } catch (e1) {
    // 备源：热搜接口能通，至少说明外网是通的（但它不是网页搜索，如实标出来）
    try {
      const H = lazy('./hotspot')
      const h = await H.fetch('weibo', 10)
      if (h && h.ok) {
        return r_ok({
          ok: true, status: 'ok', provider: 'weibo-hot', provider_label: '微博热搜（备源）',
          n: (h.items || []).length, ms: Date.now() - t0,
          note: '网页搜索被拦了，但外网是通的（用热搜备源验证）',
        })
      }
      throw new Error(h && h.error || '备源也没通')
    } catch (e2) {
      return r_ok({
        ok: false, status: 'fail', provider: '', provider_label: '',
        ms: Date.now() - t0, error: String(e1.message || e1) + '；' + String(e2.message || e2),
      })
    }
  }
}

/* ── 生成图片 / 视频 / 在 Finder 中显示 ── */
async function imageGenerate(d = {}) {
  const Im = lazy('./image')
  const r = await Im.generateImage({ prompt: str(d.prompt), model: str(d.model), size: str(d.size) })
  return r_ok(Object.assign({}, r, { url: '/gen/' + encodeURIComponent(path.basename(r.path)) }))
}

/** 通用视频生成：兼容 OpenAI 风格的 /videos/generations（含提交后轮询）。 */
async function videoGenerate(d = {}) {
  const M = lazy('./models')
  const ms = M.models()
  const mid = str(d.model) || Object.keys(ms).find((k) => ms[k] && ms[k].kind === 'video'
    && String(ms[k].key || '').trim() && String(ms[k].model || '').trim())
  if (!mid) throw new Error('还没有视频模型。到「模型」里添加，把类型选成「视频」。')
  const m = ms[mid]
  const key = String(m.key || '').trim()
  if (!key) throw new Error(`视频模型「${m.name || mid}」还没填 API Key`)
  const prompt = str(d.prompt).trim()
  if (!prompt) throw new Error('先写一句要生成什么')

  const base = String(m.url || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  const t0 = Date.now()
  const post = async (url, payload) => {
    const r = await globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
    const txt = await r.text()
    if (!r.ok) throw new Error(`视频生成失败（HTTP ${r.status}）：${txt.slice(0, 200)}`)
    try { return JSON.parse(txt) } catch { throw new Error('接口返回的不是 JSON：' + txt.slice(0, 160)) }
  }
  const get = async (url) => {
    const r = await globalThis.fetch(url, { headers })
    const txt = await r.text()
    if (!r.ok) throw new Error(`查询视频任务失败（HTTP ${r.status}）：${txt.slice(0, 160)}`)
    try { return JSON.parse(txt) } catch { throw new Error('查询返回的不是 JSON') }
  }
  const pick = (j) => {
    const data = (j && (j.data || j.videos || j.output)) || []
    const it = Array.isArray(data) ? data[0] : data
    if (it && typeof it === 'object') return it.url || it.video_url || it.b64_json || it.video || ''
    if (typeof it === 'string') return it
    return (j && (j.url || j.video_url)) || ''
  }

  let j = await post(base + '/videos/generations', {
    model: String(m.model || '').trim(), prompt, n: 1,
  })
  let outUrl = pick(j)
  let jobId = (j && (j.id || (j.data && j.data.id))) || ''
  const deadline = Date.now() + 10 * 60 * 1000
  while (!outUrl && jobId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    j = await get(base + '/videos/generations/' + encodeURIComponent(jobId))
    outUrl = pick(j)
    const st = String(j && (j.status || j.state) || '').toLowerCase()
    if (!outUrl && st && /fail|error|cancel/.test(st)) throw new Error('视频任务失败：' + (j.error || j.message || st))
  }
  if (!outUrl) throw new Error('接口没有返回视频地址（这个模型可能不支持 /videos/generations）')

  let raw
  if (/^https?:/i.test(outUrl)) {
    const r = await globalThis.fetch(outUrl)
    if (!r.ok) throw new Error('下载生成的视频失败：HTTP ' + r.status)
    raw = Buffer.from(await r.arrayBuffer())
  } else {
    raw = Buffer.from(String(outUrl).replace(/^data:video\/[^;]+;base64,/, ''), 'base64')
  }
  if (!raw || raw.length < 1000) throw new Error('接口返回的视频内容太小，可能不是视频')

  const dir = C.custPaths().videos
  P.ensureDir(dir)
  const file = path.join(dir, `${P.stamp()}-RiffCut-${ImSafeTopic(prompt)}.mp4`)
  fs.writeFileSync(file, raw)
  const probe = await lazy('./exec').probe(file)
  return r_ok({
    ok: true, path: file, name: path.basename(file), url: '/vid/' + encodeURIComponent(path.basename(file)),
    size: raw.length, model: mid, ms: Date.now() - t0,
    duration: probe ? probe.duration : 0, width: probe ? probe.width : 0, height: probe ? probe.height : 0,
  })
}
function ImSafeTopic(text) {
  const first = String(text || '').split(/[，,。！!\n]/)[0].slice(0, 12)
  return (first || '视频').replace(/[^\w\u4e00-\u9fa5-]/g, '') || '视频'
}
function imageReveal(d = {}) { return reveal(d) }

/** 首页语音输入的定稿识别：前端送 base64 WAV，落临时文件后走本机 SenseVoice。 */
async function asrAudio(d = {}) {
  const b64 = String(d.audio || '').replace(/^data:audio\/[^;]+;base64,/, '')
  if (!b64) throw new Error('没有音频数据')
  const dir = path.join(P.HOME, '缓存', '语音输入')
  P.ensureDir(dir)
  const file = path.join(dir, '输入-' + P.stamp() + '.wav')
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  try {
    const r = await lazy('./asr').transcribeAudio(file)
    if (!r.ok) throw new Error(r.error || '没识别到语音')
    return r_ok(r)
  } finally {
    try { fs.unlinkSync(file) } catch {}
  }
}

/** 一键成片：组一份方案，立刻排工程并出片。 */
function oneClick(d = {}) {
  const TK = lazy('./tasks')
  const root = str(d.root).trim()
  const requirement = str(d.requirement).trim() || '一键成片'
  const customer = d.customer || C.currentCustomer()
  const task = TK.submit('一键成片：' + requirement.slice(0, 14), async () => {
    const items = await mediaForPlan(root, customer)
    const plan = makePlan({ requirement }, items)
    return renderPlan(plan, plan.title, root, str(d.conversation_id))
  }, { kind: 'one-click', root, conversation_id: str(d.conversation_id) }, 0)
  return r_ok({ task_id: task.id })
}


/* ══════════════ 文档查看 / 编辑 ══════════════
   AI 会产出 storyboard.md、脚本、文案这类纯文本文档，然后跟用户说
   「请审核 /…/工程/剪辑/xxx/storyboard.md」。让用户去 Finder 里翻路径
   是产品缺陷 —— 必须能在软件里直接看、直接改。
   安全：只允许读**工程目录与产出目录**下的文本文件，其它路径一律拒绝，
   免得被诱导去读 ~/.ssh 之类的东西。 */
const DOC_EXT = new Set(['.md', '.txt', '.json', '.srt', '.csv', '.yml', '.yaml'])

function docSafePath(p) {
  const TL = lazy('./timeline')
  const want = path.resolve(String(p || ''))
  const roots = [P.HOME, P.CUST, TL.root && TL.root()].filter(Boolean).map((x) => path.resolve(x))
  const inside = roots.some((r) => want === r || want.startsWith(r + path.sep))
  if (!inside) throw new Error('只能查看工程/产出目录里的文档')
  if (!DOC_EXT.has(path.extname(want).toLowerCase())) throw new Error('这种文件不支持在软件里看')
  return want
}

async function docs(d = {}) {
  const act = str(d.action, 'read')
  try {
    if (act === 'read') {
      const f = docSafePath(d.path)
      if (!existsSync(f)) return rErr('文件不存在：' + f)
      const text = readFileSync(f, 'utf8')
      return r_ok({ path: f, name: path.basename(f), text, size: Buffer.byteLength(text), mtime: fsStat(f) })
    }
    if (act === 'save') {
      const f = docSafePath(d.path)
      writeFileSync(f, String(d.text == null ? '' : d.text), 'utf8')
      return r_ok({ path: f, saved: true, size: Buffer.byteLength(String(d.text || '')) })
    }
    return rErr('不认识的 action：' + act)
  } catch (e) {
    return rErr(String((e && e.message) || e))
  }
}
function fsStat(f) { try { return require('node:fs').statSync(f).mtimeMs } catch (e) { return 0 } }

module.exports = {
  bootstrap, edit, settings, ui, workspace, scan, library, indexStatus, assetsIngest,
  templates, audio, models, plugins, agent, tasks, works, projects,
  skills, conversations, hotspot, openapi, legal, integrity, publish, chat, stepsPoll, kernelState,
  kernelAbility, localmodels, agents, workers, voicemodels, kb, brand, usage, depsApi, customers,
  analytics, reveal, multiversion, visionAnalyze, assetsOrganize, update,
  ffmpegInfo, r_ok, rErr, num, str,
  planApi, renderApi, timeline, hyperframes, websearch,
  imageGenerate, videoGenerate, imageReveal, asrAudio, oneClick, multiVersionTask,
  docs,
}
