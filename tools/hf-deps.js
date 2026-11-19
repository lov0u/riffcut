#!/usr/bin/env node
/* 算出 hyperframes 的完整依赖闭包并复制到目标 node_modules。
   ★ 为什么不能只 cp node_modules/hyperframes：
     它是 pnpm/npm 展平安装，自己的 dependencies 都在上层 node_modules 里。
     只拷它自己的目录，包内跑 hyperframes --version 会报
     "Cannot find package 'acorn'" —— 界面上表现为「FFmpeg 一直读取中」，
     因为 ready() 靠 hf --version 判断环境就绪。
   用法：node tools/hf-deps.js <源 node_modules> <目标 node_modules> */
const fs = require('node:fs')
const path = require('node:path')

const [src, dst] = process.argv.slice(2)
if (!src || !dst) {
  console.error('用法：node hf-deps.js <源 node_modules> <目标 node_modules>')
  process.exit(2)
}
const seen = new Set()
const missing = []

function walk(name) {
  if (seen.has(name)) return
  seen.add(name)
  const from = path.join(src, name)
  let pj
  try { pj = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')) } catch (e) { missing.push(name); return }
  const to = path.join(dst, name)
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: false })
  } catch (e) { console.error('复制失败 ' + name + ': ' + e.message) }
  for (const d of Object.keys(pj.dependencies || {})) walk(d)
  // optionalDependencies 里有平台二进制（如 esbuild），缺了跑不起来
  for (const d of Object.keys(pj.optionalDependencies || {})) {
    if (fs.existsSync(path.join(src, d))) walk(d)
  }
}

walk('hyperframes')
console.log('复制依赖 ' + seen.size + ' 个' + (missing.length ? '，缺 ' + missing.join(', ') : ''))
