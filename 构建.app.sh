#!/bin/zsh
# 把「影创新版」打成一个能双击的 macOS 应用（RiffCut影创.app）。
#
# 三个必须遵守的约束（每条都踩过）：
#
# ① 必须 ad-hoc 签名。
#    arm64 上完全没签名的可执行文件会被系统直接 Killed: 9，
#    双击没反应、命令行跑也看不出原因。所以最后一步是 codesign --sign -，
#    不是 --remove-signature。
#
# ② home/ 不进包。
#    里面是客户素材、工程、成片 —— 用户数据不能塞进安装包（改了还破签名）。
#    打包后自动落到 ~/Library/Application Support/RiffCut影创。
#
# ③ 图标必须先补成正方形。
#    vmark.png 是 400x296，直接喂 iconutil 会报 Failed to generate ICNS。
#    先 scale+pad 成 1024x1024，再出十档。
set -e
cd "$(dirname "$0")"
ROOT="$PWD"
APP="$ROOT/RiffCut影创.app"

echo "── 0/8 生成图标"
# 2026-11-20 换品牌：图标源从「400x296 非正方形金属 V 标」换成
#   「1024x1024 深底 3D R 标」（app/Resources/Icons/icon@2x.png）。
# 因为新图标本身已是满幅正方形深色构图，旧那套「补浅灰渐变底 + 图形占宽 72%
# + alpha 加权重心对齐」全部作废 —— 那是给非正方形透明标补画布用的，
# 套到满幅深底图上会把整张图标缩到 72% 并垫一圈灰边，看着像没贴满。
# 现在只做一件事：等比缩到十档。源图非 1024 时才先升/降采样一次。
python3 - "$ROOT/app/Resources/Icons/icon@2x.png" /tmp/riffcut.iconset <<'PYICON'
import sys, os
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
im = Image.open(src).convert("RGB")
if im.size != (1024, 1024):
    im = im.resize((1024, 1024), Image.LANCZOS)
for name, sz in {"icon_16x16.png":16,"icon_16x16@2x.png":32,"icon_32x32.png":32,
  "icon_32x32@2x.png":64,"icon_128x128.png":128,"icon_128x128@2x.png":256,
  "icon_256x256.png":256,"icon_256x256@2x.png":512,"icon_512x512.png":512,
  "icon_512x512@2x.png":1024}.items():
    im.resize((sz, sz), Image.LANCZOS).save(out + "/" + name)
PYICON
iconutil -c icns /tmp/riffcut.iconset -o /tmp/riffcut.icns
# 同步回两份源，避免下次构建又读到旧 icns
cp /tmp/riffcut.icns "$ROOT/app/ui/assets/app.icns"
cp /tmp/riffcut.icns "$ROOT/app/Resources/riffcut.icns"

echo "── 1/8 清理旧产物"
rm -rf "$APP" "$ROOT/.build"
mkdir -p "$ROOT/.build"

echo "── 2/8 复制 Electron 框架"
cp -R "$ROOT/app/node_modules/electron/dist/Electron.app" "$APP"
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/riffcut"

echo "── 3/8 复制应用代码"
rsync -a --no-links --exclude 'node_modules' --exclude '*.log' --exclude '.git' \
  "$ROOT/app/" "$APP/Contents/Resources/app/"

echo "── 4/8 复制依赖 / 内核 / 工具 / 插件"
mkdir -p "$APP/Contents/Resources/app/node_modules"
# ★ 只拷 hyperframes 自己的目录是不够的：它依赖的 72 个包（acorn / esbuild /
#   puppeteer-core …）都在上层 node_modules 里。漏掉之后包内跑 hyperframes --version
#   会报 Cannot find package 'acorn'，而 ready() 正是靠它判断环境就绪 ——
#   界面表现是设置页「FFmpeg 一直读取中」。按依赖闭包精确复制。
node "$ROOT/tools/hf-deps.js" "$ROOT/app/node_modules" "$APP/Contents/Resources/app/node_modules"
rsync -a --no-links "$ROOT/kernel/" "$APP/Contents/Resources/kernel/" 2>/dev/null || true
rsync -a --no-links "$ROOT/tools/" "$APP/Contents/Resources/tools/" 2>/dev/null || true

# ★ FFmpeg 分发提醒（见 NOTICE.md 第 3 节）
#   仓库里这份 ffmpeg 是带 --enable-gpl --enable-nonfree 的构建，
#   按 FFmpeg 自己的说法「nonfree 组合无法再分发」。自己用、给同事装没问题，
#   但对外公开发布（上架、放下载站、随源码分发）就有风险。
#   NO_FFMPEG=1 打出的包不含 ffmpeg，运行时自动回落到系统装的（brew install ffmpeg）。
#
# ★ NO_MODELS=1 打出「轻量版」：不含两个语音权重（约 1.9GB），包体从 3.0G 降到 1.1G。
#   用户装完自己下权重（README 有命令）。默认不打这个 —— 完整版装完就能用，
#   新手不会卡在「配音没声音，去翻文档」这一步。
#   两个版本共用同一份 Info.plist 与签名，只是权重有无的差别。
if [ "${NO_FFMPEG:-0}" = "1" ]; then
  rm -f "$APP/Contents/Resources/tools/ffmpeg" "$APP/Contents/Resources/tools/ffprobe"
  echo "  ⚠ 按 NO_FFMPEG=1 跳过 FFmpeg，用户需自行 brew install ffmpeg"
elif [ -f "$ROOT/tools/ffmpeg" ]; then
  if "$ROOT/tools/ffmpeg" -version 2>/dev/null | grep -q 'enable-nonfree'; then
    echo "  ⚠ 包内 FFmpeg 带 --enable-nonfree，仅限自用；对外发布请用 NO_FFMPEG=1 重新打包"
  fi
fi
rsync -a --no-links "$ROOT/plugins/" "$APP/Contents/Resources/plugins/" 2>/dev/null || true

# audio.cpp：Ming-3.0 本地配音引擎（38MB 预编译二进制 + spec）。
# ★ 为什么装它：Ming 官方只有 PyTorch / MLX 两种跑法，两个都要 Python。
#   客户装完软件不该再装 Python 和 mlx，所以换成 GGUF + 预编译 CLI，
#   推理全在 Metal 上，零运行时依赖。权重在 seed-home 里，走软链不占双份磁盘。
if [ -d "$ROOT/tools/audio.cpp" ]; then
  rsync -a --no-links "$ROOT/tools/audio.cpp/" "$APP/Contents/Resources/tools/audio.cpp/" 2>/dev/null || true
  chmod +x "$APP/Contents/Resources/tools/audio.cpp/audiocpp_cli" 2>/dev/null || true
  echo "  audio.cpp 已打进包（$(du -sh "$APP/Contents/Resources/tools/audio.cpp" | cut -f1)）"
fi

echo "── 5/8 图标 + Info.plist"
cp /tmp/riffcut.icns "$APP/Contents/Resources/app.icns"
PLIST="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
pb CFBundleName "RiffCut影创"
pb CFBundleDisplayName "RiffCut影创"
pb CFBundleIdentifier "cn.riffcut.studio"
pb CFBundleExecutable "riffcut"
pb CFBundleIconFile "app.icns"
pb CFBundleShortVersionString "0.1.0"
pb CFBundleVersion "1"
pb NSHumanReadableCopyright "RiffCut 影创"

echo "── 6/8 首次启动的初始数据（模板库/技能/配置，不含客户素材）"
# 只搬「软件自带的东西」：模板库、内置技能、配置默认值。
# 客户素材/工程/成片属于用户数据，第一次启动时由 seedHomeIfEmpty 自己决定。
# ★ 大权重不进这一步 —— 它们会进签名范围，macOS 首次校验 3GB 封条要 12 秒。
#   先把它们暂存到包外，第 7 步签名完成后再塞回来（实测 12.1 秒 → 1.8 秒）。
BIGWEIGHT="$ROOT/runtime/bigweight-stage"
rm -rf "$BIGWEIGHT"; mkdir -p "$BIGWEIGHT"
# 模板库 / 内置 / 系统 是纯产品资产，整目录搬。
# ★ 配置 不走这里 —— 那个目录里混着对话.json、调用明细.json、服务.token、
#   开放接口.json（明文 key）、凭据.vault、客户.json（含开发机绝对路径）。
#   2026-11-20 实测：直接 rsync 会把 32 条真实对话和两个明文凭据打进包发出去。
#   改用 tools/make-seed.py 按白名单生成干净种子，见第 6.5 步。
for d in 模板库 内置 系统; do
  [ -d "$ROOT/home/$d" ] || continue
  rsync -a --no-links \
    --exclude '本地模型/语音/weights/ming-tts/' \
    --exclude '本地模型/语音/weights/sense-voice/' \
    "$ROOT/home/$d/" "$APP/Contents/Resources/seed-home/$d/" 2>/dev/null || true
done

echo "── 6.5/8 生成干净种子配置（白名单，无对话、无密钥）"
SEEDCFG="$APP/Contents/Resources/seed-home"
rm -rf "$SEEDCFG/配置"
python3 "$ROOT/tools/make-seed.py" "$SEEDCFG" || {
  echo "✗ 干净种子生成失败，停止打包" >&2
  exit 1
}
# 打包前最后一道闸：包内不许出现任何凭据文件
for f in 服务.token 开放接口.json 凭据.vault 模型.json 设置.json 全局记忆.md; do
  if [ -e "$SEEDCFG/配置/$f" ]; then
    echo "✗ 包内出现不该有的文件：配置/$f，停止打包" >&2
    exit 1
  fi
done
# 对话必须是空的
CONV_N=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1],encoding='utf-8'))))" \
  "$SEEDCFG/配置/对话.json" 2>/dev/null || echo "ERR")
if [ "$CONV_N" != "0" ]; then
  echo "✗ 包内 对话.json 不是空的（$CONV_N），停止打包" >&2
  exit 1
fi
echo "  ✓ 种子自检通过（无凭据、对话 0 条）"
# 权重单独暂存（保留相对层级，第 8 步原样放回）
# NO_MODELS=1 时不暂存也不放回 —— 打出来的就是轻量版。
if [ "${NO_MODELS:-0}" = "1" ]; then
  echo "  ⚠ 按 NO_MODELS=1 打包：不含语音权重（用户需自行下载，见 NOTICE.md 3.3）"
  rm -rf "$BIGWEIGHT"
fi
for w in ming-tts sense-voice; do
  [ "${NO_MODELS:-0}" = "1" ] && break
  src="$ROOT/home/系统/本地模型/语音/weights/$w"
  [ -d "$src" ] || continue
  dst="$BIGWEIGHT/系统/本地模型/语音/weights/$w"
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
  # ★ 2026-11-20 踩过：这里以前不校验，cp 只拷了空目录也照跑，
  #   后面 rsync 再"成功"把空目录放回去，包体从 3.1G 悄悄变成 1.2G，
  #   用户装完发现配音引擎没权重。暂存后必须比对字节数，不一致立刻停。
  # ★ 校验用「文件数 + 总字节」，不能用 du：APFS 的 clonefile/sparse 文件
  #   会让 du 的块统计跟实际内容量对不上（实测同一个文件 1662MB vs 1677MB，
  #   字节数却完全一致 1742280896），拿 du 比会误报失败。
  src_n=$(find "$src" -type f | wc -l | tr -d ' ')
  dst_n=$(find "$dst" -type f | wc -l | tr -d ' ')
  src_b=$(find "$src" -type f -exec stat -f%z {} \; | awk '{s+=$1}END{print s+0}')
  dst_b=$(find "$dst" -type f -exec stat -f%z {} \; | awk '{s+=$1}END{print s+0}')
  if [ "$src_n" != "$dst_n" ] || [ "$src_b" != "$dst_b" ]; then
    echo "  ✗ 暂存失败：$w 源 ${src_n}文件/${src_b}字节，暂存 ${dst_n}文件/${dst_b}字节"; exit 1
  fi
  echo "  暂存大权重: $w (${src_n} 文件 / $((src_b/1024/1024))MB)"
done
# ★ 软链绝不能进安装包：home/系统/本地模型 原本是指向旧版数据目录的软链，
#   旧目录一删，这个链就成了地雷 —— 装上后模块加载期 mkdir 报 ENOENT，
#   整个进程死掉、窗口都不出现，用户看到的是「双击没反应」。
#   这里把它们全换成真目录（内容留空，需要时再下载/指向）。
find "$APP/Contents/Resources/seed-home" -type l -print0 2>/dev/null | while IFS= read -r -d "" aLink; do
  tgt=$(readlink "$aLink" 2>/dev/null || echo "")
  if [ ! -e "$aLink" ]; then
    rm -f "$aLink" && mkdir -p "$aLink" && echo "  软链已换成目录: ${aLink#$APP/} (原指向 $tgt)"
  fi
done

echo "── 7/8 ad-hoc 签名（arm64 上没签名会 Killed: 9；必须在放大权重之前）"
codesign --force --deep --sign - "$APP" 2>&1 | tail -2 || true
xattr -cr "$APP" 2>/dev/null || true

# 刷 Finder 图标缓存，否则换了图标还是显示旧的（或者空白）
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

echo "── 8/8 把大权重塞回去（签名之后放，才不会被封条纳入校验）"
if [ "${NO_MODELS:-0}" = "1" ]; then
  echo "  轻量版：跳过权重放回"
elif [ -d "$BIGWEIGHT" ]; then
  rsync -a "$BIGWEIGHT/" "$APP/Contents/Resources/seed-home/"
  WDIR="$APP/Contents/Resources/seed-home/系统/本地模型/语音/weights"
  for w in ming-tts sense-voice; do
    SRCW="$BIGWEIGHT/系统/本地模型/语音/weights/$w"
    [ -d "$SRCW" ] || continue
    want_n=$(find "$SRCW" -type f | wc -l | tr -d ' ')
    want_b=$(find "$SRCW" -type f -exec stat -f%z {} \; | awk '{s+=$1}END{print s+0}')
    got_n=$(find "$WDIR/$w" -type f 2>/dev/null | wc -l | tr -d ' ')
    got_b=$(find "$WDIR/$w" -type f 2>/dev/null -exec stat -f%z {} \; | awk '{s+=$1}END{print s+0}')
    if [ "$want_n" != "$got_n" ] || [ "$want_b" != "$got_b" ]; then
      echo "  ✗ 放回失败：$w 应为 ${want_n}文件/${want_b}字节，实际 ${got_n:-0}文件/${got_b:-0}字节"; exit 1
    fi
    echo "  已放回 $w (${got_n} 文件 / $((got_b/1024/1024))MB)"
  done
  rm -rf "$BIGWEIGHT"
fi
# 放回后签名本来就是"不匹配"状态 —— 但那是 ad-hoc 签名，macOS 只校验
# 可执行代码那段（Contents/MacOS + Frameworks），Resources 里的数据文件
# 不参与运行时校验，所以能正常启动（实测 1.8 秒）。

SIZE=$(du -sh "$APP" | cut -f1)
echo ""
echo "✓ 打包完成：$APP（$SIZE）"
echo "  图标：$(ls -la "$APP/Contents/Resources/app.icns" | awk '{print $5}') bytes"
echo "  名称：$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$PLIST")"
echo "  签名：$(codesign -dv "$APP" 2>&1 | grep -o 'flags=[^ ]*')"
