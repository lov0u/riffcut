'use strict'
/* 界面自己的协议层：velora://app/... → 我们的 ui.html + /api/* 路由。
   为什么不用 http 起服务：多一个端口就多一处「被局域网访问」的面，
   而且端口每次变，localStorage / fetch 基准路径跟着漂。自定义协议是固定的。
   为什么用「标准协议」注册：standard:true 之后相对路径、fetch('/api/x')、
   origin、Cookie 这些才按正常网页规则工作；ordinary 的自定义协议会被
   Chromium 当成不透明源，相对路径根本解析不出来。 */
const fs = require('node:fs')
const path = require('node:path')

const SCHEME = 'velora'
const HOST = 'app'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

/** 路径路由表：界面里的 /api/xxx → api.js 里的函数 */
const API = {
  '/api/bootstrap': 'bootstrap',
  '/api/edit': 'edit',
  '/api/settings': 'settings',
  '/api/ui': 'ui',
  '/api/workspace': 'workspace',
  '/api/scan': 'scan',
  '/api/library': 'library',
  '/api/index': 'indexStatus',
  '/api/templates': 'templates',
  '/api/audio': 'audio',
  '/api/models': 'models',
  '/api/plugins': 'plugins',
  '/api/agent': 'agent',
  '/api/tasks': 'tasks',
  '/api/works': 'works',
  '/api/projects': 'projects',
  '/api/skills': 'skills',
  '/api/conversations': 'conversations',
  '/api/hotspot': 'hotspot',
  '/api/openapi': 'openapi',
  '/api/legal': 'legal',
  '/api/integrity': 'integrity',
  '/api/publish': 'publish',
  '/api/chat': 'chat',
  '/api/steps': 'stepsPoll',
  '/api/kernel': 'kernelState',
  '/api/abilities': 'kernelAbility',
  '/api/localmodels': 'localmodels',
  '/api/agents': 'agents',
  '/api/workers': 'workers',
  '/api/voicemodels': 'voicemodels',
  '/api/kb': 'kb',
  '/api/brand': 'brand',
  '/api/usage': 'usage',
  '/api/deps': 'depsApi',
  '/api/docs': 'docs',
  '/api/customers': 'customers',
  '/api/analytics': 'analytics',
  '/api/reveal': 'reveal',
  '/api/multiversion': 'multiVersionTask',
  '/api/vision/analyze': 'visionAnalyze',
  '/api/assets/organize': 'assetsOrganize',
  '/api/assets': 'assetsIngest',
  '/api/update': 'update',
  '/api/ffmpeg': 'ffmpegInfo',
  '/api/plan': 'planApi',
  '/api/render': 'renderApi',
  '/api/timeline': 'timeline',
  '/api/hyperframes': 'hyperframes',
  '/api/websearch': 'websearch',
  '/api/image/generate': 'imageGenerate',
  '/api/video/generate': 'videoGenerate',
  '/api/image/reveal': 'imageReveal',
  '/api/asr_audio': 'asrAudio',
  '/api/one-click': 'oneClick',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** 把磁盘文件变成 Response。找不到就 404，绝不返回空文件冒充成功。 */
function fileResponse(file, extraType) {
  try {
    const buf = fs.readFileSync(file)
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': extraType || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    })
  } catch {
    return new Response('not found: ' + path.basename(file), { status: 404 })
  }
}

/** 只允许访问 dir 里的文件，挡掉 ../ 和绝对路径。 */
function inside(dir, rel) {
  const clean = String(rel || '').replace(/\.\./g, '').replace(/^\/+/, '')
  const abs = path.resolve(path.join(dir, clean))
  const root = path.resolve(dir)
  return abs === root || abs.startsWith(root + path.sep) ? abs : ''
}

/** 剪辑工程里的素材：宿主页面是 velora://app/，file:// 会被跨源拦掉。 */
function projectAsset(project, name) {
  const TL = require('./timeline')
  return inside(path.join(TL.projDir(project), 'assets'), name)
}

/**
 * 模板预览页。模板写的是相对路径 lib/xxx、assets/xxx，
 * 而 URL 是 /edt/<工程>/<模板名>，浏览器会按 /edt/<工程>/ 解析，
 * 所以这里把 <模板名> 当文件、其余相对路径都映射到 compositions/ 下。
 */
function templatePage(project, rest, auto, clipId, edit) {
  const TL = require('./timeline')
  const comps = path.join(TL.projDir(project), 'compositions')
  let rel = String(rest || '').replace(/\.\./g, '').replace(/^\/+/, '')
  if (!rel) return new Response('missing template', { status: 404 })
  let full = inside(comps, rel)
  if (!full || !fs.existsSync(full)) {
    if (!path.extname(rel)) full = inside(comps, rel + '.html')
  }
  if (!full || !fs.existsSync(full)) return new Response('no template: ' + rel, { status: 404 })

  // ★ 模板的配套资源（assets/rmark.png、lib/gsap.min.js、字体等）走的是同一个
  //   /edt/<工程>/assets/xxx 路由。它们是二进制文件，绝不能当 HTML 用 utf8 读出来
  //   ——否则浏览器拿到一份乱码 text/html，图片 naturalWidth=0 全部裂成小图标。
  //   只有 .html 才做下面的 GSAP 替换 + 自动播放注入；其余按真实 MIME 直接回文件。
  //   这是所有带图片的模板在剪辑台预览都会裂的通用根因，不只影创 logo 这一例。
  if (path.extname(full).toLowerCase() !== '.html') return fileResponse(full)

  let html = ''
  try { html = fs.readFileSync(full, 'utf8') } catch (e) {
    return new Response('template unreadable: ' + e.message, { status: 500 })
  }
  /* ★ 把这个片段填过的模板变量注进预览页。
     模板源码读的是 Object.assign({}, defaults, window.__hfVariables, scoped)，
     不给它 __hfVariables 就永远只显示模板自带的默认字（CLARITY）。
     后果：右侧面板改了字、工程 JSON 也存了，但画面一动不动 ——
     用户会以为「改字功能没做」。clip_id 由剪辑台的 iframe URL 带上。 */
  let varScript = ''
  if (clipId) {
    try {
      const d = TL.load(project)
      let hit = null
      for (const tr of (d && d.tracks) || []) {
        for (const c of tr.clips || []) {
          if (String(c.id) === String(clipId)) { hit = c; break }
        }
        if (hit) break
      }
      const vv = (hit && hit.vars) || {}
      if (Object.keys(vv).length) {
        varScript = '<script>window.__hfVariables=' +
          JSON.stringify(vv).replace(/</g, '\\u003c') + ';</script>'
      }
    } catch (e) { /* 注入失败不该让预览白屏，模板自己有默认值兜底 */ }
  }
  if (varScript) html = html.replace(/<head([^>]*)>/i, '<head$1>' + varScript)
  // 模板里多半写的是公网 CDN。软件自称「断网也能用」，先把 GSAP 换成本地副本。
  html = html.replace(/<script[^>]+src=["'][^"']*gsap[^"']*["'][^>]*>\s*<\/script>/gi,
    '<script src="/tpllib/gsap.min.js"></script>')
  if (auto) {
    /* ★ 预览黑屏根因：几乎所有模板都用 gsap.timeline({paused:true})，
       所有元素初始 opacity:0，必须调 play() 才显现。原实现靠注入脚本去
       遍历 window.__timelines 再 play(0) —— 但这依赖两个脆弱前提：
       ①模板把 timeline 挂到 __timelines（部分模板没挂）②load 时序恰好对。
       只要有一条不满足，画面就停在初始帧（全黑），用户看到「先看看是黑屏」。

       根因级修法：直接把源码里的 {paused:true} 改成自动播放 + 循环。
       这样 timeline 一创建就开始跑，不依赖任何变量约定和注入时序。
       保留 __timelines 遍历作兜底（对没用 paused:true 却手动暂停的模板）。 */
    html = html.replace(/paused\s*:\s*true/gi, 'paused:false,repeat:-1')
    html = html.replace('</body>', `<script>
(function(){
  function play(){
    var t=window.__timelines||{};
    var keys=Object.keys(t);
    for (var i=0;i<keys.length;i++){
      var tl=t[keys[i]];
      if(!tl||!tl.paused)continue;   /* 已在自动播放的不重复触发 */
      try{ if(tl.play) tl.play(0); else if(tl.restart) tl.restart(); }catch(e){}
    }
  }
  /* 多级兜底：初始化后、load 后各查一次，覆盖同步/异步两种脚本写法。 */
  setTimeout(play,60);
  if(document.readyState==='complete') setTimeout(play,260);
  else window.addEventListener('load',function(){setTimeout(play,260)});
})();
</script></body>`)
  }
  /* ★ 点画面上的文字直接改（2026-11-21 用户要求）。
     以前改字只能在右侧面板的输入框里对着「原文 / 空白」改，用户的原话是
     「直接从视频上面点击就可以更改，不要从右侧面板改」。
     这里给模板预览页注入一段交互：鼠标移上去把可改的文字框出来，点一下就
     变成可编辑，改完把「原文 → 新文字」postMessage 给剪辑台，由剪辑台去写
     clip.edits。为什么不在 iframe 里直接改 DOM：模板会重新执行时间轴，
     直接改 DOM 下次 seek 就被覆盖；而写 clip.edits 是走「生成副本 + 重载预览」
     那条已经验证过的路，预览和成片吃同一份字节。
     匹配用「原文文字」而不是 t3 这种编号：编号是源文件扫描顺序，
     渲染后的 DOM 里顺序未必一致（条件渲染、伪元素、SVG），原文比对才稳。 */
  if (edit) {
    html = html.replace('</body>', `<style>
#rc-edit-hi{position:fixed;pointer-events:none;z-index:2147483647;border:1px solid #1B8B7E;
  background:rgba(27,139,126,.10);border-radius:3px;display:none;transition:none}
</style>
<script>
(function(){
  var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,TITLE:1,IFRAME:1,SVG:1,CANVAS:1,HEAD:1};
  var cid='';
  try{cid=new URLSearchParams(location.search).get('c')||''}catch(e){}
  var hi=document.createElement('div');hi.id='rc-edit-hi';document.documentElement.appendChild(hi);
  var editing=false, cur=null, orig='';

  /* 找一个元素「直接挂在它下面的第一段非空文字」——
     模板里的文字基本都是直接写在样式元素里（<div class="tagline">文字</div>），
     所以取直接子文字节点命中率最高，也不会误改到整块容器的拼接文本。 */
  function textNodeOf(el){
    if(!el||!el.childNodes)return null;
    var best=null,bestLen=0;
    for(var i=0;i<el.childNodes.length;i++){
      var n=el.childNodes[i];
      if(n.nodeType!==3)continue;
      var t=(n.nodeValue||'').replace(/\s+/g,' ').trim();
      if(t.length>bestLen){best=n;bestLen=t.length}
    }
    return best;
  }
  function usable(el){
    if(!el||!el.nodeName)return false;
    if(SKIP[el.nodeName])return false;
    if(el.closest&&el.closest('script,style,noscript,textarea,title,iframe,svg,canvas'))return false;
    var st=getComputedStyle(el);
    if(st.display==='none'||st.visibility==='hidden')return false;
    if(+st.opacity<0.06)return false;
    return true;
  }
  function targetOf(e){
    var el=e.target;
    for(var i=0;i<4&&el;i++){
      if(usable(el)&&textNodeOf(el))return el;
      el=el.parentElement;
    }
    return null;
  }
  document.addEventListener('mousemove',function(e){
    if(editing){hi.style.display='none';return}
    var el=targetOf(e);
    if(!el){hi.style.display='none';document.body.style.cursor='';return}
    var r=el.getBoundingClientRect();
    hi.style.display='block';
    hi.style.left=(r.left-2)+'px';hi.style.top=(r.top-2)+'px';
    hi.style.width=(r.width+4)+'px';hi.style.height=(r.height+4)+'px';
    document.body.style.cursor='text';
  },true);

  function finish(commit){
    if(!editing)return;
    editing=false;
    var el=cur; cur=null;
    if(!el)return;
    var now=(el.textContent||'').replace(/\s+/g,' ').trim();
    el.removeAttribute('contenteditable');
    el.style.outline='';el.style.cursor='';
    try{window.getSelection().removeAllRanges()}catch(e){}
    if(commit&&now&&now!==orig){
      try{window.parent.postMessage({__rc:1,kind:'text-edit',clip:cid,from:orig,to:now},'*')}catch(e){}
    }else if(!commit){
      el.textContent=orig;
    }
  }
  document.addEventListener('mousedown',function(e){
    if(editing){e.stopPropagation();e.preventDefault();return}
    var el=targetOf(e);
    if(!el)return;
    e.stopPropagation();e.preventDefault();
    editing=true;cur=el;
    orig=(el.textContent||'').replace(/\s+/g,' ').trim();
    el.setAttribute('contenteditable','plaintext-only');
    el.style.outline='1.5px solid #1B8B7E';
    el.style.outlineOffset='2px';
    el.focus();
    try{
      var r=document.createRange();r.selectNodeContents(el);
      var s=window.getSelection();s.removeAllRanges();s.addRange(r);
    }catch(e){}
    hi.style.display='none';
  },true);
  document.addEventListener('keydown',function(e){
    if(!editing)return;
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.stopPropagation();finish(true);}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(false);}
  },true);
  document.addEventListener('blur',function(){if(editing)finish(true)},true);
  /* 模板自己的点击/拖拽逻辑不要在这时候抢事件 */
  document.addEventListener('click',function(e){if(editing){e.stopPropagation();e.preventDefault()}},true);
})();
</script></body>`)
  }

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** 工程素材缩略图：第一次请求现抽一帧，之后直接复用。 */
async function projectThumb(project, name) {
  const TL = require('./timeline')
  const A = require('./assets')
  const P = require('./paths')
  const full = projectAsset(project, name)
  if (!full || !fs.existsSync(full)) return new Response('no asset', { status: 404 })
  const dir = path.join(TL.projDir(project), '缩略图')
  P.ensureDir(dir)
  const out = path.join(dir, String(name).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_') + '.jpg')
  if (!fs.existsSync(out)) {
    const ext = path.extname(full).toLowerCase()
    const kind = P.IMAGE_EXT.has(ext) ? '图片' : '视频'
    try { await A.thumb(full, kind, out) } catch (e) { /* 抽帧失败就走下面的 404 */ }
  }
  return fs.existsSync(out) ? fileResponse(out) : new Response('no thumb', { status: 404 })
}

/**
 * 造一个 protocol.handle 用的处理函数。
 * @param {object} opt {root: 静态文件根目录, homePage: 首页文件名}
 */
function handler(opt) {
  const root = opt.root
  const homePage = opt.homePage || 'ui.html'
  return async function handle(req) {
    let u
    try { u = new URL(req.url) } catch (e) { return new Response('bad url', { status: 400 }) }
    let p = decodeURIComponent(u.pathname || '/')

    // ── 客户产出 / 素材缩略图 / 模板缩略图 ──
    // 这些 URL 是相对 velora://app/ 解析出来的。旧版把这些目录开成了本机 HTTP 服务，
    // 这一版没有 HTTP，缺一条就整墙碎图（素材页 404 的根因）。
    if (p.startsWith('/缩略图/')) {
      const C = require('./core')
      const f = inside(C.custPaths().thumbs, p.slice('/缩略图/'.length))
      return f ? fileResponse(f) : new Response('forbidden', { status: 403 })
    }
    if (p.startsWith('/gen/')) {
      const C = require('./core')
      const f = inside(C.custPaths().images, p.slice('/gen/'.length))
      return f ? fileResponse(f) : new Response('forbidden', { status: 403 })
    }
    if (p.startsWith('/vid/')) {
      const C = require('./core')
      const f = inside(C.custPaths().videos, p.slice('/vid/'.length))
      return f ? fileResponse(f) : new Response('forbidden', { status: 403 })
    }
    if (p.startsWith('/tplthumb/')) {
      const T = require('./templates')
      const f = inside(T.thumbsRoot(), p.slice('/tplthumb/'.length))
      return f ? fileResponse(f) : new Response('forbidden', { status: 403 })
    }
    if (p === '/tpllib/gsap.min.js') {
      return fileResponse(path.join(__dirname, 'vendor', 'gsap.min.js'))
    }
    // 剪辑台 iframe：工程素材 / 模板页
    if (p.startsWith('/ed/')) {
      const parts = p.slice('/ed/'.length).split('/')
      const project = parts.shift() || ''
      const f = projectAsset(project, parts.join('/'))
      return f ? fileResponse(f) : new Response('no asset', { status: 404 })
    }
    if (p.startsWith('/edthumb/')) {
      const parts = p.slice('/edthumb/'.length).split('/')
      const project = parts.shift() || ''
      return projectThumb(project, parts.join('/'))
    }
    if (p.startsWith('/edt/')) {
      const parts = p.slice('/edt/'.length).split('/')
      const project = parts.shift() || ''
      return templatePage(project, parts.join('/'), u.searchParams.get('auto') === '1', u.searchParams.get('c') || '', u.searchParams.get('edit') === '1')
    }

    // ── 接口 ──
    if (p.startsWith('/api/')) {
      const fn = API[p]
      if (!fn) return json({ ok: false, error: '这个接口还没接：' + p }, 404)
      let body = {}
      if (req.method === 'POST') {
        try { body = await req.json() } catch (e) { body = {} }
      } else {
        body = Object.fromEntries(u.searchParams.entries())
      }
      try {
        const api = require('./api')
        const r = await api[fn](body || {})
        return json(r && typeof r === 'object' ? r : { ok: true, data: r })
      } catch (e) {
        // 后端炸了要如实说，不能伪装成「没有数据」——界面会把空当正常结果画出来，
        // 用户看到的是「什么都没变」，排查时完全没有线索。
        console.error('[ui] /api 出错', p, e)
        return json({ ok: false, error: '接口出错：' + String(e && e.message || e) })
      }
    }

    // ── 静态 ──
    if (p === '/' || p === '') p = '/' + homePage
    const rel = path.normalize(p).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '')
    const file = path.join(root, rel)
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 })
    try {
      const buf = fs.readFileSync(file)
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
      })
    } catch (e) {
      return new Response('not found: ' + rel, { status: 404 })
    }
  }
}

module.exports = { SCHEME, HOST, handler, API, MIME }
