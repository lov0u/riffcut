/* 根目录说明书 —— 写一份 README.md 到数据根目录。
 *
 * 为什么要有这个文件（2026-11-20，用户 m05899「这个软件的根目录你要做一个」）：
 *
 * 以前数据根目录是这样的（真实 ls 输出）：
 *   AGENTS.md  blob_storage  Cache  Code Cache  DawnGraphiteCache  DIPS
 *   GPUCache  Local State  Local Storage  Network Persistent State
 *   Preferences  profiles  Session Storage  Shared Dictionary  SingletonLock
 *   storages  Trust Tokens  缓存  客户  模板库  内置  配置  系统  知识库  资源
 *
 * 二十几个 Chromium 缓存目录在最上面，业务数据被压在最后几个。两个后果：
 *   ① 用户点开数据目录，看不懂哪个是能动的、哪个动了会坏；
 *   ② AI 的内核 cwd 就挂在这一层，它 ls 一次看到的就是这堆缓存，
 *      于是真会去翻 —— 这不是模型不听话，是环境没告诉它哪块地是它的。
 *
 * 现在拆成三层（见 lib/paths.js 的 KERNEL_HOME / RUNTIME）：
 *   <HOME>/         业务数据，AI 的工作目录就是这一层
 *   <HOME>/内核/     DSH 内核自己的状态，AI 不该碰
 *   <HOME>/运行时/   Electron/Chromium 的，纯机器垃圾
 *
 * 这份 README 有两个读者，所以两种写法都要有：
 *   - 给用户看：哪些能删、哪些删了会丢东西、出问题去哪儿看日志
 *   - 给 AI 看：哪一层是你的工作区、要查东西先调工具而不是翻目录
 *
 * ★ 只在文件不存在时写一次。用户改过就再也不覆盖 —— 他可能在里面记了自己的话。
 * ★ 不抛异常：写不出来顶多少一份说明书，不该影响启动。
 */
const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const FILENAME = 'README.md'

function body({ home, kernelHome, runtimeDir }) {
  return `# 影创的数据目录

这是 RiffCut 影创存放你所有东西的地方。分三层，各管各的。

## 一、目录结构

\`\`\`text
${home}/
├── 客户/           你的片子都在这。每个客户一个文件夹，按名字分
│   └── <客户名>/
│       ├── 产出/        成片、图片、配音、预览
│       ├── 工程/        剪辑工程（可以用别的软件打开）
│       ├── 音色/        这客户专属的配音音色
│       └── 品牌套件/    logo、字体、色板
├── 模板库/         448 个画面模板，AI 靠这个在没有素材时也能出片
├── 资源/           技能、品牌库、片尾、音乐、法律文书
├── 配置/           各种设置（模型、客户、界面……），JSON 格式
├── 系统/           本地模型权重（语音识别、配音）、日志、备份
├── 知识库/         你自己往里写的经验笔记，AI 会读
├── 内置/           随软件带的默认数据
├── 缓存/           可以随时删，删了下次自己重建
├── 内核/           内核状态（见下）
└── 运行时/         浏览器缓存（见下）
\`\`\`

## 二、哪些能动，哪些别动

| 目录 | 能删吗 | 说明 |
|---|---|---|
| \`客户/\` | **不能** | 你的成片和工程，删了就没了 |
| \`模板库/\` | 不能 | 删了 AI 就没画面可用 |
| \`资源/技能/\` | 不能 | AI 的实操知识，删了它做事就不靠谱 |
| \`配置/\` | 备份后再改 | 手改坏了软件会读不到设置，改前把整个 \`配置/\` 复制一份 |
| \`系统/备份/\` | 能 | 软件的自动备份，占地方就清掉旧的 |
| \`缓存/\` | **能，随便删** | 缩略图、索引这些，删了会慢一次，然后自己重建 |
| \`内核/\` | 能，但会丢对话历史 | 见下一节 |
| \`运行时/\` | **能，随便删** | 纯浏览器缓存，几十上百 MB，删了软件重开就重建 |

## 三、内核/ 和 运行时/ 是什么

这两个不是给用户用的，是软件自己工作需要的地方。

\`内核/\` —— AI 内核的状态：

\`\`\`text
${kernelHome}/
├── profiles/velora/     内核的插件配置（我们生成的，别手动改，会被覆盖）
├── sessions/            历史对话记录。删了 = 界面上的「历史对话」全空
└── storages/            内核的工作暂存
\`\`\`

\`运行时/\` —— Electron（Chromium）自己的东西：

\`\`\`text
${runtimeDir}/
├── Cache/  Code Cache/  GPUCache/  ...    都是浏览器缓存，没有你的数据
└── Preferences  Local Storage  ...        窗口位置之类的杂项
\`\`\`

**这一层是「机器垃圾」，不含任何你的内容。** 它以前跟你的片子挤在同一层，
点开数据目录第一屏全是 \`Cache\`、\`Code Cache\`、\`Trust Tokens\` 这种名字 ——
既看不懂，也让人误以为软件在乱写东西。现在收进子目录了。

## 四、给 AI 的话

如果你是内核里的那个 AI，这一节是写给你的：

**你的工作目录就是上面第一层**（\`${home}\`），里面全是人话目录，没有一个缓存文件夹。
所以不要再花时间 \`ls\` 探路了 —— 你已经知道有什么。

**要查东西，先调工具，别翻目录：**

| 你想知道 | 用这个，一次拿全 |
|---|---|
| 这台机器能干什么（模型、模板数、音色、渲染能力） | \`capabilities\` |
| 有哪些素材 | \`assets\` |
| 有哪些现成工程 | \`projects\` |
| 有哪些模板能套 | \`templates\` |
| 该怎么干这活 | \`skills\` |

**只有这四个都答不了的时候**（比如用户说「我上周放下载夹里那个咖啡的片子」），
才去 \`ls\` 具体某个目录，而且要一次命中，别从根往下点。

判断自己是不是在瞎逛：**连续调了 3 个查询类工具还没开始干活，就停下来问自己
「我到底缺哪个信息？哪个工具能一次给我？」**

## 五、出问题了去哪儿看

\`\`\`text
${join(home, '系统', '日志')}/
\`\`\`

按日期分文件。AI 答得不对、出片失败、软件起不来，都先看这里 ——
比在界面上猜快得多。

---

*这份说明由软件自动生成，只在你第一次启动时写一次。你可以改它，改完不会再被覆盖。*
`
}

/** 在数据根目录写一份 README.md。已存在就跳过，什么都不做。 */
function ensureReadme(P) {
  try {
    const p = join(P.HOME, FILENAME)
    if (existsSync(p)) return false
    writeFileSync(p, body({
      home: P.HOME,
      kernelHome: P.KERNEL_HOME,
      runtimeDir: P.RUNTIME,
    }), 'utf8')
    return true
  } catch (e) {
    /* 写不出来不影响启动 —— 顶多少一份说明书 */
    try { console.error('[readme-home] 写根目录说明失败: ' + e.message) } catch (e2) {}
    return false
  }
}

module.exports = { ensureReadme, FILENAME }
