# RiffCut 影创 · 专业剪辑智能体

> Electron + Node.js 本地视频剪辑工作台，内置 AI 导演内核，支持从分镜策划、素材生成、剪辑合成、字幕配音到多平台发布的全流程。可离线运行，客户数据本地存储，不上传云端。

[![官方网站](https://img.shields.io/badge/🌐_官网-riffcut.cn-2F6BFF?style=for-the-badge)](https://riffcut.cn)
[![下载 macOS 版](https://img.shields.io/badge/⬇_下载-macOS_安装包-2F6BFF?style=for-the-badge)](../../releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Electron](https://img.shields.io/badge/Electron-45.3.4-blue.svg)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26-green.svg)](https://nodejs.org/)
[![hyperframes](https://img.shields.io/badge/hyperframes-0.9.66-purple.svg)](https://github.com/heygen-com/hyperframes)
[![macOS](https://img.shields.io/badge/macOS-arm64-lightgrey.svg)](https://www.apple.com/macos/)

---

## 一、这是什么

**RiffCut 影创** 是一款面向短视频创作者、自媒体从业者和内容团队的**本地剪辑智能体软件**。

> **🌐 官网：[https://riffcut.cn](https://riffcut.cn)** —— 产品介绍、使用教程与最新版下载都在这里。

它不是在线剪辑网站，也不需要把素材上传到云端——所有的剪辑、渲染、发布都在你自己的 Mac 上完成。

> **⬇ [下载 macOS 安装包](DOWNLOAD.md)** —— 完整版 3.0 GB（装完即用，含语音模型）· 轻量版 1.2 GB

核心定位：

| 定位 | 说明 |
|------|------|
| **AI 导演** | 内置 DSH 内核，能听懂中文需求，自主拆分任务、调用工具、出片 |
| **本地剪辑台** | 多轨时间线、模板套用、字幕样式、音频分层、画质体检 |
| **多平台发布** | 通过 CDP 驱动浏览器，直接发布到抖音、小红书、视频号、B站等平台 |
| **离线优先** | 素材、工程、成片全部存在本地，不依赖云端渲染 |

**一句话**：你说要一条 15 秒竖屏产品片，它自己定方向、写分镜、找画面、配乐、出片，最后抽帧检查一遍才交给你。

---

## 二、软件优势

### 1. 本地优先，数据不出门
- 客户素材、剪辑工程、成片全部存储在本地 `home/` 目录（或用户指定的工作区）
- 打包后的 `.app` 是只读的，用户数据写入 `~/Library/Application Support/RiffCut影创`，换版本不丢数据
- 不需要上传素材到云端，适合对数据隐私有要求的创作者和团队

### 2. AI 导演内核，一句话就能出片
- 基于 DSH（DeepSeek Harness）内核，通过 stdio JSON-RPC 与 Electron 主进程通信
- 用户用自然语言下达指令（如「做一条 15 秒竖屏产品片」），AI 导演自主完成：定方向、写分镜、找画面、配音乐、出片、复核
- 内置 **41 个导演技能**（`home/资源/技能/` 和 `home/配置/导演技能/`），覆盖创作流程、出片流水线、字幕配音、调色、运镜、节奏卡点等全流程实操知识

### 3. 现成模板库，零素材也能出片
- 内置模板库 `home/模板库/registry/`，共 **210 个 block 目录**、注册表收录 **456 个条目**（含示例）
- 分类包括：字幕、下三分之一、转场、片头片尾、图表数据、产品展示、社媒包装、文字动画、背景纹理、动效零件
- 支持按分类和关键词筛选，绝大多数模板不依赖实拍素材，文字 + 模板即可成片

### 4. 多轨时间线 + HyperFrames 渲染引擎
- 自研 `timeline.json` 工程格式，支持视频/图形/字幕/音频四条轨道
- 基于 **hyperframes** 本地渲染引擎，不走 npx（避免首次下载 25MB 导致用户误以为卡死）
- 片段几何语义统一：x/y 为画面中心比例 0~1，w/h 为占画布比例，at 为片段内进度 0~1
- 内置动画预设：fade、slideUp/Down/Left/Right、zoomIn/Out、kenburns

### 5. 字幕系统：ASS 直出，支持关键词高亮与进场动画
- 不局限于 SRT，直接生成 ASS 字幕，支持逐条样式和内联覆盖标签
- 内置字幕预设：标准、大字、弹字、竖屏、标题、卡片、竖屏卡片、卡拉OK、竖屏卡拉OK、钩子字、编辑字
- 支持字号按短边比例缩放、贴顶/贴底锚点、黑底遮罩等短视频常用样式

### 6. 音频四层电平管理，响度达标
- 四层电平标准：对白 0 dB / 音效 −6~−10 dB / 配乐 −18~−24 dB / 环境底噪 −26~−32 dB
- 说话时配乐自动让声 −4 dB（ducking）
- 短视频平台通行响度目标 −14 LUFS，真峰值上限 −1 dB，预留 AAC 编码回升余量 1.2 dB
- 支持 macOS 系统语音（say 命令）和 Ming 本地 TTS 引擎（GGUF + 预编译 CLI，Metal 推理，零 Python 依赖）

### 7. 多平台交付规格，一条母版派生多份
- 内置 `delivery.js` 平台规格表，支持 YouTube、Shorts、Reels、TikTok、抖音、视频号、小红书、Instagram Feed、X、LinkedIn、自有网页
- 支持横屏重排竖屏（模糊底铺满，不加黑边），按平台规格导出交付档
- 交付体检：检查文件能否给客户、能否传平台、能否在网页里播放

### 8. 浏览器自动化发布（CDP 驱动）
- 内置 `cdp.js` 极简 Chrome DevTools Protocol 客户端，零第三方依赖（不装 puppeteer，避免和用户已登录的 Chrome profile 打架）
- `publish.js` 支持抖音、小红书、快手、视频号、B站等平台的网页端发布
- 默认 dry-run：填完所有字段、停在发布按钮前，截图给用户确认后才真发，避免不可撤回的误发

### 9. 插件市场 + MCP 服务器
- 内置 `market.js` 插件市场索引（6112 个插件，约 4.9MB，6 小时缓存），直接 HTTP 拉取，零延迟
- `mcp.js` 提供 MCP 服务器，把 RiffCut 的全部能力挂给 DSH 内核，通过 stdio JSON-RPC 2.0 通信
- 界面和 AI 看到的是同一份工具表，不会出现「界面上有、AI 看不到」的缝

### 10. 子智能体后台工位，主对话不阻塞
- 长耗时任务（搜文案 → 写分镜 → 渲片）单独开内核会话在后台跑，主对话秒回
- 用户可以中途加意见、改需求，后台工位互不踩
- 如实告知边界：内核 SDK 没有取消能力，「停」只能做界面层止损

### 11. 启动性能可观测，体验可控
- 主进程每个关键启动节点打毫秒数（`RiffCut_STARTUP_TRACE=1`），慢在哪一步一眼看出
- 单实例锁：防止用户双击图标启动两个进程抢同一个端口
- 调试端口仅在显式设置 `RiffCut_DEBUG_PORT` 时开启，普通用户不留任何监听端口

### 12. 打包友好，macOS 原生体验
- `构建.app.sh` 一键打包成 `RiffCut影创.app`，支持 ad-hoc 签名（arm64 上没签名会被系统 Killed: 9）
- 图标自动生成 10 档 icns
- `home/` 不进安装包，大权重（语音模型）在签名后再塞回，首次启动校验从 12.1 秒降到 1.8 秒

---

## 三、项目结构

```
RiffCut影创/
├── README.md                 # 本说明文件
├── LICENSE                   # AGPL-3.0 全文
├── NOTICE.md                 # 第三方组件与许可证清单
├── 构建.app.sh               # macOS .app 打包脚本
├── app/                      # Electron 主进程与渲染进程代码
│   ├── main.js               # 主进程入口（窗口、IPC、内核启动、私有协议）
│   ├── preload.js            # 渲染进程桥接（window.riffcut API）
│   ├── package.json          # 项目依赖（electron ^45.3.4, hyperframes ^0.9.66）
│   ├── lib/                  # 核心库
│   │   ├── core.js           # 客户、工作区、设置、历史、费用
│   │   ├── paths.js          # 全项目路径唯一真源
│   │   ├── tools.js          # AI 工具注册表（41 个工具，权限分级）
│   │   ├── kernel.js         # DSH 内核客户端（stdio JSON-RPC）
│   │   ├── render.js         # 渲染：timeline.json → composition HTML → MP4
│   │   ├── timeline.js       # 多轨剪辑工程（timeline.json → HyperFrames HTML）
│   │   ├── skills.js         # 导演技能管理（YAML front matter）
│   │   ├── templates.js      # 模板库（分类 + 变量表）
│   │   ├── publish.js        # 多平台发布（CDP 驱动浏览器）
│   │   ├── cdp.js            # 极简 Chrome DevTools Protocol 客户端
│   │   ├── mcp.js            # MCP 服务器（stdio JSON-RPC 2.0）
│   │   ├── market.js         # 插件市场索引（6112 个插件）
│   │   ├── audio.js          # 音频：TTS/配乐/音效/响度收尾
│   │   ├── subtitle.js       # 字幕：ASS 直出，关键词高亮、进场动画
│   │   ├── delivery.js       # 多平台交付规格与母版派生
│   │   ├── study.js          # 参考片子量测（切镜头、节奏、语速、响度）
│   │   ├── plan.js           # 出片前体检（时长、钩子得分、节奏审计）
│   │   ├── workers.js        # 后台工位（长耗时任务不阻塞主对话）
│   │   ├── agents.js         # 子智能体登记簿
│   │   ├── uiserver.js       # 界面协议层
│   │   ├── api.js            # 界面 API 路由
│   │   └── ...               # 其余模块：image, brand, browser, convo, exec, hook,
│   │                         #   hotspot, imgfit, insights, localmodels, looks, memory,
│   │                         #   models, openapi, profile, review, rhythm, sessions,
│   │                         #   slides, stock, tasks, turn, voicemodels, vendor
│   ├── renderer/             # 渲染进程页面
│   │   ├── index.html        # 主界面
│   │   ├── studio.html       # 剪辑台
│   │   ├── ui.html           # DSH 界面嵌入页
│   │   ├── editor.js         # 编辑器逻辑
│   │   ├── boot.html         # 启动页
│   │   └── assets/           # 静态资源
│   ├── ui/                   # DSH 界面构建
│   │   ├── build.py          # shell.html + pages/*.html → ui.html
│   │   ├── _single.html      # 单文件版（素材 base64 内联）
│   │   ├── assets/
│   │   └── src/
│   │       ├── live.js
│   │       ├── shell.html
│   │       └── pages/        # 16 个页面（build.py 硬断言）
│   └── node_modules/         # 依赖（不打进 .app，按依赖闭包复制）
├── kernel/                   # DSH 内核（随包带）
│   └── dsh/
├── tools/                    # 构建与运行时工具
│   ├── ffmpeg                # ffmpeg 二进制（见 NOTICE.md 第 3 节分发限制）
│   ├── ffprobe               # ffprobe 二进制
│   ├── hf-deps.js            # hyperframes 依赖闭包复制脚本
│   └── audio.cpp/            # Ming 本地配音引擎（预编译二进制 + spec）
├── plugins/                  # 插件目录
├── runtime/                  # 运行时暂存（bigweight-stage 等）
└── home/                     # 开发时的数据目录（打包后不进包）
    ├── 客户/                 # 客户素材、工程、成片
    ├── 资源/                 # 技能、模板、品牌库、片尾、音乐、法律
    ├── 模板库/               # 模板库（registry + thumbs）
    ├── 配置/                 # 设置、模型、客户、任务、历史、费用等
    ├── 系统/                 # 本地模型、备份、日志
    ├── 缓存/                 # 市场索引缓存等
    ├── 知识库/               # 知识库条目（INDEX.md, RULES.md）
    ├── sessions/             # 会话记录
    ├── logs/                 # 启动日志
    ├── AGENTS.md             # AI 导演工作指南
    └── profiles/             # 用户配置文件
```

---

## 四、快速开始

### 环境要求

- macOS（Apple Silicon arm64 推荐，Intel Mac 也可运行）
- Node.js 26+（开发环境；打包后用户无需安装 Node）
- Python 3（仅用于打包脚本生成图标，运行时不需要）
- FFmpeg（渲染与抽帧；见下方说明）

### 开发模式运行

```bash
# 进入 app 目录
cd app

# 安装依赖
npm install

# 启动（开发模式）
npm start

# 带调试端口启动（供外部工具读取 DOM）
RiffCut_DEBUG_PORT=9355 npm run start:debug
```

### 安装 FFmpeg

本项目仓库内的 `tools/ffmpeg` 为特定构建，**不适合随源码分发**（原因见 `NOTICE.md` 第 3 节）。请自行安装：

```bash
brew install ffmpeg
```

或从 [evermeet.cx](https://evermeet.cx/ffmpeg/) 下载 LGPL 构建，放到 `tools/` 目录。

### 打包成 macOS 应用

```bash
# 在项目根目录运行
./构建.app.sh
```

打包完成后得到 `RiffCut影创.app`，可直接双击运行。

### 首次使用

1. 双击 `RiffCut影创.app` 启动 —— **不用配任何东西，直接就能对话**（软件自带一份公共模型额度，见下）
2. 在设置里选择工作区（客户素材和产出将存在此目录下）
3. 用自然语言告诉 AI 导演你想做什么，例如：「做一条 15 秒竖屏产品推广片」

### 模型：装完即用，也可换成自己的

软件预置了一个 `auto（多模态）` 模型，走作者自建的中转网关，**不需要注册任何账号**。它的作用只是让第一次打开的人能立刻说上话、把功能摸一遍。

想用自己的模型（额度更足、速度更稳、支持图片输入）：

1. 打开「模型管理」
2. 点「添加 / 配置」，供应商下拉里选「白鹿 BailuCode」或「Agnes 国内 / 国际」—— 接口地址和模型 ID 会自动填好
3. 到对应平台注册拿一个 API Key，粘进「API Key」框，保存
4. 点「测试」确认通了，再在首页顶部的模型下拉里选中它

密钥存在 macOS 钥匙串里（`service = riffcut.apikeys`），不写进任何配置文件，也不随备份走。内置额度被限速或下线时，换自己的 key 就行，不用等更新。

---

## 五、核心功能模块说明

### 5.1 AI 导演（内核层）

DSH 内核通过 `kernel.js` 与 Electron 主进程建立 stdio JSON-RPC 通信通道。AI 导演拥有以下能力：

- **任务拆解**：把用户的自然语言需求拆成可执行的工具调用序列
- **工具调用**：通过 `tools.js` 注册表调用 41 个工具，覆盖素材、模板、时间线、渲染、发布等
- **子智能体**：通过 `workers.js` 在后台单独开会话跑长耗时任务，主对话不阻塞
- **事件通知**：`subagent.started` / `subagent.finished` 通知用于界面进度显示

### 5.2 剪辑工程（timeline.js）

工程格式为 `timeline.json`，包含：

- 画布尺寸、帧率、时长（默认 1920×1080，30fps，10秒）
- 四条轨道：视频 (v1)、图形 (g1)、字幕 (t1)、音频 (a1)
- 片段几何：x/y（中心比例 0~1）、w/h（占画布比例）、at（片段内进度 0~1）、keys（关键帧路径点）
- 动画预设：fade、slideUp/Down/Left/Right、zoomIn/Out、kenburns

### 5.3 渲染（render.js）

渲染流程：`timeline.json` → composition HTML → MP4。

- 使用本地 `hyperframes` 渲染引擎，不走 npx
- ffmpeg/ffprobe 路径显式指定，子进程环境变量透传
- 渲染子进程使用内核自带的 Node 二进制（避免打包后 `process.execPath` 变成 Electron 可执行文件）

### 5.4 字幕（subtitle.js）

- 生成 ASS 格式字幕，支持逐条样式和内联覆盖标签
- 字幕预设：标准、大字、弹字、竖屏、标题、卡片、竖屏卡片、卡拉OK、竖屏卡拉OK、钩子字、编辑字
- 字号按画面短边比例缩放，支持贴顶/贴底锚点、黑底遮罩

### 5.5 音频（audio.js）

- 四层电平：对白 0 dB / 音效 −8 dB / 配乐 −21 dB / 环境底噪 −29 dB
- 响度目标：−14 LUFS，真峰值 −1 dB，AAC 编码回升余量 1.2 dB
- 支持 macOS 系统语音和 Ming 本地 TTS（GGUF + Metal 推理）

### 5.6 多平台发布（publish.js + cdp.js）

- CDP 客户端连接用户已登录的 Chrome（独立 profile，调试端口）
- 支持抖音、小红书、快手、视频号、B站等平台网页端发布
- 默认 dry-run：填完字段、停在发布按钮前，用户确认后才真发

### 5.7 插件与 MCP（market.js + mcp.js）

- 插件市场索引：6112 个插件，6 小时缓存，直接 HTTP 拉取
- MCP 服务器：stdio JSON-RPC 2.0，把 RiffCut 能力挂给 DSH 内核

---

## 六、技术栈

| 层 | 技术 | 版本 | 说明 |
|----|------|------|------|
| 桌面框架 | Electron | ^45.3.4 | 主进程 + 渲染进程 |
| 渲染引擎 | hyperframes | ^0.9.66 | 本地视频合成 |
| 内核 | DSH (DeepSeek Harness) | 0.2.1-rc.3 | AI 导演，stdio JSON-RPC |
| 语言 | Node.js | 26+ | 所有核心库 |
| 构建脚本 | zsh + Python 3 | - | `构建.app.sh` 打包 .app |
| 多媒体 | ffmpeg / ffprobe | 6.0 | 音视频处理、抽帧、探测 |
| 本地 TTS | Ming-3.0-tts-0.5B (GGUF) | - | Metal 推理，零 Python 依赖 |
| 语音识别 | SenseVoice Small (ONNX) | - | 本地转写 |
| 浏览器自动化 | CDP (原生 WebSocket) | - | 无 puppeteer 依赖 |
| 插件协议 | MCP | 2024-11-05 | stdio JSON-RPC 2.0 |

---

## 七、授权、隐私与合规

### 7.1 授权模式

本项目采用**双许可**：

| 用途 | 授权 | 费用 |
|---|---|---|
| 学习、自用、改代码、分发（须开源修改） | **AGPL-3.0** | 免费 |
| 闭源集成、去品牌、需担保或 SLA | **商业授权** | 按需报价 |

- 完整条款见 [LICENSE](LICENSE) 与 [《开源许可与商业授权说明》](home/资源/法律/01-开源许可与商业授权.md)
- **你用本软件做出的成片、图片、文案、配音，版权归你**，AGPL 不约束产出物，可自由商用
- 商标不在开源范围内：分发修改版须更换名称与图标

### 7.2 数据与隐私

- 软件不收集用户数据，不内置遥测，不上传素材到云端
- 客户素材、工程、成片全部存在本地 `home/` 或用户指定工作区
- 只有你主动使用联网能力（模型对话、生图生视频、热点检索）时，相关数据才会发送给你**自行配置的**第三方服务
- 发布到第三方平台（抖音、小红书等）由用户在本地浏览器中操作，软件仅提供自动化辅助

### 7.3 你需要自己把关的事

- **素材授权**：音乐、字体、图片、肖像、商标，须自行取得合法授权（很多「免费」资源仅限个人使用）
- **AI 输出复核**：AI 生成的文案、画面、配音可能出错，发布前必须人工核对
- **平台规则**：遵守各平台发布规范与《广告法》等行业规定
- **声音克隆**：仅限本人或已取得明确书面授权的声音

详见 [《免责声明》](home/资源/法律/05-免责声明.md)。

### 7.4 第三方组件

完整清单、版本、许可证、**分发限制**见 [NOTICE.md](NOTICE.md)。

**特别提示**：`tools/ffmpeg` 当前构建带 `--enable-nonfree`，**不可随源码分发**，详见 NOTICE.md 第 3 节。

---

## 八、贡献指南

欢迎提交 Issue 和 Pull Request。

### 提交前

1. 阅读 `home/AGENTS.md` 了解 AI 导演的工作规范
2. 阅读 `home/配置/RULES.md` 了解知识库写入规范
3. 保持代码风格与现有 lib 模块一致（中文注释、中文变量名可接受）
4. 不要擅自更改打包流程或路径约定

### 提交时

- **代码贡献视为以 AGPL-3.0 授权**给本项目及所有下游用户
- 你保证提交内容为原创或已取得必要授权
- 一个 PR 只做一件事，附上「改了什么 / 为什么改 / 怎么验证」

### 不接受

- 移除或弱化授权声明、版权标识的改动
- 引入许可证不兼容的第三方代码（提交前请核对 [NOTICE.md](NOTICE.md)）
- 破坏打包流程的改动（除非同时更新 `构建.app.sh` 与本文档）

---

## 九、版本历史

- **v0.1.0** (2026-11)：首个公开版本。Electron + DSH 内核，41 个导演技能，210 个模板 block，多平台发布，本地渲染，双许可开源。

---

## 十、联系与反馈

| 用途 | 联系方式 |
|---|---|
| 官方网站 | [https://riffcut.cn](https://riffcut.cn) |
| 一般问题、建议 | 软件内右上角「反馈」按钮，或发邮件 |
| Bug 报告 | GitHub Issue（附复现步骤、系统版本、日志） |
| 商业授权咨询 | 邮件标题注明「商业授权咨询」 |
| 安全漏洞 | 请勿公开提交 Issue，直接发邮件 |
| 侵权投诉 | 邮件附权利证明与侵权位置 |

**邮箱：China@cyanweb.cn**

---

## 十一、致谢

本项目的实现依赖以下开源项目，感谢它们的作者：

- [Electron](https://github.com/electron/electron) — 跨平台桌面外壳
- [HyperFrames](https://github.com/heygen-com/hyperframes) — HTML 渲染视频引擎
- [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) — AI Agent 内核
- [FFmpeg](https://ffmpeg.org/) — 音视频处理基石
- [Ming-3.0-tts](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B) — 中文语音合成
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — 多语言语音识别（阿里巴巴通义实验室）

---

> **RiffCut 影创** — 让剪辑像导演一样简单，让片子像作品一样出色。
