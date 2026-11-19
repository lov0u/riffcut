# 下载 RiffCut 影创

**当前版本：v0.1.0** · macOS 12+ · Apple Silicon

[→ 前往 Release 页面下载](https://github.com/lov0u/riffcut/releases/latest)

---

## 选哪个

| 版本 | 下载体积 | 装完占用 | 语音模型 | 适合谁 |
|---|---|---|---|---|
| **完整版** | 2.1 GB（2 个分卷） | 3.0 GB | ✅ 内置 Ming-TTS + SenseVoice | 大多数人不折腾，装完就能用 |
| **轻量版** | 427 MB | 1.2 GB | ❌ 需自己下（约 1.9 GB） | 磁盘紧张 / 只用剪辑不用配音 |

**语音模型是什么**：Ming-TTS 负责「把文字念出来」（配音），SenseVoice 负责「把说的话写成字」（字幕）。两个都不装，软件照样能剪辑、能渲染、能发布，只是没有本地配音和自动字幕。

---

## 完整版安装

两个分卷都要下，缺一个解不开。

### 直接点（不熟悉命令行）

1. 下载 `RiffCut-full.zip.part-aa` 和 `RiffCut-full.zip.part-ab`
2. 两个文件放**同一个文件夹**
3. 打开「终端」，输入 `cd ` （注意后面有个空格），把那个文件夹拖进终端窗口，回车
4. 粘贴下面这行，回车：

```bash
cat RiffCut-full.zip.part-aa RiffCut-full.zip.part-ab > RiffCut-full.zip
```

5. 双击 `RiffCut-full.zip` 解压，把 `RiffCut影创.app` 拖进「应用程序」
6. 首次打开：在「应用程序」里**右键点图标 → 打开 → 再点「打开」**（未签名，直接双击会被系统拦）

### 命令行一把梭

```bash
cd ~/Downloads
cat RiffCut-full.zip.part-aa RiffCut-full.zip.part-ab > RiffCut-full.zip
shasum -a 256 RiffCut-full.zip
# 应输出 c2c8cbc5fdd4a77f18a76fd1d3abee85195d45a4e19d29061c7b9b5a03111a37
unzip RiffCut-full.zip
mv RiffCut影创.app /Applications/
xattr -cr /Applications/RiffCut影创.app
open /Applications/RiffCut影创.app
```

---

## 轻量版安装

```bash
cd ~/Downloads
unzip RiffCut-lite-0.1.0.zip
mv RiffCut影创.app /Applications/
xattr -cr /Applications/RiffCut影创.app
```

装完想补语音模型，见下方「补装语音模型」。

---

## 文件校验

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `RiffCut-lite-0.1.0.zip` | 448105135 B | `f6d081f031cd94686c2a087b6e3ed4d7c2f158afdf494f3244d386ff7ce66bb0` |
| `RiffCut-full.zip.part-aa` | 1572864000 B | `f0ab1bd866c81130c5530fbc942cf8ea7928ff1325716d8fa79a0c90b50b0933` |
| `RiffCut-full.zip.part-ab` | 654862708 B | `69f06fd10457f0cb9633acd18da888793d4d692513eb2dad3d361579f8745d19` |
| 合并后的 `RiffCut-full.zip` | 2227726708 B | `c2c8cbc5fdd4a77f18a76fd1d3abee85195d45a4e19d29061c7b9b5a03111a37` |

校验方法：

```bash
shasum -a 256 文件名
```

---

## 首次使用：配一个模型

软件**不带任何密钥**（原因见 [NOTICE.md](NOTICE.md) 第 2 节）。打开软件后：

1. 左侧点「模型管理」→ 右上角「添加 / 配置」
2. 供应商下拉里选一家带绿色「免费额度」标的：

   | 供应商 | 免费额度 | 特点 |
   |---|---|---|
   | 白鹿 BailuCode | 每天领 500 万 Tokens | 中文排版最强，出图抠图都能用 |
   | Agnes 国内 | 免费档，10 rpm | 能读图，响应快 |
   | Agnes 国际 | 免费档，20 rpm | 批量跑文本吞吐翻倍 |

3. 接口地址和模型 ID 会自动填好，点「去注册，拿 API Key」注册，复制 key
4. 粘进「API Key」框 → 保存 → 点「测试连接」确认通了

---

## 补装语音模型（轻量版需要）

```bash
pip install -U "huggingface_hub[cli]"

# 配音：Ming-TTS（1.6 GB，MIT 许可）
hf download inclusionAI/Ming-3.0-tts-0.5B \
  ming-3.0-tts-0.5b-q8_0.gguf \
  --local-dir "$HOME/Library/Application Support/RiffCut影创/系统/本地模型/语音/weights/ming-tts/"

# 字幕：SenseVoice Small（228 MB，FunASR Model License 1.1）
hf download FunAudioLLM/SenseVoiceSmall \
  model.int8.onnx tokens.txt \
  --local-dir "$HOME/Library/Application Support/RiffCut影创/系统/本地模型/语音/weights/sense-voice/"
```

下完重启软件即可。只想要配音就只下第一个，只想要字幕就只下第二个。

---

## 常见问题

**打开时提示「无法验证开发者」/「已损坏」**

未做 Apple 公证（公证要 99 美元/年开发者账号）。绕过方法：

```bash
xattr -cr /Applications/RiffCut影创.app
```

然后右键 → 打开。只需做一次。

**双击图标没反应 / 一闪就退**

先确认是不是 Apple Silicon（M 系列）。Intel Mac 未测试，可能起不来。查看方式：左上角苹果菜单 →「关于本机」→ 看「芯片」那行。

**提示缺 ffmpeg**

完整版和轻量版都自带 ffmpeg，正常不会缺。如果出现，装一个系统的：

```bash
brew install ffmpeg
```

**配音没声音**

轻量版没装 Ming-TTS 权重。按上面「补装语音模型」下载，或改装完整版。

**能不能自动更新**

v0.1.0 还没有。新版本要手动重新下载。

---

## 系统要求

| 项 | 要求 |
|---|---|
| macOS | 12 Monterey 及以上 |
| 芯片 | Apple Silicon（M1/M2/M3/M4）。Intel 未测试 |
| 磁盘 | 完整版 3.0 GB，轻量版 1.2 GB |
| 内存 | 8 GB 起，16 GB 更顺 |
| 额外依赖 | 无。Node / Python / FFmpeg 全部打包在内 |

---

## 从源码构建

```bash
git clone https://github.com/lov0u/riffcut.git
cd riffcut

# 内核（600MB，不在仓库里）
./tools/fetch-kernel.sh

# 打包（完整版）
./构建.app.sh

# 打包（轻量版，不含语音权重）
NO_MODELS=1 ./构建.app.sh
```

详见 [README.md](README.md) 第四章。
