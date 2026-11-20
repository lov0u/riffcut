/**
 * 流式下载器（给本地模型用）。
 *
 * 为什么自己写而不用现成库：
 *   - 不能引第三方依赖（Electron 主进程跑的是裸 node，多一个包就多一份审计）
 *   - 必须支持断点续传（1.6GB 的权重，断一次从头来用户会骂人）
 *   - 必须能报进度（界面上要有条真进度条，不是转圈）
 *
 * 三个约定：
 *   1. 先下到 `<目标>.part`，下完校验大小再 rename 成目标名 —— 中途失败不会留下半截文件冒充成品
 *   2. 有 `.part` 就带 Range 续传；服务器不认 Range（返回 200 而不是 206）就删了重下
 *   3. 支持 AbortSignal，取消时保留 .part，下次接着下
 */
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')

/** 下载源：按顺序试，前一个失败自动换下一个。国内优先。 */
const MIRRORS = {
  hf: [
    'https://hf-mirror.com',
    'https://huggingface.co',
  ],
  modelscope: [
    'https://modelscope.cn/api/v1/models',
  ],
  github: [
    'https://github.com',
  ],
}

const UA = 'RiffCut/0.1.0 (+https://github.com/lov0u/riffcut)'

/** 跟随跳转拿最终 URL。魔搭和 HF 都会 302 到 CDN，Node 的 https 不自动跟。 */
function follow(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('跳转太多次，放弃'))
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'HEAD',
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve(follow(next, redirects + 1))
      }
      res.resume()
      resolve({
        url,
        status: res.statusCode,
        size: parseInt(res.headers['content-length'] || '0', 10),
        ranges: String(res.headers['accept-ranges'] || '').includes('bytes'),
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('HEAD 超时')) })
    req.end()
  })
}

/** 下载一个文件到 dest。opts: {onProgress(done,total), signal, retries} */
async function fetchFile(url, dest, opts = {}) {
  const onProgress = opts.onProgress || (() => {})
  const signal = opts.signal
  const retries = opts.retries == null ? 3 : opts.retries
  const part = dest + '.part'

  fs.mkdirSync(path.dirname(dest), { recursive: true })

  let total = 0
  let attempt = 0
  let lastErr = null

  while (attempt <= retries) {
    attempt++
    try {
      // 有半截文件就续传
      let have = 0
      try { have = fs.statSync(part).size } catch (_) { have = 0 }

      const info = await follow(url)
      if (info.status !== 200 && info.status !== 206) {
        throw new Error('HTTP ' + info.status + '：' + url)
      }
      total = info.size || 0

      // 已经下完了（上次 rename 前崩的）
      if (total > 0 && have === total) {
        fs.renameSync(part, dest)
        onProgress(total, total)
        return { ok: true, path: dest, size: total, resumed: true }
      }
      // 服务器不支持续传但本地有半截 → 重下
      if (have > 0 && !info.ranges) {
        try { fs.unlinkSync(part) } catch (_) {}
        have = 0
      }

      await new Promise((resolve, reject) => {
        const u = new URL(url)
        const mod = u.protocol === 'https:' ? https : http
        const headers = { 'User-Agent': UA, 'Accept': '*/*' }
        if (have > 0) headers['Range'] = 'bytes=' + have + '-'

        const req = mod.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers,
          timeout: 60000,
        }, (res) => {
          // 又要跳转（HEAD 能跟但 GET 也可能跳，魔搭就是）
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            return reject(new Error('REDIRECT:' + new URL(res.headers.location, url).toString()))
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume()
            return reject(new Error('HTTP ' + res.statusCode))
          }
          // 服务器忽略了 Range，从头给 —— 那就从头写
          const append = have > 0 && res.statusCode === 206
          if (have > 0 && res.statusCode === 200) have = 0

          const out = fs.createWriteStream(part, append ? { flags: 'a' } : { flags: 'w' })
          let done = have
          let lastTick = 0

          res.on('data', (chunk) => {
            done += chunk.length
            const now = Date.now()
            if (now - lastTick > 200) { lastTick = now; onProgress(done, total) }
          })
          res.pipe(out)
          out.on('finish', () => {
            onProgress(done, total || done)
            out.close(() => resolve())
          })
          out.on('error', reject)
          res.on('error', reject)
          if (signal) signal.addEventListener('abort', () => {
            req.destroy(new Error('已取消'))
            out.destroy()
          }, { once: true })
        })
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('下载超时')))
        req.end()
      })

      // 校验大小（有 content-length 才校验）
      const got = fs.statSync(part).size
      if (total > 0 && got !== total) throw new Error('大小不符：期望 ' + total + ' 实得 ' + got)
      fs.renameSync(part, dest)
      return { ok: true, path: dest, size: got, attempts: attempt }
    } catch (e) {
      lastErr = e
      // GET 又跳转：换最终地址再来一次
      if (String(e.message).startsWith('REDIRECT:')) {
        url = String(e.message).slice(9)
        attempt--   // 跳转不算一次重试
        continue
      }
      if (signal && signal.aborted) throw new Error('已取消下载')
      if (attempt > retries) break
      // 退避：1s, 3s, 7s
      await new Promise(r => setTimeout(r, 1000 * (2 ** attempt - 1)))
    }
  }
  throw lastErr || new Error('下载失败')
}

/** 试多个镜像，第一个能用的就下 */
async function fetchFromMirrors(urls, dest, opts = {}) {
  let lastErr = null
  for (const u of urls) {
    try {
      return await fetchFile(u, dest, opts)
    } catch (e) {
      lastErr = e
      if (opts.signal && opts.signal.aborted) throw e
    }
  }
  throw lastErr || new Error('所有镜像都失败了')
}

module.exports = { fetchFile, fetchFromMirrors, follow, MIRRORS }
