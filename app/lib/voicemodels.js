/**
 * 语音模型目录（对应 /api/voicemodels）。
 *
 * 为什么单独一层而不是直接复用 localmodels.js：
 *   localmodels 回答「装了没」，这一层回答「能干什么」—— 模型的 caps、音色清单、
 *   可调项（情绪/语速/音高/音量），以及「选中哪个音色」的持久化。
 *   配音页整页都挂在 /api/voicemodels 上，缺了它整页是死的。
 *
 * 铁律：**音色列表严格来自当前模型**。系统音色就只列系统音色，不许把 Ming 的
 * 100 个音色混进来 —— 用户选了之后合不出来，等于骗人。
 */
const fs = require('node:fs')
const path = require('node:path')
const { join } = require('node:path')
const { existsSync } = require('node:fs')
const P = require('./paths')
const A = require('./audio')

const VM_DIR = path.join(P.HOME, '系统', '本地模型', '语音', 'weights')
const SYSTEM_ID = 'macos-system'

/** 情绪/语速/音高/音量：只有听得懂人话指令的模型才有（Ming 这类） */
const TTS_OPTS = {
  emotion: [['', '自然'], ['高兴', '高兴'], ['悲伤', '悲伤'], ['愤怒', '愤怒'],
    ['恐惧', '恐惧'], ['厌恶', '厌恶'], ['惊讶', '惊讶']],
  speed: [['', '中速'], ['慢速', '慢速'], ['快速', '快速']],
  pitch: [['', '中'], ['低', '低'], ['高', '高']],
  volume: [['', '中'], ['低', '低'], ['高', '大']],
}
const CAP_LABELS = {
  tts: '能配音', preview: '能试听', clone: '能克隆音色', import: '能导入样本',
  speed: '能调语速', volume: '能调音量', emotion: '能指定情绪', asr: '能识别语音',
}
const PARAM_CAPS = ['speed', 'volume', 'emotion']
const PIP_MIRRORS = [
  { id: 'aliyun', name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple' },
  { id: 'tsinghua', name: '清华', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { id: 'ustc', name: '中科大', url: 'https://mirrors.ustc.edu.cn/pypi/simple' },
  { id: 'pypi', name: '官方', url: 'https://pypi.org/simple' },
]
const WEIGHT_SOURCES = [
  { id: 'modelscope', name: '魔搭' },
  { id: 'hf-mirror', name: 'HF 镜像' },
  { id: 'url', name: '自定义地址' },
]

/** 三个内置模型的静态描述（权重在不在另有 localmodels 回答，这里只描述能力） */
function configModels() {
  const sys = _sysCache
  return [
    {
      id: SYSTEM_ID, name: 'macOS 系统音色', engine: 'system', category: '系统内置',
      desc: '系统自带、离线可用、无需下载。只能选系统预设音色，不能录自己的声音。',
      size: '0 MB', license: 'macOS 自带', builtin: true, need_install: false,
      caps: ['tts', 'preview', 'speed', 'volume'], voices: 'system',
      note: 'macOS 自带的中文音色很少。想要中文男声，到「系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音」勾选下载，再回来点「重新检测」。',
      installed: true, state: sys.ok ? 'ready' : 'none', step: sys.step || '',
      used_mb: 0, path: '', error: '',
    },
    {
      id: 'ming-tts', name: 'Ming-3.0 情感配音（本地离线）', engine: 'mlx', category: '本地 TTS / 情感配音',
      desc: '中英双语 44.1kHz，可直接指定情绪、语速、音高、音量，支持叹气/笑声等副语言；内置 100+ 中文音色，也能克隆自己的声音。',
      size: '约 1.5 GB', license: 'MIT（inclusionAI）', builtin: true, need_install: true,
      caps: ['tts', 'preview', 'clone', 'import', 'speed', 'emotion'],
      voices: 'preset-ming', note: '想有感情就在文本里直接写：情绪（高兴/悲伤/愤怒）、语速（慢速/中速/快速）、音高音量（低/中/高）。',
      ...mingStateOf(),
    },
    {
      id: 'sherpa-sensevoice', name: 'SenseVoice 语音识别（本地离线）', engine: 'sherpa', category: '语音识别',
      desc: '中/英/日/韩/粤语音识别，纯 CPU 可跑、完全离线；视频没字幕轨时用来转字幕。',
      size: '约 239 MB', license: 'Apache-2.0', builtin: true, need_install: true,
      caps: ['asr'], voices: [],
      note: '这是识别模型，不提供配音音色，只显示「语音转字幕」能力。',
      ...asrState(),
    },
  ]
}

/** 系统音色：真问 macOS（say -v ?），不写死一份名单 —— 用户可能自己下过新音色 */
/* ★ systemVoices() 是 async（要 spawn /usr/bin/say -v ? 去读列表）。
   当同步用拿到的是 Promise，v.good 永远 undefined → 一直报「系统里没有中文音色」。
   这个坑之前踩过一次（界面显示 0 个音色），这里是同一个函数被第二次当同步调。 */
let _sysCache = { ok: false, count: 0, step: "还没读过系统音色" }
async function primeSystem() { _sysCache = await systemState(); return _sysCache }

async function systemState() {
  let v = null
  try { v = await A.systemVoices() } catch (e) { v = null }
  const zh = (v && v.good) || []
  return {
    ok: zh.length > 0,
    count: zh.length,
    step: zh.length ? '系统里有 ' + zh.length + ' 个中文音色：' + zh.slice(0, 3).map((x) => x.name).join('、') : '系统里没有中文音色',
  }
}

function asrState() {
  try {
    const s = require('./asr').status()
    if (s.ready) {
      return { installed: true, state: 'ready', used_mb: s.used_mb || 228, step: '权重就绪', path: s.model || '' }
    }
    /* 下载中/失败要看 localmodels 的 job —— 那边是唯一事实源，
       这里自己再判一遍会出现「这边说没下、那边正在下」的矛盾。 */
    const LM = require('./localmodels')
    const j = LM.jobOf('asr')
    if (j && j.state === 'installing') {
      return { installed: false, state: 'installing', step: j.step, progress: LM.progressOf('asr'), used_mb: 0, path: '' }
    }
    if (j && j.state === 'error') {
      return { installed: false, state: 'error', step: '下载失败', error: j.error, used_mb: 0, path: '' }
    }
    return { installed: false, state: 'none', used_mb: 0, step: '还没下载权重（约 155 MB）', path: s.model || '' }
  } catch (e) { return { installed: false, state: 'none', used_mb: 0, step: e.message, path: '' } }
}

/* ★ Ming 不走「目录体积」那套判据。
   它是 audio.cpp 的 GGUF 单文件模型 + 一个预编译二进制，两者都在才算能用；
   只看目录大小会把「权重下好了但引擎没打包」判成就绪，点合成才发现跑不起来。 */
function mingStateOf() {
  try {
    const st = require('./audio').mingState()
    if (st.ok) {
      return { installed: true, state: 'ready', used_mb: st.mb || 0, step: st.step, path: st.model || '' }
    }
    const LM = require('./localmodels')
    const j = LM.jobOf('ming_tts')
    if (j && j.state === 'installing') {
      return { installed: false, state: 'installing', step: j.step, progress: LM.progressOf('ming_tts'), used_mb: 0, path: '' }
    }
    if (j && j.state === 'error') {
      return { installed: false, state: 'error', step: '下载失败', error: j.error, used_mb: 0, path: '' }
    }
    return { installed: false, state: 'none', used_mb: 0, step: st.step || '引擎不在', path: '' }
  } catch (e) {
    return { installed: false, state: 'none', used_mb: 0, step: '读不到引擎状态：' + e.message, path: '' }
  }
}

function ttsState(dirName) {
  const d = path.join(VM_DIR, dirName)
  let mb = 0
  try { mb = dirMB(d) } catch (e) {}
  const ok = mb > 100
  return {
    installed: ok, state: ok ? 'ready' : 'none', used_mb: Math.round(mb),
    step: ok ? '权重就绪' : '还没下载权重（约 1.5 GB）', path: d,
  }
}

function dirMB(dir) {
  let n = 0
  if (!fs.existsSync(dir)) return 0
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    try { const st = fs.statSync(p); n += st.isDirectory() ? dirMB(p) : st.size } catch (e) {}
  }
  return n / 1048576
}

function settings() { return P.load('settings', {}) || {} }
function saveSettings(s) { P.save('settings', s) }

function activeId() {
  const s = settings()
  return String(s.active_voice_model || SYSTEM_ID)
}

function setActive(id) {
  const ms = configModels()
  if (!ms.some((m) => m.id === id)) throw new Error('找不到这个语音模型：' + id)
  const s = settings(); s.active_voice_model = id; saveSettings(s)
  return { active: id }
}

/** 音色 / 摆位 / 锁定按模型分开存，换模型不串 */
function picksOf(mid) {
  const s = settings()
  const all = s.voice_picks || {}
  const one = all[mid] || {}
  return { sel: one.sel || '', pinned: one.pinned || [], locked: one.locked || [] }
}

function savePicks(mid, sel, pinned, locked) {
  const s = settings()
  const all = s.voice_picks || {}
  all[mid] = {
    sel: String(sel || ''),
    pinned: (pinned || []).slice(0, 9),
    locked: (locked || []).filter((n) => (pinned || []).includes(n)),
  }
  s.voice_picks = all
  saveSettings(s)
  return getPicks(mid)
}

function getPicks(mid) { return { id: mid, picks: picksOf(mid) } }

/** 左栏：模型目录 + 真实安装状态 + 当前选中 + 镜像配置 */
async function catalog() {
  await primeSystem()
  const ms = configModels()
  let active = activeId()
  if (!ms.some((m) => m.id === active)) {
    active = SYSTEM_ID
    const s = settings(); s.active_voice_model = active; saveSettings(s)
  }
  const s = settings()
  return {
    models: ms.map((m) => ({
      ...m,
      active: m.id === active,
      caps_labels: Object.fromEntries((m.caps || []).map((k) => [k, CAP_LABELS[k] || k])),
      param_caps: PARAM_CAPS.filter((k) => (m.caps || []).includes(k)),
      progress: 0, error: '',
    })),
    active,
    pip_mirrors: PIP_MIRRORS,
    pip_mirror: s.voice_pip_mirror || 'aliyun',
    pip_custom: s.voice_pip_custom || '',
    weight_sources: WEIGHT_SOURCES,
    weight_source: s.voice_weight_source || 'modelscope',
    cap_labels: CAP_LABELS,
    param_caps: PARAM_CAPS,
    dir: VM_DIR,
  }
}

/** 用户自己录/导入的音色：读 音色/index.json，只报磁盘上样本真在的那些。
    以前这里只有写没有读（saveVoiceIndex 写了没人看），所以录完音色列表里
    永远只有 100 个预设，用户以为「录制没成功」。 */
function myVoices() {
  const f = join(VM_DIR, '音色', 'index.json')
  let idx = {}
  try { idx = JSON.parse(require('node:fs').readFileSync(f, 'utf8')) || {} } catch (e) { return [] }
  const out = []
  for (const name of Object.keys(idx)) {
    const file = String((idx[name] && idx[name].file) || '')
    /* 样本文件被删了就不要再列 —— 列出来选上去合不出来，等于骗人 */
    if (!file || !existsSync(file)) continue
    /* playable 是前端 voiceRow 判断副标题用的（「可克隆说话」还是「样本文件已丢失」）。
       以前后端不返回这个字段 → 永远 undefined → 明明文件好好的也显示「样本文件已丢失」。
       文件在上面已经 existsSync 过了，能走到这里就是能用的。 */
    let sec = 0
    try {
      const st = require('node:fs').statSync(file)
      /* WAV：字节数 ÷ (16000 × 1 × 2) ；别的格式给 0，前端不显示秒数 */
      sec = st.size > 44 ? +(((st.size - 44) / 32000).toFixed(1)) : 0
    } catch (e) { sec = 0 }
    out.push({
      name, label: name, lang: 'zh_CN', kind: '我的音色', usable: true,
      featured: true, mine: true, ref: file,
      playable: true, seconds: sec,
    })
  }
  return out
}

/** 按名字找用户音色的样本路径（合成时要用它当参考音频） */
function myVoiceFile(name) {
  const n = String(name || '').trim()
  if (!n) return ''
  const hit = myVoices().find((x) => x.name === n)
  return hit ? hit.ref : ''
}

/** 右栏：音色列表严格来自当前模型 */
function voices(mid) {
  const id = String(mid || activeId())
  const ms = configModels()
  const m = ms.find((x) => x.id === id) || ms[0]
  const caps = m.caps || []
  /* 我的音色排在最前面 —— 用户刚录完就想看见它，不该翻到 100 个预设后面 */
  const mine = caps.includes('clone') ? myVoices() : []
  let list = []
  let bad = 0
  if (m.voices === 'system') {
    const v = A.systemVoices()
    list = ((v && v.good) || []).map((x) => ({
      name: x.name, label: x.name, lang: x.locale || 'zh_CN', kind: '系统音色',
      usable: true, featured: true,
    }))
  } else if (m.id === 'sherpa-sensevoice') {
    list = []   // 识别模型没有音色，如实空着
  } else {
    /* Ming 这类需要权重。权重没下就不列它的音色 —— 列出来选了上去合不出来 */
    const st = m.id === 'ming-tts' ? mingStateOf() : ttsState(m.id)
    if (st.installed) {
      list = mine.concat(MING_VOICES.map((x) => ({ ...x, label: x.label || x.name, kind: '预设音色', usable: true })))
    } else {
      bad = 1
    }
  }
  return {
    model: {
      id: m.id, name: m.name, category: m.category, engine: m.engine,
      desc: m.desc, note: m.note, caps, caps_labels: Object.fromEntries(caps.map((k) => [k, CAP_LABELS[k] || k])),
      is_tts: caps.includes('tts'), can_preview: caps.includes('preview'),
      can_clone: caps.includes('clone'), can_import: caps.includes('import'),
      tts_opts: caps.includes('emotion')
        ? Object.fromEntries(Object.entries(TTS_OPTS).map(([k, arr]) => [k, arr.map(([value, label]) => ({ value, label }))]))
        : {},
    },
    voices: list,
    count: list.length,
    unusable_count: bad,
    picks: picksOf(m.id),
    clones_imported: mine.length,
    clone_hint: caps.includes('clone') ? '录 10 秒以上干净人声（不要有背景音乐），越像越好。' : '',

    note: bad ? '「' + m.name + '」的权重还没下载，音色暂时列不出来。到本地模型里装好再回来。' : '',
  }
}

/* Ming 的预设音色 —— 从旧版 core.py 完整搬回（90+ 个）。
   换壳时这里被换成了 10 个占位名（电台叙述/纪录片旁白…），
   而模型描述还写着「内置 100+ 中文音色」，用户看到右上角只有 10 个，
   就是这么来的。真实音色是灵楷/灵小柔/灵语汐这一批，按官方表顺序。

   4 个 featured 是适合出片旁白的精选（深夜电台/讲故事/纪实/戏剧化），
   出厂默认主音色「灵小柔」+ 右栏锁定组合见 DEFAULT_PICKS。 */
const MING_FEATURED = {
  灵楷: '深夜电台叙述', 灵小棠: '温柔讲故事', 灵决冥: '纪实旁白', 悟空: '戏剧化演绎',
}
/* 出厂默认：1 主 + 4 锁（用户 2026-11-11 定的组合） */
const MING_DEFAULT_SEL = '灵小柔'
const MING_DEFAULT_PINS = ['灵楷', '灵小棠', '蜡笔小新_野原美伢', '西游记_唐僧']
/* ═══════════════════════════════════════════════════════════
   ★ 2026-11-22 重大修正：Ming 3.0 根本不认音色名字。

   实测（tools/audio.cpp/model_specs/ming3_tts.json 的 request options）：
     · 没有 speaker / voice / voice_name 这类按名字选人的参数
     · 传 `--request-option speaker=灵小安` → 引擎直接报
       「unknown Ming TTS request option: speaker」
     · 用三个不同"音色"合成同一句话，输出 WAV 的 md5 完全一样
       （灵小安 / 花小呗 / 灵楷 → 8e269c8647cd3cab017e290a26dd2152）

   引擎真正控音色的只有三条路：
     ① template_name=freeform + instruct：「用文字描述一个声音」
     ② --voice-ref <wav>：克隆一段参考音频
     ③ template_name=ip + voice_id：仅 4 个内置英文音色
        US_Emma / US_James / UK_George / UK_Charlotte

   实测 ① 有真实区分度且可复现（同一 instruct 两次 md5 相同）：
     一位三十岁女性温柔 → 基频 254.9Hz
     一位六十岁老年男性低沉 → 96.7Hz
     一位十六岁少女清亮 → 247.8Hz

   所以以前的 93 个「音色名」是假的 —— 传进去等于没传，全是同一个嗓子。
   现在改成「名字 → 声音描述（instruct）」的真实映射：名字只是标签，
   真正决定声音的是 instruct 那句中文描述。这样既保留用户认得的名字，
   又让「换音色」真的换出一个不同的声音。
   ═══════════════════════════════════════════════════════════ */

/* 名字 → (性别, 声音描述)。描述的写法参考实测有效的那几句：
   年龄 + 性别 + 音色质感 + 语速，四要素齐全时区分度最好。
   ★ 不要加"播音腔""字正腔圆"这种评价词，模型会往同一个方向收，
     不同音色之间的差异会被抹平（实测过）。 */
const MING_VOICE_ROWS = [
  /* ── 女声：按年龄 / 质感排 ── */
  ['灵小安','女','一位二十岁的年轻女性，声音清亮干净，语速轻快'],
  ['灵语汐','女','一位二十岁的年轻女性，声音温柔细腻，语速轻缓'],
  ['灵小萌','女','一位十八岁的少女，声音软糯可爱，语速稍快'],
  ['灵小柔','女','一位三十岁的女性，声音温柔柔和，语速平缓'],
  ['灵小雅','女','一位三十岁的女性，声音优雅从容，语速适中'],
  ['花小呗','女','一位二十五岁的女性，声音甜美活泼，语速轻快'],
  ['灵韵','女','一位三十五岁的女性，声音醇厚有韵味，语速舒缓'],
  ['妩媚妲己','女','一位成熟女性，声音妩媚慵懒，语速缓慢'],
  ['灵婉','女','一位三十岁的女性，声音婉转柔和，语速舒缓'],
  ['灵小月','女','一位二十二岁的女性，声音清澈带点凉意，语速适中'],
  ['灵朵儿','女','一位十六岁的少女，声音清甜稚气，语速轻快'],
  ['灵小甄','女','一位四十岁的女性，声音沉稳知性，语速从容'],
  ['灵小知','女','一位三十岁的女性，声音知性理性，语速平稳'],
  ['灵小惠','女','一位二十八岁的女性，声音亲和温暖，语速适中'],
  ['灵小晴','女','一位二十岁的女性，声音明朗开朗，语速轻快'],
  ['灵梦','女','一位二十五岁的女性，声音轻柔飘渺，语速缓慢'],
  ['灵恬','女','一位三十岁的女性，声音恬静平淡，语速平缓'],
  ['灵小汐','女','一位二十岁的女性，声音清脆如溪水，语速适中'],
  ['灵小棠','女','一位三十岁的女性，声音温暖讲故事，语速舒缓'],
  ['灵小梨','女','一位十八岁的少女，声音清亮圆润，语速适中'],
  ['灵小芸','女','一位二十六岁的女性，声音平凡自然，语速适中'],
  ['悲伤女声','女','一位三十岁的女性，声音带着压抑的悲伤，语速缓慢'],
  ['灵风信','女','一位二十五岁的女性，声音清爽爽利，语速偏快'],
  ['灵惜梦','女','一位二十二岁的女性，声音梦幻朦胧，语速缓慢'],
  ['灵悦澜','女','一位三十岁的女性，声音愉悦舒展，语速适中'],
  ['灵御心','女','一位三十五岁的女性，声音冷静克制有力量，语速沉稳'],
  ['灵语恬','女','一位二十八岁的女性，声音温润恬静，语速平缓'],
  ['灵心恬','女','一位三十岁的女性，声音内心平静温和，语速平缓'],
  ['灵悦兮','女','一位二十岁的女性，声音轻盈愉悦，语速轻快'],
  ['灵若虚','女','一位三十岁的女性，声音空灵虚无，语速缓慢'],
  ['灵未央','女','一位三十二岁的女性，声音绵长未尽，语速舒缓'],
  ['灵梦瑶','女','一位二十四岁的女性，声音甜美梦幻，语速适中'],
  ['灵雨汐','女','一位二十六岁的女性，声音湿润清凉，语速适中'],
  ['灵叙柔','女','一位三十岁的女性，声音柔和叙述感强，语速平缓'],
  ['灵绮木','女','一位二十八岁的女性，声音略带木质共鸣，语速适中'],
  ['灵素心','女','一位三十岁的女性，声音素净淡雅，语速平缓'],
  ['灵采薇','女','一位二十二岁的女性，声音清新自然，语速适中'],
  ['灵心澜','女','一位三十岁的女性，声音起伏有波澜，语速适中'],
  ['灵语冰','女','一位二十六岁的女性，声音清冷如冰，语速偏慢'],
  ['灵惜蕊','女','一位二十岁的女性，声音纤细柔弱，语速缓慢'],
  ['灵语萱','女','一位二十八岁的女性，声音活泼开朗，语速轻快'],
  ['灵语烟','女','一位三十岁的女性，声音轻烟般飘散，语速缓慢'],
  ['灵律雅','女','一位三十二岁的女性，声音端庄典雅，语速从容'],
  ['灵慈萱','女','一位四十岁的女性，声音慈爱温和，语速平缓'],
  ['灵妙音','女','一位二十五岁的女性，声音美妙悦耳，语速适中'],
  ['灵熙婉','女','一位三十岁的女性，声音和煦婉转，语速舒缓'],
  ['灵妩月','女','一位二十七岁的女性，声音柔美撩人，语速缓慢'],
  ['灵汐月','女','一位二十四岁的女性，声音清冷柔和，语速适中'],
  ['灵黛嗔','女','一位二十二岁的女性，声音娇嗔带笑意，语速轻快'],

  /* ── 男声 ── */
  ['灵小锋','男','一位二十八岁的男性，声音锋利利落，语速偏快'],
  ['灵小川','男','一位三十岁的男性，声音平稳如流水，语速适中'],
  ['灵小琪','男','一位二十六岁的男性，声音清亮年轻，语速适中'],
  ['灵空','男','一位三十岁的男性，声音空灵通透，语速缓慢'],
  ['灵宇','男','一位三十二岁的男性，声音浑厚有空间感，语速平稳'],
  ['灵朗','男','一位二十八岁的男性，声音明朗爽快，语速轻快'],
  ['灵楷','男','一位四十岁的男性，声音低沉有磁性，语速舒缓，像深夜电台'],
  ['灵旭','男','一位二十六岁的男性，声音朝气有活力，语速偏快'],
  ['灵江','男','一位三十五岁的男性，声音宽广沉稳，语速从容'],
  ['皮六','男','一位二十岁的男性，声音调皮跳脱，语速轻快'],
  ['悟空','男','一位年轻男性，声音戏剧化有张力，语速起伏明显'],
  ['灵晓声','男','一位三十岁的男性，声音清晰易懂，语速适中'],
  ['灵逸风','男','一位二十七岁的男性，声音飘逸洒脱，语速适中'],
  ['灵亦尘','男','一位三十岁的男性，声音略带沙哑沧桑，语速舒缓'],
  ['灵语尘','男','一位二十八岁的男性，声音平凡温和，语速平缓'],
  ['灵妙声','男','一位三十二岁的男性，声音悦耳动听，语速适中'],
  ['灵言澈','男','一位二十六岁的男性，声音清透干净，语速适中'],
  ['灵嘉肴','男','一位三十岁的男性，声音温厚可口，语速适中'],
  ['灵孤影','男','一位三十五岁的男性，声音孤冷疏离，语速缓慢'],
  ['灵信远','男','一位四十岁的男性，声音笃定可信，语速沉稳'],
  ['灵思齐','男','一位三十二岁的男性，声音条理清晰，语速适中'],
  ['灵渊霆','男','一位三十八岁的男性，声音深沉如雷，语速缓慢'],
  ['灵卓然','男','一位三十岁的男性，声音卓越突出，语速适中'],
  ['灵浅忧','男','一位二十五岁的男性，声音带淡淡忧郁，语速舒缓'],
  ['灵昭野','男','一位三十岁的男性，声音旷野辽阔，语速从容'],
  ['灵犀言','男','一位二十八岁的男性，声音机敏锐利，语速偏快'],
  ['灵惊鸿','男','一位三十二岁的男性，声音惊艳有冲击，语速起伏'],
  ['灵惊涛','男','一位三十五岁的男性，声音如惊涛有力，语速偏快'],
  ['灵寒陌','男','一位三十岁的男性，声音寒冷陌生，语速缓慢'],
  ['灵决冥','男','一位四十岁的男性，声音决绝深沉，语速缓慢'],
  ['灵断尘','男','一位三十六岁的男性，声音苍凉断然，语速沉稳'],
  ['灵旭扬','男','一位二十八岁的男性，声音昂扬向上，语速偏快'],
  ['灵阅川','男','一位四十二岁的男性，声音阅历丰厚，语速舒缓'],

  /* ── 影视角色：用「角色性格」描述，不能提具体作品名 ── */
  ['蜡笔小新_野原美伢','女','一位三十岁的年轻母亲，声音急躁又关切，语速偏快'],
  ['小猪佩奇_佩奇','女','一位五岁的小女孩，声音稚嫩奶气，语速慢'],
  ['康熙王朝_康熙','男','一位四十岁的皇帝，声音威严不容置疑，语速沉稳'],
  ['西游记_唐僧','男','一位三十岁的僧人，声音平和慈悲，语速缓慢'],
  ['甄嬛传_四郎','男','一位四十五岁的帝王，声音威压内敛，语速从容'],
  ['水浒传_武松','男','一位三十岁的壮汉，声音粗豪有力，语速快'],
  ['水浒传_潘金莲','女','一位二十五岁的女子，声音娇媚勾人，语速缓慢'],
  ['雍正王朝_雍正','男','一位四十五岁的帝王，声音冷峻多疑，语速沉稳'],

  /* ── 英文内置音色：走 ip 模板的 voice_id，instruct 留空 ── */
  ['US_Emma','女','', { vid: 'US_Emma' }],
  ['UK_George','男','', { vid: 'UK_George' }],
  ['UK_Charlotte','女','', { vid: 'UK_Charlotte' }],
]

const MING_VOICES = MING_VOICE_ROWS.map(([name, gender, instruct, extra]) => {
  const x = { name, lang: /^[A-Za-z]/.test(name) ? 'en' : 'zh' }
  if (gender) x.gender = gender
  /* 声音描述：真正决定这一条音色听起来是什么样 */
  if (instruct) x.instruct = instruct
  /* 英文内置音色走 ip 模板 + voice_id，其余走 freeform + instruct */
  if (extra && extra.vid) { x.vid = extra.vid; x.template = 'ip' }
  if (MING_FEATURED[name]) {
    x.label = name + ' · ' + MING_FEATURED[name]
    x.featured = true
    x.rank = Object.keys(MING_FEATURED).indexOf(name) + 1
  }
  return x
})

/* 名字 → 这条音色该怎么念（instruct 或 voice_id），给 audio.js 用 */
function mingVoiceSpec(name) {
  const n = String(name || '').trim()
  const hit = MING_VOICES.find((x) => x.name === n)
  if (!hit) return null
  return { name: hit.name, instruct: hit.instruct || '', template: hit.template || '', vid: hit.vid || '' }
}

/** 把磁盘上最近一份方案里的稿子带出来（不读内存，换页面重启都还在） */
function planScript() {
  try {
    const T = require('./timeline')
    const list = T.listProjects()
    for (const p of list) {
      const doc = T.load ? T.load(p.name || p) : null
      const plan = doc && doc.plan
      if (plan && Array.isArray(plan.lines) && plan.lines.length) {
        return { project: p.name || p, lines: plan.lines, text: plan.lines.join('\n') }
      }
      const vo = doc && doc.voice
      if (vo && vo.text) return { project: p.name || p, lines: String(vo.text).split(/\n+/), text: vo.text }
    }
  } catch (e) {}
  return { project: '', lines: [], text: '', note: '磁盘上还没有带配音稿的方案。先在剪辑台里写好文案，再回来点「载入」。' }
}

function mirrorSave(d = {}) {
  const s = settings()
  if (d.pip_mirror) s.voice_pip_mirror = String(d.pip_mirror)
  if (d.weight_source) s.voice_weight_source = String(d.weight_source)
  if (d.pip_custom !== undefined) s.voice_pip_custom = String(d.pip_custom || '').trim()
  saveSettings(s)
  const m = PIP_MIRRORS.find((x) => x.id === s.voice_pip_mirror) || PIP_MIRRORS[0]
  return { ok: true, pip_url: s.voice_pip_custom || m.url, pip_mirror: s.voice_pip_mirror, weight_source: s.voice_weight_source }
}

/** 「模型目录」按钮：在 Finder 里打开语音权重目录，用户能直接看到/拖进权重。 */
function revealDir() {
  const P2 = path.resolve(VM_DIR)
  if (!fs.existsSync(P2)) fs.mkdirSync(P2, { recursive: true })
  try { require('electron').shell.showItemInFolder(P2) } catch (e) {}
  return { path: P2 }
}

/**
 * 「从文件夹接入」按钮：弹系统文件夹选择框，把用户自己下好的权重软链进 VM_DIR。
 * 不复制（权重动辄 1.5GB，复制既慢又占双份磁盘）——建软链，原目录还在原处。
 * 识别规则：选中的文件夹本身，或它的直接子目录，名字能对上内置模型 id
 * （ming-tts / sense-voice）就认；认不出的也接进来，用文件夹名当 id，
 * 至少文件在那、用户能自己用，不骗人说「不支持」。
 */
async function adopt(d = {}) {
  let folder = String(d.path || '').trim()
  if (!folder) {
    try {
      const { dialog, BrowserWindow } = require('electron')
      const win = BrowserWindow.getFocusedWindow()
      const r = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择下载好的语音模型文件夹' })
        : await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择下载好的语音模型文件夹' })
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { cancelled: true }
      folder = r.filePaths[0]
    } catch (e) {
      return { cancelled: true, error: '弹不出文件夹选择框：' + e.message }
    }
  }
  const src = path.resolve(folder)
  if (!fs.existsSync(src)) throw new Error('这个文件夹不存在：' + src)

  // 认模型：选中目录本身像 ming-tts，或其子目录里有一个能对上名字的
  const known = ['ming-tts', 'sense-voice', 'sensevoice', 'sherpa-sensevoice']
  let id = '', modelDir = src
  const base = path.basename(src)
  if (known.includes(base)) { id = base === 'sensevoice' ? 'sense-voice' : base; modelDir = src }
  else {
    try {
      const sub = fs.readdirSync(src).filter((x) => {
        try { return fs.statSync(path.join(src, x)).isDirectory() } catch (e) { return false }
      })
      const hit = sub.find((x) => known.includes(x))
      if (hit) { id = hit === 'sensevoice' ? 'sense-voice' : hit; modelDir = path.join(src, hit) }
    } catch (e) {}
  }
  if (!id) id = base || 'imported-model'

  // 软链到 VM_DIR/<id>；已存在就先挪开成 .bak，不覆盖用户数据
  if (!fs.existsSync(VM_DIR)) fs.mkdirSync(VM_DIR, { recursive: true })
  const dest = path.join(VM_DIR, id)
  const absSrc = fs.realpathSync(modelDir)
  if (fs.existsSync(dest) || isBrokenLink(dest)) {
    let bak = dest + '.bak-' + Date.now()
    try { fs.renameSync(dest, bak) } catch (e) { bak = '' }
  }
  try {
    fs.symlinkSync(absSrc, dest, 'dir')
  } catch (e) {
    throw new Error('接入失败（建软链出错）：' + e.message)
  }
  const m = configModels().find((x) => x.id === id)
  return { ok: true, id, name: (m && m.name) || id, path: dest, target: absSrc }
}

function isBrokenLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p) } catch (e) { return false }
}

async function main(d = {}) {
  const act = String(d.action || 'list')
  if (act === 'list' || act === 'status') return await catalog()
  if (act === 'voices') { await primeSystem(); return voices(d.id) }
  if (act === 'plan_script') return planScript()
  if (act === 'save_picks') return savePicks(d.id || activeId(), d.sel, d.pinned, d.locked)
  if (act === 'set_active') return setActive(String(d.id || ''))
  if (act === 'mirror_save') return mirrorSave(d)
  /* 配音页顶栏两个按钮：模型目录 / 从文件夹接入。
     以前这俩 action 没接，前端一点就「不认识的 action」，按钮形同虚设。 */
  if (act === 'reveal') return revealDir()
  if (act === 'adopt') return await adopt(d)

  /* ── 下面这些是配音页真在用的接口，之前一个都没接 ──
     前端调 16 个 action、后端只实现了 6 个，症状就是点哪儿都弹
     「接口出错：不认识的 action：xxx」。这里按前端的实际参数逐个补上。 */
  if (act === 'tts') return await doTts(d)
  if (act === 'preview') return await doPreview(d)
  if (act === 'install') return await doInstall(d)
  if (act === 'uninstall') return await doUninstall(d)
  if (act === 'delete') return await doDelete(d)
  if (act === 'import') return await doImport(d)
  if (act === 'record_audio') return await doRecord(d)
  if (act === 'rescan_voices') return await doRescan(d)
  if (act === 'save_voice') return await doSaveVoice(d)
  if (act === 'voice_delete') return await doVoiceDelete(d)

  throw new Error('不认识的 action：' + act)
}

/* ══════════ 配音/试听：走 audio.js 的 Ming 引擎（那边是完整实现，这里只做转接） ══════════ */
async function doTts(d = {}) {
  const A = require('./audio')
  const text = String(d.text || '').trim()
  if (!text) throw new Error('配音文本是空的')
  const voice = String(d.voice || '')
  /* ★ 用户自己录的音色要真克隆：传 task:'clone' + voiceRef 参考音频。
     以前只把名字丢给 voiceId —— Ming 的 voice_id 只认 4 个内置英文音色
     （US_Emma 等，且只属于 ip 模板），中文音色名一个都不认，于是
     「选了我的音色」和「选默认音色」出来的声音完全一样。 */
  const ref = myVoiceFile(voice)
  const useRef = !!ref
  /* ★★ 必须走 A.tts()，不能直接调 A.mingTts()。
     A.tts() 里才有「预设音色名 → instruct 声音描述」的翻译（Ming 3.0 不认
     任何音色名字，只有 instruct / voice_ref / voice_id 三条路）。
     以前这里直连 mingTts 并传 voiceId:中文名，Ming 不认这个键 → 等于没选，
     所有音色都是同一个默认嗓子。这正是「选了男声放出来还是女声」的根因。 */
  const r = await A.tts(text, {
    voice: voice,
    voiceRef: useRef ? ref : undefined,
    referenceText: useRef ? String(d.reference_text || '') : undefined,
    speed: d.speed, pitch: d.pitch, volume: d.volume, emotion: d.emotion,
    language: 'zh',
  })
  if (!r.ok) throw new Error(r.error || '合成失败')
  return {
    ok: true, url: fileUrl(r.path), path: r.path, name: r.name,
    duration: r.duration || 0, mode: '本地离线', ms: r.ms,
    cloned: useRef,
    note: useRef ? ('本地 Ming 合成 · 用你的音色「' + voice + '」') : '本地 Ming 合成',
  }
}

/** 试听：跟正式配音同一条链路，只是文本短。rate 是系统 TTS 的口径，Ming 不认，忽略。 */
async function doPreview(d = {}) {
  const text = String(d.text || '').trim() || '这是音色试听，听一下合不合适。'
  const r = await doTts({ ...d, text })
  return { ...r, mode: '试听' }
}

/** 文件 → velora:// 可播地址。UI 走自定义协议，不能直接给绝对路径。 */
function fileUrl(p) {
  const name = String(p || '').split('/').pop()
  return '/voice/' + encodeURIComponent(name)
}

/* ══════════ 模型安装 / 卸载 / 删除 ══════════ */
/* 模型 id → localmodels 的 kind。
   Ming 的权重其实是手工放进去的（用户自己下 1.5G 放进 weights 目录），
   所以这里不假装能一键下载 —— 如实说明「已就绪 / 缺权重、怎么放」。 */
function kindOf(id) {
  const s = String(id || '')
  if (/ming/.test(s)) return 'ming_tts'
  if (/sense|asr/i.test(s)) return 'asr'
  if (/system|macos/i.test(s)) return 'system_tts'
  return 'ming_tts'
}
async function doInstall(d = {}) {
  const kind = kindOf(d.id)
  const st = ttsState(kind === 'asr' ? 'sense-voice' : 'ming-tts')
  if (st && st.state === 'ready') return { ok: true, state: 'ready', note: '权重已经在盘上，可以直接用' }
  const W = require('./localmodels')
  return await W.install(kind === 'asr' ? 'asr' : 'ming_tts')
}
async function doUninstall(d = {}) {
  const W = require('./localmodels')
  return W.uninstall(kindOf(d.id))
}
async function doDelete(d = {}) {
  /* 真删权重目录。跟 uninstall 的区别：uninstall 只给说明，delete 是用户明确要求删盘。 */
  const dir = join(VM_DIR, kindOf(d.id) === 'asr' ? 'sense-voice' : 'ming-tts')
  if (!existsSync(dir)) return { ok: true, note: '本机没有这个权重目录，不用删' }
  fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true, note: '已删除 ' + dir }
}

/* ══════════ 音色样本导入 / 录音 / 重扫 / 保存 / 删除 ══════════ */
async function doImport(d = {}) {
  /* 真导入：前端先用 Electron 原生对话框（riffcut.pickAudio）拿到绝对路径，
     再把它交给这里。流程是「转成 16k 单声道 WAV → 落到 音色/<名字>/sample.wav
     → 写索引」，和录音那条路走同一个落盘函数，所以后面的列表/试听/出片全部复用。
     2026-11-22 之前这里只 return 一句「请用添加模型 → 从文件夹接入」，
     等于按钮是假的。 */
  const src = String(d.path || '').trim()
  if (!src) return { ok: false, needPick: true, error: '没有收到文件路径，请重新选择音色样本' }
  if (!existsSync(src)) return { ok: false, error: '文件不在了：' + src }
  if (!/\d+$|\.\w+$/.test(src)) return { ok: false, error: '这个路径看起来不像文件：' + src }

  const name = String(d.name || '').trim() ||
    require('node:path').basename(src).replace(/\.[^.]+$/, '').slice(0, 40) || '导入的音色'
  const dir = join(VM_DIR, '音色', safeName(name))
  P.ensureDir(dir)
  const dst = join(dir, 'sample.wav')

  /* 统一转 16k 单声道 WAV：克隆要的就是这个格式，源头是 mp3/m4a 也一并吃掉。
     已经是 16k 单声道 WAV 时 ffmpeg 也会原样再转一遍（几十毫秒，不值得为省这点加判断）。 */
  let converted = false
  try {
    const EX = require('./exec')
    const r = await EX.run(P.FFMPEG, [
      '-y', '-v', 'error', '-i', src,
      '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', dst,
    ], { timeout: 120000 })
    converted = !!r.ok && existsSync(dst)
  } catch (e) { converted = false }

  if (!converted) {
    /* 转不了就原样复制（已经是 wav 且格式凑合时引擎也能吃），至少别让用户白选一次 */
    try {
      require('node:fs').copyFileSync(src, dst)
    } catch (e) {
      return { ok: false, error: '这个文件读不出来：' + (e.message || e) }
    }
  }

  saveVoiceIndex(name, dst)
  const p = await require('./exec').probe(dst)
  const sec = p ? Number(p.duration) || 0 : 0
  if (!sec) return { ok: false, error: '这个文件里没有声音，换一个再试' }
  if (sec < 3) {
    return {
      ok: true, name, path: dst, duration: sec, short: true,
      note: '已导入「' + name + '」（只有 ' + sec.toFixed(1) + ' 秒，短了点）。录 10 秒以上效果更稳。',
    }
  }
  return {
    ok: true, name, path: dst, duration: sec,
    note: '已导入「' + name + '」（' + sec.toFixed(1) + ' 秒）。现在就能用它配音。',
  }
}
async function doRecord(d = {}) {
  const A = require('./audio')
  const b64 = String(d.audio || '').replace(/^data:audio\/[^;]+;base64,/, '')
  if (!b64) throw new Error('没有收到录音数据')
  const name = String(d.name || '').trim() || ('我的音色-' + Date.now())
  const dir = join(VM_DIR, '音色', safeName(name))
  P.ensureDir(dir)
  const file = join(dir, 'sample.wav')
  require('node:fs').writeFileSync(file, Buffer.from(b64, 'base64'))
  saveVoiceIndex(name, file)
  const p = await require('./exec').probe(file)
  return { ok: true, name, path: file, duration: p ? p.duration : 0 }
}
async function doRescan() {
  /* 重扫音色库：磁盘上有什么就报什么，不猜。 */
  const dir = join(VM_DIR, '音色')
  const list = []
  try {
    for (const n of require('node:fs').readdirSync(dir)) {
      const s = join(dir, n, 'sample.wav')
      if (existsSync(s)) list.push({ name: n, path: s })
    }
  } catch (e) {}
  return { ok: true, count: list.length, voices: list }
}
async function doSaveVoice(d = {}) {
  const name = String(d.name || '').trim()
  if (!name) throw new Error('音色名不能空')
  const src = String(d.path || '').trim()
  if (!src || !existsSync(src)) throw new Error('音色样本文件不在：' + src)
  const dir = join(VM_DIR, '音色', safeName(name))
  P.ensureDir(dir)
  const dst = join(dir, 'sample.wav')
  if (src !== dst) require('node:fs').copyFileSync(src, dst)
  saveVoiceIndex(name, dst)
  return { ok: true, name, path: dst }
}
async function doVoiceDelete(d = {}) {
  const name = String(d.name || '').trim()
  if (!name) throw new Error('要给音色名')
  const dir = join(VM_DIR, '音色', safeName(name))
  try { require('node:fs').rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  /* 索引条目也要删 —— 只删目录会留下一条指向不存在文件的记录。
     myVoices() 虽然会过滤掉失效条目（不会显示幽灵音色），但索引越攒越脏，
     用户以后想核对「我到底录过几个」就说不清了。 */
  const f = join(VM_DIR, '音色', 'index.json')
  try {
    const m = JSON.parse(require('node:fs').readFileSync(f, 'utf8')) || {}
    if (Object.prototype.hasOwnProperty.call(m, name)) {
      delete m[name]
      require('node:fs').writeFileSync(f, JSON.stringify(m, null, 1), 'utf8')
    }
  } catch (e) {}
  return { ok: true, name }
}

function safeName(s) { return String(s).replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60) }

/** 音色索引：不用数据库，一个 json 就够（重启要能读回来）。 */
function saveVoiceIndex(name, file) {
  const f = join(VM_DIR, '音色', 'index.json')
  P.ensureDir(join(VM_DIR, '音色'))
  let m = {}
  try { m = JSON.parse(require('node:fs').readFileSync(f, 'utf8')) } catch (e) {}
  m[name] = { name, file, at: new Date().toISOString() }
  require('node:fs').writeFileSync(f, JSON.stringify(m, null, 1), 'utf8')
}

module.exports = {
  VM_DIR, CAP_LABELS, TTS_OPTS, PIP_MIRRORS, WEIGHT_SOURCES, MING_VOICES, mingVoiceSpec,
  catalog, voices, myVoices, myVoiceFile, setActive, getPicks, savePicks, planScript, mirrorSave, main, configModels,
}
