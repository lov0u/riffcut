#!/usr/bin/env bash
# 下载 DSH 内核到 kernel/dsh/（约 600MB）。
#
# 为什么不在仓库里：内核由 306 个 npm 包 + 一个 140MB 的 Node 运行时组成，
# 塞进 git 会让仓库变成 700MB+，每次 clone 都得等。它们全都能从公开源重建，
# 所以只在仓库里放这个脚本。
#
# 用法：
#   ./tools/fetch-kernel.sh              # 装 0.2.1-rc.3（与当前开发版一致）
#   ./tools/fetch-kernel.sh 0.2.2-rc.5   # 装指定版本
set -euo pipefail

VER="${1:-0.2.1-rc.3}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KDIR="$ROOT/kernel/dsh"

echo "内核版本: $VER"
echo "目标目录: $KDIR"

command -v npm >/dev/null || { echo "缺 npm，请先装 Node.js 20+"; exit 1; }
command -v node >/dev/null || { echo "缺 node，请先装 Node.js 20+"; exit 1; }

mkdir -p "$KDIR"
cd "$KDIR"

# dsh 是公开包，直接装。--omit=dev 跳过开发依赖，体积小一半。
if [ ! -f package.json ]; then
  cat > package.json <<'JSON'
{
  "name": "riffcut-kernel",
  "private": true,
  "version": "0.0.0",
  "description": "RiffCut 影创 的 AI 内核运行时（由 tools/fetch-kernel.sh 生成）"
}
JSON
fi

echo "→ 安装 @deepseek-ai/dsh@$VER（约 3-5 分钟）"
npm install "@deepseek-ai/dsh@$VER" --omit=dev --no-audit --no-fund

# 内核要一个自己的 node 可执行文件（app/lib/kernel.js 里 nodeBin 指的就是这个），
# 不能用系统 node —— 包分发到别人机器上时，对方不一定装了 Node。
if [ ! -x "$KDIR/node" ]; then
  echo "→ 下载 Node 运行时（arm64 macOS）"
  NODE_VER="v22.14.0"
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64)  NARCH="arm64" ;;
    x86_64) NARCH="x64" ;;
    *) echo "不支持的架构: $ARCH"; exit 1 ;;
  esac
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$NARCH.tar.gz" \
    | tar -xz -C "$TMP"
  cp "$TMP/node-$NODE_VER-darwin-$NARCH/bin/node" "$KDIR/node"
  chmod +x "$KDIR/node"
  rm -rf "$TMP"
fi

# 自检：缺这两个文件 app 就起不来
[ -f "$KDIR/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || { echo "✗ 内核入口缺失"; exit 1; }
[ -x "$KDIR/node" ] || { echo "✗ node 运行时缺失"; exit 1; }

echo
echo "✓ 内核就绪"
echo "  $("$KDIR/node" -v)  $(node -p "require('$KDIR/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo "$VER")"
du -sh "$KDIR" 2>/dev/null | awk '{print "  体积: "$1}'
