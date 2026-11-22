#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拼装 RiffCut 影创界面：shell + 12 个页面片段 → 可编辑版 + 自包含单文件版"""
import base64, glob, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # app/
SRC = os.path.join(ROOT, "ui", "src")
ASSETS = os.path.join(ROOT, "ui", "assets")
OUT_EDIT = os.path.join(ROOT, "renderer", "ui.html")
OUT_SINGLE = os.path.join(ROOT, "ui", "_single.html")

shell = open(os.path.join(SRC, "shell.html"), encoding="utf-8").read()
page_files = sorted(glob.glob(os.path.join(SRC, "pages", "*.html")))
EXPECT_PAGES = 16   # 2026-11-19：插件市场 / 内核能力 / 会话历史 / 任务与智能体，12 → 16
assert len(page_files) == EXPECT_PAGES, f"页面片段应为 {EXPECT_PAGES} 个，实际 {len(page_files)}"
pages = "\n\n".join(open(p, encoding="utf-8").read() for p in page_files)
assert "<!--PAGES-->" in shell, "shell.html 缺少 <!--PAGES--> 占位符"
html = shell.replace("<!--PAGES-->", pages)

# 注入文字样式表：46 款样式原来只在 05-专业剪辑.html 里，导出端和 AI 拿不到。
# 单独成一份 src/textstyles.js，页面里当 window.RC_TEXTSTYLES 用，Node 侧 require 同一个文件。
tsjs = open(os.path.join(SRC, "textstyles.js"), encoding="utf-8").read()
assert "</script" not in tsjs, "textstyles.js 里不能含 </script>"
assert "<!--TEXTSTYLES-->" in html, "shell.html 缺少 <!--TEXTSTYLES--> 占位符"
html = html.replace("<!--TEXTSTYLES-->", "<script>\n" + tsjs + "\n</script>")

# 注入统一真实功能接线层：10 个页面的按钮全部接到本机 /api/*
live = open(os.path.join(SRC, "live.js"), encoding="utf-8").read()
assert "<!--LIVE-->" in html, "shell.html 缺少 <!--LIVE--> 占位符"
assert "</script" not in live, "live.js 里不能含 </script>"
html = html.replace("<!--LIVE-->", "<script>\n" + live + "\n</script>")

open(OUT_EDIT, "w", encoding="utf-8").write(html)

names = sorted(set(re.findall(r"assets/([A-Za-z0-9_]+\.png)", html)))
missing = [n for n in names if not os.path.isfile(os.path.join(ASSETS, n))]
assert not missing, f"缺少素材: {missing}"
for n in names:
    data = base64.b64encode(open(os.path.join(ASSETS, n), "rb").read()).decode()
    html = html.replace(f"assets/{n}", "data:image/png;base64," + data)
# 只校验图片外链；live.js 里的 /api/assets/xxx 是接口路径，不能误判
left = re.findall(r"assets/[A-Za-z0-9_]+\.png", html)
assert not left, "仍有未内联的素材外链: %s" % left
open(OUT_SINGLE, "w", encoding="utf-8").write(html)

print(f"页面片段: {len(page_files)} 个 -> {[os.path.basename(p) for p in page_files]}")
print(f"内联素材: {len(names)} 个 -> {names}")
print(f"可编辑版: {OUT_EDIT} ({os.path.getsize(OUT_EDIT):,} bytes)")
print(f"单文件版: {OUT_SINGLE} ({os.path.getsize(OUT_SINGLE):,} bytes)")
