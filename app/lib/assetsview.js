/**
 * 素材库的「看与整理」（对应 /api/vision/analyze 与 /api/assets/organize）。
 *
 * 两件事都不许猜：
 *   · analyze —— 抽帧交给视觉模型看，模型说什么就记什么；没有视觉模型就如实说没有
 *   · organize —— 按日期/类型建子目录搬文件，动之前先算清楚要搬几个，搬完报实数
 */
const fs = require('node:fs')
const path = require('node:path')
const C = require('./core')
const E = require('./exec')
const A = require('./assets')

const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic'])
const VID = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv'])

/** 素材目录下所有文件（不递归，一屏看一层） */
function ls(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    return { name: f, path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
  }).filter((x) => !x.dir)
}

/**
 * 抽帧看图。
 *
 * ★ 为什么要拼成图墙一次问，而不是逐张问：
 *   一条 30 秒片子抽 6 帧、12 个素材就是 72 次模型调用 —— 一次 2 秒也要两分半，
 *   而且每张都只有局部信息，模型看不出「这几张其实是同一个场景的不同角度」。
 *   拼成一张 4×3 的图墙一次问，既快（一次调用）又能让它横向比较。
 *   lib/media.js 的 contactSheet 已经是现成的（ffmpeg tile 滤镜）。
 */
async function analyze(d = {}) {
  const customer = d.customer || C.currentCustomer()
  const M = require("./models")
  const I = require("./image")
  const Md = require("./media")
  /* ★ findVisionModel() 返回的是**模型 id 字符串**（"preset-auto"），不是模型对象。
     第一版写成 M.models()[d.model] : I.findVisionModel()，拿到字符串后读 .key 永远是 undefined，
     于是无论配没配好都报「没配能读图的模型」—— 这个 bug 骗过了我自己，
     因为报错本身看起来完全合理。 */
  const vid = String(d.model || I.findVisionModel() || "")
  const vm = M.models()[vid]
  if (!vm || !vm.key) {
    throw new Error("这台机器上没配能读图的模型。到「模型管理」里加一个支持图片输入的（不是纯文本的），再回来。")
  }
  const root = d.root || C.custPaths(customer).images
  if (!fs.existsSync(root)) throw new Error("素材目录不存在：" + root)
  const files = ls(root).filter((f) => {
    const e = path.extname(f.name).toLowerCase()
    return IMG.has(e) || VID.has(e)
  })
  if (!files.length) return { ok: true, root, total: 0, items: [], note: "这个目录里没有图片或视频" }

  const limit = Math.max(1, Math.min(24, Number(d.limit) || 12))
  const pick = files.slice(0, limit)
  const cache = C.custPaths(customer).cache

  /* 先把每张素材取一张代表帧（视频取第 1 秒，0 秒常是黑场或标题卡），
     再拼成一张图墙。抽帧失败的那张单独记账，不让它拖垮整批。 */
  const frames = []
  const notes = []
  for (const f of pick) {
    const ext = path.extname(f.name).toLowerCase()
    if (!VID.has(ext)) { frames.push({ file: f, shot: f.path }); continue }
    const tmp = path.join(cache, "看-" + Date.now().toString(36) + "-" + frames.length + ".jpg")
    const r = await E.run(E.FFMPEG, ["-y", "-ss", "1", "-i", f.path, "-frames:v", "1", "-q:v", "3", tmp])
    if (r.ok) frames.push({ file: f, shot: tmp, tmp })
    else notes.push(f.name + "：抽帧失败")
  }
  if (!frames.length) throw new Error("一张都抽不出帧：" + notes.join("；"))

  let wall = ""
  try {
    const sheet = await Md.tileImages(frames.map((x) => x.shot), { cols: frames.length > 8 ? 4 : 3, customer })
    wall = (sheet && sheet.path) || ""
  } catch (e) {
    notes.push("拼图墙失败（" + e.message + "），改成逐张问")
  }

  const items = []
  try {
    if (wall) {
      const ask = "这是一张素材总览图墙，从左到右、从上到下依次是 " + frames.length + " 个素材。\n"
        + frames.map((x, i) => (i + 1) + ". " + x.file.name).join("\n")
        + "\n\n逐条回答（每条一行，以序号开头）：这条素材画面里是什么、能不能用（能 / 勉强 / 不能用）、为什么。"
        + "只说画面里真能看见的，看不见就说「看不清」。"
      const one = await I.reviewImage(wall, { model: vid, shot: ask })
      /* ★ reviewImage 的返回字段是 report（不是 text/verdict）。读错字段的后果很隐蔽：
         每一条都变成「模型没提这一条」，看起来像是模型不配合，其实是代码读空。 */
      const text = String((one && (one.report || one.text || "")) || "")
      /* 按序号切回去：模型不一定每条都答、也可能答了 12 条只回 9 条，
         所以按 "N." 前缀找，找不到的那条标成「模型没提」。 */
      const lines = text.split(/\n+/)
      const byIdx = new Map()
      for (const ln of lines) {
        const m = ln.match(/^\s*(\d+)[.、)：:]\s*(.+)$/)
        if (m) byIdx.set(Number(m[1]), m[2].trim())
      }
      frames.forEach((x, i) => {
        items.push({ file: x.file.name, ok: true, verdict: byIdx.get(i + 1) || "（模型没提这一条）" })
      })
    } else {
      /* 图墙拼不出来（比如全是大尺寸 PNG）就退回逐张，但把上限压到 6 张 */
      for (const x of frames.slice(0, 6)) {
        try {
          const one = await I.reviewImage(x.shot, { model: vid, shot: d.mode || "" })
          items.push({ file: x.file.name, ok: !!(one && one.ok), verdict: (one && (one.report || one.text)) || "" })
        } catch (e) {
          items.push({ file: x.file.name, ok: false, verdict: "看不了：" + e.message })
        }
      }
    }
  } finally {
    for (const x of frames) if (x.tmp) { try { fs.unlinkSync(x.tmp) } catch (e) {} }
  }

  const bad = items.filter((x) => /不能用/.test(String(x.verdict))).length
  return {
    ok: true, root, model: vm.name || vid,
    total: files.length, looked: items.length, bad,
    wall: wall || "", items,
    notes: notes.slice(0, 6),
    note: wall
      ? "看的是拼在一起的图墙（一次问完，比逐张快得多）"
      : "没拼成图墙，退回逐张看了前 6 张",
  }
}

/**
 * 整理：把素材按 日期 / 类型 归到子目录。
 * ★ 默认 dry：先算清楚要搬几个、搬到哪，用户点「执行」才真动。
 *   整理素材是不可逆的（搬错地方用户找不到自己刚放进去的东西）。
 */
function organize(d = {}) {
  const customer = d.customer || C.currentCustomer()
  const mode = String(d.mode || 'date')
  const root = d.root || C.custPaths(customer).images
  if (!fs.existsSync(root)) throw new Error('素材目录不存在：' + root)
  const files = ls(root)
  const plan = []
  for (const f of files) {
    let sub = ''
    if (mode === 'date') {
      const t = new Date(f.mtime)
      sub = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`
    } else if (mode === 'type') {
      const ext = path.extname(f.name).toLowerCase()
      sub = IMG.has(ext) ? '图片' : (VID.has(ext) ? '视频' : '其他')
    } else if (mode === 'month') {
      const t = new Date(f.mtime)
      sub = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`
    } else {
      throw new Error('不认识的整理方式：' + mode + '（可用 date / month / type）')
    }
    plan.push({ from: f.path, to: path.join(root, sub, f.name), sub, name: f.name })
  }
  const bySub = {}
  for (const p of plan) bySub[p.sub] = (bySub[p.sub] || 0) + 1

  if (!d.exec) {
    return {
      ok: true, dry: true, mode, root, count: plan.length,
      groups: Object.entries(bySub).map(([k, v]) => ({ dir: k, n: v })),
      note: plan.length ? '还没动任何文件。确认要搬就带 exec:1 再来一次。' : '没有可整理的素材',
    }
  }
  let moved = 0
  const errs = []
  for (const p of plan) {
    try {
      fs.mkdirSync(path.dirname(p.to), { recursive: true })
      // 目标已存在就不覆盖：同名不同内容的素材，覆盖等于毁掉一个
      if (fs.existsSync(p.to)) { errs.push(p.name + ' 目标已有同名文件，跳过'); continue }
      fs.renameSync(p.from, p.to)
      moved++
    } catch (e) { errs.push(p.name + '：' + e.message) }
  }
  return { ok: true, dry: false, mode, root, moved, total: plan.length, errors: errs.slice(0, 20) }
}

module.exports = { analyze, organize, ls }
