# 第三方组件与许可证清单（NOTICE）

RiffCut 影创 1.0.0

本文件列出本软件包含的第三方组件、版本、许可证，以及**分发时必须注意的限制**。

**最后更新：2026-11-20**

---

## 1. 主运行时

| 组件 | 版本 | 许可证 | 上游 | 备注 |
|---|---|---|---|---|
| Electron | 45.3.4 | MIT | https://github.com/electron/electron | 应用外壳 |
| HyperFrames | 0.9.66 | **Apache-2.0** | https://github.com/heygen-com/hyperframes （`packages/cli`） | 视频渲染引擎；随包**未附** LICENSE 文件，分发时须自行补齐 Apache-2.0 全文 |
| DSH 内核（`@deepseek-ai/dsh` 及约 300 个子包） | 0.2.1-rc.3 | **MIT** | — | 全部 MIT，无例外（见第 2 节） |

---

## 2. DSH 内核中的非 MIT 例外

DSH 内核绝大多数包为 MIT，以下三个例外：

| 包 | 版本 | 许可证 |
|---|---|---|
| `@deepseek-ai/libreoffice-kit` | 0.1.5 | **MPL-2.0** |
| `@deepseek-ai/node-addon-system` | 0.1.2 | **BSD-3-Clause** |
| `@deepseek-ai/node-addon-system-darwin-arm64` | 0.1.2 | **BSD-3-Clause** |

- **MPL-2.0** 是**文件级** copyleft：修改了 `libreoffice-kit` 的源文件，须公开这些**被修改的文件**，但不必公开整个软件。仅使用（不修改）时无额外义务。
- **BSD-3-Clause** 要求：保留版权声明、免责声明、不得用作者名义背书。分发时须随附许可证全文。

---

## 3. ⚠️ 分发限制组件（重要）

### 3.1 FFmpeg

**当前构建版本：6.0（Apple clang 13.1.6，arm64）**

编译配置（节选，来自 `ffmpeg -version`）：

```
--enable-gpl
--enable-nonfree
--enable-libx264
--enable-libx265
--enable-libmp3lame
--enable-libass
--enable-libvpx
--enable-libfdk-aac (如含)
```

**⚠️ 该二进制不可随本软件源码一起对外分发。**

原因：

| 开关 | 后果 |
|---|---|
| `--enable-gpl` | 整个 FFmpeg 二进制变为 **GPL-2.0-or-later** 覆盖 |
| `--enable-nonfree` | 引入**不可再分发**的组件（如 `libfdk-aac`），使整个二进制**无法以任何许可证合法分发** |
| `--enable-libx264` / `libx265` | GPL 组件，触发传染性 |

**三种处理方案（按推荐度排序）：**

**方案 A（推荐）：分发时不含 FFmpeg，首次启动引导用户自装**
- 打包时排除 `tools/ffmpeg`
- 启动检测：找不到 ffmpeg → 提示「请先安装 FFmpeg：`brew install ffmpeg`」
- 优点：零法律风险；缺点：用户多一步操作

**方案 B：换用 LGPL 构建的 FFmpeg**
- 使用 `--disable-gpl --disable-nonfree` 的构建（如 `evermeet.cx` 的 LGPL 版，或自行编译）
- 代价：失去 libx264/libx265（H.264/H.265 编码），需改用 `libopenh264` 或系统 VideoToolbox
- 优点：可合法分发；缺点：编码能力下降

**方案 C：把 FFmpeg 作为「独立程序」由用户自行下载**
- 软件不内置二进制，运行时按需下载到用户数据目录
- 需注意：仍属于「分发」行为，只是分发者变成用户
- 实践中风险较低，但**不是零风险**

**当前状态：方案 A 未实施，二进制仍在 `tools/ffmpeg`。**

---

### 3.2 模型权重（已核实，2026-11-20）

| 权重 | 大小 | 上游 | 许可证 | 可分发 | 义务 |
|---|---|---|---|---|---|
| `ming-tts`<br>`ming-3.0-tts-0.5b-q8_0.gguf` | 1742280896 B<br>(1662 MB) | `inclusionAI/Ming-3.0-tts-0.5B`<br>(HuggingFace) | **MIT** | ✅ 可以 | 保留版权声明与 MIT 许可文本 |
| `sense-voice`<br>`model.int8.onnx`<br>`tokens.txt` | 239233841 B<br>(229 MB) | `FunAudioLLM/SenseVoiceSmall`<br>(HuggingFace) | **FunASR Model License 1.1** | ✅ 可以 | **必须标注来源与作者信息**，保留模型名称 |

**SenseVoice 的许可证义务（第 2.2 条原文）：**

> When using, copying, modifying, and sharing [FunASR Software], you must attribute the source and author information and retain relevant model names in [FunASR Software].

**落地要求**：在「关于」页面或 `NOTICE.md` 显著位置写明：

```
语音识别：SenseVoice Small
来源：阿里巴巴通义实验室 FunAudioLLM
https://github.com/FunAudioLLM/SenseVoice
许可证：FunASR Model License 1.1
```

许可证全文：`https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE`

**注意**：FunASR Model License 1.1 第 3 条明确「仅供参考与学习用途，阿里巴巴集团不承担任何直接或间接损失的责任」——这与本软件《免责声明》口径一致，但**它不限制商用**（未出现 non-commercial 字样），可随软件分发。

两个权重均可合法分发，无需排除。

### 3.3 仓库里没有、需要自己拉的东西

仓库刻意不含下面三类大文件（合计约 2.5GB），源码 clone 下来只有约 130MB。缺什么就补什么：

| 缺什么 | 体积 | 怎么补 | 不补的后果 |
|---|---|---|---|
| `kernel/dsh/`（DSH 内核 + Node 运行时） | ~600MB | `./tools/fetch-kernel.sh` | 软件起不来，AI 导演功能全废 |
| `home/系统/本地模型/语音/weights/`（两个语音权重） | ~1.9GB | 见下方 | 本地配音/识别不可用，其余功能正常 |
| `tools/ffmpeg`、`tools/ffprobe` | ~80MB | `brew install ffmpeg` | 渲染与抽帧不可用 |

**内核为什么要自己拉**：`@deepseek-ai/dsh` 是 npm 上的公开包（当前 0.2.2-rc.5，本项目用 0.2.1-rc.3），依赖树 306 个包。放进 git 会让仓库膨胀到 700MB+，而它完全可从公开源重建。`tools/fetch-kernel.sh` 做的事就是 `npm install @deepseek-ai/dsh@<版本>` + 下载一个 arm64 Node 运行时到 `kernel/dsh/node`（内核不能用系统 node —— 分发到没装 Node 的机器上会起不来）。

**语音权重怎么拉**：

```bash
# Ming-TTS（MIT）
pip install -U "huggingface_hub[cli]"
hf download inclusionAI/Ming-3.0-tts-0.5B \
  ming-3.0-tts-0.5b-q8_0.gguf \
  --local-dir home/系统/本地模型/语音/weights/ming-tts/

# SenseVoice Small（FunASR Model License 1.1）
hf download FunAudioLLM/SenseVoiceSmall \
  model.int8.onnx tokens.txt \
  --local-dir home/系统/本地模型/语音/weights/sense-voice/
```

也可以只放你需要的那个：只配字幕不配音，就只拉 SenseVoice；只配音不做识别，就只拉 Ming-TTS。

---

## 4. 模板库素材

`模板库/registry/` 下共 **210 个 block 目录** + 若干 component，来源分三类：

### 4.1 上游开源项目（Apache-2.0）

多数 block 来自 HyperFrames 生态（`https://hyperframes.heygen.com`，Apache-2.0）。这些目录通常随附：

- `THIRD-PARTY-LICENSES.txt`（着色器、库依赖）
- 字体 `OFL.txt` / `LICENSE.txt`

**分发时须保留这些文件。**

### 4.2 字体（SIL Open Font License 1.1）

已确认的字体许可文件示例：

```
blocks/glass-shard-title/assets/fonts/CormorantGaramond-OFL.txt
blocks/glass-shard-title/assets/fonts/Geist-OFL.txt
blocks/extruded-logo/assets/fonts/Geist-OFL.txt
blocks/weight-wave/assets/fonts/OFL.txt
blocks/chatgpt-exchange/assets/fonts/inter-LICENSE.txt
blocks/code-slice-hero/assets/Geist-OFL.txt
```

**OFL 要求**：保留版权声明与许可文本；不得单独售卖字体；修改字体须改名。

### 4.3 权利主体原创

其余 block 为原创，适用 AGPL-3.0（与主软件一致）。

---

## 5. 系统组件

| 组件 | 许可证 | 说明 |
|---|---|---|
| macOS 系统库 | Apple 专有 | 随系统提供，不随本软件分发 |
| Python 3（如内置） | PSF License | 若打包 Python 解释器，须随附 PSF 许可文本 |
| Node.js（如内置） | MIT | 同上 |

---

## 6. 分发检查清单

对外分发本软件（含修改版）前，逐项确认：

- [ ] 已随附 `LICENSE`（AGPL-3.0 全文，661 行）
- [ ] 已随附本 `NOTICE.md`
- [ ] 已保留所有第三方版权声明与许可文本
- [ ] **已处理 FFmpeg**（排除 / 换 LGPL 版 / 改为用户自装）
- [ ] 已保留 SenseVoice 的来源与模型名称标注
- [ ] 已随附 Ming-3.0-tts 的 MIT 许可文本
- [ ] 已确认模板库中每个 block 的许可文件随包保留
- [ ] 若修改了 `libreoffice-kit` 源文件，已公开修改部分
- [ ] 已更换名称与图标（若为修改版），未使用官方商标
- [ ] 已在关于页面注明「基于 RiffCut 影创开发」
- [ ] 已提供对应源代码（AGPL-3.0 第 6 条）

---

## 7. 许可证全文位置

| 许可证 | 获取方式 |
|---|---|
| AGPL-3.0 | 仓库根目录 `LICENSE`，或 https://www.gnu.org/licenses/agpl-3.0.txt |
| Apache-2.0 | https://www.apache.org/licenses/LICENSE-2.0.txt |
| MIT | https://opensource.org/licenses/MIT |
| MPL-2.0 | https://www.mozilla.org/en-US/MPL/2.0/ |
| BSD-3-Clause | https://opensource.org/licenses/BSD-3-Clause |
| OFL-1.1 | https://openfontlicense.org/ |

---

*本清单基于 2026-11-20 的实际依赖扫描生成。依赖升级后请重新核对。*
