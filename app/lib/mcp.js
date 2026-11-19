#!/usr/bin/env node
'use strict'
/**
 * MCP server —— 把 RiffCut 的全部能力挂给 DSH 内核。
 *
 * DSH 通过 stdio 起这个进程，然后看到 mcp__velora-video__<工具名>。
 * 协议是换行分隔的 JSON-RPC 2.0，不需要第三方 SDK。
 *
 * 为什么要这层而不是让内核直接调 HTTP：
 *   DSH 的 MCP 客户端只管 stdio，不会替我们做鉴权、客户隔离、路径校验。
 *   这些都在 lib/tools.js 里，走同一份工具表 = 界面和 AI 看到的是同一批能力，
 *   不会出现「界面上有、AI 看不到」或反过来。
 *
 * ★ 环境变量 RiffCut_CUSTOMER 决定这次会话在哪个客户下工作。
 */

const T = require('./tools')

const PROTOCOL = '2024-11-05'
const SERVER_NAME = 'velora-video'

/** 从中文参数说明猜 JSON 类型 —— 猜错的代价只是模型传字符串，工具层会兜底。 */
// 参数名 → 类型。这张表比「从中文说明里猜」可靠得多：
// 说明是给人看的，措辞随手写；参数名是契约，改名时一定会想到类型。
const NUMBER_KEYS = new Set(['at', 'dur', 'duration', 'seconds', 'sec', 'offset', 'limit',
  'since', 'width', 'height', 'fps', 'rate', 'volume', 'amount', 'size', 'port',
  'timeout', 'level_num', 'n', 'bpm', 'beats', 'pages', 'count', 'skip', 'top'])
const BOOL_KEYS = new Set(['exec', 'final', 'deep', 'hidden', 'force', 'dry', 'merge',
  'vertical', 'ideas', 'clear', 'noopen', 'silent', 'keep', 'overwrite'])

function typeOf(desc, key) {
  const k = String(key || '')
  const d = String(desc || '')
  const low = d.toLowerCase()
  if (NUMBER_KEYS.has(k)) return 'number'
  if (BOOL_KEYS.has(k)) return 'boolean'
  // 名字明确的字符串参数（动作枚举、路径、标识）
  if (['action', 'name', 'path', 'paths', 'id', 'project', 'platform', 'kind', 'q',
       'text', 'title', 'body', 'tags', 'url', 'model', 'key', 'voice', 'preset',
       'cat', 'ext', 'srt', 'video', 'music', 'mood', 'patch', 'level', 'scope',
       'template', 'which', 'fill', 'query', 'keywords', 'prompt', 'content'].includes(k)) return 'string'
  if (/true|false/.test(low) || d.includes('是否') || d.includes('开关')) return 'boolean'
  if (['数量', '个数', '第几', '帧数', '秒数', '层数', '宽度', '高度', '时长', '毫秒', '端口'].some(x => d.includes(x))) return 'number'
  // 只有明确写「列表/数组/list of」才算数组；单独出现 list 多为动作名
  if (/list of|array of/i.test(low) || d.includes('列表') || d.includes('数组')) return 'array'
  return 'string'
}

function schemaOf(t) {
  const props = {}
  const args = t.args || {}
  for (const [k, v] of Object.entries(args)) props[k] = { type: typeOf(v, k), description: String(v || '') }
  // 全部当可选：工具自己会校验必填项并给人话提示，
  // 在 schema 层硬要求反而会让模型因为「少一个参数」直接放弃。
  return { type: 'object', properties: props, additionalProperties: false }
}

function listTools(customer) {
  const out = []
  for (const t of Object.values(T.REGISTRY)) {
    if (!T.allowed(t, customer)) continue
    let desc = String(t.desc || '').trim() || t.name
    if (t.hints) desc += `（${t.hints}）`
    out.push({ name: t.name, description: desc, inputSchema: schemaOf(t) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function toText(r) {
  if (typeof r === 'string') return r
  if (r && typeof r === 'object') {
    for (const k of ['text', 'message', 'result']) {
      if (typeof r[k] === 'string' && r[k].trim()) return r[k]
    }
    if (r.error) return '出错了：' + r.error
    return JSON.stringify(r)
  }
  return String(r == null ? '' : r)
}

async function callTool(name, args, customer) {
  const r = await T.call(name, args || {}, customer)
  return { content: [{ type: 'text', text: r.ok ? toText(r.text) : String(r.error) }], isError: !r.ok }
}

// ── stdio 循环 ──
function send(o) {
  process.stdout.write(JSON.stringify(o) + '\n')
}

function err(id, code, msg) {
  send({ jsonrpc: '2.0', id: id == null ? null : id, error: { code, message: msg } })
}

async function main() {
  const customer = process.env.RiffCut_CUSTOMER || ''
  let buf = ''
  process.stdout.on('error', () => process.exit(0))   // 父进程关了就别报警

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', async chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { err(null, -32700, '不是合法 JSON'); continue }
      const { id, method, params } = msg
      try {
        if (method === 'initialize') {
          send({
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: PROTOCOL,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: '1.0.0' },
            },
          })
        } else if (method === 'notifications/initialized') {
          // 通知，不回
        } else if (method === 'tools/list') {
          const tools = listTools(customer)
          send({ jsonrpc: '2.0', id, result: { tools } })
        } else if (method === 'tools/call') {
          const name = params && params.name
          const args = (params && params.arguments) || {}
          const r = await callTool(name, args, customer)
          send({ jsonrpc: '2.0', id, result: r })
        } else if (method === 'ping') {
          send({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'shutdown') {
          send({ jsonrpc: '2.0', id, result: null })
          setTimeout(() => process.exit(0), 100)
        } else if (method === 'exit') {
          process.exit(0)
        } else if (id != null) {
          err(id, -32601, `没有这个方法：${method}`)
        }
      } catch (e) {
        if (id != null) err(id, -32603, String((e && e.message) || e))
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

if (require.main === module) main()

module.exports = { PROTOCOL, SERVER_NAME, listTools, callTool, schemaOf, typeOf, toText }
