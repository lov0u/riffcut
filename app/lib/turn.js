'use strict'
/**
 * 内核消息 → 界面能用的东西。
 *
 * 为什么要单独一层：内核的 assistant/message 里 content 是「块数组」，
 * 同一个 message 里混着三种块：
 *   { type:'reasoning', text }  ← 模型的思考过程（英文，给用户看是噪音）
 *   { type:'tool-call', id, name, arguments }
 *   { type:'text', text }       ← 真正要说给用户听的话
 * 第一版直接把整个 message 拼成字符串，结果界面上出现一大段英文 thinking，
 * 用户以为软件在说胡话。所以这里必须按 type 分开取，不能笼统拼。
 */

/** 取「给用户看的」文本。reasoning 一律不要。 */
function textOf(message) {
  if (!message) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return String(message.text || '')
  return c.filter((x) => x && x.type === 'text').map((x) => String(x.text || '')).join('')
}

/** 取思考过程（只在调试面板里显示，不混进回答）。 */
function reasoningOf(message) {
  const c = message && message.content
  if (!Array.isArray(c)) return ''
  return c.filter((x) => x && x.type === 'reasoning').map((x) => String(x.text || '')).join('')
}

/** 取工具调用：[{ id, name, args }]。 */
function toolCallsOf(message) {
  const c = message && message.content
  if (!Array.isArray(c)) return []
  return c
    .filter((x) => x && (x.type === 'tool-call' || x.type === 'tool_use'))
    .map((x) => ({
      id: x.id || '',
      // ★ 工具名带 mcp__velora-video__ 前缀，界面上要短名字
      name: String(x.name || (x.tool && x.tool.name) || '').replace(/^mcp__velora-video__/, ''),
      args: x.arguments || x.input || {},
    }))
}

/** 一次 turn 的完整记录，给界面渲染用。 */
function makeTurn(message) {
  return {
    text: textOf(message),
    reasoning: reasoningOf(message),
    tools: toolCallsOf(message),
  }
}

module.exports = { textOf, reasoningOf, toolCallsOf, makeTurn }
