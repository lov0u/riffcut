/**
 * 品牌套件（对应 /api/brand）。
 *
 * 目录约定照旧版：<客户目录>/品牌套件/<套件名>/{品牌.json, 资产/}
 * 资产槽位固定六个（logo 主体 / 完整字标 / 图标 / 中文字标 / 吉祥物 / 底纹），
 * 槽位名不能改 —— 模板里按槽位名引用，改了 448 个模板全找不到图。
 */
const fs = require('node:fs')
const path = require('node:path')
const C = require('./core')

const SLOTS = [
  { key: 'logo_main', label: '主标志', hint: '方形或接近方形，单色最稳' },
  { key: 'logo_full', label: '完整字标', hint: '标志 + 文字横向排列' },
  { key: 'icon', label: '图标', hint: '只有图形，用于头像与角标' },
  { key: 'wordmark', label: '中文名', hint: '只有文字，用于片尾落版' },
  { key: 'mascot', label: '吉祥物', hint: '可选，透明底 PNG' },
  { key: 'texture', label: '底纹', hint: '可选，平铺纹理' },
]
const SLOT_KEYS = SLOTS.map((s) => s.key)

/** 套件根目录：<客户目录>/品牌套件 */
function kitsDir(customer) {
  return path.join(C.custPaths(customer).root, '品牌套件')
}

function listKits(customer) {
  const dir = kitsDir(customer)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const d = path.join(dir, name)
    if (!fs.statSync(d).isDirectory()) continue
    const meta = readMeta(d)
    const assets = {}
    const ad = path.join(d, '资产')
    if (fs.existsSync(ad)) {
      for (const f of fs.readdirSync(ad)) {
        const slot = SLOT_KEYS.find((k) => f.startsWith(k))
        if (slot && !assets[slot]) assets[slot] = path.join(ad, f)
      }
    }
    out.push({
      name, customer,
      dir: d,
      colors: meta.colors || {},
      fonts: meta.fonts || {},
      note: meta.note || '',
      default: !!meta.default,
      slots: SLOTS.map((s) => ({ ...s, file: assets[s.key] || '', ok: !!assets[s.key] })),
      filled: SLOT_KEYS.filter((k) => assets[k]).length,
      total: SLOT_KEYS.length,
    })
  }
  return out.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.name.localeCompare(b.name))
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '品牌.json'), 'utf8')) || {} } catch (e) { return {} }
}

/** 出片预设：模板库里带 ratio 与 duration 的那批，给首页「套用模板」下拉用 */
function presets(customer) {
  try {
    const T = require('./templates')
    const all = T.catalog ? T.catalog(customer) : (T.list ? T.list(customer) : [])
    return (all || []).filter((t) => t && t.name).slice(0, 40).map((t) => ({
      id: t.name, name: t.title || t.name, ratio: t.aspect || '16:9',
      duration: t.duration || 0, cat: t.cat || '',
    }))
  } catch (e) { return [] }
}

function bootstrap(customer) {
  const kits = listKits(customer)
  const cur = kits.find((k) => k.default) || kits[0] || null
  return {
    customer,
    kits,
    current: cur ? cur.name : '',
    slots: SLOTS,
    colors: (cur && cur.colors) || {},
    fonts: (cur && cur.fonts) || {},
    presets: presets(customer),
    note: kits.length ? '' : '这个客户还没有品牌套件。建一套，模板和字幕会自动用上你的色与字。',
  }
}

/** 保存一套（只写 品牌.json；资产是用户自己拷进 资产/ 目录的，这里不搬文件） */
function saveKit(d = {}) {
  const customer = d.customer || C.currentCustomer()
  const name = String(d.kit || d.name || '').trim()
  if (!name) throw new Error('套件要有名字')
  const dir = path.join(kitsDir(customer), name)
  fs.mkdirSync(path.join(dir, '资产'), { recursive: true })
  const meta = readMeta(dir)
  if (d.colors && typeof d.colors === 'object') meta.colors = d.colors
  if (d.fonts && typeof d.fonts === 'object') meta.fonts = d.fonts
  if (d.note !== undefined) meta.note = String(d.note || '')
  if (d.default !== undefined) meta.default = !!d.default
  meta.updated = new Date().toISOString()
  fs.writeFileSync(path.join(dir, '品牌.json'), JSON.stringify(meta, null, 1))
  // 一个客户只留一个默认套件，否则模板不知道听谁的
  if (meta.default) {
    for (const other of listKits(customer)) {
      if (other.name === name) continue
      const p = path.join(other.dir, '品牌.json')
      const m = readMeta(other.dir)
      if (m.default) { m.default = false; fs.writeFileSync(p, JSON.stringify(m, null, 1)) }
    }
  }
  return bootstrap(customer)
}

function deleteKit(d = {}) {
  const customer = d.customer || C.currentCustomer()
  const name = String(d.kit || d.name || '').trim()
  const dir = path.join(kitsDir(customer), name)
  if (!fs.existsSync(dir)) throw new Error('没有这套：' + name)
  /* 不直接 rm：先改名成 .废-时间戳，用户后悔了还能从 Finder 捞回来 */
  const bak = dir + '.废-' + Date.now().toString(36)
  fs.renameSync(dir, bak)
  return { ...bootstrap(customer), backup: bak }
}

module.exports = { SLOTS, SLOT_KEYS, kitsDir, listKits, bootstrap, saveKit, deleteKit, presets }
