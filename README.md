# RiffCut 影创 · 专业剪辑智能体

> Electron + Node.js 本地视频剪辑工作台，内置 AI 导演内核，支持从分镜策划、素材生成、剪辑合成、字幕配音到多平台发布的全流程。可离线运行，客户数据本地存储，不上传云端。
>
> **English:** A local-first AI video editing workstation built on Electron + Node.js with a built-in AI director. It covers the whole pipeline — storyboard planning, asset generation, editing, subtitles, voiceover and multi-platform publishing — entirely on your Mac, with no cloud upload. Click the language switcher below to read the full English version 👇

[![官方网站](https://img.shields.io/badge/🌐_官网-riffcut.cn-2F6BFF?style=for-the-badge)](https://riffcut.cn)
[![下载 macOS 版](https://img.shields.io/badge/⬇_下载-macOS_安装包-2F6BFF?style=for-the-badge)](../../releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Electron](https://img.shields.io/badge/Electron-45.3.4-blue.svg)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26-green.svg)](https://nodejs.org/)
[![hyperframes](https://img.shields.io/badge/hyperframes-0.9.66-purple.svg)](https://github.com/heygen-com/hyperframes)
[![macOS](https://img.shields.io/badge/macOS-arm64-lightgrey.svg)](https://www.apple.com/macos/)

---

<details>
<summary>🇬🇧 English Documentation — click to expand / 点此展开英文版</summary>

# RiffCut · The Professional Editing Agent

> A local-first AI video editing workstation built on Electron + Node.js with a built-in AI director. It covers the whole pipeline — storyboard planning, asset generation, editing and compositing, subtitles, voiceover, and multi-platform publishing. It runs offline; all client data is stored locally and never uploaded to the cloud.

[![Website](https://img.shields.io/badge/🌐_Website-riffcut.cn-2F6BFF?style=for-the-badge)](https://riffcut.cn)
[![Download for macOS](https://img.shields.io/badge/⬇_Download-macOS-2F6BFF?style=for-the-badge)](../../releases/latest)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Electron](https://img.shields.io/badge/Electron-45.3.4-blue.svg)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26-green.svg)](https://nodejs.org/)
[![hyperframes](https://img.shields.io/badge/hyperframes-0.9.66-purple.svg)](https://github.com/heygen-com/hyperframes)
[![macOS](https://img.shields.io/badge/macOS-arm64-lightgrey.svg)](https://www.apple.com/macos/)

---

## 1. What is it

**RiffCut** is a **local editing agent** for short-video creators, self-media professionals, and content teams.

> **🌐 Website: [https://riffcut.cn](https://riffcut.cn)** — product intro, tutorials, and the latest download.

It is not an online editing site, and you never need to upload your footage to a cloud — all editing, rendering, and publishing happens on your own Mac.

> **⬇ [Download the macOS installer](DOWNLOAD.md)** — 427 MB; 1.2 GB after install. Speech models download on first launch (about 1.9 GB, optional).

Positioning:

| Aspect | Description |
|---|---|
| **AI director** | Built-in DSH kernel; understands Chinese prompts, decomposes tasks, calls tools, and delivers finished videos |
| **Local editing desk** | Multi-track timeline, template reuse, subtitle styles, audio layering, quality checks |
| **Multi-platform publishing** | Drives a browser via CDP to publish directly to Douyin, Xiaohongshu, WeChat Channels, Bilibili, etc. |
| **Offline-first** | Footage, projects, and outputs all live locally; no cloud rendering dependency |

**In one sentence**: ask it for a 15-second vertical product video and it decides the direction, writes the storyboard, finds visuals, adds music, renders, then inspects the result before handing it to you.

---

## 2. Advantages

### 1. Local-first, data never leaves your machine
- Client footage, projects, and outputs are stored under local `home/` (or a workspace you choose)
- The packaged `.app` is read-only; user data goes to `~/Library/Application Support/RiffCut影创`, so upgrades never lose data
- No cloud upload — suited to creators and teams with strict privacy requirements

### 2. AI director kernel, one sentence to a finished video
- Built on the DSH (DeepSeek Harness) kernel, communicating with the Electron main process over stdio JSON-RPC
- Give a natural-language instruction (e.g. "make a 15-second vertical product video") and the AI director handles direction, storyboard, visuals, music, rendering, and review
- **41 built-in director skills** (`home/资源/技能/` and `home/配置/导演技能/`) covering the full production workflow
- **Native DSH alignment**: sessions can use the kernel's native tools (file I/O, shell, search, persistent terminal, sub-agents, team collaboration, scheduled tasks) — not just a thin video wrapper. Switch permission to "full access" and the AI can read files across the whole machine, same as raw DSH
- **Web search**: when the host has no `DEEPSEEK_API_KEY`, native search automatically falls back to the built-in stack (Bing primary, DuckDuckGo backup), so the model never stops just because a key is missing

### 3. Ready-made template library, no footage required
- Built-in registry `home/模板库/registry/`: **210 block directories**, **456 registered items** (including examples)
- Categories: subtitles, lower thirds, transitions, intros/outros, charts, product showcases, social packaging, kinetic type, background textures, motion parts
- Filter by category and keyword; most templates need no real footage — text + template is enough
- **Editable text**: 384 of 448 templates (86%) support direct text editing — 247 declare `data-composition-variables`, and `tpltext.js` scans the other 137 for on-screen text. In the editor, **click the text on canvas to edit it** — no hunting through side panels
- **Templates are design references, not assets**: instead of copying one template N times to fill the timeline (which just repeats one layout), `design_with_template` extracts the composition grammar (beats, seconds per beat, offsets, easing, which properties create motion) and uses it to lay out the whole film
- Stretching a template syncs `data-duration` to the copy so the animation truly fills the duration

### 4. Multi-track timeline + HyperFrames rendering
- Custom `timeline.json` project format with four tracks: video / graphics / subtitles / audio
- Local **hyperframes** rendering engine — not npx (avoids a 25 MB first-run download that users mistake for a hang)
- Unified clip geometry: x/y as center ratio 0–1, w/h as canvas proportion, at as in-clip progress 0–1
- Built-in animation presets: fade, slideUp/Down/Left/Right, zoomIn/Out, kenburns

### 5. Subtitles: direct ASS output, keyword highlight, entry animation
- Generates ASS directly, not just SRT — per-line styles and inline override tags
- Presets: standard, big, pop, vertical, title, card, vertical card, karaoke, vertical karaoke, hook, editorial
- Font size scales with the short edge; top/bottom anchors, backdrop masks, and other short-video staples

### 6. Four-layer audio level management
- Four levels: dialogue 0 dB / SFX −6 to −10 dB / music −18 to −24 dB / ambience −26 to −32 dB
- Music ducks −4 dB under speech
- Short-video loudness target −14 LUFS, true peak ≤ −1 dB, 1.2 dB headroom for AAC encoding
- Supports macOS system voice (`say`) and the Ming local TTS engine (GGUF + prebuilt CLI, Metal inference, zero Python dependency)

### 7. Multi-platform delivery specs, one master to many
- Built-in `delivery.js` spec table: YouTube, Shorts, Reels, TikTok, Douyin, WeChat Channels, Xiaohongshu, Instagram Feed, X, LinkedIn, web
- Reflows horizontal to vertical (blurred background fill, no black bars), exports per platform
- Delivery check: is it client-ready, platform-uploadable, web-playable

### 8. Browser automation publishing (CDP)
- Minimal built-in `cdp.js` Chrome DevTools Protocol client, zero dependencies (no puppeteer — avoids conflicts with the user's logged-in Chrome profile)
- `publish.js` supports web publishing to Douyin, Xiaohongshu, Kuaishou, WeChat Channels, Bilibili, etc.
- Dry-run by default: fills every field, stops before the publish button, and waits for your confirmation

### 9. Plugin market + MCP server
- Built-in `market.js` index (6,112 plugins, ~4.9 MB, 6-hour cache), fetched over HTTP with zero latency
- `mcp.js` exposes all RiffCut capabilities to the DSH kernel over stdio JSON-RPC 2.0
- UI and AI see the same tool table — no "it's in the UI but AI can't see it" gap

### 10. Background sub-agent desk, main chat never blocks
- Long tasks (search copy → write storyboard → render) run in separate kernel sessions in the background; the main chat replies instantly
- You can chime in mid-run and change requirements; background desks don't step on each other
- Honest about limits: the kernel SDK has no cancel API, so "stop" is a UI-level mitigation only

### 11. Observable startup, predictable experience
- Millisecond timing at each key startup node (`RiffCut_STARTUP_TRACE=1`)
- Single-instance lock prevents double-clicks from launching two processes fighting over one port
- Debug port only opens when `RiffCut_DEBUG_PORT` is explicitly set; normal users have no listening port

### 12. Packaging-friendly, native macOS feel
- `构建.app.sh` builds `RiffCut影创.app` in one step with ad-hoc signing (unsigned arm64 apps get `Killed: 9`)
- Auto-generates 10 sizes of icns
- `home/` is excluded from the installer; large weights (speech models) are inserted after signing, cutting first-launch validation from 12.1 s to 1.8 s

---

## 3. Project structure

```
RiffCut影创/
├── README.md                 # this file
├── LICENSE                   # AGPL-3.0 full text
├── NOTICE.md                 # third-party components and licenses
├── 构建.app.sh               # macOS .app build script
├── app/                      # Electron main + renderer code
│   ├── main.js               # main entry (window, IPC, kernel, private protocol)
│   ├── preload.js            # renderer bridge (window.riffcut API)
│   ├── package.json          # dependencies (electron ^45.3.4, hyperframes ^0.9.66)
│   ├── lib/                  # core libraries
│   │   ├── core.js           # clients, workspace, settings, history, costs
│   │   ├── paths.js          # single source of truth for all paths
│   │   ├── tools.js          # AI tool registry (99 tools, permission tiers)
│   │   ├── kernel.js         # DSH kernel client (stdio JSON-RPC)
│   │   ├── render.js         # render: timeline.json → composition HTML → MP4
│   │   ├── timeline.js       # multi-track editing project
│   │   ├── skills.js         # director skill management
│   │   ├── templates.js      # template library (categories + variables + grammar)
│   │   ├── tpltext.js        # on-canvas text recognition and replacement
│   │   ├── vidlook.js        # per-shot video reading (cut by real scene boundaries)
│   │   ├── publish.js        # multi-platform publishing (CDP)
│   │   ├── cdp.js            # minimal Chrome DevTools Protocol client
│   │   ├── mcp.js            # MCP server (stdio JSON-RPC 2.0)
│   │   ├── market.js         # plugin market index (6,112 plugins)
│   │   ├── audio.js          # audio: TTS / music / SFX / loudness
│   │   ├── subtitle.js       # ASS subtitles, highlight, entry animation
│   │   ├── delivery.js       # platform specs and master derivation
│   │   ├── ...               # others: image, brand, browser, convo, exec, vendor, ...
│   ├── renderer/             # renderer pages
│   └── ui/                   # DSH UI build (src/pages, build.py)
├── kernel/dsh/               # DSH kernel (bundled)
├── tools/                    # build and runtime tools
│   ├── ffmpeg / ffprobe      # binaries (see NOTICE.md §3 for redistribution limits)
│   └── audio.cpp/            # Ming local TTS engine
└── home/                     # dev-time data dir (excluded from package)
    ├── 客户/                 # client footage, projects, outputs
    ├── 模板库/               # template library
    ├── 配置/                 # settings, models, clients, tasks, history
    └── AGENTS.md             # AI director working guide
```

---

## 4. Quick start

### Requirements
- macOS (Apple Silicon arm64 recommended; Intel Mac also works)
- Node.js 26+ (development only; end users need not install Node)
- Python 3 (only for build-script icon generation, not needed at runtime)
- FFmpeg (rendering and frame extraction; see below)

### Development mode
```bash
cd app
npm install
npm start

# with a debug port (for external tools reading the DOM)
RiffCut_DEBUG_PORT=9355 npm run start:debug
```

### Install FFmpeg
The bundled `tools/ffmpeg` is a specific build **not meant for source redistribution** (see `NOTICE.md` §3). Install it yourself:
```bash
brew install ffmpeg
```
Or download an LGPL build from [evermeet.cx](https://evermeet.cx/ffmpeg/) and place it in `tools/`.

### Build the macOS app
```bash
# from the project root
./构建.app.sh
```
This produces `RiffCut影创.app`, ready to double-click.

### First use
1. Double-click `RiffCut影创.app` — **no setup needed; just start chatting** (a shared model quota is included)
2. Pick a workspace in settings (client footage and outputs go there)
3. Tell the AI director what you want in plain language, e.g. "make a 15-second vertical product promo"

### Model: works out of the box, or bring your own
A preset `auto (multimodal)` model routes through the author's own gateway — **no account required**. It exists so first-time users can talk to it immediately and try things out.

To use your own model (more quota, steadier speed, image input):
1. Open "Model Management"
2. Click "Add / Configure", pick "BailuCode" or "Agnes CN / Global" from the provider dropdown — endpoint and model ID fill in automatically
3. Register on the platform, get an API Key, paste it in, save
4. Click "Test" to verify, then select it in the model dropdown at the top of the home page

Keys are stored in the macOS Keychain (`service = riffcut.apikeys`), never in config files or backups. If the built-in quota is throttled or retired, just switch to your own key — no waiting for an update.

---

## 5. Core modules

### 5.1 AI director (kernel layer)
The DSH kernel talks to Electron over stdio JSON-RPC via `kernel.js`:
- **Task decomposition**: turns natural language into an executable tool-call sequence
- **Tool calling**: 99 tools via `tools.js` (assets, templates, timeline, rendering, publishing, ...)
- **Sub-agents**: `workers.js` runs long tasks in separate background sessions
- **Events**: `subagent.started` / `subagent.finished` drive UI progress

### 5.2 Chat UI: native DSH parity
Several details match native DSH behavior:
- **Reasoning**: the model's step-by-step thinking is collected into a collapsible block above the tool group and the answer — fixed order `me → reasoning → tools → answer`. The summary scrolls with content while running and auto-collapses when done. DSH controls this with `reasoningEffort`; this project declares `reasoningEfforts` tiers (`off/low/medium/high`) in the profile and defaults `high` in `initialize`.
- **Tool group**: each turn's tool calls are packed into one collapsible group showing a single semantic line by default; expand for per-step input/output.
- **Elapsed time**: ticks every second ("thinking… Xs"), then freezes at "done in Xs" using kernel `turn/start` / `turn/end` timestamps, not a front-end wall clock.
- **Byte streaming**: text and reasoning stream in character by character, via `agent/assistant-stream` chunks relayed over JSON-RPC.
- **Images**: images and text are two blocks in the **same message** (image above, text below); image-only messages leave no empty bubble. Single images are capped at 240 px, thumbnails at 96 px. Both sent images and unsent composer drafts open a lightbox (blurred backdrop; close via Esc / backdrop / close button; focus trapped and restored).
- **Tables**: Markdown tables follow DSH tokens (13px/22px, thin borders, bold non-wrapping header, zebra striping, `tabular-nums` for numeric columns), with horizontal scroll for long tables.

### 5.3 Editing project (`timeline.js`)
`timeline.json` holds canvas size, fps, duration (default 1920×1080, 30fps, 10s), four tracks, clip geometry (x/y center ratio, w/h canvas proportion, at in-clip progress, keys keyframe path) and animation presets.

### 5.4 Rendering (`render.js`)
`timeline.json` → composition HTML → MP4, using local hyperframes (not npx), explicit ffmpeg/ffprobe paths, and the kernel's bundled Node binary (avoids `process.execPath` pointing at Electron after packaging).

### 5.5 Subtitles (`subtitle.js`)
ASS output with per-line styles and inline tags; presets listed above; font size scales with the short edge; top/bottom anchors and backdrop masks.

### 5.6 Audio (`audio.js`)
Four levels (dialogue 0 / SFX −8 / music −21 / ambience −29 dB); −14 LUFS target, −1 dB true peak, 1.2 dB AAC headroom; macOS system voice and Ming local TTS (GGUF + Metal).

### 5.7 Publishing (`publish.js` + `cdp.js`)
CDP connects to the user's logged-in Chrome (separate profile, debug port); publishes to Douyin, Xiaohongshu, Kuaishou, WeChat Channels, Bilibili, etc.; dry-run by default.

### 5.8 Plugins and MCP (`market.js` + `mcp.js`)
6,112-plugin index with 6-hour HTTP cache; MCP server over stdio JSON-RPC 2.0 exposes RiffCut to the DSH kernel.

---

## 6. Tech stack

| Layer | Tech | Version | Notes |
|---|---|---|---|
| Desktop | Electron | ^45.3.4 | main + renderer |
| Rendering | hyperframes | ^0.9.66 | local video compositing |
| Kernel | DSH (DeepSeek Harness) | 0.2.1-rc.3 | AI director, stdio JSON-RPC |
| Language | Node.js | 26+ | all core libraries |
| Build | zsh + Python 3 | — | `构建.app.sh` |
| Multimedia | ffmpeg / ffprobe | 6.0 | processing, extraction, probing |
| Local TTS | Ming-3.0-tts-0.5B (GGUF) | — | Metal inference, zero Python deps |
| ASR | SenseVoice Small (ONNX) | — | local transcription |
| Browser automation | CDP (native WebSocket) | — | no puppeteer |
| Plugin protocol | MCP | 2024-11-05 | stdio JSON-RPC 2.0 |

---

## 7. License, privacy, compliance

### 7.1 Dual license
| Use | License | Cost |
|---|---|---|
| Study, personal use, modify, redistribute (with source) | **AGPL-3.0** | Free |
| Closed-source integration, de-branding, warranty / SLA | **Commercial** | Quote |

- Full terms in [LICENSE](LICENSE) and [the licensing note](home/资源/法律/01-开源许可与商业授权.md)
- **You own the outputs** — videos, images, copy, and voiceovers made with the software; AGPL does not restrict outputs, they may be used commercially
- Trademarks are outside the open-source grant: modified distributions must change the name and icon

### 7.2 Data and privacy
- No telemetry, no data collection, no cloud upload of footage
- All data lives in local `home/` or your chosen workspace
- Data is sent only to third-party services **you configured**, and only when you actively use online features (model chat, image/video generation, hot-topic search)
- Publishing to third-party platforms happens in your local browser; the software only assists with automation

### 7.3 What you must check yourself
- **Asset licensing**: music, fonts, images, portraits, trademarks — obtain proper rights ("free" often means personal use only)
- **AI output review**: generated copy, visuals, and voiceovers can be wrong; review before publishing
- **Platform rules**: comply with each platform and advertising regulations
- **Voice cloning**: only your own voice, or voices with explicit written consent

See the [Disclaimer](home/资源/法律/05-免责声明.md).

### 7.4 Third-party components
Full list, versions, licenses, and **redistribution limits** in [NOTICE.md](NOTICE.md).

**Note**: the current `tools/ffmpeg` build has `--enable-nonfree` and **must not be redistributed with source**; see NOTICE.md §3.

---

## 8. Contributing

Issues and PRs are welcome.

Before submitting:
1. Read `home/AGENTS.md` for the AI director's working rules
2. Read `home/配置/RULES.md` for knowledge-base conventions
3. Match the style of existing lib modules (Chinese comments and variable names are acceptable)
4. Don't change packaging or path conventions without discussion

When submitting:
- **Code contributions are licensed under AGPL-3.0** to this project and all downstream users
- You warrant the content is original or properly licensed
- One PR per change, with "what / why / how verified"

Not accepted:
- Changes that remove or weaken license / copyright notices
- License-incompatible third-party code (check [NOTICE.md](NOTICE.md))
- Changes that break packaging (unless `构建.app.sh` and this doc are updated too)

---

## 9. Version history

- **v0.1.0** (2026-11): first public release. Electron + DSH kernel, 41 director skills, 210 template blocks, multi-platform publishing, local rendering, dual-license open source.

From the v0.1.0 development cycle (most recent first):

| Category | Change |
|---|---|
| Installer | Speech weights no longer bundled; installer 2.1 GB → 427 MB; downloaded from domestic mirrors on first launch (ModelScope → hf-mirror → Hugging Face fallback) |
| Chat UI | Collapsible reasoning block, tool group folding, live elapsed time frozen from real turn timestamps, byte streaming, multimodal images (image/text split, no empty bubble for image-only, shared lightbox for drafts and sent images), DSH-token Markdown tables |
| AI | Native tools grown 0 → 52 (file I/O, shell, search, persistent terminal, sub-agents, team collaboration, scheduled tasks, skills, demos, ask-user), 99 tools total; "full access" permission reads the whole machine |
| Search | Native search falls back to the built-in stack when `DEEPSEEK_API_KEY` is missing (Bing primary + DDG backup) |
| Templates | Editable-text coverage 86% (384/448); `design_with_template` extracts composition grammar so the AI lays out the whole film instead of repeating a template; stretching syncs `data-duration` |
| Text | 46 text styles extracted to a single source shared by UI, AI tools, and export |
| Assets | Per-shot video reading (cut by real scene boundaries), distinct from folder frame-grabbing and output quality checks |
| Colors | UI unified to pure white + tool blue `#2563EB` with three border tiers |
| Stability | Deleting a client no longer throws ENOENT; dropping files into chat no longer rejected as "set workspace"; Enter during Chinese IME selection no longer sends a message; image archives no longer lost |

**v0.1.1** (2026-11): Ming voice gender bug fixed (male voices came out female), full re-record workflow with preview/re-record/save, play-button loading states, and all 448 templates made fully offline (zero external CDN dependencies).

---

## 10. Contact

| Purpose | Contact |
|---|---|
| Website | [https://riffcut.cn](https://riffcut.cn) |
| Questions / suggestions | In-app "Feedback" button, or email |
| Bug reports | GitHub Issue (include repro steps, OS version, logs) |
| Commercial licensing | Email with subject "Commercial License Inquiry" |
| Security vulnerabilities | Email directly, do not file a public issue |
| Infringement complaints | Email with proof of rights and location of infringement |

**Email: China@cyanweb.cn**

---

## 11. Acknowledgements

Built on the shoulders of:

- [Electron](https://github.com/electron/electron) — cross-platform desktop shell
- [HyperFrames](https://github.com/heygen-com/hyperframes) — HTML-to-video engine
- [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) — AI agent kernel
- [FFmpeg](https://ffmpeg.org/) — multimedia foundation
- [Ming-3.0-tts](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B) — Chinese speech synthesis
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — multilingual ASR (Alibaba Tongyi Lab)

---

> **RiffCut** — make editing feel like directing, and every cut feel like a work of art.

</details>

## 一、这是什么

**RiffCut 影创** 是一款面向短视频创作者、自媒体从业者和内容团队的**本地剪辑智能体软件**。

> **🌐 官网：[https://riffcut.cn](https://riffcut.cn)** —— 产品介绍、使用教程与最新版下载都在这里。

它不是在线剪辑网站，也不需要把素材上传到云端——所有的剪辑、渲染、发布都在你自己的 Mac 上完成。

> **⬇ [下载 macOS 安装包](DOWNLOAD.md)** —— 427 MB，装完 1.2 GB。语音模型首次启动时按需下载（约 1.9 GB，可选）

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
- **能力与 DSH 原生对齐**：会话里能用到内核原生工具（读写文件、执行命令、搜索、持久终端、子智能体、团队协作、定时任务等），不只是一层包起来的视频工具。权限档位可切「完全访问」，此时 AI 能读整台电脑上的文件，和直接用 DSH 一样
- **联网搜索**：宿主机没配 `DEEPSEEK_API_KEY` 时，内核原生搜索会自动让位给软件自带的搜索栈（Bing 源，DuckDuckGo 兜底），不会出现「模型说没 API Key、然后不搜了」

### 3. 现成模板库，零素材也能出片
- 内置模板库 `home/模板库/registry/`，共 **210 个 block 目录**、注册表收录 **456 个条目**（含示例）
- 分类包括：字幕、下三分之一、转场、片头片尾、图表数据、产品展示、社媒包装、文字动画、背景纹理、动效零件
- 支持按分类和关键词筛选，绝大多数模板不依赖实拍素材，文字 + 模板即可成片
- **模板可改字**：448 个模板里 384 个（86%）能直接改文字 —— 247 个靠模板自身声明 `data-composition-variables`，另外 137 个没声明的由 `tpltext.js` 扫出画面文字补上。剪辑台里**点画面上的字直接改**，不用去右侧面板找输入框
- **模板是设计参考，不是素材**：AI 不会把模板复制 N 遍铺满时间线（那样观众只看到同一版式重复、内容没增加），而是先用 `design_with_template` 拆出模板的编排语法（几拍、每拍几秒、同拍错开多少、进场/强调各用什么缓动、动感来自哪些属性），再按这个语法给整条片子自己排内容
- 拉长模板时自动把 `data-duration` 同步到副本，动画真铺满时长，不是前 5 秒动完就定格

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
│   │   ├── tools.js          # AI 工具注册表（99 个工具，权限分级）
│   │   ├── kernel.js         # DSH 内核客户端（stdio JSON-RPC）
│   │   ├── render.js         # 渲染：timeline.json → composition HTML → MP4
│   │   ├── timeline.js       # 多轨剪辑工程（timeline.json → HyperFrames HTML）
│   │   ├── skills.js         # 导演技能管理（YAML front matter）
│   │   ├── templates.js      # 模板库（分类 + 变量表 + 编排语法）
│   │   ├── tpltext.js        # 模板正文文字识别与替换（没声明变量的模板也能改字）
│   │   ├── vidlook.js        # 逐镜头读视频（按真实镜头边界切段取帧）
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
│   │       ├── textstyles.js # 46 款文字样式唯一真源（界面/AI/导出共用）
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
- **工具调用**：通过 `tools.js` 注册表调用 99 个工具，覆盖素材、模板、时间线、渲染、发布等
- **子智能体**：通过 `workers.js` 在后台单独开会话跑长耗时任务，主对话不阻塞
- **事件通知**：`subagent.started` / `subagent.finished` 通知用于界面进度显示

### 5.2 对话界面：与 DSH 原生一致的呈现

界面上的对话区不是简单的一张气泡列表，几处细节按 DSH（DeepSeek Harness）原生行为对齐：

- **思考过程**（`reasoning`）：模型这一步在判断什么，单独收成可折叠的「思考」块，排在过程组上方、回答上方，顺序固定为 `我 → 思考 → 过程组 → 回答`。运行中摘要随内容滚动、标题带微光，完成后自动收起。DSH 通过 `reasoningEffort` 控制模型是否产出思考，本项目在 profile 里同时声明 `reasoningEfforts` 档位（`off/low/medium/high`）并在 `initialize` 请求里默认带 `high`。
- **过程组**：一轮里的所有工具调用打包成一个可折叠组，默认只显示一行语义汇总（如「已读取文件并已执行命令」），点开才看每步明细（输入 / 输出两栏），完成自动收起。
- **用时**：运行中每秒跳动「深度求索中，用时 X秒 ···」，完成后定格为「已完成，用时 X」。数据源是内核 `turn/start` 与 `turn/end` 事件自带的时间戳差值，不是前端自己掐的墙钟时间。
- **逐字节流**：文字和思考逐字冒出来，不是等一整段生成完再一次吐出。实现上由内核 `agent/assistant-stream` 的 chunk 经 JSON-RPC 服务端合成事件转发到界面。
- **图片消息**：图片与文字是**同一条消息里的上下两块**（图片在上、文字在下），纯图片时不留空文字气泡，单图长边 240px、多图 96×96 缩略。已发送的图片和输入框里还没发的草稿图**都能点击看大图**（灯箱：模糊遮罩、Esc / 点遮罩 / 点关闭键三种关闭方式、焦点锁定与还原）。
- **表格**：AI 回答里的 Markdown 表格按 DSH 的令牌排版（13px / 22px、细边框、表头浅底加粗不换行、斑马纹、纯数字列 `tabular-nums` 不换行），长表横向滚动。

### 5.3 剪辑工程（timeline.js）

工程格式为 `timeline.json`，包含：

- 画布尺寸、帧率、时长（默认 1920×1080，30fps，10秒）
- 四条轨道：视频 (v1)、图形 (g1)、字幕 (t1)、音频 (a1)
- 片段几何：x/y（中心比例 0~1）、w/h（占画布比例）、at（片段内进度 0~1）、keys（关键帧路径点）
- 动画预设：fade、slideUp/Down/Left/Right、zoomIn/Out、kenburns

### 5.4 渲染（render.js）

渲染流程：`timeline.json` → composition HTML → MP4。

- 使用本地 `hyperframes` 渲染引擎，不走 npx
- ffmpeg/ffprobe 路径显式指定，子进程环境变量透传
- 渲染子进程使用内核自带的 Node 二进制（避免打包后 `process.execPath` 变成 Electron 可执行文件）

### 5.5 字幕（subtitle.js）

- 生成 ASS 格式字幕，支持逐条样式和内联覆盖标签
- 字幕预设：标准、大字、弹字、竖屏、标题、卡片、竖屏卡片、卡拉OK、竖屏卡拉OK、钩子字、编辑字
- 字号按画面短边比例缩放，支持贴顶/贴底锚点、黑底遮罩

### 5.6 音频（audio.js）

- 四层电平：对白 0 dB / 音效 −8 dB / 配乐 −21 dB / 环境底噪 −29 dB
- 响度目标：−14 LUFS，真峰值 −1 dB，AAC 编码回升余量 1.2 dB
- 支持 macOS 系统语音和 Ming 本地 TTS（GGUF + Metal 推理）

### 5.7 多平台发布（publish.js + cdp.js）

- CDP 客户端连接用户已登录的 Chrome（独立 profile，调试端口）
- 支持抖音、小红书、快手、视频号、B站等平台网页端发布
- 默认 dry-run：填完字段、停在发布按钮前，用户确认后才真发

### 5.8 插件与 MCP（market.js + mcp.js）

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

**v0.1.0 开发期内的重要改动**（按时间倒序）：

| 类别 | 改动 |
|---|---|
| 安装包 | 不再随包带语音权重，安装包 2.1 GB → 427 MB；首次启动询问后从国内镜像后台下载（魔搭 → hf-mirror → huggingface 三级降级） |
| 对话界面 | 思考过程独立可折叠块、过程组折叠、用时实时跳动且以真实 turn 时间戳定格、逐字流式输出、图片多模态（图片与文字分块、纯图不留空气泡、草稿与已发共用灯箱）、Markdown 表格按 DSH 令牌排版 |
| AI 能力 | 原生工具从 0 补到 52 个（读写文件、执行命令、搜索、持久终端、子智能体、团队协作、定时任务、技能、演示、提问），工具总数 99；权限可切「完全访问」读整台电脑 |
| 搜索 | 宿主机缺 `DEEPSEEK_API_KEY` 时，原生搜索自动让位给自带搜索栈（Bing 主源 + DDG 兜底） |
| 模板 | 模板可改字覆盖率 86%（448 个里 384 个）；`design_with_template` 拆编排语法让 AI 按模板思路排整条片，不再复制模板铺满时间线；拉长模板时同步 `data-duration` 让动画真铺满 |
| 文字 | 46 款文字样式抽成唯一真源，界面、AI 工具、导出三端共用 |
| 素材 | 新增逐镜头读视频（按真实镜头边界切段取帧），与「整夹抽帧」「成片抽帧体检」区分 |
| 配色 | 界面统一为纯白 + 工具蓝 `#2563EB`，三档描边（区域 / 控件 / 分隔） |
| 稳定性 | 删客户不再报 ENOENT；对话里拖文件不再被当成「设工作区」拒绝；中文输入法选词按 Enter 不再误发；图片存档不再丢失 |

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

