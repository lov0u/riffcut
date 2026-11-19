// 技能：41 个导演技能 + 知识库条目。
// 关键：技能既是「给 AI 看的说明书」，也是 DSH 内核能直接吃的 SKILL.md。
// 两边格式统一，一份内容两处用，不再各维护一遍。
const { join, basename, dirname, resolve } = require('node:path')
const {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
  statSync, copyFileSync, cpSync, rmSync,
} = require('node:fs')
const { homedir } = require('node:os')
const P = require('./paths')
const C = require('./core')

/** 解析 YAML front matter（只处理单层 key: value，够用且不引 yaml 库）。 */
function parseSkill(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  const params = {}
  let body = String(text)
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i < 0) continue
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if (v === 'true') v = true
      else if (v === 'false') v = false
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = v.includes('.') ? parseFloat(v) : parseInt(v, 10)
      params[k] = v
    }
    body = m[2]
  }
  return { params, body: body.trim() }
}

function buildSkill(params, body) {
  const head = Object.entries(params)
    .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? v : v}`).join('\n')
  return `---\n${head}\n---\n\n${String(body).trim()}\n`
}

function skillsDir() { return P.BASE.skills }
function directorDir() { return P.BASE.director_skills }

/** 两个目录都算（资源/技能 是副本，配置/导演技能 是主）。按 id 去重。 */
function listSkills() {
  const seen = new Map()
  for (const dir of [directorDir(), skillsDir()]) {
    if (!existsSync(dir)) continue
    let files
    try { files = readdirSync(dir).filter(f => f.endsWith('.md')) } catch { continue }
    for (const f of files.sort()) {
      const id = basename(f, '.md')
      if (seen.has(id)) continue
      let text
      try { text = readFileSync(join(dir, f), 'utf8') } catch { continue }
      const { params, body } = parseSkill(text)
      seen.set(id, {
        id, title: params.title || id, tag: params.tag || '自定义',
        whenToUse: params.whenToUse || '', summary: params.summary || '',
        enabled: params.enabled !== false,
        order: Number(params.order ?? 99),
        params, body, path: join(dir, f),
      })
    }
  }
  return [...seen.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
}

/** 按用户说的话挑技能：命中 whenToUse 关键词的排前面。 */
function matchSkills(query, limit = 6) {
  const all = listSkills().filter(s => s.enabled)
  const q = String(query || '').trim()
  if (!q) return all.slice(0, limit)
  const scored = []
  for (const s of all) {
    let score = 0
    const words = String(s.whenToUse || '').split(/\s+/).filter(Boolean)
    for (const w of words) if (w && q.includes(w)) score += 3
    if (s.title && q.includes(s.title)) score += 5
    if (s.summary && q.includes(s.summary.slice(0, 6))) score += 1
    if (String(s.body).includes(q.slice(0, 4))) score += 1
    if (score > 0) scored.push({ s, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return (scored.length ? scored.map(x => x.s) : all).slice(0, limit)
}

function getSkill(id) {
  return listSkills().find(s => s.id === id) || null
}

/** 技能的完整正文（给 AI 读，也直接能当 DSH 的 SKILL.md）。 */
function skillContent(id) {
  const s = getSkill(id)
  if (!s) return null
  return {
    name: s.id, title: s.title, tag: s.tag,
    meta: s.params, content: s.body,
  }
}

function versionsDir() { return join(directorDir(), '.versions') }

/** 覆盖前先留一份。删掉这条技能时历史版本一起留着，后悔还能找回来。 */
function backupSkill(id) {
  const file = join(directorDir(), id + '.md')
  if (!existsSync(file)) return ''
  const d = join(versionsDir(), id)
  P.ensureDir(d)
  const out = join(d, P.stamp() + '.md')
  try { copyFileSync(file, out) } catch (e) { return '' }
  try {
    const all = readdirSync(d).filter((f) => f.endsWith('.md')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - 20))) {
      try { unlinkSync(join(d, old)) } catch (e) {}
    }
  } catch (e) {}
  return out
}

function writeSkill(id, { title, tag, params, body }) {
  const dir = directorDir()
  P.ensureDir(dir)
  const slug = id || P.slug(title) || 'skill-' + P.stamp()
  const p = { ...(params || {}) }
  p.title = title || p.title || slug
  p.tag = tag || p.tag || '自定义'
  const file = join(dir, slug + '.md')
  if (existsSync(file)) backupSkill(slug)
  writeFileSync(file, buildSkill(p, body || ''), 'utf8')
  C.history('写技能', slug)
  return { id: slug, path: file }
}

/** 启用 / 停用：只改 front matter 的 enabled，正文一个字都不动。 */
function toggleSkill(id) {
  const s = getSkill(id)
  if (!s) throw new Error('找不到这个技能：' + id)
  const params = { ...(s.params || {}) }
  params.enabled = params.enabled === false
  writeSkill(id, { title: s.title, tag: s.tag, params, body: s.body })
  return { id, enabled: params.enabled }
}

function listVersions(id) {
  const d = join(versionsDir(), id)
  if (!existsSync(d)) return []
  try {
    return readdirSync(d).filter((f) => f.endsWith('.md'))
      .sort().reverse().map((f) => basename(f, '.md'))
  } catch (e) { return [] }
}

function restoreVersion(id, version) {
  const src = join(versionsDir(), id, String(version).replace(/[^\w.-]/g, '') + '.md')
  if (!existsSync(src)) throw new Error('没有这个历史版本：' + version)
  const cur = join(directorDir(), id + '.md')
  if (existsSync(cur)) backupSkill(id)
  const text = readFileSync(src, 'utf8')
  writeFileSync(cur, text, 'utf8')
  C.history('恢复技能版本', id + ' · ' + version)
  return { id, version }
}

/** 扫描来源：用户加的 + 几个常见技能目录。只回真正存在的。 */
function sources() {
  const cfg = P.load('skill_sources', {}) || {}
  const extra = Array.isArray(cfg.sources) ? cfg.sources : []
  const base = [
    join(P.HOME, '资源', '技能'),
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.codex', 'skills'),
  ]
  const out = []
  for (const x of base.concat(extra)) {
    const p = resolve(String(x || '').replace(/^~/, homedir()))
    if (!p || out.includes(p)) continue
    try { if (statSync(p).isDirectory()) out.push(p) } catch (e) {}
  }
  return out
}

function saveSources(list) {
  P.save('skill_sources', { sources: (list || []).slice(0, 40) })
  return sources()
}

function addSource(path) {
  const p = resolve(String(path || '').replace(/^~/, homedir()))
  let st
  try { st = statSync(p) } catch (e) { throw new Error('这个路径不存在：' + path) }
  if (!st.isDirectory()) throw new Error('要填一个文件夹路径：' + path)
  const cfg = P.load('skill_sources', {}) || {}
  const extra = Array.isArray(cfg.sources) ? cfg.sources : []
  if (!extra.includes(p)) extra.push(p)
  return saveSources(extra)
}

function delSource(path) {
  const p = resolve(String(path || '').replace(/^~/, homedir()))
  const cfg = P.load('skill_sources', {}) || {}
  const extra = (Array.isArray(cfg.sources) ? cfg.sources : []).filter((x) => resolve(String(x)) !== p)
  return saveSources(extra)
}

function walkMd(root, out, depth = 0) {
  if (depth > 5) return out
  let es = []
  try { es = readdirSync(root, { withFileTypes: true }) } catch (e) { return out }
  for (const e of es) {
    if (e.name.startsWith('.')) continue
    const full = join(root, e.name)
    if (e.isDirectory()) walkMd(full, out, depth + 1)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

function scan() {
  const srcs = sources()
  const have = new Set(listSkills().map((x) => x.id))
  const titles = new Set(listSkills().map((x) => x.title))
  const items = []
  for (const src of srcs) {
    for (const f of walkMd(src, [])) {
      if (items.length >= 500) break
      let text = ''
      try { text = readFileSync(f, 'utf8') } catch (e) { continue }
      const { params } = parseSkill(text)
      const title = params.title || params.name || basename(dirname(f)) || basename(f, '.md')
      const id = basename(f) === 'SKILL.md' ? basename(dirname(f)) : basename(f, '.md')
      items.push({
        key: f, skill_path: f, source_label: basename(src),
        title, id,
        imported: have.has(id) || titles.has(title),
      })
    }
  }
  return { sources: srcs, items }
}

/** 把一个外部 SKILL.md 收进软件自己的技能库（原文件不动）。 */
function importFile(file) {
  const text = readFileSync(file, 'utf8')
  const { params, body } = parseSkill(text)
  const title = params.title || params.name || basename(dirname(file)) || basename(file, '.md')
  let id = P.slug(title)
  const exists = (x) => existsSync(join(directorDir(), x + '.md')) || existsSync(join(skillsDir(), x + '.md'))
  let uniq = id, i = 2
  while (exists(uniq)) uniq = id + '-' + i++
  writeFileSync(join(directorDir(), uniq + '.md'), buildSkill({
    title, tag: params.tag || '导入',
    whenToUse: params.whenToUse || params.description || '',
    summary: params.summary || '',
    enabled: true,
    order: params.order || 99,
    source: file,
  }, body || text), 'utf8')
  return uniq
}

function importPath(path) {
  const p = resolve(String(path || '').replace(/^~/, homedir()))
  let st
  try { st = statSync(p) } catch (e) { throw new Error('找不到这个路径：' + path) }
  const files = st.isDirectory() ? walkMd(p, []) : [p]
  if (!files.length) throw new Error('这里没有 .md 技能文件')
  let n = 0
  const failed = []
  for (const f of files.slice(0, 200)) {
    try { importFile(f); n++ } catch (e) { failed.push(basename(f) + '：' + e.message) }
  }
  if (!n) throw new Error('一个都没导进来：' + (failed[0] || '格式不对'))
  C.history('导入技能', n + ' 个 · ' + p)
  return n
}

function importScanned(items) {
  let added = 0, skipped = 0
  for (const it of (items || []).slice(0, 200)) {
    const f = String(it && (it.skill_path || it.path) || '').trim()
    if (!f || !existsSync(f)) { skipped++; continue }
    try { importFile(f); added++ } catch (e) { skipped++ }
  }
  C.history('导入扫描技能', added + ' 个')
  return { added, skipped }
}

function exportBackup() {
  const out = join(P.SYS_BACKUPS, '技能备份-' + P.stamp())
  P.ensureDir(out)
  let n = 0
  for (const dir of [directorDir(), skillsDir()]) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const to = join(out, n + '-' + f)
      try { copyFileSync(join(dir, f), to); n++ } catch (e) {}
    }
  }
  if (existsSync(versionsDir())) {
    try { cpSync(versionsDir(), join(out, '.versions'), { recursive: true }) } catch (e) {}
  }
  return out
}

function deleteSkill(id) {
  for (const dir of [directorDir(), skillsDir()]) {
    const f = join(dir, id + '.md')
    if (existsSync(f)) { unlinkSync(f); C.history('删技能', id); return true }
  }
  return false
}

/**
 * 把技能同步给 DSH 内核：内核扫 <DSH_HOME>/skills/ 下的 SKILL.md。
 * 这是「自我进化」能留下的根本 —— 内核自动加载，不需要额外代码。
 */
function syncToKernel(dshHome) {
  const home = dshHome || join(P.SYS, 'dsh')
  const target = join(home, 'skills')
  P.ensureDir(target)
  let n = 0
  for (const s of listSkills()) {
    if (!s.enabled) continue
    const dir = join(target, s.id)
    P.ensureDir(dir)
    // DSH 要求 front matter 有 name（kebab-case）+ description
    const dshName = s.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'skill'
    const desc = (s.summary || s.whenToUse || s.title || s.id).slice(0, 400)
    const head = [
      '---',
      `name: ${dshName}`,
      `description: ${JSON.stringify(desc)}`,
      '---',
      '',
      s.body,
    ].join('\n')
    writeFileSync(join(dir, 'SKILL.md'), head, 'utf8')
    n++
  }
  return { target, count: n }
}

module.exports = {
  parseSkill, buildSkill, skillsDir, directorDir,
  listSkills, matchSkills, getSkill, skillContent,
  writeSkill, deleteSkill, syncToKernel,
  toggleSkill, backupSkill, versionsDir, listVersions, restoreVersion,
  sources, saveSources, addSource, delSource, scan, importPath, importScanned, exportBackup,
}
