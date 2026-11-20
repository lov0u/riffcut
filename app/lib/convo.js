/**
 * 首页对话存档（对应旧版 /api/conversations 的 save / get / flow / delete / list）。
 *
 * ★ 和 lib/sessions.js 是两件事，不要合并：
 *   - sessions.js 读的是「内核自己的会话」（home/sessions/*.jsonl.zstd），
 *     记的是内核跑了什么；用户改不了，也不该改。
 *   - 这个文件是「用户在首页打的字 + AI 回的话 + 每一步工具轨迹」，
 *     是给人看的存档，可以重命名、可以归档、可以导出。
 * 旧版就是这份独立存档，照搬结构，别自己发明。
 */
const fs = require('node:fs')
const path = require('node:path')
const P = require('./paths')

const FILE = path.join(P.HOME, '配置', '对话.json')
const MAX_MSG = 400
/** 这些标题是占位，接真实对话内容后要自动重算 */
/* ★ 这张表是「标题还是占位符，需要按真实内容重算」的判断依据。
   加了 'RiffCut' 让新对话的占位标题也能被重算；
   'AI 导演' 保留 —— 用户已有的历史对话里可能就存着这个标题，
   从这里删掉会让那些对话的标题永远停在占位状态。 */
const DEFAULT_TITLES = new Set(['', '新对话', '你好', 'RiffCut', 'AI 导演', '未命名对话'])

/** 六项需求澄清（旧版 BRIEF_FIELDS 的 key） */
const BRIEF_FIELDS = [
  { key: 'audience', label: '目标受众', hint: '这条片子给谁看，例如 To B 客户 / 年轻消费者' },
  { key: 'duration', label: '视频时长', hint: '成片多长，例如 60 秒 / 自动匹配' },
  { key: 'platform', label: '投放平台', hint: '在哪儿播，例如 官网 / 展会 / 抖音' },
  { key: 'aspect', label: '横竖版', hint: '画幅比例，例如 16:9 横版 / 9:16 竖版' },
  { key: 'tone', label: '品牌调性', hint: '整体感觉，例如 科技感 / 温暖 / 高级简约' },
  { key: 'selling', label: '重点卖点', hint: '最想传达什么，例如 技术实力 / 交付效率' },
]
const BRIEF_KEYS = BRIEF_FIELDS.map((f) => f.key)

function now() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function read() {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch (e) { return [] }
}

/** 原子写：先写 .tmp 再 rename。写到一半断电不会留下半个 JSON 把整份存档读崩 */
function write(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1))
  fs.renameSync(tmp, FILE)
}

// ── 标题 ────────────────────────────────────────────────
const PREFIXES = ['请帮我', '麻烦帮我', '帮我', '麻烦', '请', '我想做', '我想', '我要',
  '能不能帮我', '能不能', '可以帮我', '可以', '给我', '来一个',
  '做一个', '做个', '生成', '制作', '做', '一条', '一个', '一支', '一部', '一段']

/** 把一句话压成能当标题的短语：去客套、取第一句、限长 */
function cleanPhrase(s, limit = 16) {
  let t = String(s || '').replace(/\s+/g, ' ').trim()
  for (let k = 0; k < 3; k++) {
    let hit = false
    for (const p of PREFIXES) {
      if (t.startsWith(p)) { t = t.slice(p.length).replace(/^[\s，,。.:：;；、]+/, ''); hit = true; break }
    }
    if (!hit) break
  }
  for (const sep of ['。', '！', '？', '\n', '；', ';']) {
    if (t.includes(sep)) { t = t.split(sep)[0].trim(); break }
  }
  t = t.replace(/^[\s「」《》"'“”‘’。.!！?？,，:：;；\-—]+/, '').replace(/[\s「」《》"'“”‘’。.!！?？,，:：;；\-—]+$/, '')
  if (!t) return ''
  return t.length > limit ? t.slice(0, limit) + '…' : t
}

/** 自动起标题：先看用户第一句话，再看 AI 第一句，都不行就留占位 */
function autoTitle(conv) {
  const msgs = conv.messages || []
  const firstUser = msgs.find((m) => m.who !== 'AI' && String(m.text || '').trim())
  if (firstUser) {
    const t = cleanPhrase(firstUser.text)
    if (t) return t
  }
  const firstAi = msgs.find((m) => m.who === 'AI' && String(m.text || '').trim())
  if (firstAi) {
    const t = cleanPhrase(firstAi.text, 20)
    if (t) return t
  }
  return '新对话'
}

/** 真正的标题：用户亲手起过就不动 */
function titleOf(conv) {
  const cur = String(conv.title || '').trim()
  if (conv.title_by === 'user' && cur && !DEFAULT_TITLES.has(cur)) return cur
  if (cur && !DEFAULT_TITLES.has(cur)) return cur
  return autoTitle(conv)
}

// ── 需求澄清 ────────────────────────────────────────────
const BRIEF_KW = {
  audience: ['To B', 'to B', 'TO B', 'B端', 'B 端', 'To C', 'C端', '消费者', '目标客户',
    '面向客户', '潜在客户', '年轻用户', '内部汇报', '招商'],
  platform: ['官网', '展会', '抖音', '小红书', '视频号', 'B站', 'B 站', '朋友圈',
    '公众号', '快手', '淘宝', '京东', '大屏', '线下', 'YouTube', 'Instagram'],
  tone: ['科技感', '大气', '温暖', '简约', '高级', '极简', '活力', '专业', '稳重',
    '年轻', '国潮', '未来感', '质感', '亲切'],
}

function briefOf(conv) {
  const manual = conv.brief || {}
  const texts = (conv.messages || []).map((m) => String(m.text || '')).join(' ')
  const need = String(conv.requirement || '') + ' ' + texts
  const auto = {}
  for (const key of ['audience', 'platform', 'tone']) {
    const hit = (BRIEF_KW[key] || []).find((k) => need.includes(k))
    if (hit) auto[key] = { value: hit, from: '来自你的需求' }
  }
  const plan = conv.plan || {}
  if (plan.duration) auto.duration = { value: '约 ' + plan.duration + ' 秒', from: '来自制作方案' }
  const ap = (plan.output && plan.output.aspect) || ''
  if (ap) auto.aspect = { value: ap + (ap.includes('9:16') ? ' 竖版' : ' 横版'), from: '来自制作方案' }
  if (plan.summary) auto.selling = { value: String(plan.summary).slice(0, 40), from: '来自制作方案' }

  const out = {}
  for (const f of BRIEF_FIELDS) {
    const u = manual[f.key]
    if (u && (u.value || typeof u === 'string')) {
      out[f.key] = { value: typeof u === 'string' ? u : u.value, from: '你补充的', manual: true }
    } else if (auto[f.key]) {
      out[f.key] = { ...auto[f.key], manual: false }
    } else {
      out[f.key] = { value: '', from: '', manual: false }
    }
  }
  return out
}

// ── 增删改查 ────────────────────────────────────────────
/** 老对话没写 workspace 字段（保存时前端从不传），但写了 folder。
 *  用 folder 反推工作区名，让升级前的对话也归到正确的工作区下，而不是全挤在「影创」。 */
function workspaceFromFolder(folder) {
  if (!folder) return ''
  try {
    const C = require('./core')
    const hit = (C.workspaces() || []).find((w) => {
      const p = String(w.path || '').replace(/\/$/, '')
      return p && (folder === p || folder.indexOf(p + path.sep) === 0)
    })
    return hit ? hit.name : ''
  } catch (e) { return '' }
}

function list(opts = {}) {
  const all = read()
  let items = all
  if (opts.customer) items = items.filter((c) => (c.customer || '') === opts.customer)
  if (opts.status) items = items.filter((c) => (c.status || '') === opts.status)
  if (!opts.includeArchived) items = items.filter((c) => !c.archived)
  // 更新过的排前面
  items = items.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50))
  return items.slice(0, limit).map((c) => ({
    id: c.id,
    title: c.title || autoTitle(c),
    customer: c.customer || '',
    /* ★ 侧栏按 workspace 分组（shell.html 的 groupOf）：不返回这个字段，
       前端永远只能看到 customer，工作区选择就白选了。 */
    workspace: c.workspace || workspaceFromFolder(c.folder),
    model: c.model || '',
    status: c.status || '',
    archived: !!c.archived,
    pinned_at: c.pinned_at || '',
    created: c.created || '',
    updated: c.updated || '',
    msg_count: (c.messages || []).length,
    has_plan: !!c.plan,
  }))
}

function get(id) {
  const c = read().find((x) => x.id === id)
  if (!c) return { ok: false, error: '找不到这个对话：' + id }
  return { ok: true, ...c, brief: briefOf(c), briefFields: BRIEF_FIELDS }
}

function save(d = {}) {
  const all = read()
  let cid = String(d.id || '').trim()
  let conv = all.find((x) => x.id === cid)
  if (!conv) {
    cid = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    conv = { id: cid, created: now(), messages: [] }
    all.push(conv)
  }
  for (const k of ['customer', 'folder', 'model', 'status', 'plan', 'task', 'title',
    'requirement', 'tracks', 'title_by', 'title_model_done', 'workspace', 'archived', 'pinned_at']) {
    if (k in d && d[k] !== undefined) conv[k] = d[k]
  }
  // 用户亲手填的标题：标记为用户命名，自动总结以后不覆盖
  const ut = String(d.title || '').trim()
  if (ut && !DEFAULT_TITLES.has(ut) && !('title_by' in d)) conv.title_by = 'user'

  // 需求澄清补丁：只认六个 key
  if (d.brief_patch && typeof d.brief_patch === 'object') {
    const br = { ...(conv.brief || {}) }
    for (const [k, v] of Object.entries(d.brief_patch)) {
      if (!BRIEF_KEYS.includes(k)) continue
      const s = String(v == null ? '' : v).trim()
      if (s) br[k] = { value: s, at: now() }
      else delete br[k]
    }
    conv.brief = br
  }
  if (Array.isArray(d.messages)) conv.messages = d.messages
  for (const m of (d.append || [])) {
    if (!m || !String(m.text || '').trim()) continue
    const msg = { who: m.who || '我', text: String(m.text), time: m.time || now() }
    if (Array.isArray(m.steps) && m.steps.length) {
      msg.steps = m.steps.slice(0, 12).filter((x) => x && typeof x === 'object').map((x) => ({
        tool: String(x.tool || ''), ok: !!x.ok, args: x.args || {}, out: String(x.out || '').slice(0, 1200),
      }))
    }
    if (m.usage && typeof m.usage === 'object') {
      msg.usage = {}
      for (const k of ['in', 'out', 'cached', 'rounds', 'ms']) msg.usage[k] = Number(m.usage[k] || 0)
    }
    if (m.model) msg.model = String(m.model).slice(0, 80)
    conv.messages.push(msg)
  }
  if (conv.messages.length > MAX_MSG) conv.messages = conv.messages.slice(-MAX_MSG)
  conv.updated = now()
  conv.title = titleOf(conv)
  conv.msg_count = conv.messages.length
  conv.has_plan = !!conv.plan
  write(all)
  return { ok: true, ...conv }
}

function del(id) {
  const all = read()
  const i = all.findIndex((x) => x.id === id)
  if (i < 0) return { ok: false, error: '找不到这个对话：' + id }
  all.splice(i, 1)
  write(all)
  return { ok: true, id }
}

function archive(id, on = true) {
  const all = read()
  const c = all.find((x) => x.id === id)
  if (!c) return { ok: false, error: '找不到这个对话：' + id }
  c.archived = !!on
  c.updated = now()
  write(all)
  return { ok: true, id, archived: c.archived }
}

/** 收藏/置顶：pin=true 打时间戳置顶，pin=false 取消。
    不动 updated —— 收藏是「整理」，不该把这条顶到「最近更新」之外。 */
function pin(id, on = true) {
  const all = read()
  const c = all.find((x) => x.id === id)
  if (!c) return { ok: false, error: '找不到这个对话：' + id }
  c.pinned_at = on ? now() : ''
  write(all)
  return { ok: true, id, pinned_at: c.pinned_at }
}

/** 整条对话导出成 markdown，用户可以存档或发给客户 */
function exportText(id) {
  const r = get(id)
  if (!r.ok) return r
  const L = ['# ' + r.title, '', `${r.created} → ${r.updated}`, '']
  if (r.brief) {
    const filled = BRIEF_FIELDS.filter((f) => (r.brief[f.key] || {}).value)
    if (filled.length) {
      L.push('## 需求', '')
      for (const f of filled) L.push(`- **${f.label}**：${r.brief[f.key].value}（${r.brief[f.key].from}）`)
      L.push('')
    }
  }
  L.push('## 对话', '')
  for (const m of (r.messages || [])) {
    L.push(`**${m.who}**（${m.time || ''}）`, '', String(m.text || ''), '')
    if (m.steps && m.steps.length) {
      L.push('<details><summary>这一步动了 ' + m.steps.length + ' 次手</summary>', '')
      for (const s of m.steps) L.push(`- ${s.ok ? '✓' : '✗'} \`${s.tool}\``)
      L.push('', '</details>', '')
    }
  }
  return { ok: true, id, text: L.join('\n') }
}

module.exports = {
  FILE, BRIEF_FIELDS, BRIEF_KEYS, cleanPhrase, autoTitle, briefOf,
  list, get, save, del, archive, pin, exportText, read,
}
