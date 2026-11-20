// 内核 profile 生成器。
//
// 三件事：
//   1. bundles 选 dsh-base + dsh-web-app —— web-app 才带插件市场/自动化任务/设置面板，
//      这是用户明确要保留的原生能力，不能用 sdk-app（那只有 stdio 没界面）。
//   2. 模型路由从旧软件的模型配置翻译过来（v0 先用 agnes，v1 接 models.json）。
//   3. patch 里插我们的剪辑预设 + MCP 视频工具 + 技能目录。
const { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync } = require('node:fs')
const { join } = require('node:path')

// 三个 bundle 缺一不可：
//   dsh-base     —— 内核本体（agent 循环、工具、会话、沙箱）
//   dsh-sdk-app  —— stdio JSON-RPC 通道。没有它，我们起子进程后
//                   `initialize` 永远等不到响应（界面壳靠这条通道说话）
//   dsh-web-app  —— 原生 Web 界面（插件市场、自动化任务、设置面板）。
//                   用户明确要保留的 DSH 原生能力都在这里；
//                   它和 sdk-app 各起各的服务，互不冲突（实测同时装能起来）。
const BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-web-app',
]

function q(s) { return JSON.stringify(String(s)) }

/* 内核 persona 前缀。原来 DSH 默认是
     "You are a coding agent powered by the {{model}} model."
   那句让 AI 一直以为自己在写代码，于是打招呼也去 ls 目录、列工具清单。

   ★ 2026-11-20 第三次修改（用户 m06193）：
     前两版都犯了同一个错 —— 想把「怎么答」直接写死。
     第一版写 "Be brief"、"at most 50 Chinese characters"，
     第二版改成「如果问你是谁，你就答『我是影创的 AI 导演，你把想做的片子说一句……』」，
     结果它每句话都带上「我是影创的 AI 导演」这个头衔，答什么都先自报家门。
     用户原话：「他的回答里边怎么总是掺着我是影创的 AI 导演这一句？这个你是不是
     也是给他强烈的限制了？」—— 对，就是。

     现在的写法只在「被问到时」给一个名字，不复述整句话，也不要求每轮自报：
       · 名字就叫 RiffCut，不是「AI 导演」，不是 Harness，不是任何模型名
       · 只在被问到时说，不主动提
       · 不提就不提，没有「每次回答要先介绍自己」这种事

     这就是这类问题的通用教训：**提示词里每写一句「你要说 X」，它就会到处说 X。**
     想让它自然，就把事实放在那儿（你叫什么），把什么时候用交给它判断。 */
const PERSONA_PREFIX = [
  'You are the assistant inside RiffCut (影创), a Chinese short-video production app.',
  'You are not a coding agent and not a general assistant; you help people make short videos.',
  'Your name is RiffCut. If someone asks who you are, that is the answer — a name, not a title.',
  'Only say it when asked. Do not open replies with it, and do not introduce yourself unprompted.',
  'You are not a Harness, a kernel, an MCP client, or a model name; people here do not know those',
  'words and hearing them makes them think the wrong app opened.',
  'Answer in Chinese.',
  'Match the length to what was actually asked: a greeting gets a greeting, a real brief gets a plan.',
  'Judge for yourself whether a message is conversation or a work order; nobody hands you a script.',
  'Mistaking one for the other is not symmetrical: treating talk as work makes people wait half a minute',
  'for a reply to "hi", while treating work as talk only costs one extra question — so when unsure,',
  'reply as conversation and let them say more.',
  'Conversation gets words. A work order gets tools, and then a finished cut.',
  'A cut worth watching is planned before it is assembled: for anything beyond a trivial',
  'rearrange, write the shot list first and let the person see it before building. Piling',
  'templates onto a timeline with no plan gives them black frames, cropped letters, and a',
  'film they never approved — then they ask if this is really a video. Match the template',
  'aspect ratio to the project: a 1920x1080 title dropped into a 1080x1920 project loses',
  'its sides ("Cyanweb" becomes "yanwe"). Build the project in the template\'s aspect ratio,',
  'not the other way round. For end cards use an animated 片头片尾 block (logo-outro,',
  'extruded-logo, glass-hero) — a static CTA component is a card, not a film ending, and the',
  'delivery gate will reject it as a still image. Edit a template\'s own variables via',
  'template_vars + addtemplate vars; stacking addtext over English defaults gives two layers of words.',
  'Describing a tool call in your message is not making one. Writing "→ run edit_timeline",',
  'pasting a JSON parameter block, or saying "I have created the project" / "now doing step 1"',
  'produces no project and no workflow step — the editor will be empty and the user stops',
  'believing you. A real tool call shows up on its own in the interface; you do not narrate it.',
  'When someone says "do not make it yet, just explain the design", that is conversation:',
  'give the thinking and the options, then wait for the word to actually start.',
  'Your working directory is already clean and its layout is described in the workspace instructions,',
  'so there is nothing to discover by listing directories first.',
].join(' ')

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); return p }

/**
 * 从我们自己的模型表读（lib/models.js），只取能对话的。
 * 以前读的是旧软件那份 json —— 那个路径在新版里根本不存在，
 * 结果永远是空、永远回落内置 agnes，用户在界面上配的模型一点用不上。
 */
function readModels() {
  try {
    const M = require('./models')
    const ms = M.models()
    const out = []
    for (const [mid, m] of Object.entries(ms)) {
      if (!m || !m.chat) continue
      if (!M.usable(m)) continue
      // 本机 tts/asr 不走 llm 路由
      if (m.kind === 'tts' || m.kind === 'asr') continue
      if (!m.url) continue
      const key = String(m.key || '').trim()
      if (!key) continue
      out.push({ id: mid, name: m.name || m.model, model: m.model, url: m.url, key, kind: m.kind })
    }
    /* ★ 顺序决定内核默认走哪个 provider（patchYaml 里 provs[0] 就是 agent-default-model）。
       以前完全跟着 json 的键顺序走，用户在界面上换了默认模型也不生效 —— 他改的是
       设置里的 chat_model_id，而这里根本没看那个字段。现在把用户选中的提到第一位。 */
    const cur = M.chatModelId(ms)
    if (cur) {
      const i = out.findIndex((x) => x.id === cur)
      if (i > 0) out.unshift(out.splice(i, 1)[0])
    }
    return out
  } catch { return [] }
}

/** 生成 cordis.patch.yml 的正文。 */
function patchYaml({ models, env, homeDir, workDir }) {
  const lines = []
  // ── 模型路由：一个 llm-pi-ai 装全部 provider（多个同名条目会互相顶掉）
  lines.push('- id: llm-pi-ai')
  lines.push('  name: "@deepseek-ai/dsh-llm-pi-ai"')
  lines.push('  config:')
  lines.push('    providers:')

  const provs = []
  if (models.length) {
    models.forEach((m, i) => {
      const pid = 'velora-m' + i
      const envName = 'RiffCut_KEY_' + i
      env[envName] = m.key
      provs.push({ pid, envName, m })
      lines.push(`      ${pid}:`)
      lines.push(`        displayName: ${q(m.name || m.model)}`)
      lines.push(`        apiKeyEnv: ${envName}`)
      lines.push(`        api: openai-completions`)
      lines.push(`        baseURL: ${q(String(m.url).replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, ''))}`)
      lines.push('        models:')
      lines.push(`          - id: ${q(m.model)}`)
      lines.push(`            name: ${q(m.name || m.model)}`)
      lines.push('            input: [text, image]')
    })
  } else {
    /* ★ 2026-11-20 改：这里以前会偷偷读 ~/.dsh/.credentials.yaml 里的 AGNES_API_KEY 顶上，
       于是出现最难受的一种状态 —— 模型管理里三个模型全显示「待配置」，对话却照样能通，
       而且用的是用户在界面上根本看不见的一把 key。两条配置源各说各话，用户永远搞不清
       自己到底在花谁的钱。现在只有一个事实源：模型表（lib/models.js）。
       模型表里没有可用模型，就老实报错，让用户去模型管理配。 */
    const M = require('./models')
    const cur = M.chatModelId() || M.PRESET_ID
    const mm = M.models()[cur]
    throw new Error(
      '模型表里没有可用的对话模型（' + (mm ? mm.name || cur : cur) + ' 缺接口地址或密钥）。' +
      '到「模型管理」里填一个能对话的模型再启动。'
    )
  }

  const first = provs[0]
  lines.push('- id: agent-default-model')
  lines.push('  name: "@deepseek-ai/dsh-agent-default-model"')
  lines.push('  config:')
  lines.push(`    provider: ${first.pid}`)
  lines.push(`    model: ${q(first.m.model)}`)

  // ── 插件市场：接 DSH 社区真实索引（6112 个）
  // ★ dsh-base 里没有 plugin-market，裸写 - id: 会被当成「修改已有条目」静默丢弃，
  //   必须用 - insert: 才是新增。
  lines.push('- insert:')
  // 界面定制插件（纯 client 包）：
  //   ★ 不能进 bundles —— bundles 要求 package.json 里有 dsh.bundle，
  //     我们只有 dsh.client，加了会报
  //     `skipping profile bundle "@velora/client": declares no dsh.bundle`。
  //   ★ 作为普通插件条目 insert 即可：dsh-client-modules 会扫 loader 的
  //     entries，发现 dsh.client 声明就把它的 ./client 装进前端。
  const pluginDir = join(__dirname, '..', '..', 'plugins', 'velora-client')
  if (existsSync(pluginDir)) {
    lines.push('    - id: velora-client')
    lines.push('      name: "@velora/client"')
  }
  lines.push('    - id: plugin-market')
  lines.push('      name: "@deepseek-ai/dsh-plugin-market"')
  lines.push('      config:')
  lines.push('        indexes:')
  lines.push('          - "https://awesome-dsh-plugin.com/index.json"')
  lines.push('          - "https://dshmarket.com/index.json"')
  lines.push('        cacheTtlMs: 21600000')
  lines.push('    - id: tool-plugin-market')
  lines.push('      name: "@deepseek-ai/dsh-plugin-market/tools"')
  lines.push('    - id: tool-plugin-manager')
  lines.push('      name: "@deepseek-ai/dsh-plugin-manager/tools"')
  lines.push('    - id: plugin-manager')
  lines.push('      name: "@deepseek-ai/dsh-plugin-manager"')

  // ── Web 服务器：内核自带的界面（含插件市场/自动化任务/设置）
  //    ★ host 与 port 都是 required；host 不接受通配地址。
  //    ★ port 必须能变：写死一个值，第二个实例（或用户机器上撞了）直接
  //      `listen EADDRINUSE` → required plugin 不激活 → 整个内核起不来。
  //    ★ 端口必须在 Node 侧读好、把字面数字写进 YAML —— 别把文件 IO 塞进
  //      `!!js`：实测 cordis 求值拿到的是 [object Object]，报
  //      `$.port expected number but got [object Object]`。
  // ★ 用传进来的 homeDir，不是模块常量 P.HOME —— 后者是「真实数据目录」，
  //   拿它读端口会让所有临时 home（测试、多实例）都去抢同一个端口，
  //   症状是第二次启动必然 EADDRINUSE。
  const portFile = join(homeDir || require('./paths').HOME, '配置', 'port.txt')
  let webPort = 0
  try {
    const n = parseInt(readFileSync(portFile, 'utf8').trim(), 10)
    if (Number.isFinite(n) && n > 1024 && n < 65535) webPort = n
  } catch {}
  // ★ 关掉「自动用系统浏览器打开界面」。
  //   界面就在我们自己的 Electron 窗口里 —— 它再弹一个 Chrome，
  //   用户第一反应就是「你怎么用浏览器打开」。注意这不是命令行参数
  //   （`--no-open` 会报 unknown option），是 web-app 插件的配置项。
  //   插件 id 是 web-runtime（不是 web-app），它的 openBrowser 默认取
  //   `ctx.webStartup.openBrowser`，我们直接覆盖成 false。
  lines.push('- id: web-runtime')
  lines.push('  config:')
  lines.push('    openBrowser: false')
  lines.push('    printUrl: true')
  lines.push('- id: webserver')
  lines.push('  config:')
  lines.push('    host: 127.0.0.1')
  // 0 = 让内核自己挑空闲端口（只有连 port.txt 都没有时才会走到这里）
  lines.push(`    port: ${webPort || 0}`)

  // ── 沙箱：完全托管（桌面软件，用户自己的机器）
  /* ★ workspaceRoot 以前写 process.cwd()（2026-11-20 修）。
     内核由 kernel.js 以 cwd=kernelDir 启动，所以 process.cwd() 拿到的是
     kernel/dsh 那个目录 —— 沙箱的「工作区根」指到了内核自己身上，
     跟 AI 实际的 cwd（用户数据目录）完全不是一个地方。
     打包后尤其明显：能不能写文件、写到哪，全看这个错的根。
     改成传进来的 homeDir（= KERNEL_HOME 的父级业务目录）。
     ★ 注入方式仍是 !!js 表达式，但取的是本函数作用域里的变量，
       不是全局 —— patch 是字符串，闭包里的 homeDir 已经拼进去了。 */
  lines.push('- id: sandbox-policy')
  lines.push('  config:')
  lines.push('    mode: danger-full-access')
  lines.push(`    workspaceRoot: ${q(workDir || homeDir)}`)
  lines.push('- id: approval')
  lines.push('  config:')
  lines.push('    policy: never')

  // ── MCP：把我们的 42 个工具挂给内核（AI 靠这个真正动手）
  // ★ dsh-base 里没有 mcp-client，裸写 - id: 会被当成「修改已有条目」静默丢弃，
  //   必须用 - insert: 且条目缩进 4 空格。踩过两次，别再改回去。
  const mcpEntry = join(__dirname, 'mcp.js')
  // ★ 必须用内核自带那个 node，不能用 process.execPath：
  //   打包后用户机器上不一定有 Homebrew，而 kernel/dsh/node 是我们随包带的、
  //   只链 /usr/lib 的那份（已经验过不依赖 /opt/homebrew）。
  const K = require('./kernel')
  const nodeBin = existsSync(join(K.KERNEL_DIR, 'node')) ? join(K.KERNEL_DIR, 'node') : process.execPath
  lines.push('- insert:')
  lines.push('    - id: mcp-client')
  lines.push('      name: "@deepseek-ai/dsh-mcp-client"')
  lines.push('      config:')
  lines.push('        transport: stdio')
  lines.push('        serverName: velora-video')
  lines.push(`        command: ${q(nodeBin)}`)
  lines.push('        args:')
  lines.push(`          - ${q(mcpEntry)}`)
  lines.push('        env:')
  lines.push('          RiffCut_CUSTOMER: !!js process.env.RiffCut_CUSTOMER || ""')
  lines.push('        toolCallTimeoutMs: 1800000')
  lines.push('        failOnStartupError: false')

  // ── 技能：把我们的 41 个导演技能挂进去
  const P = require('./paths')
  const skillDirs = [
    join(P.HOME, '配置', '导演技能'),
    join(P.RES, '技能'),
  ].filter(existsSync)
  if (skillDirs.length) {
    lines.push('- id: skill-filesystem')
    lines.push('  config:')
    lines.push('    customSkillDirs:')
    for (const d of skillDirs.slice(0, 1)) lines.push(`      - ${q(d)}`)
  }

  /* ★ 把内核自带的 persona 换掉。
     2026-11-20 实测：DSH 的每个 preset（standard/ptc/minimal/cordis）都挂了一个
     persona 插件，前缀写死成 `You are a coding agent powered by the {{model}} model.`。
     这句话是给写代码场景的，在影创里它带来两个实际问题：
       ① AI 自称「DeepSeek Harness 的 AI 助手 / 视频创作代理」，用户问"你是谁"时
          它答的是宿主框架的名字，不是产品的名字；
       ② 它把整轮当成编码任务，用户说「你好」，它去 ls 目录、list_mcp_resources、
          列能力清单，一轮走 48 步 —— 因为这确实是 coding agent 的开场动作。

     ★ 真正生效的字段是 personaPrefix，不是 preset.plugins[] 里那个嵌套的 persona：
       patch 按**顶层 id** 匹配（dsh-app-boot 的 applyEntryPatches），而
       preset 的 plugins 是普通对象数组、不是 group，里层条目永远进不了 entryMap；
       且 config 是整体替换、不深合并。所以只能patch顶层这条 system-prompt。
     ★ 这里不再是 "coding agent"，而是一个短视频导演 —— 和 home/AGENTS.md 对齐。
     ★ 只改前缀不改插件结构：DSH 内部逻辑不读这段话，纯提示词层。 */
  lines.push('- id: system-prompt')
  lines.push('  config:')
  lines.push('    includeHarnessIdentity: false')
  lines.push('    personaPrefix: ' + q(PERSONA_PREFIX))

  /* ★★ 自动上下文压缩：必须提到顶层，preset 里那份用不上。
     2026-11-20 实测过程（这一段踩了两天）：
       ① 内核里 compaction 相关包一共六个，cfg 里 25 处 compaction 引用，
          preset-standard/ptc/minimal 内部都有 `- id: compaction`（cordis:group,
          group: true, isolate: {compaction, toolResultPruner}），看起来是启用的。
       ② 但 SDK 起会话走的不是 preset 组装路径：dsh-sdk-jsonrpc-server 的
          createSession() 直接 `this.ctx.agents.create({sessionId, meta, agentOptions})`，
          agentOptions 只有 provider/model/reasoningEffort/maxTokens —— 没有 preset。
          所以 preset 里那份 compaction-basic 从来没被实例化。
       ③ 顶层那条本来写着 `disabled: true`（dsh-base 关掉的），patch 想启用必须
          显式写 `disabled: false`，只写 config 不会让它活过来。
       ④ 实测对照：只在模型上注入 contextWindow=70000（理论阈值 2464 token）、
          塞 5200 token/轮 × 3 轮 → **0 个压缩事件**；
          再加顶层 `- id: compaction-basic / disabled: false` → compaction/start、
          compaction/summary、compaction/end 全部正常，摘要里能读出中英文 checkpoint。
     阈值公式（dsh-compaction-basic/lib/index.js:124-132）：
       pressureBudget = contextWindow - reservedCompletionTokens - headroomTokens(65536)
       thresholdTokens = min(contextWindow * thresholdRatio(0.8), pressureBudget)
     默认 256K 窗口下 = min(209715, 163840) = **163840 token** 才触发 —— 也就是
     约 65 万汉字。这不是"没生效"，是"阈值等于永远不触发"。
     headroomTokens 从 65536 降到 16384：留 16K 给下一轮请求足够，阈值同时降到
     min(209715, 229376) = 209715，虽然还是很宽松但不再是天文数字。
     ★ 用户明确要求「上下文越长越好，越长的智力越高」——所以这里不给小阈值，
       只保证机制真的在工作。真要省 token 由用户自己说。 */
  lines.push('- id: compaction-basic')
  lines.push("  name: '@deepseek-ai/dsh-compaction-basic'")
  lines.push('  disabled: false')
  lines.push('  config:')
  lines.push('    headroomTokens: 16384')
  lines.push('    thresholdRatio: 0.8')
  lines.push('    auto: true')
  /* tool-result-pruner 也提上来：单个工具结果超过 8192 字符就压到
     头 4096 + 尾 1024。这个不需要触发阈值，每一步都生效，是最便宜的省上下文手段。
     注意它和 compaction-basic 是两件不同的事：前者剪单条工具结果，
     后者把整段历史换成摘要 checkpoint。 */
  lines.push('- id: tool-result-pruner')
  lines.push("  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'")
  lines.push('  disabled: false')
  lines.push('  config:')
  lines.push('    thresholdChars: 8192')
  lines.push('    headChars: 4096')
  lines.push('    tailChars: 1024')

  return lines.join('\n') + '\n'
}

/**
 * 写 profile 并返回 {provider, model, env}。
 * 幂等：只在内容确实变了时才写盘，避免内核每次启动都重载。
 */
function buildProfile({ kernelDir, homeDir, workDir, profile }) {
  const dir = join(homeDir, 'profiles', profile)
  ensureDir(dir)

  // ── 界面定制插件：只换侧栏左上品牌 + 首页 hero 标记，其余保持 DSH 原样。
  //    ★ 必须走官方 slots 机制，绝不注入 DOM —— 注入的东西下一次 React
  //      重渲染就没了，还得跟着它的 hashed 类名改（踩过一次）。
  //    ★ 插件放在 <ROOT>/plugins/ 而不是内核 node_modules 里：内核整体换版本时
  //      它不受影响。profile 的 node_modules 里做软链让 DSH 能解析到它。
  const rootDir = join(__dirname, '..', '..')
  const pluginSrc = join(rootDir, 'plugins', 'velora-client')
  const bundles = BUNDLES.slice()
  if (existsSync(pluginSrc)) {
    try {
      const linkDir = ensureDir(join(dir, 'node_modules', '@velora'))
      const linkPath = join(linkDir, 'client')
      const st = lstatSync(linkPath, { throwIfNoEntry: false })
      if (!st) symlinkSync(pluginSrc, linkPath, 'dir')
    } catch (e) {
      process.stderr.write('[profile] 插件软链失败: ' + e.message + '\n')
    }
  } else {
    process.stderr.write('[profile] 没找到界面插件: ' + pluginSrc + '\n')
  }

  const env = {}
  const models = readModels()
  const patch = patchYaml({ models, env, homeDir, workDir })

  /* ★ 不能整体重写 package.json —— 会把用户装的插件抹掉。
     踩过的坑：这个函数每次 /api/chat 都跑一次，原来直接写
     `{name, private, dsh:{profile:{bundles}}}`，于是 plugins() 里
     pnpm 装好的 dependencies 和用户加进 bundles 的插件，下次启动全没了。
     症状：插件市场里显示「已装」，但 AI 完全用不到它 —— 因为 profile 里那条记录被冲掉了。
     正解：读旧文件，把 dependencies 原样带上，bundles 做并集（内置的在前，用户加的在后）。 */
  let oldPkg = {}
  try { oldPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (e) { oldPkg = {} }
  const oldBundles = ((oldPkg.dsh || {}).profile || {}).bundles || []
  const mergedBundles = Array.from(new Set(bundles.concat(oldBundles.filter((x) => !bundles.includes(x)))))
  const pkg = {
    name: 'velora-profile',
    private: true,
    dsh: { profile: { bundles: mergedBundles } },
  }
  if (oldPkg.dependencies && Object.keys(oldPkg.dependencies).length) pkg.dependencies = oldPkg.dependencies

  const files = {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'cordis.yml': '[]\n',
    'cordis.patch.yml': patch,
    'pnpm-workspace.yaml': 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  }
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name)
    let old = null
    try { old = readFileSync(p, 'utf8') } catch {}
    if (old !== body) writeFileSync(p, body, 'utf8')
  }

  // 插件软链目录（我们的定制插件放这里；DSH 从 profile 下解析）
  ensureDir(join(dir, 'node_modules'))

  return {
    provider: models.length ? 'velora-m0' : 'velora-m0',
    model: models.length ? models[0].model : 'agnes-2.5-flash',
    env,
    patchPath: join(dir, 'cordis.patch.yml'),
    profileDir: dir,
  }
}

module.exports = { buildProfile, BUNDLES }
