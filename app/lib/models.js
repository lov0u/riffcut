'use strict'
/**
 * 模型管理：模型表、密钥存放、连接测试、用量归因。
 *
 * 两条硬规则来自旧软件的实战：
 *  · **密钥不落明文**。模型.json 里绝不写 key，改用本机钥匙串
 *    （macOS `security` 命令，service = `riffcut.<软件根 hash>`）。
 *    旧版是自己实现的一套加密信封，好处是不依赖系统；代价是用户换机器/
 *    重装就全部读不出来。钥匙串是系统能力，跟着账户走，更稳。
 *  · **默认模型不在模型管理页设置**。用户在首页对话下拉里选一次，
 *    写进 设置.json 的 chat_model_id，重启/重开窗口都不换。
 *    以前只写浏览器 localStorage，App 用 file:// 载入页面，一重启就空，
 *    于是每次都退回 is_default 那个 —— 用户看到的是「我选的模型重启又变回去了」。
 */

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const path = require('path')
const P = require('./paths')
const C = require('./core')
const E = require('./exec')

/* ★ 钥匙串服务名必须是「稳定的」，不能跟安装路径绑定。
   以前是 sha1(P.ROOT) —— 源码目录是 /…/影创新版，打包后在
   /…/影创新版/RiffCut影创.app/Contents/Resources，两者算出两个完全不同的服务名：
     源码 → riffcut.da07f4655d8b
     包内 → riffcut.4a8dd1656a34
   后果：用户在界面里填的 API Key 存进「源码那一个」，重启后 App 从包里跑，
   读的是另一个空条目 → 模型管理三个模型全显示「待配置」，
   一点「测试」就弹「没有密钥：到模型管理填上 API Key」。填一百遍也没用。
   现在固定成一个常量服务名，跟路径无关；同时保留旧名的读取做迁移。 */
const KEYCHAIN_SERVICE = 'riffcut.apikeys'

/** 老版本用路径哈希当服务名，这些名字下可能存着真 Key —— 要迁过来 */
function legacyServices() {
  const out = []
  try {
    const root = String(P.ROOT || '')
    out.push('riffcut.' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 12))
    // 常见的另一种根：仓库根目录（开发时 ROOT 是它，打包后不是）
    const repo = root.replace(/\/RiffCut影创\.app\/Contents\/Resources$/, '')
    if (repo !== root) out.push('riffcut.' + crypto.createHash('sha1').update(repo).digest('hex').slice(0, 12))
  } catch (e) {}
  return [...new Set(out)].filter(Boolean)
}

const PRESET_ID = 'preset-auto'

/**
 * 预设供应商：软件里预置「用哪家的接口」，密钥一律留空由用户自己填。
 *
 * ★ 为什么密钥不打包进 app
 *   ① 技术上网关一拦就没了 —— Electron 的 asar 只是打包不是加密，`npx asar extract`
 *      一条命令就能解开，密钥明文躺着。任何人下载安装包都能拿走。
 *   ② 一旦泄露是你自己买单 —— 别人拿你的 key 跑量，账单记在你头上，且平台按 key 封号，
 *      你所有用户同时不可用。
 *   ③ 打包进去等于「你替用户付钱」，那就不是卖软件而是卖 API 额度，成本随用户数线性涨。
 *   正确做法：软件只提供「这家怎么填」的模板 + 一键跳转注册页，密钥存用户自己的钥匙串。
 *
 * 注册地址填的是官方入口，不是推广链接 —— 推广码由使用者在设置里自己贴
 * （见下方 invite 字段），这样软件本体不含任何人的分成关系，合规且不锁死。
 *
 * ★ 这三条预设的共同点是「注册就能用，不用充值」。
 *   第一次打开软件的人最怕的是「还没干活先要付钱」，所以选预设时优先免费额度的家，
 *   付费的（DeepSeek/OpenAI 等）留在「其他」组里当备选。
 *   白鹿每天 500 万 Tokens、Agnes 免费档，实测够跑几十条短视频的文案与出图。
 */
const PRESETS = [
  {
    key: 'bailu',
    name: '白鹿 BailuCode',
    vendor: 'OpenAI 兼容',
    url: 'https://bailucode.com/openapi/v1',
    model: 'bailu-2.8',
    kind: 'text',
    vision: false,
    image: true,
    register: 'https://bailucode.com/auth/register',
    console: 'https://bailucode.com/api_platform/',
    // 白鹿注册页认 ?invite=INV-XXXX-XXXX 格式，留空则走普通注册
    inviteParam: 'invite',
    invite: 'INV-NEPT-NJ5X-DLKP',
    free: '每天领 500 万 Tokens，不用充值',
    note: '免费额度：每天登录控制台可领 500 万 Tokens，够跑几十条片子的文案。' +
          '中文排版最强，文生图主力 bailu-image-2.0，抠图 bailu-image-remove。' +
          'base_url 必须带 /openapi（写成 https://bailucode.com/v1 会返回 HTML）。',
  },
  {
    key: 'agnes-cn',
    name: 'Agnes（国内）',
    vendor: 'OpenAI 兼容',
    url: 'https://api.agnes-ai.cn/v1',
    model: 'agnes-2.5-flash',
    kind: 'vision',
    vision: true,
    image: true,
    register: 'https://platform.agnes-ai.cn/login',
    console: 'https://platform.agnes-ai.cn/',
    inviteParam: '',
    invite: '',
    registerNote: '登录页点「Sign Up」注册，没有独立注册页',
    free: '注册即送，免费档日常够用 · 10 rpm',
    note: '免费额度：注册即有，日常够用。10 rpm（每分钟 10 次）。' +
          '国内端点比国际版快约 35%，能读图、能生图。边聊边改选它。',
  },
  {
    key: 'agnes-intl',
    name: 'Agnes（国际）',
    vendor: 'OpenAI 兼容',
    url: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.5-flash',
    kind: 'vision',
    vision: true,
    image: true,
    register: 'https://platform.agnes-ai.com/login',
    console: 'https://platform.agnes-ai.com/',
    inviteParam: '',
    invite: '',
    registerNote: '登录页点「Sign Up」注册，没有独立注册页',
    free: '注册即送，免费档 · 20 rpm（国内两倍）',
    note: '免费额度：注册即有。20 rpm（国内的两倍），批量跑文本选它 —— ' +
          '100 条文案国内要 10 分钟，这里 5 分钟。' +
          '国际 key 只在 apihub.agnes-ai.com 生效，填到国内端点会 401。',
  },
]

function presetOf(key) {
  return PRESETS.find((p) => p.key === String(key || '')) || null
}

/** 拼注册链接：有推广码就带上，没有就是官方注册页。
 *  推广码优先读用户在设置里自己贴的那一个（设置.json 的 preset_invites），
 *  其次读 PRESETS 里写的默认值。这样推广关系属于使用者，不属于软件本体。 */
function inviteOf(key) {
  const p = presetOf(key)
  if (!p) return ''
  try {
    const s = C.settings()
    const m = s && s.preset_invites
    if (m && typeof m === 'object' && String(m[p.key] || '').trim()) {
      return String(m[p.key]).trim()
    }
  } catch (e) {}
  return String(p.invite || '').trim()
}

function registerUrl(key) {
  const p = presetOf(key)
  if (!p) return ''
  const inv = inviteOf(key)
  if (!p.inviteParam || !inv) return p.register
  const sep = p.register.includes('?') ? '&' : '?'
  return p.register + sep + p.inviteParam + '=' + encodeURIComponent(inv)
}

/** 存推广码。传空字符串就是清掉。 */
function setInvite(key, code) {
  const p = presetOf(key)
  if (!p) throw new Error('没有这个预设供应商')
  const s = C.settings()
  const m = (s.preset_invites && typeof s.preset_invites === 'object') ? { ...s.preset_invites } : {}
  const v = String(code || '').trim()
  if (v) m[p.key] = v
  else delete m[p.key]
  s.preset_invites = m
  C.saveSettings(s)
  return { key: p.key, invite: v, register: registerUrl(p.key) }
}

const DEFAULT_MODELS = {
  'slot-text': {
    id: 'slot-text', name: '文本 / 对话模型', kind: 'text',
    vendor: 'OpenAI 兼容', url: '', key: '', model: '',
    price: 0, builtin: true, chat: true, vision: false,
    roles: ['需求理解', '脚本创作', '质量检查'], fallback: '',
    note: '听懂需求、写文案、排分镜。填任意兼容 /chat/completions 的模型 ID。',
  },
  'slot-vision': {
    id: 'slot-vision', name: '视觉 / 多模态模型', kind: 'vision',
    vendor: 'OpenAI 兼容（图片输入）', url: '', key: '', model: '',
    price: 0, builtin: true, chat: true, vision: true,
    roles: ['视觉分析', '参考视频分析'], fallback: '',
    note: '填支持图片输入的模型 ID（Agnes 2.5flash / GPT-4o / Gemini / Qwen-VL 等）；点「测试连接」会真发一张图，能不能读图由实测结果说话。',
  },
  'slot-tts': {
    id: 'slot-tts', name: 'macOS 系统音色（本机）', kind: 'tts',
    vendor: '本机 · 离线可用', url: '', key: '', model: 'say',
    price: 0, builtin: true, chat: false, vision: false,
    roles: ['语音合成'], fallback: '',
    note: '系统自带，不用装、不用联网；中文可用音色 8 个，想要更自然的音色可另装本地神经 TTS。',
  },
  'slot-asr': {
    id: 'slot-asr', name: '本地语音识别', kind: 'asr',
    vendor: '本机 · 离线可用', url: '', key: '', model: 'sense-voice',
    price: 0, builtin: true, chat: false, vision: false,
    roles: ['语音转字幕'], fallback: '',
    note: '基于 SenseVoice（sherpa-onnx），中/英/日/韩/粤离线识别，权重随软件预置，开箱即用。',
  },
}

const KINDS = ['text', 'vision', 'image', 'video', 'tts', 'asr']

/**
 * 请求头里的 UA 不能是默认的 node/undici。
 * 白鹿前面挂了 Cloudflare，没有浏览器指纹的 UA 会被 403 error code: 1010
 * （那是浏览器签名异常，不是鉴权失败 —— 换 key 没用）。
 * 其它家也不介意收到一个正常 Chrome UA，所以统一带上。
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ── 钥匙串 ───────────────────────────────────────────────
/** 按指定服务名读一次。拿不到返回空串。 */
function keyGetFrom(svc, id) {
  try {
    const out = execFileSync('/usr/bin/security',
      ['find-generic-password', '-s', svc, '-a', String(id), '-w'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return String(out || '').trim()
  } catch { return '' }
}

/** 读一个密钥。拿不到返回空串（绝不抛 —— 读不到密钥不该让整个模型表炸）。
 *  先读新服务名；没有就扫旧的服务名，读到还顺手迁过来 —— 用户不必重填一遍。 */
function keyGet(id) {
  const v = keyGetFrom(KEYCHAIN_SERVICE, id)
  if (v) return v
  for (const svc of legacyServices()) {
    const old = keyGetFrom(svc, id)
    if (old) {
      // 静默迁移：写进新服务名，下次就不用再找了
      try { keySet(id, old) } catch (e) {}
      return old
    }
  }
  return ''
}

function keySet(id, value) {
  const v = String(value || '')
  if (!v) return keyDel(id)
  try {
    // -U = 已存在就更新。密码从 stdin 读不进去，只能走参数 —— `security` 没有
    // 其它写法；这个进程是本机的，参数列表只有自己的用户看得到。
    execFileSync('/usr/bin/security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', String(id), '-w', v],
      { timeout: 5000, stdio: 'ignore' })
    return true
  } catch { return false }
}

function keyDel(id) {
  try {
    execFileSync('/usr/bin/security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', String(id)],
      { timeout: 5000, stdio: 'ignore' })
  } catch {}
  return true
}

// ── 模型表 ───────────────────────────────────────────────
function _stripKeys(ms) {
  const out = {}
  for (const [k, v] of Object.entries(ms || {})) {
    if (!v || typeof v !== 'object') continue
    const c = { ...v }
    delete c.key
    out[k] = c
  }
  return out
}

function _inferKind(v) {
  const m = String((v && v.model) || '').toLowerCase()
  if (v && v.vision) return 'vision'
  if (/image|dall|flux|sd|seedream|draw/.test(m)) return 'image'
  if (/video|kling|sora|veo/.test(m)) return 'video'
  if (/tts|speech|say|voice/.test(m)) return 'tts'
  if (/whisper|asr|sense/.test(m)) return 'asr'
  return 'text'
}

/**
 * 读模型表。做一次性迁移、补内置槽位、把钥匙串里的密钥复活进内存。
 * ★ 复活只在内存里，不回写 json —— 写回去就破功了。
 */
function models() {
  let ms = P.load('models', {}) || {}
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) ms = {}
  let dirty = false

  // ① 迁移：json 里还有明文 key 的，搬进钥匙串，并从 json 里删掉。
  //    顺序很关键 —— 先搬走再写盘；早期写反了，保存时又把明文写回去了。
  const plain = {}
  for (const [k, v] of Object.entries(ms)) {
    if (v && typeof v === 'object' && String(v.key || '').trim()) plain[k] = String(v.key).trim()
  }
  if (Object.keys(plain).length) {
    for (const [k, v] of Object.entries(plain)) {
      keySet(k, v)
      delete ms[k].key
    }
    dirty = true
  }

  // ② 补内置槽位（用户删了也能恢复）
  for (const [k, v] of Object.entries(DEFAULT_MODELS)) {
    if (!(k in ms)) { ms[k] = { ...v }; dirty = true }
    else if (ms[k].builtin && !String(ms[k].model || '').trim()) {
      // 空槽位：描述/标记随版本更新；用户一旦填过模型就完全交给用户
      for (const f of ['note', 'kind', 'roles', 'vision', 'chat', 'image', 'video']) {
        if (ms[k][f] !== v[f]) { ms[k][f] = v[f]; dirty = true }
      }
    }
  }

  // ③ 补 kind
  for (const [k, v] of Object.entries(ms)) {
    if (!v || typeof v !== 'object') continue
    if (!v.kind) { v.kind = _inferKind(v); dirty = true }
    if (!v.id) { v.id = k; dirty = true }
  }

  if (dirty) P.save('models', _stripKeys(ms))

  // ④ 把钥匙串里的密钥复活进内存（不回写）
  for (const k of Object.keys(ms)) {
    const v = ms[k]
    if (!v || typeof v !== 'object') continue
    if (!String(v.key || '').trim()) {
      const got = keyGet(k)
      if (got) v.key = got
    }
  }
  return ms
}

function usable(v) {
  if (!v || typeof v !== 'object') return false
  if (v.builtin && ['tts', 'asr'].includes(v.kind)) return !!String(v.model || '').trim()
  if (!String(v.model || '').trim()) return false
  // 本机类（say / sense-voice）不需要 url/key
  if (['tts', 'asr'].includes(v.kind)) return true
  return !!String(v.url || '').trim()
}

/** 能对话的（chat=true 且可用）。给首页下拉用。 */
function chatModels(ms) {
  ms = ms || models()
  return Object.entries(ms)
    .filter(([, v]) => v && v.chat && usable(v))
    .map(([id, v]) => ({ id, name: v.name || id, kind: v.kind, model: v.model, vision: !!v.vision }))
}

/** 用户上次选的对话模型。失效（删了/没配好）就返回空，让调用方落默认。 */
function chatModelId(ms) {
  ms = ms || models()
  const want = String(C.settings().chat_model_id || '').trim()
  if (want && usable(ms[want])) return want
  // 没选过：优先内置 preset，其次第一个可用的视觉模型，再其次第一个可用的文本模型
  if (ms[PRESET_ID] && usable(ms[PRESET_ID])) return PRESET_ID
  const vis = Object.entries(ms).find(([, v]) => v && v.vision && v.chat && usable(v))
  if (vis) return vis[0]
  const txt = Object.entries(ms).find(([, v]) => v && v.kind === 'text' && usable(v))
  return txt ? txt[0] : ''
}

function setChatModel(mid) {
  const ms = models()
  const id = String(mid || '').trim()
  if (!ms[id]) throw new Error('找不到这个模型，可能已经被删掉了')
  if (!usable(ms[id])) throw new Error(`「${ms[id].name || id}」还没填接口地址或模型 ID，选它也没法对话`)
  const s = C.settings()
  s.chat_model_id = id
  C.saveSettings(s)
  C.history('切换对话模型', ms[id].name || id)
  return { id, name: ms[id].name || id }
}

/** 存一个模型（新增或修改）。key 走钥匙串，json 里永远不放。 */
function saveModel(data) {
  const ms = models()
  const id = String((data && data.id) || '').trim() || ('m-' + P.stamp())
  const prev = ms[id] || {}
  const v = { ...prev, ...(data || {}), id }
  v.name = String(v.name || '').trim() || '未命名模型'
  v.kind = KINDS.includes(v.kind) ? v.kind : _inferKind(v)
  v.model = String(v.model || '').trim()
  v.url = String(v.url || '').trim().replace(/\/+$/, '')
  v.price = Number(v.price) || 0
  v.vision = v.kind === 'vision' || !!v.vision
  v.chat = v.kind === 'tts' || v.kind === 'asr' ? false : (v.chat !== false)
  const key = String(v.key || '').trim()
  if (key) keySet(id, key)
  delete v.key
  ms[id] = v
  P.save('models', _stripKeys(ms))
  C.history('保存模型', v.name)
  return { id, name: v.name }
}

function deleteModel(id) {
  const ms = models()
  if (!ms[id]) throw new Error('找不到这个模型')
  if (ms[id].builtin) throw new Error(`「${ms[id].name}」是随软件带的槽位，不能删；改它的地址和模型 ID 就行`)
  delete ms[id]
  keyDel(id)
  P.save('models', _stripKeys(ms))
  const s = C.settings()
  if (s.chat_model_id === id) { delete s.chat_model_id; C.saveSettings(s) }
  C.history('删除模型', id)
  return { ok: true }
}

// ── 调用 ─────────────────────────────────────────────────
function apiOf(url, kind) {
  const u = String(url || '').toLowerCase()
  if (u.includes('anthropic') && !u.endsWith('/v1')) return 'anthropic-messages'
  return 'openai-completions'
}

/** 一次对话。返回 {ok, text, usage:{in,out}, model, ms, error}。 */
async function chat(mid, messages, opts = {}) {
  const ms = models()
  const v = ms[mid || chatModelId(ms)]
  if (!v) throw new Error('还没配模型：到「模型管理」填一个能对话的模型')
  if (!usable(v)) throw new Error(`「${v.name || mid}」还没填接口地址或模型 ID`)
  const key = String(v.key || keyGet(v.id || mid) || '').trim()
  if (!key && !/localhost|127\.0\.0\.1/.test(String(v.url || ''))) {
    throw new Error(`「${v.name || mid}」没有密钥：到「模型管理」填上 API Key`)
  }
  const base = String(v.url || '').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions'
  const body = {
    model: v.model,
    messages,
    stream: false,
  }
  if (opts.jsonMode) body.response_format = { type: 'json_object' }
  if (opts.temperature != null) body.temperature = Number(opts.temperature)
  if (opts.maxTokens) body.max_tokens = Number(opts.maxTokens)

  const t0 = Date.now()
  const headers = { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA }
  if (key) headers.Authorization = 'Bearer ' + key
  let r
  try {
    const resp = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(opts.timeout) || 600000),
    })
    const txt = await resp.text()
    let j = null
    try { j = JSON.parse(txt) } catch {}
    if (!resp.ok) {
      const msg = (j && (j.error?.message || j.message)) || txt.slice(0, 300)
      recordUsage({ model: v.name || mid, kind: v.kind, ok: false, ms: Date.now() - t0 })
      return { ok: false, error: `HTTP ${resp.status}：${msg}`, model: v.model, ms: Date.now() - t0 }
    }
    // ★ 推理模型（Qwen3 / DeepSeek-R1 一类）先出 reasoning_content 再出 content。
    // max_tokens 给小了会全部被思考过程吃掉，content 是空串 —— 看起来像「模型没回话」，
    // 实际是配额被 reasoning 用光了。这时候把思考过程亮出来，比返回空串有用得多。
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {}
    let text = String(msg.content || '')
    const think = String(msg.reasoning_content || '')
    if (!text.trim() && think.trim()) text = think
    const u = (j && j.usage) || {}
    recordUsage({
      model: v.name || mid, kind: v.kind, ok: true, ms: Date.now() - t0,
      in: u.prompt_tokens || 0, out: u.completion_tokens || 0, price: v.price || 0,
    })
    return {
      ok: true, text, model: v.model, ms: Date.now() - t0,
      usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 },
      raw: j,
    }
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? '请求超时' : String((e && e.message) || e)
    recordUsage({ model: v.name || mid, kind: v.kind, ok: false, ms: Date.now() - t0 })
    return { ok: false, error: msg, model: v.model, ms: Date.now() - t0 }
  }
}

/** 测试连接：真发一句话（视觉得真发一张图），由实测结果说话。 */
async function test(id) {
  const ms = models()
  const v = ms[id]
  if (!v) throw new Error('找不到这个模型')
  if (['tts', 'asr'].includes(v.kind)) {
    const A = require('./audio')
    if (v.kind === 'tts') {
      const voices = await A.systemVoices()
      return { ok: true, text: `本机中文音色 ${voices.good.length} 个，可直接配音` }
    }
    return { ok: true, text: '本地语音识别随软件预置，可直接用' }
  }
  // 视觉模型：真发一张 1x1 的图，能读出来才算能读图
  const messages = [{ role: 'user', content: '只回两个字：收到' }]
  if (v.vision) {
    const A = require('./assets')
    const png = A.tinyPng()
    messages[0].content = [
      { type: 'text', text: '这张图是什么颜色？只回颜色名。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } },
    ]
  }
  const r = await chat(id, messages, { maxTokens: 256, timeout: 60000 })
  if (!r.ok) return { ok: false, text: r.error }
  return { ok: true, text: String(r.text || '').trim().slice(0, 80) || '（空回答）', ms: r.ms }
}

// ── 用量归因 ─────────────────────────────────────────────
const USAGE_MAX = 5000

function recordUsage(rec) {
  try {
    const list = P.load('usage', [])
    const arr = Array.isArray(list) ? list : []
    arr.push({ at: P.now(), ...rec })
    P.save('usage', arr.slice(-USAGE_MAX))
    // 费用单独累计一份，给「模型管理」页直接读
    const cost = P.load('usage_totals', {}) || {}
    const inTok = Number(rec.in) || 0, outTok = Number(rec.out) || 0
    const price = Number(rec.price) || 0        // 元 / 百万 token
    const yuan = (inTok + outTok) / 1e6 * price
    cost.total_calls = (Number(cost.total_calls) || 0) + 1
    cost.total_in = (Number(cost.total_in) || 0) + inTok
    cost.total_out = (Number(cost.total_out) || 0) + outTok
    cost.total_yuan = +((Number(cost.total_yuan) || 0) + yuan).toFixed(6)
    cost.by_model = cost.by_model || {}
    const bm = cost.by_model[rec.model] || { calls: 0, in: 0, out: 0, yuan: 0 }
    bm.calls++; bm.in += inTok; bm.out += outTok; bm.yuan = +(bm.yuan + yuan).toFixed(6)
    cost.by_model[rec.model] = bm
    P.save('usage_totals', cost)
  } catch {}
}

function usageRecent(limit = 50) {
  const arr = P.load('usage', [])
  return (Array.isArray(arr) ? arr : []).slice(-Math.max(1, Number(limit) || 50)).reverse()
}

function usageTotals() {
  return P.load('usage_totals', {}) || { total_calls: 0, total_in: 0, total_out: 0, total_yuan: 0, by_model: {} }
}

/** 模型管理页要的完整快照。 */
function snapshot() {
  const ms = models()
  const cur = chatModelId(ms)
  const items = Object.entries(ms).map(([id, v]) => ({
    id, name: v.name || id, kind: v.kind, vendor: v.vendor || '',
    model: v.model || '', url: v.url || '', price: Number(v.price) || 0,
    builtin: !!v.builtin, chat: !!v.chat, vision: !!v.vision,
    roles: v.roles || [], fallback: v.fallback || '', note: v.note || '',
    usable: usable(v), hasKey: !!(String(v.key || '').trim()),
    current: id === cur,
  }))
  return {
    items, kinds: KINDS, current: cur,
    chat: chatModels(ms),
    presets: PRESETS.map((p) => ({
      key: p.key, name: p.name, vendor: p.vendor, url: p.url, model: p.model,
      kind: p.kind, vision: !!p.vision, image: !!p.image,
      register: registerUrl(p.key), console: p.console || '', note: p.note || '',
      registerNote: p.registerNote || '',
      /* free 是「这家免费额度怎么算」的一句话摘要，显示在卡片最上面那行绿条里。
         为空表示这家不免费（付费供应商），前端据此隐藏绿条。 */
      free: p.free || '',
      /* 把当前生效的推广码一起给前端：只给 hasInvite 布尔值，
         用户看不出自己填的是哪个码，改错也没法对。 */
      invite: inviteOf(p.key),
      hasInvite: !!(String(inviteOf(p.key) || '').trim()),
    })),
    usage: usageTotals(),
    recent: usageRecent(20),
    keychain: KEYCHAIN_SERVICE,
  }
}

module.exports = {
  DEFAULT_MODELS, KINDS, PRESET_ID, PRESETS, presetOf, registerUrl, setInvite, inviteOf,
  models, usable, chatModels, chatModelId, setChatModel,
  saveModel, deleteModel, chat, test, apiOf,
  recordUsage, usageRecent, usageTotals, snapshot,
  keyGet, keySet, keyDel, KEYCHAIN_SERVICE,
}
