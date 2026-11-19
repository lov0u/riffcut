'use strict'
/**
 * 视觉库：转场 / 运镜 / 调色 / 影调预设 / 变速曲线。
 *
 * 这些是纯词表 + ffmpeg 滤镜映射，不含业务逻辑，所以整块照搬旧软件的数据。
 * 数字与映射关系都有实测依据，不要凭感觉改：
 *  · 「叠化」原本映射到 xfade 的 dissolve —— 那是个坑。ffmpeg 的 dissolve =
 *    交叉淡化 + 逐像素随机选取（官方为了抑制色带），在 yuv420p 上直接变成满屏
 *    盐噪，转场重叠帧邻差从 0.2 飙到 16，抽帧出来是一层雪花 + 黄色杂色条。
 *    同一段自己叠自己也出噪点，跟素材无关。对照实测 fade / fadewhite /
 *    smoothleft / circleopen / pixelize 全都干净；用纯色测过 xfade 的 fade
 *    中点就是真交叉淡化（红+蓝→紫 127,0,127），观感一样只是没有 dithering。
 *    所以叠化改走 fade —— 观感不变，噪点消失。
 *  · 「冲进」冲完不能完全定住：2 倍缩放上再推 3.5%/7% 够不上 freezedetect 的
 *    -58dB 阈值，等于白留；45% 是"从 2.0 一路缓推到 2.45"，冲击感保住同时画面
 *    确实还在动。同理「拉远」要留 1.03 的底、「快推」要 pow(on/n, 0.35) 全程缓出。
 */

// ── 转场：名字 → [xfade 名, 默认时长] ──────────────────────────
const TRANSITIONS = 
{ "淡入淡出": ["fade", 0.5], "叠化": ["fade", 0.5], "闪白": ["fadewhite", 0.3], "闪黑": ["fadeblack", 0.4], "淡灰": ["fadegrays", 0.4], "快淡": ["fadefast", 0.25], "慢淡": ["fadeslow", 0.8], "左推": ["slideleft", 0.4], "右推": ["slideright", 0.4], "上推": ["slideup", 0.4], "下推": ["slidedown", 0.4], "左滑": ["smoothleft", 0.45], "右滑": ["smoothright", 0.45], "上滑": ["smoothup", 0.45], "下滑": ["smoothdown", 0.45], "左盖": ["coverleft", 0.4], "右盖": ["coverright", 0.4], "上盖": ["coverup", 0.4], "下盖": ["coverdown", 0.4], "左揭": ["revealleft", 0.4], "右揭": ["revealright", 0.4], "上揭": ["revealup", 0.4], "下揭": ["revealdown", 0.4], "圆形开": ["circleopen", 0.5], "圆形合": ["circleclose", 0.5], "竖向开": ["vertopen", 0.45], "横向开": ["horzopen", 0.45], "竖向合": ["vertclose", 0.45], "横向合": ["horzclose", 0.45], "圆形裁": ["circlecrop", 0.5], "矩形裁": ["rectcrop", 0.5], "斜切": ["diagtl", 0.45], "斜切右": ["diagtr", 0.45], "左擦": ["wipeleft", 0.4], "右擦": ["wiperight", 0.4], "上擦": ["wipeup", 0.4], "下擦": ["wipedown", 0.4], "左上擦": ["wipetl", 0.45], "右下擦": ["wipebr", 0.45], "像素化": ["pixelize", 0.5], "径向": ["radial", 0.5], "距离": ["distance", 0.5], "横切片": ["hlslice", 0.4], "纵切片": ["vuslice", 0.4], "横向风": ["hlwind", 0.45], "纵向风": ["vdwind", 0.45], "横向模糊": ["hblur", 0.4], "横向压缩": ["squeezeh", 0.45], "纵向压缩": ["squeezev", 0.45], "推近": ["zoomin", 0.5]}


// 素材里常写的口头说法，归一到上面的键。归一不了的一律当硬切 ——
// 宁可不动，也不要因为一个看不懂的词就整片渲不出来。
// ★「溶解」原来写的是 "dissolve"，那不是 TRANSITIONS 的键，认不出来会静悄悄
//   变成硬切；归一到「叠化」才对。
const TRANS_ALIAS = 
{"": "", "无": "", "硬切": "", "直接切": "", "cut": "", "none": "", "淡入快出": "淡入淡出", "交叉淡化": "叠化", "溶解": "叠化", "dissolve": "叠化", "渐隐": "淡入淡出", "渐显": "淡入淡出", "fade": "淡入淡出", "滑入": "左推", "推进": "左推", "滑动": "左滑", "滑动切换": "左滑", "圈入": "圆形开", "圈出": "圆形开", "圆形扩展": "圆形开", "擦除": "左擦", "划像": "左擦", "wipe": "左擦", "闪白切换": "闪白", "白闪": "闪白", "黑场": "闪黑", "淡到黑": "闪黑", "故障": "横切片", "glitch": "横切片", "卡点": "快淡", "zoom": "推近", "缩放": "推近"}


// ── 运镜 ────────────────────────────────────────────────────
const CAMERA_MOVES = 
{"固定": "不动。大多数段本来就该不动", "推近": "慢慢推近，注意力越收越紧，最常用", "拉远": "从局部退到全景，用来交代环境或收尾", "快推": "一脚踩进画面，冲击强，用在开场或爆点", "左移": "镜头横移，给静止画面一点纵深", "右移": "同上，方向相反", "上移": "自下而上摇，适合人物登场", "下移": "自上而下摇，适合落幅在细节上", "冲进": "前 0.3 秒一口气冲到 1.6~2 倍然后定住。全片最值钱那一拍用它", "甩镜": "横向甩过去，快到模糊。换场兼换气，比叠化有劲"}

const CAMERA_ALIAS = 
{"不动": "固定", "无": "固定", "none": "固定", "推": "推近", "zoom": "推近", "拉": "拉远", "横移": "左移", "摇": "左移", "punch": "冲进", "punchin": "冲进", "硬推": "冲进", "冲击": "冲进", "爆发": "冲进", "whip": "甩镜", "甩": "甩镜", "甩动": "甩镜", "横甩": "甩镜"}


// 模型常把转场名当运镜名写（「横向风」是 xfade 的横切，不是镜头运动）。
// 认不出的名字会退回「固定」，整段就静止 —— 那不是模型的本意，是本机没认出来。
// 这里把最常见的几种转场名映射到最接近的运镜，宁可动错方向也不要死着。
const CAMERA_FROM_TRANS = {
  横向风: '左移', 纵向风: '上移', 横切片: '左移', 纵切片: '上移',
  左滑: '左移', 右滑: '右移', 上滑: '上移', 下滑: '下移',
  左推: '左移', 右推: '右移', 上推: '上移', 下推: '下移',
  推近: '推近', 拉远: '拉远', 距离: '推近', 径向: '推近',
}

/** 运镜名字归一。认不出返回「固定」。 */
function cameraKey(name) {
  const n = String(name || '').trim()
  if (!n) return '固定'
  if (n in CAMERA_MOVES) return n
  if (n in CAMERA_ALIAS) return CAMERA_ALIAS[n]
  for (const k of Object.keys(CAMERA_MOVES)) if (n.includes(k)) return k
  if (n in CAMERA_FROM_TRANS) return CAMERA_FROM_TRANS[n]
  return '固定'
}

/** 转场名字归一。认不出返回空串（= 硬切）。 */
function transKey(name) {
  const n = String(name || '').trim()
  if (!n) return ''
  if (n in TRANSITIONS) return n
  if (n in TRANS_ALIAS) return TRANS_ALIAS[n]
  for (const k of Object.keys(TRANSITIONS)) if (n.includes(k)) return k
  return ''
}

/** 转场 → {xa: xfade 名, dur: 秒}。硬切返回 null。 */
function transOf(name) {
  const k = transKey(name)
  if (!k) return null
  const [xa, dur] = TRANSITIONS[k]
  return { name: k, xa, dur: Number(dur) }
}

/**
 * 运镜 → zoompan 链。amount 0~1 控制幅度，1 是默认（约 1.25 倍）。
 * ★ zoompan 会重排时间轴，调用方必须显式 -t 钉住时长。
 */
function cameraChain(name, W, H, dur, fps = 30, amount = 1.0) {
  const k = cameraKey(name)
  if (k === '固定') return ''
  let amt = Number(amount)
  if (!Number.isFinite(amt)) amt = 1.0
  amt = Math.max(0.1, Math.min(2.0, amt))
  const n = Math.max(2, Math.round(Math.max(0.2, Number(dur) || 0) * Number(fps || 30)))
  const zmax = 1.0 + 0.25 * amt
  const cx = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
  const S = `s=${Math.round(W)}x${Math.round(H)}`
  const f = (v, d = 4) => v.toFixed(d)

  if (k === '推近') {
    return `zoompan=z='min(1+${f((zmax - 1.0) / n)}*on\\,${zmax.toFixed(3)})':d=1:${S}:${cx}`
  }
  if (k === '快推') {
    // 全程缓出：pow(进度, 0.35) 前段冲得猛、后段还在慢慢推，到最后一帧才停。
    // 冲劲没丢，但每一帧都在动（定住就是死帧，freezedetect 直接判画面冻结）。
    return `zoompan=z='min(1+${f(zmax - 1.0)}*pow(on/${Math.max(2, n)}\\,0.35)\\,${zmax.toFixed(3)})':d=1:${S}:${cx}`
  }
  if (k === '冲进') {
    let zt = 1.0 + 1.0 * amt
    zt = Math.max(1.15, Math.min(2.0, zt))
    const hit = Math.max(2, Math.round(n * 0.28))
    const tail = (zt - 1.0) * 0.45
    return `zoompan=z='min(1+${f((zt - 1.0) / hit)}*min(on/${hit}\\,1)+${f(tail / Math.max(1, n))}*on/${Math.max(1, n)}\\,${(zt + tail).toFixed(3)})':d=1:${S}:${cx}`
  }
  if (k === '甩镜') {
    // 只在水平方向加运动模糊 —— 四周都糊就是失焦，只有横向糊才是甩。
    // zoompan 做不到这种糊法，所以先 return 一个 avgblur，横向位移仍靠 zoompan 的 x。
    const swipe = W - W / (1.0 + 0.16 * amt)
    return `avgblur=sizeX=${Math.max(3, Math.round(W * 0.02 * amt))}:sizeY=1,` +
      `zoompan=z='${(1.0 + 0.16 * amt).toFixed(3)}+${f(0.03 * amt)}*on/${Math.max(1, n)}':d=1:${S}:` +
      `x='iw-iw/zoom-${swipe.toFixed(1)}*(1-min(on/${Math.max(2, Math.round(n * 0.5))},1))':y='ih/2-(ih/zoom/2)'`
  }
  if (k === '拉远') {
    // 留 1.03 的底、并让位置同时缓慢回中，整段都在动（缩到 1.0 就顶住 = 死帧）。
    const lo = 1.03
    return `zoompan=z='max(${zmax.toFixed(3)}-${f((zmax - lo) / n, 5)}*on\\,${lo.toFixed(3)})':` +
      `d=1:${S}:x='iw/2-(iw/zoom/2)+${Math.max(0.5, W * 0.004).toFixed(2)}*sin(on/${Math.max(2, n)}*1.57)':y='ih/2-(ih/zoom/2)'`
  }
  // 平移：先放大一点再靠 x/y 移动看不同区域。两个端点都用 zoom 的实时值算，
  // 不写死像素 —— 写死会在非标画幅上跳。
  const Z = (1.0 + 0.2 * amt).toFixed(3)
  const CX = 'iw/2-(iw/zoom/2)'
  const CY = 'ih/2-(ih/zoom/2)'
  const pan = {
    左移: ['x', 'iw-iw/zoom', '0', CY],
    右移: ['x', '0', 'iw-iw/zoom', CY],
    上移: ['y', 'ih-ih/zoom', '0', CX],
    下移: ['y', '0', 'ih-ih/zoom', CX],
  }
  const [axis, a, b, other] = pan[k] || ['x', '0', 'iw-iw/zoom', CY]
  const move = `${a}+(${b}-(${a}))*min(on/${n},1)`
  return axis === 'x'
    ? `zoompan=z='${Z}':d=1:${S}:x='${move}':y='${other}'`
    : `zoompan=z='${Z}':d=1:${S}:x='${other}':y='${move}'`
}

// ── 调色：LUT 风格等效滤镜链 ────────────────────────────────
// 不用 .cube 文件，纯 ffmpeg 原生滤镜近似常见影调。理由：分发一个 .app
// 不该靠几十兆的 LUT 包，而且用户手上有素材但手上没有 LUT。
// 参数都按"轻度可用"取值 —— 过重的调色一眼假，宁可欠一点。
const COLOR_LOOKS = 
{"原色": ["不调", "null"], "电影": ["压暗高光、青影橙光，最通用的一条", "colorbalance=rs=-0.04:bs=0.05:rh=0.06:bh=-0.05,curves=m='0/0.02 0.25/0.23 0.5/0.5 0.75/0.78 1/0.96',eq=saturation=1.06:contrast=1.08"], "胶片": ["轻微偏暖、颗粒感、暗部抬起", "colorbalance=rs=0.04:gs=0.01:bs=-0.03:rh=0.03:bh=-0.02,curves=m='0/0.05 0.25/0.24 0.5/0.51 0.75/0.78 1/0.96',eq=saturation=0.96:contrast=1.04,noise=alls=6:allf=t"], "人像": ["降饱和、暖肤色、提亮中间调", "colorbalance=rs=0.05:gs=0.02:bs=-0.03:rh=0.02:bh=-0.01,curves=m='0/0.04 0.5/0.53 1/0.97',eq=saturation=0.92:brightness=0.02"], "黑白": ["去色 + 提对比", "hue=s=0,curves=m='0/0.02 0.15/0.08 0.5/0.52 0.85/0.92 1/0.98',eq=contrast=1.3"], "冷调": ["偏蓝、收紧暗部，适合悬疑/科技", "colorbalance=rs=-0.06:bs=0.08:rh=-0.02:bh=0.05,eq=saturation=0.9:contrast=1.12"], "暖调": ["偏橙、提亮，适合生活/美食", "colorbalance=rs=0.07:gs=0.03:bs=-0.05:rh=0.04:bh=-0.03,eq=saturation=1.08:brightness=0.02"], "青橙": ["大片标配：青影橙光，反差拉满", "colorbalance=rs=-0.08:bs=0.10:rh=0.10:bh=-0.08,eq=saturation=1.2:contrast=1.15"], "褪色": ["低饱和、灰雾、复古", "curves=m='0/0.08 0.5/0.52 1/0.93',eq=saturation=0.72:contrast=0.95"], "高反差": ["黑更黑白更白，适合动作", "curves=m='0/0 0.25/0.16 0.5/0.5 0.75/0.86 1/1',eq=contrast=1.22"]}


/** 调色名归一 + 取滤镜链。认不出返回 'null'（不调）。 */
function colorLook(name) {
  const n = String(name || '').trim()
  if (!n) return { name: '原色', desc: '不调', vf: 'null' }
  const k = n in COLOR_LOOKS ? n : Object.keys(COLOR_LOOKS).find(x => n.includes(x))
  if (!k) return { name: '原色', desc: '不调', vf: 'null' }
  const [desc, vf] = COLOR_LOOKS[k]
  return { name: k, desc, vf }
}

// ── 变速曲线：名字 → [说明, [[时长占比, 速度], ...]] ──────────
// 速度是倍率：1.0 原速、1.8 快、0.55 慢。
const SPEED_CURVES = 
{"顿点": ["冲进来然后卡住，短视频最常用", [[0.45, 1.8], [0.25, 1.0], [0.3, 0.55]]], "起势": ["慢慢起、越来越快，适合铺垫后爆发", [[0.35, 0.7], [0.35, 1.0], [0.3, 1.7]]], "冲刺": ["前慢后极快，收在动作最高点", [[0.4, 0.85], [0.35, 1.4], [0.25, 2.2]]], "呼吸": ["快慢快，一个来回", [[0.3, 1.35], [0.4, 0.8], [0.3, 1.35]]], "骤停": ["匀速然后急刹", [[0.7, 1.2], [0.3, 0.4]]]}


/**
 * 变速曲线 → 累计时间轴。返回 [{from, to, speed}]，from/to 是**原片**时间。
 *
 * 用途：把一段素材按曲线变速后，知道每个速度档在原片和成片里各占多久，
 * 才能把字幕、音效、卡点对回去。
 */
function speedSegments(curveName, duration) {
  const total = Math.max(0.1, Number(duration) || 0)
  const k = String(curveName || '').trim()
  const def = SPEED_CURVES[k] || SPEED_CURVES['顿点']
  const parts = def[1]
  const sum = parts.reduce((a, [p]) => a + p, 0) || 1
  const out = []
  let src = 0
  for (const [p, speed] of parts) {
    // parts 的比例是**成片时间**占比，所以原片长度 = 成片长度 × 速度
    const outDur = total * (p / sum)
    const srcDur = outDur * speed
    out.push({ from: +src.toFixed(3), to: +(src + srcDur).toFixed(3), speed })
    src += srcDur
  }
  return out
}

/** 变速滤镜链：把多段不同速度拼起来。返回 {filter, total}。 */
function speedFilter(curveName, duration, opts = {}) {
  const segs = speedSegments(curveName, duration)
  if (!segs.length) return { filter: '', total: Number(duration) || 0 }
  const parts = [], labels = []
  segs.forEach((s, i) => {
    const sp = s.speed.toFixed(3)
    // setpts 除速度 → 时间变短（加速）；atempo 直接吃倍率，但要夹在 0.5~2.0
    const at = Math.max(0.5, Math.min(2.0, s.speed))
    parts.push(`[0:v]trim=${s.from}:${s.to},setpts=(PTS-STARTPTS)/${sp}[v${i}]`)
    if (opts.audio) parts.push(`[0:a]atrim=${s.from}:${s.to},asetpts=PTS-STARTPTS,atempo=${at.toFixed(3)}[a${i}]`)
    labels.push(i)
  })
  const vcat = labels.map(i => `[v${i}]`).join('') + `concat=n=${labels.length}:v=1:a=0[vout]`
  parts.push(vcat)
  let filter = parts.join(';')
  let total = 0
  for (const s of segs) total += (s.to - s.from) / s.speed
  if (opts.audio) {
    filter += ';' + labels.map(i => `[a${i}]`).join('') + `concat=n=${labels.length}:v=0:a=1[aout]`
  }
  return { filter, total: +total.toFixed(3), segs }
}

// ── 影调预设：一位摄影师定下的一套光 + 一支镜头 + 一种调色 ────
// 为什么要这一层：单独写「电影感」「偏冷一点」这种词，模型会把它们平均成
// 一锅浆糊。真实片子的影调是**三件事一起定**的 —— 主光从哪来、镜头多长、
// 颜色是什么关系。定好一个名字，这三段就互相咬住了，出来才是「拍的」而不是「拼的」。

const LOOK_PRESETS = {
  "夜巡": {
    "who": "Deakins 式夜景",
    "light": "单一有动机的硬光，无补光，主补比 8:1；室外冷月光对室内暖实用光，暗部保留层次但压得深",
    "camera": "35mm f/2.8，几乎不加扩散，固定机位或极慢运动",
    "palette": "冷蓝灰对钠灯琥珀，接近单色只留一处暖",
    "best": "夜晚室内、走廊、门槛、独处的人",
    "vf": "colorbalance=rs=-0.05:bs=0.06:rm=-0.03:bm=0.05:rh=-0.06:bh=0.08,curves=m='0/0.01 0.25/0.18 0.5/0.47 0.75/0.76 1/0.95',eq=saturation=0.86:contrast=1.12"
  },
  "逆光自然": {
    "who": "Lubezki 式自然光",
    "light": "只用现场光，黄金时刻，主补比 2:1，太阳进画或贴着画框，允许大面积耀斑",
    "camera": "21–27mm 贴近主体，f/2.8，手持微动，雾状耀斑",
    "palette": "暖金 + 天青，地面降饱和，低反差胶片感",
    "best": "外景、运动、逆光人脸、沉浸视角",
    "vf": "colorbalance=rs=0.06:gs=0.02:bs=-0.04:rh=-0.02:bh=0.03,curves=m='0/0.06 0.5/0.54 1/0.98',eq=saturation=1.02:contrast=0.96,gblur=sigma=0.3"
  },
  "窗光室内": {
    "who": "Portra 式室内日常",
    "light": "大面积北向窗当主光，白墙反弹补光，2:1，不用实用光",
    "camera": "50mm f/2，Black Pro-Mist 1/8，柔和衰减",
    "palette": "Kodak Portra 400：暖橡木、奶油、淡蓝、黄铜；低反差、奶油肌",
    "best": "有人的室内、生活方式、安静的居家场面",
    "vf": "colorbalance=rs=0.05:gs=0.02:bs=-0.02:rh=0.02:bh=-0.01,curves=m='0/0.05 0.5/0.53 1/0.97',eq=saturation=0.94:contrast=0.98,noise=alls=4:allf=t"
  },
  "霓虹夜街": {
    "who": "CineStill 式夜街",
    "light": "只用实用光——霓虹、招牌、车灯，4:1，湿地面从下往上反光",
    "camera": "35mm f/1.4，强光晕、变形宽银幕耀斑、可见颗粒",
    "palette": "CineStill 800T：品红青、钠橙、黑柏油；每个高光带红晕",
    "best": "夜晚外景、街道、酒吧、雨",
    "vf": "colorbalance=rs=0.08:bs=0.06:rh=-0.05:bh=0.10,eq=saturation=1.18:contrast=1.10,noise=alls=8:allf=t"
  },
  "光柱几何": {
    "who": "Fan Ho 式光柱",
    "light": "一束硬光穿过雾或尘埃，8:1 以上，其余全在暗部",
    "camera": "50mm f/5.6，高反差，黑位压死",
    "palette": "高反差单色；银高光、压死的黑",
    "best": "建筑、楼梯井、巨大几何里的小人",
    "vf": "format=gray,curves=m='0/0 0.2/0.06 0.5/0.45 0.8/0.94 1/1',eq=contrast=1.28"
  },
  "黄昏街区": {
    "who": "Crewdson 式黄昏",
    "light": "蓝调时段环境光对室内暖实用光，加一处无动机补光，2:1 但诡异",
    "camera": "大画幅等效，50mm f/8，全部实焦，轻微空气雾",
    "palette": "冷蓝外景、琥珀窗、降饱和中间调；电影感画面",
    "best": "郊区、凝固的叙事、不自然的静",
    "vf": "colorbalance=rs=-0.05:bs=0.08:rh=0.06:bh=-0.04,curves=m='0/0.04 0.5/0.50 1/0.95',eq=saturation=0.86:contrast=1.06"
  },
  "棚拍静物": {
    "who": "Penn 式棚拍",
    "light": "单只北向柔光箱 45 度，对面黑旗挡反光，4:1，不打背景光",
    "camera": "100mm f/8，不加扩散，绝对静止",
    "palette": "中性无缝地面，一到两个物体色调，克制",
    "best": "人像、产品、任何要显得深思过的东西",
    "vf": "curves=m='0/0.02 0.5/0.5 1/0.98',eq=saturation=0.94:contrast=1.06"
  },
  "硬光黑白": {
    "who": "Alton 式硬光",
    "light": "单一硬光在高处偏侧，巨大投影形状，加烟，8:1",
    "camera": "40mm f/4，硬边阴影，轻微暗角",
    "palette": "单色或近单色加琥珀实用光；湿街反光",
    "best": "戏剧、紧张、夜晚、审讯室气质",
    "vf": "format=gray,curves=m='0/0 0.25/0.12 0.5/0.5 0.75/0.88 1/1',eq=contrast=1.30,vignette=angle=PI/4.2"
  },
  "直闪纪实": {
    "who": "Parr 式直闪",
    "light": "机顶直闪压过环境，1:1，前景过曝，背后急速衰减",
    "camera": "35mm f/8，硬，快照的即时感",
    "palette": "过饱和原色、晒伤的粉、塑料红",
    "best": "冷幽默纪实、食物、近距离细节、日常",
    "vf": "curves=m='0/0.03 0.5/0.54 1/1',eq=saturation=1.26:contrast=1.10,vignette=angle=PI/5"
  },
  "逆光劳作": {
    "who": "Salgado 式劳作",
    "light": "现场光，高反差，逆光穿过尘或蒸汽，4:1",
    "camera": "35mm f/4，可见颗粒，重度加减光的手感",
    "palette": "高反差单色，银高光，深黑",
    "best": "劳作、手、尺度、人的力气",
    "vf": "format=gray,curves=m='0/0 0.25/0.10 0.5/0.48 0.75/0.90 1/1',eq=contrast=1.24,noise=alls=9:allf=t"
  },
  "建筑黄昏": {
    "who": "Shulman 式建筑",
    "light": "室内实用光与蓝调天空精确平衡，1:1，长曝光",
    "camera": "24mm 移轴，f/11，垂直线校正，由近到远全实焦",
    "palette": "室内暖金对黄昏青；干净、中世纪现代",
    "best": "建筑、房产、室内空间",
    "vf": "colorbalance=rs=0.04:bs=-0.03:rh=-0.03:bh=0.06,curves=m='0/0.03 0.5/0.51 1/0.98',eq=saturation=1.04:contrast=1.04"
  },
  "平光日常": {
    "who": "Eggleston 式平光",
    "light": "平铺的现场日光，1:1，不制造戏剧",
    "camera": "50mm f/5.6，正对视角，不倾斜",
    "palette": "染料转印式饱和；一处强色对着中性色",
    "best": "物件、被抬高的日常、美国式风景",
    "vf": "curves=m='0/0.03 0.5/0.52 1/0.99',eq=saturation=1.22:contrast=1.02"
  }
}


/** 影调名归一，认不出返回 null。 */
function lookPreset(name) {
  const n = String(name || '').trim()
  if (!n) return null
  const k = n in LOOK_PRESETS ? n : Object.keys(LOOK_PRESETS).find(x => n === x || n.includes(x))
  return k ? { name: k, ...LOOK_PRESETS[k] } : null
}

/** 影调 → 生图 prompt 片段（第 3/4/10 段：光、镜头、调色）。 */
function lookPrompt(name) {
  const p = lookPreset(name)
  if (!p) return ''
  return [`主光：${p.light}`, `镜头：${p.camera}`, `调色：${p.palette}`].join('\n')
}

/** 全部影调名（给 AI 挑）。 */
function lookNames() {
  return Object.entries(LOOK_PRESETS).map(([k, v]) => ({ name: k, who: v.who, best: v.best }))
}

module.exports = {
  TRANSITIONS, TRANS_ALIAS, CAMERA_MOVES, CAMERA_ALIAS, COLOR_LOOKS, SPEED_CURVES, LOOK_PRESETS,
  transKey, transOf, cameraKey, cameraChain, colorLook, speedSegments, speedFilter,
  lookPreset, lookPrompt, lookNames,
}
