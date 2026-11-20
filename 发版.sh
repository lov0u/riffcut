#!/bin/zsh
# 打一个能发的包。默认只落本地，不碰 GitHub。
#
# 用法：
#   ./发版.sh                  本地打包 + 出 zip + 算 sha256 + 写 feed.json（不联网）
#   ./发版.sh --upload         同上，然后把 zip / feed.json 传到 GitHub Release
#   ./发版.sh --upload --minor 顺便把 version 的次版本号 +1 再打（0.1.0 → 0.2.0）
#   ./发版.sh --lite           只打轻量版（不带 1.7G 语音权重，约 450M）
#   ./发版.sh --skip-build     复用已经存在的 .app，只重新压包算哈希
#
# 为什么默认不传：用户 2026-11-20 明确要求"不要每一次更新都直接上传 github 重新打包"。
# 上传是发布动作，必须显式喊一声才做。本地迭代用 ./发版.sh 就够了。
set -e
cd "$(dirname "$0")"
ROOT="$PWD"

UPLOAD=0
BUMP=""
LITE=0
SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --upload) UPLOAD=1 ;;
    --minor)  BUMP=minor ;;
    --patch)  BUMP=patch ;;
    --lite)   LITE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 && !/^#/ {exit}' "$0"; exit 0 ;;
    *) echo "未知参数：$a（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

REPO="lov0u/riffcut"
APP="$ROOT/RiffCut影创.app"
OUT="$ROOT/发布"

# ── 1. 版本号 ────────────────────────────────────────────────
if [ -n "$BUMP" ]; then
  python3 - "$ROOT/app/package.json" "$BUMP" <<'PYB'
import json, sys
p, which = sys.argv[1], sys.argv[2]
d = json.load(open(p))
a, b, c = (int(x) for x in d["version"].split("."))
if which == "minor": a, b, c = a, b + 1, 0
else:               a, b, c = a, b, c + 1
d["version"] = f"{a}.{b}.{c}"
d["build"] = int(d.get("build", 0)) + 1
with open(p, "w") as f:
    f.write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
print(f"   版本 → {d['version']} (build {d['build']})")
PYB
fi
VER=$(python3 -c "import json;print(json.load(open('$ROOT/app/package.json'))['version'])")
BLD=$(python3 -c "import json;print(json.load(open('$ROOT/app/package.json')).get('build',1))")
echo "════ 发版 $VER (build $BLD) ════"

# ── 2. 打包 ──────────────────────────────────────────────────
if [ "$SKIP_BUILD" = "1" ] && [ -d "$APP" ]; then
  echo "── 1/4 跳过构建，复用 $(du -sh "$APP" | cut -f1) 的现有包"
else
  echo "── 1/4 构建 .app（约 3~6 分钟）"
  if [ "$LITE" = "1" ]; then
    NO_MODELS=1 ./构建.app.sh
  else
    ./构建.app.sh
  fi
fi

[ -d "$APP" ] || { echo "✗ 没有 $APP" >&2; exit 1; }

# 打包自检：版本号写进 Info.plist 了吗（写死会导致更新器永远认为已是最新）
PLIST_VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo "")
if [ "$PLIST_VER" != "$VER" ]; then
  echo "✗ Info.plist 版本是 '$PLIST_VER'，package.json 是 '$VER' —— 更新器会永远认为已是最新" >&2
  exit 1
fi
echo "   Info.plist 版本 ✓ $PLIST_VER"

# ── 3. 压包 + 哈希 ───────────────────────────────────────────
mkdir -p "$OUT"
ZIPNAME="RiffCut-lite-$VER.zip"
ZIP="$OUT/$ZIPNAME"
rm -f "$ZIP"
echo "── 2/4 压缩 $ZIPNAME"
# 用 ditto 而不是 zip：它保留 macOS 的扩展属性与资源分叉，
# 解压出来的 .app 结构才和原样一致（zip 会丢 xattr，偶尔导致签名报错）。
ditto -c -k --keepParent --sequesterRsrc "$APP" "$ZIP"
SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
SZ=$(stat -f%z "$ZIP")
echo "   $(du -sh "$ZIP" | cut -f1)  sha256 $SHA"

# ── 4. feed.json ────────────────────────────────────────────
echo "── 3/4 写 feed.json"
FEED="$ROOT/feed.json"
python3 - "$FEED" "$VER" "$BLD" "$SHA" "$SZ" "$ZIPNAME" "$REPO" <<'PYF'
import json, sys, datetime
path, ver, bld, sha, size, zipname, repo = sys.argv[1:8]
try: old = json.load(open(path))
except Exception: old = {}
feed = {
    "version": ver,
    "build": int(bld),
    "channel": "stable",
    "url": f"https://github.com/{repo}/releases/download/v{ver}/{zipname}",
    "sha256": sha,
    "size": int(size),
    "min_version": old.get("min_version", "0.0.1"),
    "released_at": datetime.date.today().isoformat(),
    "notes": old.get("notes", ""),
}
with open(path, "w") as f:
    f.write(json.dumps(feed, ensure_ascii=False, indent=2) + "\n")
print(f"   feed.json → {ver}")
PYF

# ── 5. 上传（只有显式 --upload 才做）───────────────────────────
if [ "$UPLOAD" = "0" ]; then
  echo "── 4/4 本地完成，没有上传"
  echo ""
  echo "✓ 包在：$ZIP"
  echo "  清单：$FEED"
  echo ""
  echo "  要发到线上，加 --upload 重跑；"
  echo "  或者手动上传这两个文件到 GitHub Release v$VER。"
  exit 0
fi

: "${GH_TOKEN:?上传需要先 export GH_TOKEN=ghp_xxx}"
echo "── 4/4 上传 GitHub Release v$VER"
# 国内直连 github.com 的 302 会卡住，必须绕代理并钉 IP。
CURL=(curl -sS --noproxy '*' --resolve api.github.com:443:140.82.113.3
           --resolve uploads.github.com:443:140.82.113.4
           -H "Authorization: token $GH_TOKEN"
           -H "Accept: application/vnd.github+json")

RID=$( "${CURL[@]}" "https://api.github.com/repos/$REPO/releases/tags/v$VER" 2>/dev/null \
       | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null || echo "" )
if [ -z "$RID" ]; then
  echo "   新建 release v$VER"
  RID=$( "${CURL[@]}" -X POST "https://api.github.com/repos/$REPO/releases" \
         -d "{\"tag_name\":\"v$VER\",\"name\":\"v$VER\",\"draft\":false,\"prerelease\":false}" \
         | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])" )
else
  echo "   复用 release $RID"
fi

up() {
  local f="$1" name="$2"
  local old_id
  old_id=$( "${CURL[@]}" "https://api.github.com/repos/$REPO/releases/$RID/assets" \
            | python3 -c "import json,sys;print(next((a['id'] for a in json.load(sys.stdin) if a['name']=='$name'),''))" )
  [ -n "$old_id" ] && curl -sS --noproxy '*' -X DELETE \
      -H "Authorization: token $GH_TOKEN" \
      "https://api.github.com/releases/assets/$old_id" >/dev/null 2>&1 || true
  curl -sS --noproxy '*' --resolve uploads.github.com:443:140.82.113.4 \
       -H "Authorization: token $GH_TOKEN" \
       -H "Content-Type: application/octet-stream" \
       --data-binary "@$f" \
       "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$name" \
       | python3 -c "import json,sys;d=json.load(sys.stdin);print('   ↑', d.get('name'), d.get('size'), 'bytes')"
}
up "$FEED" "feed.json"
up "$ZIP" "$ZIPNAME"

echo "   验证远端 feed…"
curl -sS -L --noproxy '*' --resolve github.com:443:140.82.113.3 \
  "https://github.com/$REPO/releases/latest/download/feed.json" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('   远端版本', d['version'], '| sha256', d['sha256'][:16]+'…')"

echo ""
echo "✓ 已发布 v$VER"
echo "  客户端启动后会自动检查到这一版。"
