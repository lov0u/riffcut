#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「干净种子配置」——构建时放进 app 包里的那套初始数据。

为什么需要这个脚本
──────────────────
以前 构建.app.sh 第 6 步是这么干的：

    rsync -a "$ROOT/home/配置/" "$APP/Contents/Resources/seed-home/配置/"

也就是说把开发机上 home/配置/ 整个目录原样搬进包里。而那个目录里除了产品默认值，
还躺着这些东西（2026-11-20 实测）：

    对话.json          32 条真实对话
    调用明细.json      740 条调用记录
    客户.json          18 个客户，含 /Users/lov0u/影创/客户/... 绝对路径
    服务.token         明文 token
    开放接口.json      明文 key: vk-l-...
    凭据.vault         keychain 加密的凭据包
    费用.json          历史账单
    历史.json / 素材库.json / 最近方案.json / 待确认操作.json

一旦打包分发，这些全部跟着走。所以改成：只从 home/配置/ 里挑白名单文件，
其余一律不拷；白名单里的文件如果含运行时数据，写成空骨架。

判据（哪个进白名单）
────────────────────
一个问题就够：这个文件删了，用户第一次打开软件还能不能正常跑？
  - 能跑 → 是运行时数据，不进包（或者进空骨架）
  - 跑不了 → 是产品默认值，必须进包

比如 路由.json 定义了失败冷却策略，删了软件就没有重试逻辑 → 进包。
而 对话.json 删了就是没有历史会话，属于正常的新装状态 → 不进包。

用法
────
    python3 tools/make-seed.py <输出目录>

构建脚本这样调：

    python3 tools/make-seed.py "$APP/Contents/Resources/seed-home"

脚本会自己创建 配置/ 子目录并写入干净文件，不碰输出目录里的其它内容。
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'home', '配置')

# ── 白名单：这些是产品默认值，必须进包 ────────────────────────────────
# 直接原样复制。改动前先问自己：删了它新用户还能不能跑？
COPY_AS_IS = [
    '路由.json',        # 失败冷却/退避策略，删了没有重试
    '导演规则.json',    # 分镜规则
    '导演指令.md',      # 系统提示词主体
    '导演经验.md',      # 经验沉淀的初始内容
    '界面.json',        # 默认布局
    '语音模型.json',    # 音色清单
    '本地安全.json',    # 本地接口要不要 token
]

# ── 空骨架：进包但必须清空运行时数据 ──────────────────────────────────
# 这些文件结构是产品的一部分（代码要读它的字段），但里面的内容属于某个具体用户。
EMPTY_SKELETON = {
    '对话.json': [],
    '调用明细.json': [],
    '调用累计.json': {},
    '费用.json': {},
    '历史.json': {},
    '最近方案.json': {},
    '待确认操作.json': {},
    '任务.json': {},
    '发布.json': {},
    '素材库.json': {},
    '客户.json': [],
}

# ── 绝对不进包 ────────────────────────────────────────────────────────
# 命中这里的一律跳过，哪怕它在上面两个列表里（防御性写法，防止将来手滑加错）。
#
# ★ 模型.json 不进包，但「装完就能对话」不受影响：
#   随软件带的默认额度写在 app/lib/models.js 的 PRESET_KEY + DEFAULT_MODELS['preset-auto']，
#   用户第一次启动时 models() 第 ② 步会把它补进自己的模型表、第 ⑤ 步填上内置 key。
#   也就是说默认值走代码不走数据文件 —— 数据文件里只会有用户自己配的模型和私钥，
#   那种东西无论如何都不该跟着安装包走。
NEVER = {
    '服务.token',       # 明文 token
    '开放接口.json',    # 明文 key
    '凭据.vault',       # keychain 凭据包
    '模型.json',        # 含用户填的接口地址、自建网关 IP 和私人 key
    '设置.json',        # 含用户偏好、路径、API 相关开关
    '全局记忆.md',      # 用户和 AI 的长期记忆
    '授权同意.json',    # 上一个用户的协议同意记录
    '完整性清单.json',  # 上一个用户的文件指纹
    'port.txt',         # 运行时端口
}

# ── 进包但必须洗掉特定字段 ────────────────────────────────────────────
# 更新.json 的结构和说明文字都是产品的一部分，但 feed_url 里可能躺着开发机路径
# （曾实测到 /private/tmp/volena-tests-c_10q6zb/发布/feed.json）。打包出去等于把
# 本地临时目录结构公开，而且用户点「检查更新」会去读一个不存在的路径。
#
# ★ feed_url 现在固定写成 GitHub 的正式发布地址，不再是空串。
#   写成空串的后果：新装的用户「检查更新」永远只看到「还没配更新地址」，
#   自动更新对所有人都是死的。这里是发布链路的唯一入口，改版本时不用动它。
PUBLIC_FEED = 'https://github.com/lov0u/riffcut/releases/latest/download/feed.json'
SANITIZE = {
    '更新.json': {'feed_url': PUBLIC_FEED, 'check_on_start': True},
}

# ── 子目录：整目录复制 ────────────────────────────────────────────────
# 这两个是产品资产不是用户数据：43 个导演技能、20 条经验沉淀。
# 实测扫过没有密钥、没有绝对路径（唯一一处 /Users/... 是文档里的说明文字）。
COPY_DIRS = ['导演技能', '经验库']

# 协议目录不从这里拷 —— 见 LEGAL_SRC，用 home/资源/法律 的新版
LEGAL_SRC = os.path.join(ROOT, 'home', '资源', '法律')


def log(msg):
    print('  ' + msg)


def main():
    if len(sys.argv) < 2:
        print('用法: python3 tools/make-seed.py <输出目录>', file=sys.stderr)
        return 2
    out = os.path.abspath(sys.argv[1])
    cfg = os.path.join(out, '配置')
    os.makedirs(cfg, exist_ok=True)

    copied, emptied, skipped = [], [], []

    # 1. 白名单原样复制
    for name in COPY_AS_IS:
        src = os.path.join(SRC, name)
        if name in NEVER:
            skipped.append(name + '（被 NEVER 拦下）')
            continue
        if not os.path.exists(src):
            skipped.append(name + '（源不存在）')
            continue
        shutil.copy2(src, os.path.join(cfg, name))
        copied.append(name)

    # 2. 空骨架
    for name, empty in EMPTY_SKELETON.items():
        if name in NEVER:
            skipped.append(name + '（被 NEVER 拦下）')
            continue
        dst = os.path.join(cfg, name)
        with open(dst, 'w', encoding='utf-8') as f:
            json.dump(empty, f, ensure_ascii=False, indent=2)
            f.write('\n')
        emptied.append(name)

    # 3. 洗字段后复制（更新.json）
    for name, patch in SANITIZE.items():
        src = os.path.join(SRC, name)
        if not os.path.exists(src):
            skipped.append(name + '（源不存在）')
            continue
        try:
            d = json.load(open(src, encoding='utf-8'))
        except Exception as e:
            skipped.append('%s（读不了：%s）' % (name, e))
            continue
        d.update(patch)
        with open(os.path.join(cfg, name), 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write('\n')
        copied.append('%s（已洗 %s）' % (name, '、'.join(patch)))

    # 4. 整目录复制（导演技能 / 经验库）
    for d in COPY_DIRS:
        src = os.path.join(SRC, d)
        if not os.path.isdir(src):
            skipped.append(d + '/（源不存在）')
            continue
        dst = os.path.join(cfg, d)
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        n = len([f for f in os.listdir(dst) if not f.startswith('.')])
        copied.append('%s/（%d 个）' % (d, n))

    # 5. 剩下的：源目录里有、但两个列表都没提到的，报告出来让人决定
    for name in sorted(os.listdir(SRC)):
        p = os.path.join(SRC, name)
        if os.path.isdir(p):
            if name in COPY_DIRS:
                continue          # 上面已经整目录拷过了
            if name == '协议':
                skipped.append(name + '/（改用 home/资源/法律 的新版）')
            else:
                skipped.append(name + '/（未列入白名单）')
            continue
        if name in COPY_AS_IS or name in EMPTY_SKELETON or name in NEVER or name in SANITIZE:
            continue
        skipped.append(name + '（未列入白名单）')

    # 6. 法律文件：用 home/资源/法律 的新版，覆盖旧协议目录
    legal_dst = os.path.join(cfg, '协议')
    if os.path.isdir(LEGAL_SRC):
        os.makedirs(legal_dst, exist_ok=True)
        n = 0
        for name in os.listdir(LEGAL_SRC):
            if name.startswith('.') or not name.endswith(('.md', '.json')):
                continue
            shutil.copy2(os.path.join(LEGAL_SRC, name), os.path.join(legal_dst, name))
            n += 1
        copied.append('协议/（%d 个法律文件）' % n)

    log('原样复制 %d 项：%s' % (len(copied), '、'.join(copied) or '无'))
    log('清空骨架 %d 项：%s' % (len(emptied), '、'.join(emptied) or '无'))
    if skipped:
        log('跳过 %d 项：%s' % (len(skipped), '、'.join(skipped)))

    # 7. 自检：输出目录里不该出现的东西
    bad = []
    for root, dirs, files in os.walk(cfg):
        for f in files:
            if f in NEVER:
                bad.append(os.path.relpath(os.path.join(root, f), out))
    if bad:
        print('✗ 干净种子自检失败，以下文件不该出现：', bad, file=sys.stderr)
        return 1
    # 对话必须为空
    conv = os.path.join(cfg, '对话.json')
    if os.path.exists(conv):
        try:
            d = json.load(open(conv, encoding='utf-8'))
            if d:
                print('✗ 对话.json 不是空的（%d 条）' % len(d), file=sys.stderr)
                return 1
        except Exception as e:
            print('✗ 对话.json 读不了：%s' % e, file=sys.stderr)
            return 1
    log('自检通过：无凭据、无密钥、对话为空')
    return 0


if __name__ == '__main__':
    sys.exit(main())
