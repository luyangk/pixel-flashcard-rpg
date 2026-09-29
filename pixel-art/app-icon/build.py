#!/usr/bin/env python3
"""《知识侠客》主屏图标（app icon）绘制程序 —— pixel-art-studio 管线。

## 为什么单独一份（不在 scripts/gen-sprites.mjs 里）

`scripts/gen-sprites.mjs` 产出的是**游戏内素材**（`assets/sprites/`，1x 尺寸、由引擎缩放）。
主屏图标不同：它由**浏览器**按 manifest 声明的尺寸取用，必须是真实像素尺寸的 PNG
（192×192 / 512×512），还要外加一张 maskable 变体。两者的"交付口径"不同，混在一个
生成器里会让 `--check` 的幂等清单变得含糊。

## 为什么必须是 ≥192（这一条是安装的前提，不是审美）

Chrome 判定"这个站点能装成应用"时有**图标尺寸下限**（Lighthouse 的判据是至少一张 192×192，
Chromium 内部下限 144px）。低于下限时，Chrome 只给你一个**书签快捷方式**（不是 WebAPK）——
而"分享 → 知识侠客"这条系统分享入口**只在 WebAPK 上存在**。所以图标尺寸直接决定
「分享进来」（PRD §4.2 / D47）能不能用。旧的 32×32/64×64 声明就是这个坑。

## 口径

- 1x 作画 64×64（比 32² 多一档细节；导出为**整数**缩放：×3 = 192、×8 = 512）；
- 调色板与游戏一致：墨（K0–K6）+ 宣纸（P0–P4）+ 枯笔赭石（S0–S2）+ 朱砂（落款印）；
  **不用霓虹**（PRD §7 / D15：霓虹只给怪物）——玩家侧的东西是墨与纸；
- 无随机源、不写时间戳 ⇒ 重跑逐字节相同（`--check` 可证）。

用法：
    python3 pixel-art/app-icon/build.py                # 画 + 导出到 assets/icons/ + 预览
    python3 pixel-art/app-icon/build.py --check        # 与仓库现有 PNG 逐字节比对
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "assets", "icons")

SKILL_CANDIDATES = [
    os.environ.get("PIXELSTUDIO_SCRIPTS", ""),
    os.path.join(ROOT, ".dsh", "skills", "pixel-art-studio", "scripts"),
    os.path.join(os.path.dirname(ROOT), ".dsh", "skills", "pixel-art-studio", "scripts"),
]
for cand in SKILL_CANDIDATES:
    if cand and os.path.isfile(os.path.join(cand, "pixelstudio.py")):
        sys.path.insert(0, cand)
        break
else:
    sys.exit("找不到 pixelstudio.py：请设置 PIXELSTUDIO_SCRIPTS=<skill>/scripts")

from PIL import Image  # noqa: E402

from pixelstudio import Sprite  # noqa: E402

# ---------------------------------------------------------------------------
# 调色板（与 scripts/gen-sprites.mjs 逐字一致）
# ---------------------------------------------------------------------------
K0, K1, K2, K3, K4, K5, K6 = "#0e1116", "#1a1f27", "#272e39", "#3a4351", "#525d6e", "#6f7b8d", "#93a0b0"
P0, P1, P2, P3 = "#f5f1e4", "#e6dfcc", "#d2c9b2", "#b6ab92"
S0, S1, S2 = "#7a6446", "#5c4a33", "#3d3021"
C0, C1 = "#8c2d24", "#c04a3c"
PALETTE = [K0, K1, K2, K3, K4, K5, K6, P0, P1, P2, P3, S0, S1, S2, C0, C1]

BG = K0

# 导出清单：文件名 -> 1x 缩放倍数（整数）
EXPORTS = {
    "icon-192.png": 3,     # 192 = 64 × 3
    "icon-512.png": 8,     # 512 = 64 × 8
}


def draw_card(s: Sprite, x0: int, y0: int, x1: int, y1: int, fold: int) -> None:
    """闪卡：宣纸面 + 左上受光 / 右下背光 + 右上折角 + 三行墨线。

    `fold` = 右上折角的边长（0 = 不折）。折角是"这是一张**纸**"最省像素的暗示。
    """
    s.rect(x0, y0, x1, y1, P1)
    s.outline(K0, where="inside")
    # 内嵌一道浅边：让纸面有厚度（不是纯色块）
    s.rect(x0 + 2, y0 + 2, x1 - 2, y1 - 2, P2, fill=False)
    # 左上受光、右下背光
    s.line(x0 + 3, y0 + 1, x1 - 3, y0 + 1, P0)
    s.line(x0 + 1, y0 + 3, x0 + 1, y1 - 3, P0)
    s.line(x1 - 1, y0 + 3, x1 - 1, y1 - 3, P2)
    s.line(x0 + 3, y1 - 1, x1 - 3, y1 - 1, P3)
    if fold > 0:
        # 折角：先**按行**抹掉右上那一片（v5 的教训：按列抹会切出一个竖井，
        # 折痕线还会伸到纸外变成一根天线），再画折痕与翻折面的高光。
        for i in range(fold):
            for j in range(fold - i):
                s.px(x1 - j, y0 + i, BG)
        # 折痕：一条**连续**的深墨斜线（v6 首版在这里穿插了高光点，远看像纸被撕成锯齿）
        for i in range(fold):
            s.px(x1 - fold + i, y0 + i, K0)


def draw_master() -> Sprite:
    """64×64 主图：墨底 + 牌框；一张折角闪卡（三行墨线 + 朱砂落款印）+ 一道投影。

    构图取舍（v1–v4 的眼睛记录）：
    - v1/v2 把剑画在卡**背后** ⇒ 卡把剑身吃掉，只剩两截棍子；
    - v3 把剑斜**压在卡上** ⇒ 剑把卡劈成两半，小尺寸下是一根斜杠压着一个白方块；
    - v4 把剑**横放在卡下** ⇒ 三个横条各说各话，像工具栏，不像剑。
    结论：**一个图标只讲一件事**。闪卡是主线物件（每次作答都摸它），剑留给游戏内的画面。
    卡上的朱砂印就是"侠客"的那一点：不抢剪影，但一眼看得见。
    """
    s = Sprite(64, 64, palette=PALETTE)

    # ① 底与外框：外圈 K2、内圈 K1 —— 形成一道"木框凹槽"，让图标在浅色壁纸上也有边界
    s.rect(0, 0, 63, 63, BG)
    s.rect(2, 2, 61, 61, K2, fill=False)
    s.rect(3, 3, 60, 60, K1, fill=False)

    # ② 投影：卡片右下各偏移 2px 的深墨影（把纸从墨底上"抬"起来）
    s.rect(14, 12, 51, 54, K1)
    s.rect(13, 13, 50, 53, K1)

    # ③ 闪卡（折角朝右上；印在右下角 —— 落款是整张图唯一的暖色重音）
    draw_card(s, 11, 9, 48, 51, 9)
    s.rect(37, 36, 44, 43, C0)
    s.rect(38, 37, 43, 42, C1)
    s.rect(40, 39, 40, 41, C0)
    s.rect(38, 40, 43, 40, C0)
    # 卡面墨线：三行长句 + 一行写短的（墨线一律止于印的左边，别从印上压过去）
    s.rect(18, 19, 41, 20, K2)
    s.rect(18, 26, 41, 27, K2)
    s.rect(18, 33, 41, 34, K2)
    s.rect(18, 40, 30, 41, K2)

    return s

    # ③ 闪卡：宣纸面 + 选择性轮廓（外轮廓深墨 1px）
    s.rect(17, 15, 45, 49, P1)
    s.outline(K0, where="inside")
    # 左上受光（P0）、右下背光（P2/P3）
    s.line(19, 17, 43, 17, P0)
    s.line(18, 18, 18, 47, P0)
    s.line(44, 18, 44, 47, P2)
    s.line(19, 47, 43, 47, P2)
    s.line(19, 46, 43, 46, P3)
    # 卡面文字：三行墨线（越往下越短，像一段没写完的笔记）
    s.rect(23, 22, 39, 23, K2)
    s.rect(23, 28, 39, 29, K2)
    s.rect(23, 34, 33, 35, K2)
    # ④ 落款朱砂印：整张图唯一的暖色重音
    s.rect(35, 39, 41, 45, C0)
    s.rect(36, 40, 40, 44, C1)
    s.rect(38, 41, 38, 43, C0)
    s.rect(36, 42, 40, 42, C0)

    return s


def maskable_png(s: Sprite) -> Image.Image:
    """maskable 变体：512×512 满幅背景 + 主图缩到 384（×6）居中。

    为什么缩到 75%：Android 的自适应图标会裁成圆形/方圆形，安全区直径约 80%；
    主图自带的外框正好落在会被裁掉的角上，而它与背景同色 ⇒ 裁掉也看不出来。
    """
    canvas = Image.new("RGBA", (512, 512), BG)
    art = s.composite().resize((384, 384), Image.NEAREST)
    canvas.alpha_composite(art, (64, 64))
    return canvas


def sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def render(s: Sprite, out_dir: str, preview: str | None) -> dict[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    digests: dict[str, str] = {}
    for name, scale in EXPORTS.items():
        path = os.path.join(out_dir, name)
        s.save_png(path, scale=scale)
        digests[name] = sha256(path)
    mask_path = os.path.join(out_dir, "icon-maskable-512.png")
    maskable_png(s).save(mask_path)
    print("png -> %s (64x64 master @%dx, maskable)" % (mask_path, 6))
    digests["icon-maskable-512.png"] = sha256(mask_path)
    if preview:
        s.preview(preview, scale=8)
    return digests


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--check", action="store_true", help="与仓库现有 PNG 逐字节比对")
    ap.add_argument("--no-preview", action="store_true")
    args = ap.parse_args()

    s = draw_master()

    if args.check:
        tmp = os.path.join(HERE, "_check")
        render(s, tmp, None)
        diffs = 0
        print("\n幂等比对（重生成 vs 仓库现有）-----------------------------------------")
        for name in list(EXPORTS) + ["icon-maskable-512.png"]:
            fresh = sha256(os.path.join(tmp, name))
            repo = os.path.join(OUT_DIR, name)
            if not os.path.isfile(repo):
                print("  缺失  %s" % name)
                diffs += 1
                continue
            same = fresh == sha256(repo)
            if not same:
                diffs += 1
            print("  %s  %-28s %s" % ("一致" if same else "不一致", name, fresh[:8]))
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
        if diffs:
            print("%d 个文件与仓库不一致：请重跑 python3 pixel-art/app-icon/build.py 并提交产物。" % diffs)
            sys.exit(1)
        print("全部 %d 张 PNG 与仓库逐字节一致（幂等可复现）。" % (len(EXPORTS) + 1))
        return

    preview = None if args.no_preview else os.path.join(HERE, "preview.png")
    digests = render(s, args.out, preview)
    print("\n产物清单 ---------------------------------------------------------------")
    for name, digest in digests.items():
        size = os.path.getsize(os.path.join(args.out, name))
        print("  %-28s %5dB  %s" % (name, size, digest[:8]))
    print("------------------------------------------------------------------------")
    s.stats()


if __name__ == "__main__":
    main()
