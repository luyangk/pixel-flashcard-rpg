#!/usr/bin/env node
/**
 * gen-sprites.mjs —— 《知识侠客》正式像素素材生成器（Plan 4 · T9，pixel-art-studio 管线）。
 *
 * 本脚本是 assets/sprites/*.png 的**唯一来源**，纯 Node 驱动 + Pillow 绘制：
 *   - Node 侧（本文件）：定位项目级 pixel-art-studio skill、把内嵌的绘制程序写到临时目录、
 *     调 python3 执行、打印清单（尺寸 / 字节 / sha256）。不联网、不引新依赖。
 *   - 绘制侧（内嵌 Python，见下方 PY_SOURCE）：每个像素都由它画出来——有限调色板、手工 ramp、
 *     选择性轮廓、抖动质感；口径见 docs/PRD.md §7（D15）与 docs/LORE.md §6：
 *     水墨低饱和为底，赛博霓虹（青/品红/电蓝）只给怪物；1x 作画、整数缩放、禁抗锯齿、禁半透明。
 *
 * 为什么把绘制程序内嵌在 .mjs 里：素材必须可复现（重跑得到逐像素相同的 PNG），而仓库的 npm
 * 依赖里没有 Pillow。内嵌后只有"一份真相"，`node scripts/gen-sprites.mjs` 一条命令即可全量重生成，
 * 不需要额外的旁挂文件。审阅时可用 --emit-python 把绘制程序导出来单独看/单独跑。
 *
 * 前置：python3 + Pillow（本机 10.2.0）；pixel-art-studio 项目级 skill（自动定位，或
 * 用环境变量 PIXELSTUDIO_SCRIPTS=<skill>/scripts 指定）。
 *
 * 用法：
 *   node scripts/gen-sprites.mjs                             # 全量重生成到 assets/sprites/
 *   node scripts/gen-sprites.mjs --only hero,mob-1           # 只重生成子集（开发期快循环）
 *   node scripts/gen-sprites.mjs --out /tmp/sprites          # 写到别处（不动仓库）
 *   node scripts/gen-sprites.mjs --check                     # 重生成到临时目录，与仓库 PNG 逐字节比对
 *   node scripts/gen-sprites.mjs --emit-python /tmp/draw.py  # 导出内嵌绘制程序（审阅/调试）
 *
 * 幂等：绘制无随机源（噪声固定 seed），PNG 不写时间戳块 ⇒ 连续两次运行逐字节相同（sha256 可证）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_OUT = join(ROOT, 'assets', 'sprites');

/** 全部产物，顺序即 _contact-sheet.png 的拼图顺序。 */
export const SPRITE_FILES = [
  'hero.png',
  'mob-1.png',
  'mob-2.png',
  'mob-3.png',
  'mob-4.png',
  'boss-1.png',
  'boss-2.png',
  'boss-3.png',
  'boss-4.png',
  'bg-arena.png',
  'prologue-01-cloud-age.png',
  'prologue-02-data-flood.png',
  'prologue-03-great-forgetting.png',
  'prologue-04-cloud-down.png',
  'prologue-05-old-art.png',
  'prologue-06-teaching.png',
  'prologue-07-departure.png',
  'prologue-08-title.png',
  'arc-1.png',
  'arc-2.png',
  'arc-3.png',
  // Plan 7 · T4：练功木人桩（木桩练功的敌人位）
  'drill-dummy.png',
  '_contact-sheet.png',
];

/** 内嵌绘制程序（与 `--emit-python` 导出、以及独立运行的内容完全相同）。 */
export const PY_SOURCE = String.raw`
#!/usr/bin/env python3
"""《知识侠客》像素素材绘制程序（pixel-art-studio 管线 / Pillow）。

本文件由 scripts/gen-sprites.mjs 内嵌同源文本后写到临时目录执行——不要手改导出的副本，
改 scripts/gen-sprites.mjs。开发期可独立运行：

    PIXELSTUDIO_SCRIPTS=<skill>/scripts python3 draw.py --out <dir> [--only hero,mob-1]

绘制口径（PRD §7 / D15 / LORE §6）：
- 水墨低饱和为底（墨 / 宣纸 / 枯笔赭石），赛博霓虹（青·品红·电蓝）只出现在小怪与卷灵上；
- 像素精确：1x 作画、整数缩放导出、禁抗锯齿、禁半透明过渡（存档 PNG 只有 a=0/255）；
- 有限调色板（每张 ≤32 色，实际远低于）；手工 ramp；选择性轮廓（外轮廓深墨 K0 1px）。
- 绘制顺序：体块 → 选择性轮廓 → 霓虹/发光/细部（描边不落在发光件上，让核心"亮"起来）。
"""
from __future__ import annotations

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont


# ---------------------------------------------------------------------------
# pixel-art-studio 载入（ramp/outline/dither/preview 等方法论复用 skill）
# ---------------------------------------------------------------------------
def load_pixelstudio():
    cands = []
    env = os.environ.get("PIXELSTUDIO_SCRIPTS")
    if env:
        cands.append(env)
    here = os.path.dirname(os.path.abspath(__file__))
    for base in (here, os.path.dirname(here)):
        cands.append(os.path.join(base, ".dsh", "skills", "pixel-art-studio", "scripts"))
        cands.append(os.path.join(base, "skills", "pixel-art-studio", "scripts"))
        cands.append(os.path.join(os.path.dirname(base), ".dsh", "skills", "pixel-art-studio", "scripts"))
    for c in cands:
        if os.path.isfile(os.path.join(c, "pixelstudio.py")):
            sys.path.insert(0, c)
            return c
    sys.exit("找不到 pixelstudio.py：请设置环境变量 PIXELSTUDIO_SCRIPTS=<skill>/scripts")


PIXELSTUDIO_DIR = load_pixelstudio()
from pixelstudio import Sprite  # noqa: E402

# ---------------------------------------------------------------------------
# 项目调色板
# ---------------------------------------------------------------------------
# 墨（低饱和冷灰；手工 ramp：暗部偏冷、亮部偏暖，明度步长 ≥8%）
K0 = "#0e1116"
K1 = "#1a1f27"
K2 = "#272e39"
K3 = "#3a4351"
K4 = "#525d6e"
K5 = "#6f7b8d"
K6 = "#93a0b0"
INK = [K0, K1, K2, K3, K4, K5, K6]

# 宣纸（暖白，留白与枯笔的底）
P0 = "#f5f1e4"
P1 = "#e6dfcc"
P2 = "#d2c9b2"
P3 = "#b6ab92"
P4 = "#988d74"
PAPER = [P0, P1, P2, P3, P4]

# 赭石/枯笔（旧纸、器物、木石）
S0 = "#7a6446"
S1 = "#5c4a33"
S2 = "#3d3021"
SEPIA = [S0, S1, S2]

# 霓虹三族 + 紫（暗部偏紫蓝，亮部近白；明度步长大 ⇒ 1x 下也在发光）
CY = ["#0a3e4d", "#12a89c", "#25e8d8", "#c9fff6"]
MG = ["#4d0a3c", "#a3166f", "#ff3fa8", "#ffd2ec"]
BL = ["#141a5c", "#2b46c8", "#5b86ff", "#cfe0ff"]
VI = ["#2a1052", "#6a2fd0", "#a06bff", "#e5d2ff"]
# 朱砂（只用于落款印的暖点；不是霓虹，不违反"霓虹只给怪物"）
CINNABAR = ["#8c2d24", "#c04a3c"]

MOB_COLS = INK + PAPER[1:3]
BOSS_COLS = INK + PAPER[:4] + SEPIA[:2]
SCENE_COLS = INK + PAPER + SEPIA + CY + MG + BL + VI + CINNABAR


def new32(cols=None):
    return Sprite(32, 32, palette=list(cols or MOB_COLS))


def new64(cols=None):
    return Sprite(64, 64, palette=list(cols or (BOSS_COLS + CY + MG)))


def selout(s, c=K0):
    """统一轮廓口径：外轮廓深墨 1px（inside selout，留给剪影破口自己长出去）。"""
    s.outline(c, where="inside")
    return s


def pm(s, pts, c):
    for x, y in pts:
        s.px(x, y, c)
    return s


def band(s, pts, c):
    """沿折线绘 1px 线（Bresenham，不会在拐角堆双像素）。"""
    for i in range(len(pts) - 1):
        s.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], c)
    return s


def save(s, out, name, rgb=False):
    path = os.path.join(out, name)
    if rgb:
        s.composite().convert("RGB").save(path)
    else:
        s.save_png(path)
    return s


# ---------------------------------------------------------------------------
# hero.png —— 32×32 侠客（背剑的墨色人影，面向右）
# ---------------------------------------------------------------------------
def hero(out):
    s = new32(INK + PAPER + SEPIA)

    # ---- 体块 ----
    s.rect(13, 3, 20, 5, K1, fill=True)          # 发顶
    s.rect(13, 3, 19, 3, K0, fill=True)
    s.rect(12, 4, 17, 11, K1, fill=True)         # 后脑/鬓
    s.rect(12, 4, 12, 9, K0, fill=True)
    s.rect(12, 3, 13, 4, K0, fill=True)          # 发髻
    s.rect(18, 5, 20, 10, P2, fill=True)         # 面部（留纸色）
    s.px(18, 5, P3)
    s.px(19, 7, K0)                              # 眼
    s.px(19, 6, K1)                              # 眉
    s.px(20, 8, K0)                              # 鼻
    s.px(20, 9, P4)
    s.px(19, 10, K0)                             # 下颌
    s.rect(16, 11, 19, 11, P3, fill=True)        # 颈
    s.px(15, 11, K0)                             # 颈下的墨影（把头和躯干断开）
    s.rect(13, 12, 20, 12, K0, fill=True)        # 衣领
    s.rect(11, 13, 21, 14, K3, fill=True)        # 肩
    s.rect(11, 13, 12, 14, K4, fill=True)
    s.rect(12, 15, 20, 18, K2, fill=True)        # 胸背
    s.rect(12, 15, 14, 18, K3, fill=True)        # 受光面（左上）
    s.rect(19, 15, 20, 18, K1, fill=True)        # 背光面
    s.rect(20, 13, 21, 18, K0, fill=True)
    s.rect(12, 19, 20, 20, K1, fill=True)        # 腰
    s.rect(11, 21, 21, 24, K1, fill=True)        # 下摆
    s.rect(11, 21, 12, 23, K2, fill=True)
    pm(s, [(16, 16), (16, 17), (15, 18)], K1)    # 衣褶（错位 1px）
    pm(s, [(18, 21), (18, 22), (17, 23)], K2)
    pm(s, [(13, 22), (13, 23)], K2)
    s.rect(12, 19, 20, 19, K0, fill=True)        # 腰带
    s.rect(15, 19, 17, 19, S0, fill=True)
    # 腿（两腿 + 2px 负形，靴尖朝右）
    s.rect(13, 25, 15, 28, K1, fill=True)
    s.rect(18, 25, 20, 28, K1, fill=True)
    s.rect(13, 25, 13, 27, K3, fill=True)
    s.rect(18, 25, 18, 27, K2, fill=True)
    s.rect(16, 25, 17, 28, None, fill=True)      # 双腿负形
    s.rect(12, 29, 16, 29, K0, fill=True)
    s.rect(17, 29, 22, 29, K0, fill=True)
    s.rect(12, 28, 15, 28, K4, fill=True)
    s.rect(17, 28, 20, 28, K3, fill=True)
    s.noise(11, 13, 14, 18, K4, density=0.08, seed=5, only=K3)
    selout(s, K0)

    # ---- 背剑（斜挎：柄过左肩、鞘横过后背到右胯；长斜线才读得出是"剑"） ----
    axis = [(10, 9), (11, 10), (12, 11), (13, 13), (14, 14), (15, 15), (16, 17),
            (17, 18), (18, 19), (19, 20), (20, 21), (21, 22)]
    for i, (x, y) in enumerate(axis):
        s.px(x, y, K1)               # 鞘身
        s.px(x + 1, y, K0)           # 下缘墨边
        if i % 3 == 0:
            s.px(x, y - 1, K4)       # 上缘受光
    # 剑格（与鞘轴垂直的三像素横档）+ 缠柄 + 剑首
    s.px(8, 10, K4)
    s.px(9, 9, K3)
    s.px(10, 8, K4)
    s.px(7, 11, K0)
    s.px(11, 7, K0)
    s.px(9, 8, K2)
    s.px(8, 9, K2)
    s.px(9, 7, K5)
    s.px(8, 8, K2)
    s.px(8, 7, K0)
    s.px(10, 7, K0)
    s.px(7, 8, K0)
    # 鞘尖
    s.px(22, 23, K4)
    s.px(22, 22, K0)
    s.px(21, 23, K0)
    return save(s, out, "hero.png")


# ---------------------------------------------------------------------------
# 小怪 ×4 —— 赛博霓虹"数据虫/故障体"
# 同族：共用暗色机壳（K0–K4）+ 单族霓虹。四款在【轮廓】【核心形状】【光效走向】同时区分：
#   mob-1 横向分节幼虫 · 横条核心 · 光向左拖尾
#   mob-2 六足爬行体   · 菱形核心 · 光向下渗漏
#   mob-3 悬浮窗体     · 方核+错位残影 · 光向上喷发
#   mob-4 提线面具     · 中空环+斜杠 · 光沿提线垂落
# ---------------------------------------------------------------------------
def mob1(out):
    """缓存妖：横向分节幼虫，核心=横向光条，光效向后（左）拖尾。"""
    s = new32(MOB_COLS + CY)
    s.circle(9, 19, 5, K1, fill=True)
    s.circle(16, 18, 6, K2, fill=True)
    s.circle(23, 19, 5, K1, fill=True)
    s.circle(9, 17, 4, K2, fill=True, only=K1)
    s.circle(16, 16, 5, K3, fill=True, only=K2)
    s.circle(23, 17, 4, K2, fill=True, only=K1)
    s.rect(6, 23, 26, 24, K0, fill=True, only=K1)
    s.rect(13, 23, 20, 24, K0, fill=True, only=K2)
    pm(s, [(12, 15), (12, 16), (12, 17), (12, 18), (12, 19), (12, 20)], K0)
    pm(s, [(19, 14), (19, 15), (19, 16), (19, 17), (19, 18), (19, 19), (19, 20)], K0)
    s.rect(25, 15, 28, 22, K3, fill=True)        # 头（右）楔形
    s.rect(28, 17, 29, 20, K2, fill=True)
    s.rect(25, 22, 28, 23, K0, fill=True)
    s.rect(8, 24, 9, 26, K0, fill=True)          # 足（2px 粗）
    s.rect(15, 24, 16, 27, K0, fill=True)
    s.rect(22, 24, 23, 25, K0, fill=True)
    selout(s, K0)
    # 霓虹：背鳍（3px 三角成簇，高度不齐）、核心横条、尾焰、复眼
    for fx, h in ((10, 2), (17, 3), (24, 2)):
        s.rect(fx - 1, 15, fx + 1, 15, CY[1], fill=True)
        if h == 3:
            s.rect(fx - 1, 14, fx + 1, 14, CY[1], fill=True)
        s.px(fx, 14 if h == 2 else 13, CY[2])
        s.px(fx - 1, 14, CY[0])
    s.rect(13, 17, 18, 19, CY[0], fill=True)
    s.rect(14, 18, 17, 18, CY[2], fill=True)
    s.rect(15, 18, 16, 18, CY[3], fill=True)
    pm(s, [(13, 18), (18, 18), (13, 16), (18, 20)], CY[1])
    # 尾焰：贴着尾端向右上收细（不是悬空碎点）
    s.rect(4, 18, 5, 20, CY[0], fill=True)
    pm(s, [(3, 18), (3, 19), (3, 20), (2, 19)], CY[1])
    s.px(4, 18, CY[1])
    s.px(2, 18, CY[0])
    s.px(30, 18, CY[3])
    s.px(30, 19, CY[3])
    pm(s, [(29, 21), (30, 20)], K0)
    return save(s, out, "mob-1.png")


def mob2(out):
    """爬虫魔：六足宽体（股节 2px + 胫节 1px 有膝），核心=菱形，光效向下渗漏。"""
    s = new32(MOB_COLS + MG + CY)
    legs = [
        ([(11, 14), (8, 11)], [(8, 11), (5, 7)]),
        ([(21, 14), (24, 11)], [(24, 11), (27, 7)]),
        ([(10, 18), (6, 17)], [(6, 17), (3, 16)]),
        ([(22, 18), (26, 17)], [(26, 17), (29, 16)]),
        ([(11, 21), (8, 24)], [(8, 24), (5, 27)]),
        ([(21, 21), (24, 24)], [(24, 24), (27, 27)]),
    ]
    for femur, tibia in legs:
        band(s, femur, K1)
        band(s, [(x, y + 1) for x, y in femur], K0)
        band(s, tibia, K1)
        band(s, [(x, y + 1) for x, y in tibia], K0)
        s.px(femur[1][0], femur[1][1] - 1, K4)
    s.circle(16, 18, 7, K1, fill=True)
    s.circle(15, 16, 6, K2, fill=True, only=K1)
    s.circle(13, 14, 3, K3, fill=True, only=K2)
    s.rect(10, 24, 22, 24, K0, fill=True, only=K1)
    pm(s, [(12, 13), (13, 12), (14, 12), (15, 12)], K4)
    # 螯肢：实心 2px（避免虚点读成噪点）
    band(s, [(22, 15), (24, 13), (26, 12)], K2)
    band(s, [(22, 16), (24, 14), (26, 13)], K1)
    band(s, [(23, 16), (25, 14), (27, 13)], K0)
    band(s, [(22, 21), (25, 23), (27, 24)], K2)
    band(s, [(22, 22), (25, 24), (27, 25)], K1)
    band(s, [(23, 22), (26, 24), (28, 25)], K0)
    selout(s, K0)
    # 霓虹：复眼、菱形核心、向下渗漏（短柱，不和足抢读）
    s.rect(19, 12, 20, 13, K0, fill=True)
    s.rect(21, 15, 22, 16, K0, fill=True)
    s.px(20, 12, CY[2])
    s.px(22, 15, CY[2])
    s.px(19, 13, CY[1])
    s.px(21, 16, CY[1])
    for d in range(3):
        halfw = 3 - d
        c = (MG[0], MG[1], MG[2])[d]
        for i in range(-halfw, halfw + 1):
            s.px(16 + i, 18 - halfw + abs(i), c)
            s.px(16 + i, 18 + halfw - abs(i), c)
    s.px(16, 17, MG[3])
    s.px(16, 18, MG[3])
    # 向下渗漏：两段 2px 宽短柱 + 两粒脱离的光珠（成对，不成散点）
    for x in (12, 19):
        s.rect(x, 25, x + 1, 25, MG[1], fill=True)
        s.rect(x, 26, x + 1, 26, MG[0], fill=True)
    pm(s, [(15, 28), (16, 29)], MG[0])
    pm(s, [(25, 11), (28, 24)], MG[2])
    return save(s, out, "mob-2.png")


def mob3(out):
    """弹窗鬼：悬浮窗体（后窗残影 + 前窗破损）；核心=电蓝方核；光效向上喷发。"""
    s = new32(MOB_COLS + BL)
    # 后窗残影：顶边 + 右边两条实线，各留一处 2px 断口（虚线框会读成噪点）
    s.rect(12, 5, 29, 5, K4, fill=True)
    s.rect(20, 5, 21, 5, None, fill=True)
    s.rect(29, 5, 29, 20, K3, fill=True)
    s.rect(29, 11, 29, 12, None, fill=True)
    s.px(12, 4, K3)
    s.px(29, 4, K3)
    # 前窗
    s.rect(5, 11, 24, 27, K1, fill=True)
    s.rect(6, 12, 23, 26, K2, fill=True, only=K1)
    s.rect(5, 11, 24, 14, K3, fill=True)          # 标题栏
    s.rect(5, 11, 24, 11, K0, fill=True)
    s.rect(5, 26, 24, 27, K0, fill=True)
    s.rect(5, 15, 5, 25, K0, fill=True)
    s.rect(24, 15, 24, 25, K0, fill=True)
    pm(s, [(9, 13), (13, 13), (17, 13)], K5)      # 标题栏数据块（不是文字）
    s.rect(21, 12, 23, 14, K1, fill=True)         # 关闭控件（× 形，不是汉字）
    s.rect(21, 12, 23, 12, K0, fill=True)
    s.rect(21, 14, 23, 14, K0, fill=True)
    pm(s, [(21, 13), (23, 13), (22, 13)], K4)
    pm(s, [(24, 24), (24, 25), (23, 26), (22, 26)], None)   # 右下角裂口
    s.rect(8, 18, 23, 19, K1, fill=True)          # 故障错位切片（只切内部，不动外框）
    pm(s, [(8, 18), (8, 19)], K0)
    selout(s, K0)
    # 霓虹：错位残影、方核、向上喷发锥
    pm(s, [(22, 17), (23, 18), (23, 17)], BL[0])
    pm(s, [(7, 17), (8, 16)], BL[0])
    s.rect(10, 20, 16, 25, BL[0], fill=True)
    s.rect(11, 21, 15, 24, BL[2], fill=True)
    s.rect(12, 22, 14, 23, BL[3], fill=True)
    s.px(11, 21, BL[3])
    pm(s, [(18, 22), (19, 23), (17, 23)], BL[1])
    s.rect(12, 9, 14, 10, BL[1], fill=True)       # 锥形光柱（3→2→1px，别做太亮）
    s.rect(13, 10, 14, 10, BL[2], fill=True)
    s.rect(12, 7, 13, 8, BL[1], fill=True)
    s.rect(12, 5, 12, 6, BL[0], fill=True)
    pm(s, [(11, 9), (15, 9)], BL[0])
    s.px(17, 8, BL[0])
    # 悬浮投影（抖动收窄，不是一条实心带）
    s.dither(9, 30, 20, 30, K4, K0, mix=0.5, pattern="checker")
    s.dither(11, 29, 18, 29, K2, K4, mix=0.5, pattern="bayer2")
    pm(s, [(10, 30), (19, 30)], K3)
    return save(s, out, "mob-3.png")


def mob4(out):
    """空指针傀：悬浮面具；核心=真中空环 + 斜杠（空集，不是汉字）；光沿两条提线垂落。"""
    s = new32(MOB_COLS + CY + MG)
    # 两条提线（1px，下细上粗），不做横杆（横杆会读成桌子）
    band(s, [(13, 19), (12, 24), (13, 30)], K3)
    band(s, [(19, 19), (20, 24), (19, 30)], K4)
    band(s, [(16, 20), (16, 25)], K5)
    # 面具
    s.circle(16, 13, 7, K1, fill=True)
    s.circle(15, 12, 6, K2, fill=True, only=K1)
    s.circle(19, 16, 4, K0, fill=True, only=K2)
    # 双角（2px 实心三角 + 青尖，成簇不成点）
    pm(s, [(11, 6), (10, 5), (10, 4)], K2)
    pm(s, [(21, 6), (22, 5), (22, 4)], K2)
    pm(s, [(11, 7), (12, 6)], K1)
    pm(s, [(21, 7), (20, 6)], K1)
    s.rect(14, 19, 18, 19, K0, fill=True)         # 下颌缝
    pm(s, [(15, 20), (17, 20)], K0)
    # 眼窝：真透空（背景透出）+ 墨框
    s.rect(11, 10, 12, 11, None, fill=True)
    s.rect(19, 10, 20, 11, None, fill=True)
    pm(s, [(11, 9), (13, 9), (10, 10), (10, 11), (13, 12), (11, 12)], K0)
    pm(s, [(19, 9), (21, 9), (21, 12), (19, 12), (18, 10), (18, 11)], K0)
    selout(s, K0)
    # 霓虹：环核（中空）+ 斜杠 + 角尖 + 眼窝青瞳 + 线端光珠
    s.circle(16, 15, 4, CY[1], fill=False)
    s.circle(16, 15, 4, CY[2], fill=False)
    pm(s, [(12, 11), (20, 19), (13, 12), (19, 18)], CY[0])
    s.px(12, 10, CY[3])
    s.px(19, 11, CY[3])
    pm(s, [(10, 3), (22, 3)], CY[2])
    s.rect(15, 16, 17, 16, None, fill=True)       # 环心透空
    pm(s, [(14, 17), (15, 16), (17, 14), (18, 13)], MG[2])   # 斜杠（空集符号）
    pm(s, [(13, 19), (19, 13)], MG[0])
    pm(s, [(12, 30), (13, 29)], MG[1])            # 线端光珠
    pm(s, [(19, 30), (20, 29)], MG[1])
    pm(s, [(16, 26), (16, 27)], CY[0])
    return save(s, out, "mob-4.png")



# ---------------------------------------------------------------------------
# 卷灵 Boss ×4（64×64）
# 同族：水墨卷轴/碑/横幅 + 霓虹核心；四款在【主体形制】【核心形状】【光效走向】区分：
#   boss-1 锦绣篇·卷灵：文蛛——残页为足、横卷为腹，品红球核
#   boss-2 巴别篇·卷灵：断碑——断裂方尖碑缠语根，青核在断口
#   boss-3 烟火篇·卷灵：百万只眼——横卷横幅 + 家电坟场，电蓝巨眼
#   boss-4 长安篇·卷灵：倒悬墨瀑——竖卷巨人，紫核，墨流向上
# ---------------------------------------------------------------------------
def _strip(s, pts, body, edge, w=3):
    """沿折线涂 w 像素宽的"纸条/肢体"，两侧压墨边（不再是细线，可读性靠宽度）。"""
    offs = list(range(-(w // 2), w // 2 + 1))
    for o in offs:
        band(s, [(x + o, y) for x, y in pts], body if o == 0 else body)
    band(s, [(x - (w // 2) - 1, y) for x, y in pts], edge)
    band(s, [(x + (w // 2) + 1, y) for x, y in pts], edge)
    return s


def boss1(out):
    s = new64(BOSS_COLS + MG + CY)
    # 六足：残页纸条（先画，压在卷轴下）
    legs = [
        [(22, 35), (13, 27), (5, 21)],
        [(20, 41), (9, 41), (2, 39)],
        [(22, 46), (12, 53), (6, 59)],
        [(44, 35), (53, 27), (61, 21)],
        [(46, 41), (57, 41), (63, 39)],
        [(44, 46), (54, 53), (60, 59)],
    ]
    for i, leg in enumerate(legs):
        _strip(s, leg, P1 if i % 2 == 0 else P2, K0, w=3)
        for j in range(1, 4):                       # 纸条上的墨字迹（1px 短划，不是字）
            x, y = leg[0][0] + (leg[-1][0] - leg[0][0]) * j // 4, leg[0][1] + (leg[-1][1] - leg[0][1]) * j // 4
            s.px(x - 1, y, K2)
            s.px(x + 1, y, K2)
    # 腹部：横置卷轴
    s.rect(20, 30, 46, 50, P2, fill=True)
    s.rect(20, 30, 46, 33, P1, fill=True)
    s.rect(20, 46, 46, 50, P3, fill=True)
    s.rect(20, 50, 46, 51, K0, fill=True)
    for x in range(24, 45, 6):                      # 残页墨行（短划）
        s.rect(x, 37, x + 3, 37, K3, fill=True)
        s.rect(x + 2, 41, x + 5, 41, K3, fill=True)
    # 卷轴两端木轴
    s.rect(16, 29, 20, 51, K1, fill=True)
    s.rect(46, 29, 50, 51, K1, fill=True)
    s.rect(16, 29, 20, 31, K3, fill=True)
    s.rect(46, 29, 50, 31, K3, fill=True)
    s.rect(17, 26, 19, 28, K2, fill=True)
    s.rect(47, 26, 49, 28, K2, fill=True)
    # 头：圆首前体（压住腹卷上缘）+ 螯肢
    s.circle(33, 23, 9, K1, fill=True)
    s.circle(32, 22, 8, K2, fill=True, only=K1)
    s.circle(30, 20, 4, K3, fill=True, only=K2)
    s.rect(24, 26, 42, 30, P1, fill=True)
    s.rect(24, 26, 42, 27, P0, fill=True)
    s.rect(25, 29, 41, 30, P3, fill=True)
    pm(s, [(24, 26), (42, 26)], K0)
    band(s, [(26, 30), (23, 34), (24, 38)], K2)
    band(s, [(27, 31), (25, 34), (26, 38)], K0)
    band(s, [(40, 30), (43, 34), (42, 38)], K2)
    band(s, [(39, 31), (41, 34), (40, 38)], K0)
    pm(s, [(30, 17), (30, 18), (34, 17), (34, 18), (32, 16)], K3)
    selout(s, K0)
    # 霓虹：复眼、品红球核、足端光斑
    s.rect(29, 21, 31, 22, K0, fill=True)
    s.rect(35, 21, 37, 22, K0, fill=True)
    s.px(30, 21, CY[2])
    s.px(36, 21, CY[2])
    s.px(29, 22, CY[1])
    s.px(35, 22, CY[1])
    s.px(30, 20, CY[3])
    s.px(36, 20, CY[3])
    s.circle(33, 41, 8, K1, fill=True)
    s.circle(33, 41, 6, MG[0], fill=True)
    s.circle(33, 41, 4, MG[1], fill=True)
    s.circle(33, 41, 2, MG[2], fill=True)
    s.rect(32, 39, 34, 40, MG[3], fill=True)
    s.px(30, 38, MG[2])
    pm(s, [(33, 32), (33, 31), (33, 50), (33, 51)], MG[0])
    for (x, y) in ((6, 21), (61, 21), (6, 20), (61, 20)):
        s.px(x, y, MG[1])
    pm(s, [(9, 41), (2, 39)], MG[0])
    pm(s, [(57, 41), (63, 39)], MG[0])
    s.px(5, 22, CY[1])
    s.px(62, 22, CY[1])
    return save(s, out, "boss-1.png")


def boss2(out):
    s = new64(BOSS_COLS + CY + MG)
    # 基座与下部碑身
    s.rect(18, 53, 46, 59, K2, fill=True)
    s.rect(18, 53, 46, 55, K3, fill=True)
    s.rect(20, 59, 44, 61, K1, fill=True)
    s.rect(24, 31, 40, 53, K2, fill=True)
    s.rect(24, 31, 28, 53, K3, fill=True)
    s.rect(25, 31, 27, 53, K4, fill=True)
    s.rect(37, 31, 40, 53, K1, fill=True)
    s.rect(39, 31, 40, 53, K0, fill=True)
    # 上部碑身 + 尖顶
    s.rect(24, 14, 40, 28, K2, fill=True)
    s.rect(24, 14, 28, 28, K3, fill=True)
    s.rect(25, 14, 27, 28, K4, fill=True)
    s.rect(37, 14, 40, 28, K1, fill=True)
    for k in range(7):
        s.rect(26 + k, 13 - k, 38 - k, 13 - k, K2, fill=True)
        s.px(26 + k, 13 - k, K4)
        s.px(27 + k, 13 - k, K3)
        s.px(38 - k, 13 - k, K0)
    s.px(32, 6, K3)
    s.px(32, 7, K4)
    # 断裂（锯齿）+ 断口错位
    for x in range(24, 41):
        for k in range(x % 3):
            s.px(x, 28 - k, None)
    for x in range(24, 41):
        for k in range((x + 1) % 3):
            s.px(x, 31 + k, None)
    for x in range(29, 36):
        s.px(x, 29, None)
    s.rect(30, 26, 34, 26, K0, fill=True)
    # 仪式横带（石色）+ 崩口
    s.rect(25, 17, 39, 18, S0, fill=True)
    s.rect(25, 17, 39, 17, S1, fill=True)
    pm(s, [(27, 18), (33, 18), (37, 18)], K0)
    s.rect(25, 45, 39, 46, S0, fill=True)
    s.rect(25, 46, 39, 46, S1, fill=True)
    pm(s, [(29, 45), (35, 45)], K0)
    # 风化裂纹
    for i, (pts, c) in enumerate((
        ([(30, 8), (31, 16), (30, 22), (32, 27)], K0),
        ([(34, 33), (33, 40), (35, 47), (34, 53)], K1),
        ([(27, 36), (26, 43)], K1),
    )):
        band(s, pts, c)
    s.noise(25, 33, 27, 52, K4, density=0.10, seed=3, only=K3)
    # 语根藤蔓（缠绕）
    vines = [
        [(20, 22), (26, 24), (20, 27), (27, 30)],
        [(42, 36), (35, 38), (42, 42), (36, 45)],
        [(22, 48), (30, 50), (24, 53)],
    ]
    for v in vines:
        band(s, v, K3)
    selout(s, K0)
    # 霓虹：断口青核 + 裂缝光 + 藤节
    s.circle(32, 29, 6, CY[0], fill=True)
    s.circle(32, 29, 4, CY[1], fill=True)
    s.circle(32, 29, 2, CY[2], fill=True)
    s.rect(31, 28, 32, 29, CY[3], fill=True)
    pm(s, [(30, 22), (33, 21), (29, 24), (34, 25), (32, 35), (30, 37), (33, 39)], CY[2])
    pm(s, [(31, 16), (31, 14), (33, 43), (32, 46)], CY[1])
    pm(s, [(27, 24), (20, 27), (35, 38), (42, 42), (30, 50)], MG[2])
    pm(s, [(21, 26), (41, 41), (29, 50)], MG[1])
    s.px(23, 30, MG[0])
    s.px(37, 47, MG[0])
    return save(s, out, "boss-2.png")


def boss3(out):
    s = new64(BOSS_COLS + CY + MG + BL)
    # 横幅卷轴
    s.rect(6, 24, 58, 44, P2, fill=True)
    s.rect(6, 24, 58, 27, P1, fill=True)
    s.rect(6, 41, 58, 44, P3, fill=True)
    s.rect(6, 44, 58, 45, K0, fill=True)
    s.rect(6, 23, 58, 23, K0, fill=True)
    for x in range(14, 56, 7):                      # 残页墨行
        s.rect(x, 29, x + 4, 29, K3, fill=True)
        s.rect(x + 2, 39, x + 5, 39, K3, fill=True)
    # 左端卷心（螺旋）
    s.circle(8, 34, 6, K1, fill=True)
    s.circle(8, 34, 4, P2, fill=True)
    s.circle(8, 34, 2, P3, fill=True)
    s.px(8, 34, K1)
    # 右端撕口
    for y in range(23, 46):
        for k in range((y + 1) % 4):
            s.px(58 - k, y, None)
    # 家电坟场（下方）
    s.rect(34, 44, 54, 58, K1, fill=True)
    s.rect(34, 44, 54, 46, K2, fill=True)
    s.rect(35, 47, 53, 57, K2, fill=True, only=K1)
    s.rect(36, 49, 52, 49, K0, fill=True)
    s.rect(36, 51, 38, 52, K3, fill=True)
    s.rect(41, 51, 43, 52, K3, fill=True)
    s.rect(46, 51, 48, 52, K3, fill=True)
    s.rect(8, 48, 22, 58, K1, fill=True)
    s.rect(8, 48, 22, 49, K2, fill=True)
    s.rect(10, 51, 20, 55, K2, fill=True)
    s.rect(26, 52, 32, 58, K1, fill=True)
    s.rect(26, 52, 32, 53, K2, fill=True)
    s.rect(24, 58, 56, 60, K1, fill=True, only=None)
    pm(s, [(24, 59), (56, 59)], K1)
    selout(s, K0)
    # 百万只眼（密集中段，疏密有致；每只=墨窝 + 霓虹瞳）
    eyes = [
        (12, 31, 2, CY), (17, 34, 3, MG), (23, 30, 2, BL), (28, 33, 3, CY),
        (36, 31, 2, MG), (41, 35, 4, CY), (48, 30, 2, BL), (53, 33, 3, CY),
        (14, 37, 3, MG), (20, 40, 2, CY), (44, 27, 3, MG), (50, 39, 2, CY),
        (55, 36, 2, MG), (10, 35, 2, BL), (26, 39, 2, MG), (38, 39, 3, BL),
    ]
    for (ex, ey, w, fam) in eyes:
        s.rect(ex - w // 2, ey, ex + w // 2, ey, K0, fill=True)
        s.rect(ex - w // 2, ey - 1, ex + w // 2, ey - 1, fam[0], fill=True)
        s.px(ex, ey - 1, fam[2])
        s.px(ex - 1, ey, fam[1])
    # 中央巨眼
    s.ellipse(22, 28, 38, 40, K0, fill=True)
    s.ellipse(23, 29, 37, 39, P0, fill=True)
    s.circle(30, 34, 4, BL[0], fill=True)
    s.circle(30, 34, 3, BL[1], fill=True)
    s.circle(30, 34, 1, BL[2], fill=True)
    pm(s, [(29, 32), (28, 33)], BL[3])
    s.px(30, 34, K0)
    for (dx, dy) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        pm(s, [(30 + dx * 5, 34 + dy * 5), (30 + dx * 6, 34 + dy * 6)], K0)
    pm(s, [(30, 26), (30, 42)], K0)
    # 家电上的霓虹
    s.circle(22, 52, 5, BL[0], fill=True, only=K2)
    s.circle(22, 52, 4, BL[1], fill=True, only=K2)
    s.circle(22, 52, 2, BL[2], fill=True, only=BL[1])
    s.rect(16, 52, 19, 53, CY[1], fill=True)
    s.rect(19, 52, 19, 53, CY[2], fill=True)
    s.rect(29, 55, 30, 56, MG[1], fill=True)
    s.rect(29, 44, 33, 44, MG[0], fill=True)
    s.rect(45, 54, 50, 54, CY[1], fill=True)
    s.rect(46, 54, 49, 54, CY[2], fill=True)
    # 卷轴下缘滴墨
    for x in (12, 27, 46):
        s.rect(x, 46, x, 47, K1, fill=True)
        s.px(x, 48, K2)
    return save(s, out, "boss-3.png")


def boss4(out):
    s = new64(BOSS_COLS + VI + CY)
    # 顶部卷轴横杆（悬着的卷）
    s.rect(19, 5, 45, 9, K1, fill=True)
    s.rect(19, 5, 45, 6, K3, fill=True)
    s.rect(21, 7, 43, 7, K4, fill=True)
    s.rect(18, 4, 20, 10, K0, fill=True)
    s.rect(44, 4, 46, 10, K0, fill=True)
    s.rect(20, 3, 22, 4, K2, fill=True)
    s.rect(42, 3, 44, 4, K2, fill=True)
    # 主体：上宽下窄的墨柱
    for y in range(11, 55):
        half = 12 - (y - 11) * 4 // 44
        s.rect(32 - half, y, 32 + half, y, K2, fill=True)
        s.rect(32 - half, y, 32 - half + 3, y, K3, fill=True)
        s.rect(32 + half - 2, y, 32 + half, y, K1, fill=True)
        s.px(32 + half, y, K0)
        s.px(32 - half - 1, y, K0)
    s.rect(32 - 8, 54, 32 + 8, 54, K0, fill=True)
    # 大袖（左右）
    s.polygon([(20, 20), (11, 26), (9, 34), (14, 38), (22, 36), (24, 26)], K2, fill=True)
    s.polygon([(44, 20), (53, 26), (55, 34), (50, 38), (42, 36), (40, 26)], K2, fill=True)
    s.polygon([(20, 21), (12, 26), (10, 33), (15, 36), (21, 34), (22, 26)], K3, fill=True)
    s.polygon([(44, 21), (52, 26), (54, 33), (49, 36), (43, 34), (42, 26)], K1, fill=True)
    band(s, [(14, 36), (22, 36)], K0)
    band(s, [(42, 36), (50, 36)], K0)
    # 衣纹（竖向，错位）
    for (x, y0, y1) in ((27, 20, 30), (35, 24, 34), (31, 40, 50), (29, 44, 52)):
        band(s, [(x, y0), (x, y1)], K1)
    s.noise(31, 14, 33, 50, K4, density=0.06, seed=11, only=K3)
    # 倒悬墨瀑的"河床"（上下贯通的浅色水道）
    for x in (26, 29, 32, 35, 38):
        for y in range(13, 52):
            if (x + y) % 7 < 4:
                s.px(x, y, K4)
            if (x * 3 + y) % 5 < 2:
                s.px(x, y, K5)
    # 下摆：向下的滴墨（3 处）+ 向上的墨滴（倒悬暗示）
    for x in (26, 32, 38):
        s.rect(x, 55, x, 56, K1, fill=True)
        s.px(x, 57, K2)
    pm(s, [(28, 12), (34, 12), (31, 10)], K3)
    selout(s, K0)
    # 霓虹：紫罗兰核心 + 逆流墨瀑的光 + 顶端光珠
    s.circle(32, 32, 8, VI[0], fill=True)
    s.circle(32, 32, 6, VI[1], fill=True)
    s.circle(32, 32, 4, VI[2], fill=True)
    s.rect(31, 30, 33, 33, VI[3], fill=True)
    s.px(30, 29, VI[3])
    pm(s, [(32, 22), (32, 20), (32, 43), (32, 45), (30, 46), (34, 46)], VI[2])
    pm(s, [(27, 24), (29, 21), (37, 24), (35, 21)], VI[1])
    s.px(32, 18, VI[1])
    s.px(26, 48, VI[0])
    s.px(38, 48, VI[0])
    # 上升的光点（墨瀑逆流）
    for (x, y) in ((24, 18), (30, 19), (34, 19), (40, 18), (28, 15), (36, 15)):
        s.px(x, y, VI[1])
        s.px(x, y - 1, VI[0])
    pm(s, [(26, 4), (27, 3), (38, 4), (37, 3), (32, 2), (31, 3)], K4)
    s.px(29, 2, K5)
    s.px(35, 2, K5)
    s.px(30, 3, CY[1])
    s.px(34, 3, CY[1])
    s.px(32, 2, CY[2])
    return save(s, out, "boss-4.png")


# ---------------------------------------------------------------------------
# drill-dummy.png —— 练功木人桩 32×32（Plan 7 · T4 / D46）
# 用途：木桩练功的"敌人"位。**尺寸刻意取 32×32（与小怪同档）**：练功用遭遇战参数，
# 木桩就该是小怪那个体量（64×64 是卷灵的档，渲染时两者都是 2× 放大 ⇒ 会显得比小怪大一倍）。
# 绘制口径与其它素材一致，但**刻意不用霓虹**——木桩是练功对象，不是怪物（PRD §7 / LORE §6）。
# 剪影优先：宽十字底座 → 粗桩身 → 两条上臂 + 一条中臂 → 短腿，1x 下一眼是"人形桩"。
# ---------------------------------------------------------------------------
def dummy(out):
    """练功木人桩：木色三臂桩 + 绳箍 + 十字底座，左上来光。

    二轮修订（目检 6× 后改的四处）：①底座两端做成与横梁连通的翘起（首版像挂了两块小方块）；
    ②桩顶收窄到 r=3 并去掉多余的"帽子"方块（首版读成棒棒糖头）；③木纹改成不等长的断续线
    （首版每 6px 一道等长横线，机械感重）；④中臂上移一格、绳箍下移一格，腾开下半身的拥挤。
    """
    s = new32(INK + PAPER + SEPIA)
    # ---- 底座（先画，桩身压住中段）----
    s.rect(4, 27, 27, 30, S1, fill=True)           # 横梁
    s.rect(4, 27, 27, 28, S0, fill=True)           # 梁上缘受光
    s.rect(4, 30, 27, 30, S2, fill=True)           # 梁下缘背光
    s.rect(3, 25, 7, 27, S1, fill=True)            # 左端翘起（与梁连通，不是浮块）
    s.rect(3, 25, 7, 26, S0, fill=True)
    s.rect(24, 25, 28, 27, S1, fill=True)          # 右端翘起
    s.rect(24, 25, 28, 26, S0, fill=True)
    # ---- 短腿：从左下斜插到桩底（三稿下移一格 + 上缘受光，与底座/绳箍分开）----
    _strip(s, [(15, 24), (11, 27), (8, 29)], S1, K0, w=3)
    band(s, [(15, 23), (11, 26), (8, 28)], S0)
    # ---- 桩身 ----
    s.rect(12, 7, 19, 27, S1, fill=True)
    s.rect(12, 7, 14, 27, S0, fill=True)           # 左缘受光（光自左上）
    s.rect(18, 7, 19, 27, S2, fill=True)           # 右缘背光
    # 木纹：不等长、不等距的断续深线（避免机械感）
    s.rect(16, 12, 17, 12, S2, fill=True)
    s.rect(15, 19, 17, 19, S2, fill=True)
    s.px(16, 24, S2)
    # ---- 桩顶：窄圆首（收进桩身，不做棒棒糖头）----
    s.circle(16, 6, 3, S1, fill=True)
    s.circle(15, 5, 2, S0, fill=True, only=S1)
    # 三稿：去掉头顶那颗孤立白点（1px 白在头顶会读成"眼睛/鬼脸"，而这是木桩）
    # ---- 三臂：上左 / 上右 / 中左（3px 粗、端头圆）----
    s.rect(6, 11, 13, 13, S1, fill=True)
    s.rect(6, 11, 13, 11, S0, fill=True)
    s.circle(6, 12, 1, S1, fill=True)
    s.rect(13, 11, 13, 13, S2, fill=True)          # 臂根 1px 暗线：把臂与桩/绳箍分开
    s.rect(18, 15, 25, 17, S1, fill=True)
    s.rect(18, 15, 25, 15, S0, fill=True)
    s.circle(25, 16, 1, S1, fill=True)
    s.rect(18, 15, 18, 17, S2, fill=True)
    s.rect(7, 19, 12, 21, S1, fill=True)
    s.rect(7, 19, 12, 19, S0, fill=True)
    s.circle(7, 20, 1, S1, fill=True)
    s.rect(12, 19, 12, 21, S2, fill=True)
    # ---- 绳箍：两道（PAPER 系，与木色拉开；上箍上移一格腾开臂根，下箍上移到腿根之上）----
    for by in (8, 22):
        s.rect(12, by, 19, by + 1, P3, fill=True)
        s.rect(12, by, 19, by, P4, fill=True)
        for sx in (13, 16, 18):
            s.px(sx, by + 1, P4)
    # ---- 轮廓与磨损 ----
    selout(s, K0)
    s.px(9, 12, P4)                                # 臂上磨痕
    s.px(22, 16, P4)
    s.px(9, 20, P4)
    return save(s, out, "drill-dummy.png")


# ---------------------------------------------------------------------------
# bg-arena.png —— 64×64 可平铺"数据荒原"地面（无缝）
# 做法：所有笔触都按 64 取模落点（跨边的特征自动从对边接回来），保证 torus 上连续。
# 口径：只用墨/宣纸/赭石（荒原上是混沌的地盘，但霓虹铁律留给怪物本体）。
# ---------------------------------------------------------------------------
def _bline(x0, y0, x1, y1):
    """Bresenham 点列（不 clip），配合取模落点画跨边笔触。"""
    pts = []
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        pts.append((x0, y0))
        if x0 == x1 and y0 == y1:
            return pts
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy


def _wpx(s, x, y, c, size=64):
    s.px(x % size, y % size, c)


def _wline(s, pts, c, size=64, thick=0):
    for i in range(len(pts) - 1):
        for (x, y) in _bline(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]):
            _wpx(s, x, y, c, size)
            if thick:
                _wpx(s, x, y + 1, c, size)


def _wrect(s, x0, y0, x1, y1, c, size=64):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            _wpx(s, x, y, c, size)


def bg_arena(out):
    # 平铺观感（T11 会 5×3.75 次铺满 320×240）——三版教训：
    #   ① 跨整块的长裂纹 ⇒ 平铺后是一眼可辨的重复花纹；
    #   ② 等长短斜线 ⇒ 变成"鳞片/箭头"底纹，比裂纹更吵；
    #   ③ 大块土斑 ⇒ 变成花布，且规则分布读成点阵。
    # 结论：64px 的块里**不能有比 4px 更大、比底色更跳的特征**，否则重复必被看见。
    # 定稿 = 高颗粒底（低对比抖动）+ ≤4px 的碎屑（覆盖率 ~8%）+ 几笔 5px 墨痕（跨边接回）。
    # 所有笔触都按 64 取模落点 ⇒ 跨边特征自动从对边接回来（真无缝，非"切一刀"）。
    s = new64(INK + PAPER + SEPIA)
    s.rect(0, 0, 63, 63, P2, fill=True)
    s.dither(0, 0, 63, 63, P2, P3, mix=0.36, pattern="bayer4")
    s.dither(0, 0, 63, 63, P2, P4, mix=0.10, pattern="bayer8")
    # 低对比土色斑（2–3px，只用 P4：与底色同族，不抢读）
    for (x, y) in ((7, 9), (23, 4), (41, 13), (55, 6), (14, 22), (31, 19), (48, 26), (60, 30),
                   (4, 37), (20, 34), (37, 41), (52, 45), (11, 51), (27, 55), (44, 58), (58, 61)):
        _wpx(s, x, y, P4)
        _wpx(s, x + 1, y, P4)
        _wpx(s, x, y + 1, P4)
        if (x + y) % 3:
            _wpx(s, x + 1, y + 1, P4)
    # 小碎石（2×2，K4 + 1px K5 高光，尺寸不一；12 处散点，非点阵）
    for (x, y) in ((9, 24), (36, 21), (56, 34), (22, 56), (46, 41), (0, 52),
                   (62, 22), (28, 38), (14, 11), (44, 28), (33, 50), (52, 13)):
        _wrect(s, x, y, x + 1, y + 1, K4)
        _wpx(s, x, y, K5)
        _wpx(s, x + 1, y + 2, K3)
    # 墨痕（5–6px，K4 单像素线；三条里两条故意压边）
    _wline(s, [(-2, 17), (3, 19)], K4)
    _wline(s, [(30, 44), (35, 46)], K4)
    _wline(s, [(59, 7), (64, 9)], K4)
    # 墨点（1px 成对 + 1px 高光，不是孤立脏点）
    for (x, y) in ((20, 16), (48, 24), (12, 8), (36, 42), (54, 52), (4, 44), (30, 34), (40, 55)):
        _wpx(s, x, y, K4)
        _wpx(s, x + 1, y, K5)
    # 枯草（赭石短划，成簇：画面唯一暖色）
    for (x, y) in ((14, 36), (33, 12), (52, 58), (6, 18), (44, 30), (26, 2), (58, 40), (20, 28)):
        _wline(s, [(x, y), (x + 1, y - 3)], S0)
        _wline(s, [(x + 2, y), (x + 2, y - 2)], S1)
        _wline(s, [(x + 3, y), (x + 4, y - 3)], S0)
    return save(s, out, "bg-arena.png", rgb=True)

# ---------------------------------------------------------------------------
# 序章 8 屏（64×64，原地覆盖 T6 灰阶占位件；语义见 assets/narrative/prologue.json）
# 口径：水墨为底；霓虹只出现在混沌/云端相关物（P2 数据溢出、P4 云端失效、P7 故障月）；
#       古法相关（P5 残谱、P6 授艺的卡）用纸色/赭石暖光，不给霓虹。
# 全部不透明 RGB：它们是 <img> 直接铺满插画框的整幅画面。
# ---------------------------------------------------------------------------
def _crowd(s, x, y, stiff=True):
    """街头呆立的墨色小人物（4px 宽 10px 高）。"""
    s.rect(x, y + 3, x + 3, y + 8, K1, fill=True)     # 身
    s.rect(x + 1, y, x + 2, y + 2, K0, fill=True)     # 头
    s.rect(x + 1, y + 3, x + 2, y + 5, K2, fill=True)
    s.px(x, y + 4, K3)
    s.px(x, y + 9, K0)
    s.px(x + 3, y + 9, K0)
    if not stiff:
        pm(s, [(x - 1, y + 2), (x - 1, y + 1)], K0)
        pm(s, [(x + 4, y + 2), (x + 4, y + 1)], K0)


def prologue1(out):
    """云端盛世：霓虹城市 + 头顶悬浮发光的数据云。"""
    s = new64(INK + PAPER + SEPIA + CY + MG + BL)
    s.gradient_dither(0, 0, 63, 40, [K2, K3, K4], axis="v", pattern="bayer4")
    # 数据云（霓虹只在这里）
    clouds = [(14, 10, 9), (34, 7, 11), (52, 14, 7), (24, 18, 6)]
    for (cx, cy, r) in clouds:
        s.circle(cx, cy, r, CY[0], fill=True)
        s.circle(cx - 1, cy - 1, r - 2, CY[1], fill=True)
        s.circle(cx + 2, cy, r - 3, BL[1], fill=True)
        s.circle(cx - 2, cy + 1, 2, CY[2], fill=True)
        pm(s, [(cx + r - 2, cy - r + 2), (cx - r + 3, cy + r - 2)], CY[3])
        for k in range(cy + r, 40, 3):        # 云端垂下的数据帘
            s.px(cx, k, CY[1] if (k + cx) % 2 else CY[0])
    # 天际线
    sky = [(0, 30, 8), (9, 24, 6), (16, 34, 5), (22, 27, 7), (30, 36, 4),
           (35, 29, 6), (42, 33, 5), (48, 22, 7), (56, 31, 8)]
    for (x, y, w) in sky:
        s.rect(x, y, min(63, x + w - 1), 46, K1, fill=True)
        s.rect(x, y, min(63, x + w - 1), y, K0, fill=True)
        for wy in range(y + 3, 44, 4):
            if (x + wy) % 3 == 0:
                s.px(x + 1, wy, CY[1])
            if (x + wy) % 5 == 0:
                s.px(min(63, x + w - 2), wy + 1, BL[1])
    # 行人 + 头顶的云
    for (x, y) in ((6, 52), (18, 53), (31, 52), (44, 53), (56, 54)):
        _crowd(s, x, y)
        s.px(x + 1, y + 2, K0)
        s.rect(x, y - 2, x + 2, y - 2, CY[1], fill=True)
        s.px(x + 1, y - 3, CY[2])
    s.rect(0, 61, 63, 63, K1, fill=True)
    s.dither(0, 58, 63, 60, K1, K2, mix=0.5, pattern="bayer4")
    return save(s, out, "prologue-01-cloud-age.png", rgb=True)


def prologue2(out):
    """数据溢出：机房窗外野草爬过电缆，黑色液体聚成兽形。"""
    s = new64(INK + PAPER + SEPIA + CY + MG)
    s.rect(0, 0, 63, 63, K2, fill=True)
    s.dither(0, 0, 63, 63, K2, K3, mix=0.35, pattern="bayer8")
    # 窗（左上）：窗外夜空 + 野草
    s.rect(4, 5, 28, 26, K1, fill=True)
    s.rect(5, 6, 27, 25, K0, fill=True)
    s.rect(4, 4, 28, 5, P3, fill=True)
    s.rect(4, 25, 28, 26, P3, fill=True)
    s.rect(4, 4, 4, 26, P3, fill=True)
    s.rect(28, 4, 28, 26, P3, fill=True)
    s.dither(6, 7, 26, 17, K1, K2, mix=0.4, pattern="bayer4")
    pm(s, [(9, 10), (12, 9), (15, 11), (22, 10)], K4)
    for (x, h) in ((7, 6), (11, 9), (16, 7), (20, 10), (24, 8)):
        band(s, [(x, 24), (x + 1, 24 - h)], S0)          # 野草
        band(s, [(x + 1, 24), (x + 2, 23 - h)], S1)
    band(s, [(5, 20), (14, 23), (22, 20), (27, 23)], K3)  # 电缆
    band(s, [(5, 21), (14, 24), (22, 21), (27, 24)], K0)
    # 机房机柜
    for x in (6, 22, 38, 52):
        s.rect(x, 28, x + 9, 52, K1, fill=True)
        s.rect(x, 28, x, 52, K0, fill=True)
        s.rect(x + 9, 28, x + 9, 52, K0, fill=True)
        for y in range(31, 50, 4):
            s.rect(x + 2, y, x + 7, y + 1, K2, fill=True)
            s.px(x + 3, y, K4)
    s.rect(6, 28, 15, 29, K3, fill=True)
    s.rect(38, 28, 47, 29, K3, fill=True)
    s.px(14, 33, CY[1])
    s.px(46, 37, CY[0])
    # 黑液聚成兽形
    s.rect(0, 52, 63, 63, K2, fill=True)                # 地面提亮，黑色兽形才读得出
    s.dither(0, 52, 63, 63, K2, K3, mix=0.35, pattern="bayer4")
    s.rect(0, 51, 63, 52, K0, fill=True)
    # 黑液聚成的兽形（暗块压在亮地上）
    s.circle(30, 59, 13, K0, fill=True)
    s.circle(21, 60, 10, K0, fill=True)
    s.circle(41, 60, 10, K0, fill=True)
    s.circle(30, 50, 8, K0, fill=True)
    s.circle(31, 44, 5, K0, fill=True)                  # 昂起的头
    s.circle(24, 47, 4, K0, fill=True)
    s.circle(38, 47, 4, K0, fill=True)
    s.px(28, 40, K0)
    s.px(34, 40, K0)
    s.dither(18, 44, 44, 52, K0, K1, mix=0.5, pattern="bayer4")
    pm(s, [(27, 43), (28, 42), (29, 41)], K1)
    pm(s, [(35, 43), (34, 42), (33, 41)], K1)
    s.rect(26, 45, 28, 46, MG[2], fill=True)            # 兽眼
    s.rect(34, 45, 36, 46, MG[2], fill=True)
    s.px(27, 45, MG[3])
    s.px(35, 45, MG[3])
    pm(s, [(24, 52), (22, 54), (26, 56)], K1)
    s.px(33, 38, CY[2])
    s.px(31, 40, CY[1])
    for x in range(4, 60, 6):
        s.px(x, 58, K1)
        s.px(x + 2, 60, K1)
    return save(s, out, "prologue-02-data-flood.png", rgb=True)


def prologue3(out):
    """大遗忘：街头人群呆立，手机滑落，有人抓着头发。"""
    s = new64(INK + PAPER + SEPIA + CY)
    s.rect(0, 0, 63, 63, P1, fill=True)
    s.dither(0, 0, 63, 30, P1, P2, mix=0.35, pattern="bayer4")
    s.dither(0, 30, 63, 63, P2, P3, mix=0.3, pattern="bayer8")
    s.rect(0, 44, 63, 45, K4, fill=True)              # 路缘
    s.rect(0, 46, 63, 63, P3, fill=True)
    s.dither(0, 46, 63, 63, P3, P4, mix=0.25, pattern="bayer4")
    # 呆立的人（其中一个抓头发、一个蹲下）
    for (x, y) in ((4, 34), (15, 35), (28, 34), (40, 35)):
        _crowd(s, x, y)
    _crowd(s, 51, 36)
    pm(s, [(51, 33), (50, 31), (49, 30), (53, 33), (54, 31), (55, 30)], K1)   # 抓头发
    s.rect(21, 40, 24, 43, K1, fill=True)             # 蹲着的人
    s.rect(21, 40, 22, 40, K0, fill=True)
    pm(s, [(33, 41), (34, 42)], K0)
    # 滑落的手机（屏还亮着最后一点青光）
    s.rect(45, 44, 48, 47, K0, fill=True)
    s.rect(46, 45, 47, 46, CY[0], fill=True)
    s.px(46, 45, CY[1])
    s.rect(9, 46, 11, 47, K0, fill=True)
    # 留白处的墨渍（成簇的散点，不是格子纹）
    for (bx, by, n) in ((57, 16, 9), (3, 13, 7)):
        for i in range(n):
            x = bx + (i * 5 + i * i) % 6
            y = by + (i * 3 + i * i * 2) % 8
            s.px(x, y, K3 if i % 3 else K4)
            if i % 2:
                s.px(x + 1, y, K4)
    s.px(59, 20, K2)
    s.px(5, 17, K2)
    return save(s, out, "prologue-03-great-forgetting.png", rgb=True)


def prologue4(out):
    """云端失效：天空中的数据云成片熄灭。"""
    s = new64(INK + PAPER + CY + BL)
    s.gradient_dither(0, 0, 63, 63, [P2, P1, P3], axis="v", pattern="bayer4")
    # 云朵：还亮着的是纸色云，熄灭的是墨色云（成片熄灭）
    clouds = [(9, 11, 7, True), (24, 8, 9, False), (45, 11, 8, True), (57, 21, 5, False),
              (15, 27, 8, False), (33, 23, 7, True), (50, 33, 7, False), (23, 40, 6, False),
              (40, 42, 6, False), (7, 42, 5, False)]
    for (cx, cy, r, alive) in clouds:
        edge = P1 if alive else K4
        body = P2 if alive else K3
        s.circle(cx, cy, r, edge, fill=True)
        s.circle(cx - 1, cy - 1, r - 2, body, fill=True)
        s.circle(cx + r - 2, cy + 1, max(1, r - 3), edge, fill=True, only=body)
        if alive:
            s.px(cx, cy, CY[2])
            s.px(cx - 1, cy + 1, CY[1])
            s.px(cx + 2, cy - 1, CY[1])
        else:
            s.circle(cx, cy, r - 1, K1, fill=True)      # 熄灭的云整团变墨，不留同心环
            s.circle(cx - 1, cy - 1, r - 3, K2, fill=True)
            s.px(cx - 1, cy, K0)
            s.px(cx + 2, cy + 1, K0)
    # 熄灭后掉下来的数据点（由亮到灭）
    for (x, y, c) in ((24, 20, CY[1]), (25, 24, CY[0]), (15, 36, BL[0]),
                      (50, 41, CY[0]), (33, 32, BL[1]), (41, 48, CY[0])):
        s.px(x, y, c)
        s.px(x + 1, y, c)
    s.px(18, 33, CY[0])
    s.px(45, 44, BL[0])
    # 天际线（细，压在下缘）
    for (x, w, h) in ((0, 10, 10), (11, 6, 6), (18, 8, 12), (27, 5, 7),
                      (33, 9, 11), (43, 6, 6), (50, 14, 9)):
        s.rect(x, 63 - h, x + w - 1, 63, K1, fill=True)
        s.rect(x, 63 - h, x + w - 1, 63 - h, K0, fill=True)
        s.px(x + 1, 63 - h + 2, CY[1])
    return save(s, out, "prologue-04-cloud-down.png", rgb=True)


def prologue5(out):
    """古法：破庙中一卷泛黄的记忆术残谱自动翻页（纯水墨+赭石，不给霓虹）。"""
    s = new64(INK + PAPER + SEPIA)
    s.rect(0, 0, 63, 63, K2, fill=True)
    s.dither(0, 0, 63, 63, K2, K3, mix=0.3, pattern="bayer8")
    # 后墙的破洞与窗
    s.rect(40, 6, 60, 24, K1, fill=True)
    s.rect(40, 6, 60, 7, P3, fill=True)
    s.rect(40, 6, 41, 24, P3, fill=True)
    s.rect(59, 6, 60, 24, P3, fill=True)
    s.rect(40, 23, 60, 24, P3, fill=True)
    # 光柱（纸白抖动）射到残谱上
    for i in range(26):
        for x in range(42 - i // 2, 44 + i // 2):
            if (x * 3 + i * 5) % 7 < 3:
                s.px(x, 25 + i, P0)
    # 立柱
    for x in (2, 22, 56):
        s.rect(x, 0, x + 5, 48, K1, fill=True)
        s.rect(x, 0, x + 1, 48, K3, fill=True)
        s.rect(x + 5, 0, x + 5, 48, K0, fill=True)
        s.px(x + 2, 10, K4)
    s.rect(0, 0, 63, 3, K1, fill=True)                 # 断梁
    band(s, [(8, 2), (30, 8), (52, 3)], K1)
    band(s, [(8, 3), (30, 9), (52, 4)], K0)
    s.px(31, 9, K2)
    # 地面
    s.rect(0, 48, 63, 63, K3, fill=True)
    s.dither(0, 48, 63, 63, K3, K4, mix=0.35, pattern="bayer4")
    s.rect(0, 47, 63, 48, K0, fill=True)
    # 泛黄残谱（自动翻页：右页卷起）
    s.rect(14, 34, 46, 54, P2, fill=True)
    s.rect(14, 34, 46, 35, P0, fill=True)
    s.rect(14, 53, 46, 54, P4, fill=True)
    s.rect(14, 34, 15, 54, P3, fill=True)
    s.rect(45, 34, 46, 54, P3, fill=True)
    s.rect(29, 34, 30, 54, K4, fill=True)              # 中缝
    for i, y in enumerate(range(38, 52, 3)):           # 墨字迹（1px 短划，不是字）
        for x in range(18 + (i % 2), 28, 2):
            s.px(x, y, S1)
        for x in range(33, 43 - (i % 3), 2):
            s.px(x, y, S1)
    s.px(20, 40, S0)
    s.px(36, 43, S0)
    # 翻起的右页（卷起）
    s.polygon([(45, 34), (54, 30), (58, 34), (56, 44), (46, 48)], P1, fill=True)
    s.polygon([(46, 35), (53, 31), (56, 35), (54, 42), (47, 45)], P2, fill=True)
    band(s, [(45, 34), (54, 30), (58, 34), (56, 44), (46, 48)], K0)
    band(s, [(46, 35), (53, 31)], K2)
    s.rect(30, 30, 31, 34, K1, fill=True)
    # 尘点
    pm(s, [(20, 22), (26, 14), (34, 18), (48, 12), (12, 20)], P0)
    return save(s, out, "prologue-05-old-art.png", rgb=True)


def prologue6(out):
    """授艺：剪影人物把一张发光的卡片按入胸口（暖赭光，不是霓虹）。"""
    s = new64(INK + PAPER + SEPIA)
    s.rect(0, 0, 63, 63, P2, fill=True)
    s.dither(0, 0, 63, 63, P2, P3, mix=0.3, pattern="bayer4")
    s.dither(0, 44, 63, 63, P2, P4, mix=0.35, pattern="bayer8")
    # 剪影人物（面左，抬手按卡入胸）
    # 暖光晕（抖动，不是同心圆靶）
    s.dither(24, 28, 46, 50, S0, P3, mix=0.35, pattern="bayer4", only=P2)
    s.dither(26, 30, 44, 48, P4, "keep", mix=0.35, pattern="bayer8", only=P3)
    s.rect(31, 13, 42, 25, K1, fill=True)              # 头
    s.rect(31, 13, 40, 15, K0, fill=True)
    s.rect(34, 18, 42, 23, P4, fill=True, only=K1)     # 面（留纸色）
    s.px(38, 20, K0)
    s.px(37, 19, K1)
    s.rect(30, 26, 44, 28, K2, fill=True)              # 颈肩
    s.rect(30, 26, 44, 26, K3, fill=True)
    s.rect(28, 27, 46, 30, K2, fill=True)
    s.rect(28, 27, 46, 28, K3, fill=True)
    s.rect(31, 31, 43, 50, K1, fill=True)              # 身
    s.rect(31, 31, 34, 50, K2, fill=True)
    s.rect(28, 31, 31, 40, K1, fill=True)              # 左臂（抬起）
    s.rect(25, 29, 29, 34, K1, fill=True)
    s.rect(25, 29, 29, 30, K2, fill=True)
    s.rect(45, 32, 49, 46, K1, fill=True)              # 右臂（垂）
    s.rect(31, 51, 35, 58, K1, fill=True)              # 腿
    s.rect(39, 51, 43, 58, K1, fill=True)
    s.rect(29, 58, 37, 59, K0, fill=True)
    s.rect(37, 58, 45, 59, K0, fill=True)
    # 卡片（纸色方卡 + 墨边；按进胸口的那只手从右侧伸过来）
    s.rect(32, 34, 38, 42, K0, fill=True)
    s.rect(33, 35, 37, 41, P0, fill=True)
    s.rect(33, 35, 37, 36, S0, fill=True)
    s.rect(34, 38, 36, 39, P1, fill=True)
    s.px(33, 40, P2)
    s.rect(38, 36, 44, 38, K1, fill=True)
    s.rect(38, 36, 44, 36, K2, fill=True)
    s.rect(41, 39, 47, 41, K1, fill=True)
    selout(s, K0)
    # 背景墨渍
    s.dither(2, 8, 14, 22, K4, P2, mix=0.3, pattern="bayer4")
    s.dither(50, 8, 62, 24, K3, P2, mix=0.25, pattern="bayer4")
    return save(s, out, "prologue-06-teaching.png", rgb=True)


def prologue7(out):
    """出发：侠客背影走向数据荒原，水墨山脊线上挂着故障感的霓虹月。"""
    s = new64(INK + PAPER + SEPIA + MG + CY)
    s.gradient_dither(0, 0, 63, 40, [P1, P2, P3], axis="v", pattern="bayer4")
    # 故障霓虹月（混沌相关 ⇒ 允许霓虹）
    s.circle(46, 13, 7, MG[0], fill=True)
    s.circle(46, 13, 6, MG[1], fill=True)
    s.circle(45, 12, 4, MG[2], fill=True)
    s.px(45, 11, MG[3])
    s.rect(41, 12, 51, 12, K0, fill=True)              # 横向切片（故障）
    s.rect(43, 16, 50, 16, MG[0], fill=True)
    s.rect(42, 9, 44, 9, MG[2], fill=True)
    s.rect(38, 13, 41, 13, MG[1], fill=True)
    s.rect(52, 12, 54, 12, MG[1], fill=True)
    s.px(49, 6, MG[1])
    s.px(50, 5, MG[0])
    s.px(40, 20, MG[1])
    s.px(39, 21, MG[0])
    # 墨色山脊（两层，远淡近浓）
    far = [(0, 34), (8, 28), (16, 33), (24, 26), (32, 32), (40, 27), (48, 33), (56, 29), (63, 32)]
    band(s, far, K5)
    for x in range(64):
        y = far[min(len(far) - 1, x * (len(far) - 1) // 63)][1]
        s.rect(x, y + 1, x, 40, K4, fill=True, only=None)
    near = [(0, 44), (10, 38), (20, 43), (30, 36), (42, 42), (52, 37), (63, 43)]
    for i in range(len(near) - 1):
        for (x, y) in _bline(near[i][0], near[i][1], near[i + 1][0], near[i + 1][1]):
            s.rect(x, y, x, 46, K2, fill=True)
            s.px(x, y, K1)
    s.rect(0, 45, 63, 63, K2, fill=True)
    s.dither(0, 45, 63, 63, K2, K1, mix=0.4, pattern="bayer4")
    # 荒原上的枯草与碎石
    for (x, y) in ((8, 50), (22, 54), (40, 52), (56, 48), (16, 60), (48, 59)):
        band(s, [(x, y), (x + 1, y - 3)], S0)
        band(s, [(x + 2, y), (x + 3, y - 2)], S1)
    pm(s, [(30, 56), (31, 56), (32, 57)], K3)
    pm(s, [(12, 52), (13, 52), (14, 53)], K3)
    # 侠客背影（背剑，走向荒原深处）
    s.rect(28, 40, 33, 43, K0, fill=True)              # 头
    s.rect(27, 44, 34, 52, K0, fill=True)              # 身
    s.rect(27, 44, 28, 52, K1, fill=True)
    s.rect(29, 54, 31, 60, K0, fill=True)              # 腿
    s.rect(32, 54, 34, 60, K0, fill=True)
    s.rect(26, 60, 31, 61, K0, fill=True)
    s.rect(32, 60, 37, 61, K0, fill=True)
    band(s, [(33, 44), (36, 53)], K2)                  # 背上的剑
    band(s, [(34, 44), (37, 53)], K0)
    s.px(35, 42, K2)
    s.px(35, 43, K1)
    s.rect(29, 47, 32, 47, K1, fill=True)
    s.px(26, 46, K1)
    s.px(35, 46, K1)
    # 归鸟
    for (x, y) in ((20, 14), (25, 11), (31, 16)):
        s.px(x, y, K2)
        s.px(x + 1, y - 1, K2)
        s.px(x + 2, y, K2)
    return save(s, out, "prologue-07-departure.png", rgb=True)


def prologue8(out):
    """标题画面《知识侠客》——不画任何文字/汉字（标题由 DOM 渲染），只做水墨构图。"""
    s = new64(INK + PAPER + SEPIA + CINNABAR)
    s.rect(0, 0, 63, 63, P1, fill=True)
    s.dither(0, 0, 63, 63, P1, P2, mix=0.35, pattern="bayer8")
    s.dither(0, 40, 63, 63, P1, P3, mix=0.3, pattern="bayer4")
    # 大笔横披：实心墨，两端收锋（飞白只在边缘，不做规整点阵）
    s.rect(4, 30, 59, 33, K0, fill=True)
    s.rect(2, 31, 5, 32, K0, fill=True)
    s.px(1, 31, K0)
    for (x, y) in ((60, 30), (61, 31), (60, 32), (62, 30), (62, 33), (63, 31), (63, 32),
                   (58, 29), (58, 34), (55, 28), (56, 35), (50, 29), (51, 34)):
        s.px(x, y, K0 if (x + y) % 2 else K1)
    for (x, y) in ((12, 30), (18, 33), (24, 30), (30, 33), (37, 30), (43, 33), (49, 30),
                   (15, 33), (27, 33), (46, 30), (54, 33)):
        s.px(x, y, P2)
        s.px(x + 1, y, P1 if x % 3 else P2)
    # 搁在笔意上的剑（3px 厚：墨面 + 上缘高光 + 下端墨边）
    band(s, [(20, 47), (52, 15)], K1)
    band(s, [(21, 48), (53, 16)], K0)
    band(s, [(19, 46), (51, 14)], K4)
    for t in range(0, 33, 2):
        s.px(19 + t, 45 - t, K5)
    s.rect(17, 44, 22, 49, K2, fill=True)              # 剑格
    s.px(16, 45, K4)
    s.px(23, 48, K4)
    s.px(16, 50, K0)
    s.px(23, 43, K0)
    s.rect(14, 50, 17, 52, S0, fill=True)              # 柄
    s.rect(14, 50, 17, 50, S1, fill=True)
    s.px(15, 53, K0)
    s.px(18, 53, K0)
    s.px(13, 51, K0)
    s.px(13, 54, K0)
    s.px(18, 49, K0)
    s.px(53, 15, K2)                                   # 剑首
    s.px(54, 14, K0)
    s.px(55, 14, K0)
    s.px(54, 16, K0)
    # 朱砂落款印（纯色方块 + 缺口，不含汉字）
    s.rect(48, 50, 53, 55, CINNABAR[0], fill=True)
    s.rect(49, 51, 52, 54, CINNABAR[1], fill=True)
    s.px(50, 52, CINNABAR[0])
    s.px(52, 51, CINNABAR[0])
    s.px(51, 54, CINNABAR[0])
    return save(s, out, "prologue-08-title.png", rgb=True)




# ---------------------------------------------------------------------------
# 暗线三幕（64×64，LORE §5.3；assets/narrative/arc.json 的 art 路径）
# 三张必须"一眼看出是同一世界的三个时刻"：共用同一副荒原地基（_waste_ground）、同一墨/纸基调、
# 同一地平线口径；区别只在【主体】与【光从哪来】：
#   arc-1 源头：夜墨荒原，残片全部朝远方一点微光倾斜（引力感）
#   arc-2 真相：纸白天光，云端残骸把"知识"投成地上的墨影（影子无脸、不是凶兽）
#   arc-3 留白：墨色城门，门缝一线光（极克制），侠客立于门前，门后不画
# 霓虹只出现在云端/混沌一侧；第三幕门缝光是唯一例外（青紫一线，1px）。
# ---------------------------------------------------------------------------
def _waste_ground(s, y0):
    """三幕共用的荒原地基：纸灰颗粒 + 小碎石 + 枯草 + 零星墨点 + 地平线墨线。"""
    s.rect(0, y0, 63, 63, P2, fill=True)
    s.dither(0, y0, 63, 63, P2, P3, mix=0.36, pattern="bayer4")
    s.dither(0, y0, 63, 63, P2, P4, mix=0.10, pattern="bayer8")
    s.rect(0, y0, 63, y0, K0, fill=True)
    s.dither(0, y0 + 1, 63, min(63, y0 + 4), K4, "keep", mix=0.35, pattern="bayer4", only=P3)
    for (x, y) in ((9, 51), (24, 58), (41, 46), (56, 54), (14, 44), (33, 61), (50, 41)):
        s.rect(x, y, x + 1, y + 1, K4, fill=True)
        s.px(x, y, K5)
    for (x, y) in ((6, 58), (20, 49), (37, 55), (52, 60), (28, 45)):
        band(s, [(x, y), (x + 1, y - 3)], S0)
        band(s, [(x + 2, y), (x + 2, y - 2)], S1)
        band(s, [(x + 3, y), (x + 4, y - 3)], S0)
    for (x, y) in ((17, 57), (45, 52), (31, 42)):
        s.px(x, y, K4)
        s.px(x + 1, y, K5)
    return s


def _shard(s, x, y, n, edge, slope=1):
    """残片：从卷轴上撕下来的纸条（纸面 P1 + 上下墨边 K0/K2），朝光源一端带 1px 霓虹残光。"""
    for i in range(n):
        xx, yy = x + i, y + slope * i
        s.px(xx, yy - 1, K0)
        s.px(xx, yy, P1)
        s.px(xx, yy + 1, K2)
        s.px(xx, yy + 2, K0)
        if i in (1, n - 2):
            s.px(xx, yy, P0)
    s.px(x + n, y + slope * n - 1, edge)
    s.px(x + n - 1, y + slope * (n - 1) - 1, K2)
    return s


def arc1(out):
    """一 · 源头：所有卷灵的残片指向同一个方向；荒原深处有什么在收集知识。"""
    s = new64(INK + PAPER + SEPIA + CY + MG + VI)
    # 夜空（上浓下淡）
    s.gradient_dither(0, 0, 63, 33, [K1, K2, K3], axis="v", pattern="bayer8")
    s.dither(0, 20, 63, 33, K3, K4, mix=0.18, pattern="bayer8")
    _waste_ground(s, 34)
    # 远方的一点微光：亮核 + 径向衰减的晕（不是矩形抖动块）
    lx, ly = 45, 19
    for yy in range(ly - 8, ly + 9):
        for xx in range(lx - 8, lx + 9):
            d2 = (xx - lx) ** 2 + (yy - ly) ** 2
            if d2 == 0 or d2 > 64:
                continue
            keep = (xx * 7 + yy * 13) % 10
            if d2 <= 9:
                s.px(xx, yy, CY[0])
            elif d2 <= 25 and keep < 6:
                s.px(xx, yy, K4)
            elif d2 <= 49 and keep < 3:
                s.px(xx, yy, K4)
            elif keep < 1:
                s.px(xx, yy, K5)
    s.px(lx, ly, CY[3])
    s.px(lx - 1, ly, CY[2])
    s.px(lx + 1, ly + 1, CY[1])
    # 被收拢的知识碎屑（纸屑向光源聚拢，越近越密）
    for (x, y, n) in ((30, 26, 2), (34, 21, 3), (37, 24, 2), (41, 17, 3), (39, 28, 2), (28, 15, 2)):
        for i in range(n):
            s.px(x + i, y - i // 2, P1)
            s.px(x + i, y + 1 - i // 2, K2)
    # 引力虚线（墨色短划，指向光源）
    for pts in (
        [(4, 13), (10, 15)],
        [(16, 9), (22, 12)],
        [(2, 26), (8, 27)],
        [(24, 30), (30, 28)],
        [(12, 22), (17, 22)],
        [(33, 8), (37, 11)],
    ):
        band(s, pts, K4)
    # 残片：撕下来的卷轴纸条（纸面 + 墨边），一律朝光源倾斜
    _shard(s, 3, 47, 8, MG[1], -1)
    _shard(s, 14, 56, 6, CY[1], -1)
    _shard(s, 1, 37, 6, MG[0], -1)
    _shard(s, 24, 60, 5, CY[2], 0)
    _shard(s, 41, 52, 7, VI[1], -1)
    _shard(s, 52, 59, 5, CY[0], -1)
    s.dither(0, 58, 26, 63, K3, "keep", mix=0.4, pattern="bayer4", only=P3)
    s.dither(44, 60, 63, 63, K3, "keep", mix=0.35, pattern="bayer4", only=P3)
    return save(s, out, "arc-1.png")


def arc2(out):
    """二 · 真相：混沌不是入侵者，是被云端辜负的知识投下的影子（投影，不是凶兽）。"""
    s = new64(INK + PAPER + SEPIA + CY + MG + BL)
    s.gradient_dither(0, 0, 63, 38, [P1, P2, P2], axis="v", pattern="bayer4")
    s.dither(0, 0, 63, 18, P1, P3, mix=0.10, pattern="bayer8")
    _waste_ground(s, 40)
    # 云端残骸（霓虹只在云端一侧）：三朵断裂的数据云（圆团，不是方块按钮）
    clouds = [(12, 10, 7), (32, 8, 8), (52, 12, 6)]
    for (cx, cy, r) in clouds:
        s.circle(cx, cy, r, CY[0], fill=True)
        s.circle(cx - 1, cy - 1, r - 2, CY[1], fill=True)
        s.circle(cx + 2, cy + 1, max(1, r - 3), CY[2], fill=True, only=CY[1])
        s.rect(cx - r + 1, cy + r - 1, cx + r - 1, cy + r - 1, CY[3], fill=True)
        s.px(cx + r - 1, cy - r + 1, CY[2])
        s.px(cx - r + 2, cy - r + 2, BL[2])
        s.px(cx + 3, cy + 2, MG[2])
    # 被"辜负"的缺口：云团被咬掉一角（露出纸底）
    s.rect(15, 5, 19, 9, P2, fill=True)
    s.dither(15, 5, 19, 9, P2, P3, mix=0.35, pattern="bayer4")
    s.rect(46, 8, 49, 12, P2, fill=True)
    s.rect(28, 13, 31, 16, P2, fill=True)
    # 落下的数据碎片（由亮到灭）
    for (x, y, c) in ((14, 17, CY[2]), (15, 21, CY[1]), (16, 25, CY[0]), (17, 30, CY[0]),
                      (30, 17, BL[2]), (31, 22, BL[1]), (32, 27, BL[0]),
                      (50, 19, MG[2]), (51, 24, MG[1]), (52, 29, MG[0])):
        s.px(x, y, c)
        if c != CY[0] and c != BL[0] and c != MG[0]:
            s.px(x + 1, y, c)
    # 投影：自每朵云斜向下的抖动光路（同一斜率，明确是"投"下来的）
    for i, x0 in enumerate((14, 28, 42)):
        for j in range(15):
            xx = x0 + j
            yy = 17 + j
            if (xx + yy * 3) % 5 < 2:
                s.px(xx, yy, K4)
            elif (xx + yy) % 7 == 0:
                s.px(xx, yy, K3)
    # 地上的"影子"：墨色平涂（K2，比角色浅一档 = 是"光的缺席"而非实体）+ 不规则软边。
    # 位置相对云团右下偏移 3px：与上面的投影光路同向（光自左上 ⇒ 影落在右下）。
    def shadow_blob(cx, cy, r):
        for yy in range(cy - r, cy + r + 1):
            for xx in range(cx - r, cx + r + 1):
                dx, dy = xx - cx, yy - cy
                if dx * dx + dy * dy <= r * r:
                    s.px(xx, yy, K2)
    shadow_blob(25, 45, 6)
    shadow_blob(37, 43, 7)
    shadow_blob(48, 46, 6)
    for yy in range(44, 48):
        for xx in range(21, 52):
            s.px(xx, yy, K2)
    # 软边：边界外侧按确定性稀疏度撒 1px（有机收边，不用棋盘格）
    for (x, y) in ((18, 42), (17, 44), (19, 48), (23, 51), (28, 52), (33, 50), (36, 53),
                   (40, 52), (44, 53), (48, 52), (52, 48), (53, 45), (52, 42), (50, 40),
                   (46, 39), (43, 37), (39, 36), (34, 36), (30, 39), (26, 39), (22, 41),
                   (20, 46), (26, 49), (31, 52), (38, 49), (45, 49), (49, 43)):
        s.px(x, y, K2)
        if (x + y) % 2:
            s.px(x, y + 1, K3)
        elif (x * 3 + y) % 3 == 0:
            s.px(x + 1, y, K3)
    # 影子里残留的"知识"残影（暗色，不是眼睛）
    s.px(31, 44, K4)
    s.px(32, 44, K4)
    s.px(39, 43, K5)
    s.px(27, 46, K4)
    s.px(44, 46, K4)
    s.px(34, 47, K5)
    return save(s, out, "arc-2.png")


def arc3(out):
    """三 · 留白：侠客立于本体门前，门后未明（门缝一线光；门后不画）。"""
    s = new64(INK + PAPER + SEPIA + CY + VI)
    s.gradient_dither(0, 0, 63, 56, [P1, P2, P2], axis="v", pattern="bayer4")
    s.dither(0, 0, 24, 30, P1, P3, mix=0.10, pattern="bayer8")
    for (x, y) in ((6, 12), (14, 7), (20, 18), (3, 24), (11, 28)):
        s.px(x, y, K4)
        s.px(x + 1, y, K5)
    band(s, [(0, 33), (7, 30), (14, 34), (21, 31)], K5)
    band(s, [(0, 34), (8, 31), (15, 35), (22, 32)], K4)
    # 城门：门框（石）+ 两片墨色门板
    s.rect(26, 6, 62, 56, K2, fill=True)
    s.rect(26, 6, 62, 8, K3, fill=True)
    s.rect(26, 6, 62, 6, K0, fill=True)
    s.rect(26, 6, 28, 56, K3, fill=True)
    s.rect(26, 6, 26, 56, K0, fill=True)
    s.rect(60, 6, 62, 56, K1, fill=True)
    s.rect(62, 6, 62, 56, K0, fill=True)
    s.rect(30, 11, 44, 54, K1, fill=True)
    s.rect(47, 11, 59, 54, K1, fill=True)
    s.rect(30, 11, 44, 12, K3, fill=True)
    s.rect(47, 11, 59, 12, K3, fill=True)
    for x in (35, 40):
        s.rect(x, 13, x, 53, K0, fill=True)
    for x in (52, 56):
        s.rect(x, 13, x, 53, K0, fill=True)
    s.noise(31, 14, 43, 53, K3, density=0.05, seed=23, only=K1)
    s.noise(48, 14, 58, 53, K3, density=0.05, seed=29, only=K1)
    s.rect(29, 24, 32, 26, S0, fill=True)
    s.rect(29, 24, 32, 24, S1, fill=True)
    s.rect(57, 24, 60, 26, S0, fill=True)
    s.rect(57, 24, 60, 24, S1, fill=True)
    s.rect(24, 54, 62, 57, P3, fill=True)
    s.rect(24, 54, 62, 54, K0, fill=True)
    s.rect(24, 57, 62, 57, K0, fill=True)
    s.rect(26, 55, 60, 56, P2, fill=True)
    _waste_ground(s, 58)
    # 门缝一线光：整条门缝只给"一线"，且刻意断成几截、只几粒提亮（克制优先）
    for y in range(11, 55):
        s.px(45, y, VI[1] if (y % 7) not in (0, 5) else VI[0])
    for y in (13, 14, 22, 23, 31, 32, 40, 41, 48, 49):
        s.px(45, y, VI[2])
    for y in (18, 27, 36, 45):
        s.px(45, y, CY[2])
    s.px(45, 25, VI[3])
    s.rect(46, 11, 46, 54, K0, fill=True)
    s.dither(43, 13, 44, 53, VI[0], "keep", mix=0.35, pattern="bayer4", only=K1)
    s.dither(47, 13, 47, 53, K2, "keep", mix=0.5, pattern="bayer4", only=K1)
    # 侠客背影（立于门前；被门缝光在右缘勾出 1px 边光）
    s.rect(34, 38, 40, 41, K0, fill=True)                    # 头
    s.rect(33, 42, 42, 51, K0, fill=True)                    # 身
    s.rect(33, 42, 34, 51, K1, fill=True)
    s.rect(33, 43, 33, 50, VI[0], fill=True)                 # 左缘暗
    s.rect(35, 53, 37, 58, K0, fill=True)                    # 腿
    s.rect(40, 53, 42, 58, K0, fill=True)
    s.rect(32, 58, 37, 59, K0, fill=True)
    s.rect(40, 58, 45, 59, K0, fill=True)
    s.rect(38, 53, 39, 58, None, fill=True)                  # 双腿负形
    band(s, [(40, 44), (43, 52)], K2)                        # 背剑
    band(s, [(41, 44), (44, 52)], K0)
    s.px(42, 42, K2)
    s.px(42, 43, K1)
    s.rect(36, 46, 40, 46, K1, fill=True)
    s.px(32, 45, K1)
    s.px(42, 45, K1)
    pm(s, [(42, 42), (42, 43), (42, 44), (42, 45), (42, 46)], VI[1])   # 右侧边光
    pm(s, [(41, 38), (41, 39), (42, 38)], VI[1])
    pm(s, [(41, 52), (42, 52), (42, 53)], VI[0])
    pm(s, [(43, 55), (43, 56)], VI[0])
    return save(s, out, "arc-3.png")


# ---------------------------------------------------------------------------
# 目检拼图（_contact-sheet.png）：全部素材 4× 整数放大 + 文件名/尺寸/用色数标注。
# 这是**工作文件**（sharp_edges #12：拼图/预览不是交付素材），故不参与调色板契约。
# ---------------------------------------------------------------------------
CONTACT_GROUPS = [
    ["hero", "mob-1", "mob-2", "mob-3", "mob-4"],
    ["boss-1", "boss-2", "boss-3", "boss-4", "bg-arena"],
    ["prologue-01-cloud-age", "prologue-02-data-flood", "prologue-03-great-forgetting",
     "prologue-04-cloud-down", "prologue-05-old-art"],
    ["prologue-06-teaching", "prologue-07-departure", "prologue-08-title"],
    ["arc-1", "arc-2", "arc-3"],
]


def _checker(w, h, sq=8):
    im = Image.new("RGB", (w, h), (238, 238, 238))
    d = ImageDraw.Draw(im)
    for y in range(0, h, sq):
        for x in range(0, w, sq):
            if (x // sq + y // sq) % 2:
                d.rectangle([x, y, x + sq - 1, y + sq - 1], fill=(216, 216, 216))
    return im


def _font(size=14):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def contact_sheet(out_dir, sheet_path, scale=4):
    cols = 5
    pad, lab = 10, 20
    cell = 64 * scale
    rows = (len(CONTACT_GROUPS) + 0)
    W = cols * (cell + pad) + pad
    H = rows * (cell + lab + pad) + pad
    sheet = _checker(W, H)
    d = ImageDraw.Draw(sheet)
    font = _font(13)
    for r, group in enumerate(CONTACT_GROUPS):
        for c, name in enumerate(group):
            path = os.path.join(out_dir, name + ".png")
            im = Image.open(path).convert("RGBA")
            big = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
            x = pad + c * (cell + pad)
            y = pad + r * (cell + lab + pad)
            colors = len(set((p[0], p[1], p[2]) for p in im.getdata() if p[3] > 0))
            d.text((x + 2, y + 2), "%s  %d²  %dc" % (name, im.width, colors),
                   fill=(25, 25, 30), font=font)
            sheet.paste(big, (x, y + lab), big)
    sheet.save(sheet_path)
    print("contact sheet -> %s (%dx%d)" % (sheet_path, W, H))
    return sheet_path


ALL = {
    "hero": hero,
    "drill-dummy": dummy,
    "mob-1": mob1,
    "mob-2": mob2,
    "mob-3": mob3,
    "mob-4": mob4,
    "boss-1": boss1,
    "boss-2": boss2,
    "boss-3": boss3,
    "boss-4": boss4,
    "bg-arena": bg_arena,
    "prologue-01-cloud-age": prologue1,
    "prologue-02-data-flood": prologue2,
    "prologue-03-great-forgetting": prologue3,
    "prologue-04-cloud-down": prologue4,
    "prologue-05-old-art": prologue5,
    "prologue-06-teaching": prologue6,
    "prologue-07-departure": prologue7,
    "prologue-08-title": prologue8,
    "arc-1": arc1,
    "arc-2": arc2,
    "arc-3": arc3,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--preview", default="")
    ap.add_argument("--sheet", default="")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    names = [n.strip() for n in args.only.split(",") if n.strip()] or list(ALL)
    for n in names:
        if n not in ALL:
            sys.exit("未知素材名: %s（可选: %s）" % (n, ",".join(ALL)))
        ALL[n](args.out)
    if args.preview:
        os.makedirs(args.preview, exist_ok=True)
        for n in names:
            src = os.path.join(args.out, n + ".png")
            im = Image.open(src).convert("RGBA")
            scale = 10
            sheet = Image.new("RGB", (32 * scale + 4, 32 * scale + 4), (235, 235, 235))
            sheet.paste(im.resize((im.width * scale, im.height * scale), Image.NEAREST), (2, 2), im.resize((im.width * scale, im.height * scale), Image.NEAREST))
            sheet.save(os.path.join(args.preview, n + ".png"))
    if args.sheet:
        contact_sheet(args.out, args.sheet)
    print("pixelstudio dir: %s" % PIXELSTUDIO_DIR)


if __name__ == "__main__":
    main()
`;

/** 定位 pixel-art-studio 的 scripts 目录（含 pixelstudio.py）。 */
function findPixelStudioScripts() {
  const env = process.env.PIXELSTUDIO_SCRIPTS;
  if (env && existsSync(join(env, 'pixelstudio.py'))) return env;
  let dir = ROOT;
  for (let i = 0; i < 5; i++) {
    for (const rel of [['.dsh', 'skills'], ['skills'], ['..', '.dsh', 'skills']]) {
      const cand = resolve(dir, ...rel, 'pixel-art-studio', 'scripts');
      if (existsSync(join(cand, 'pixelstudio.py'))) return cand;
    }
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    '找不到 pixel-art-studio 的 pixelstudio.py。请设置 PIXELSTUDIO_SCRIPTS=<skill>/scripts，' +
      '或在仓库上级目录保留 .dsh/skills/pixel-art-studio/。',
  );
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, only: '', check: false, emitPython: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--only') args.only = argv[++i] ?? '';
    else if (a === '--check') args.check = true;
    else if (a === '--emit-python') args.emitPython = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

function runDraw({ out, only, sheet }) {
  const scripts = findPixelStudioScripts();
  const python = process.env.PYTHON ?? 'python3';
  const tmp = mkdtempSync(join(tmpdir(), 'gen-sprites-'));
  const pyPath = join(tmp, 'draw_sprites.py');
  writeFileSync(pyPath, PY_SOURCE, 'utf8');
  const argv = [pyPath, '--out', out];
  if (only) argv.push('--only', only);
  if (sheet) argv.push('--sheet', sheet);
  try {
    execFileSync(python, argv, {
      stdio: 'inherit',
      env: { ...process.env, PIXELSTUDIO_SCRIPTS: scripts, PYTHONHASHSEED: '0' },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return { w: 0, h: 0 };
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 只影响 --only 子集的产物清单。 */
function filesFor(only) {
  if (!only) return SPRITE_FILES;
  const want = new Set(only.split(',').map((s) => s.trim()).filter(Boolean).map((s) => `${s}.png`));
  return SPRITE_FILES.filter((f) => want.has(f));
}

function printManifest(outDir, only) {
  const files = filesFor(only).filter((f) => f !== '_contact-sheet.png');
  console.log('\n产物清单 ---------------------------------------------------------------');
  for (const f of files) {
    const p = join(outDir, f);
    const buf = readFileSync(p);
    const { w, h } = pngSize(buf);
    console.log(
      `  ${f.padEnd(34)} ${String(w).padStart(3)}×${String(h).padEnd(3)} ${String(statSync(p).size).padStart(5)}B  ${sha256(buf).slice(0, 8)}`,
    );
  }
  console.log('  (+ _contact-sheet.png 目检拼图)');
  console.log('------------------------------------------------------------------------');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  if (args.emitPython) {
    writeFileSync(args.emitPython, PY_SOURCE, 'utf8');
    console.log(`内嵌绘制程序已导出 -> ${args.emitPython}（${PY_SOURCE.split('\n').length} 行）`);
    return;
  }
  if (args.check) {
    const tmp = mkdtempSync(join(tmpdir(), 'gen-sprites-check-'));
    try {
      runDraw({ out: tmp, only: args.only, sheet: join(tmp, '_contact-sheet.png') });
      const files = filesFor(args.only).filter((f) => f !== '_contact-sheet.png');
      let diffs = 0;
      console.log('\n幂等比对（重生成 vs 仓库现有）-----------------------------------------');
      for (const f of files) {
        const a = sha256(readFileSync(join(tmp, f)));
        const repoPath = join(DEFAULT_OUT, f);
        if (!existsSync(repoPath)) {
          console.log(`  缺失  ${f}`);
          diffs += 1;
          continue;
        }
        const b = sha256(readFileSync(repoPath));
        const same = a === b;
        if (!same) diffs += 1;
        console.log(`  ${same ? '一致' : '不一致'}  ${f.padEnd(34)} ${a.slice(0, 8)} ${same ? '' : `≠ ${b.slice(0, 8)}`}`);
      }
      console.log('------------------------------------------------------------------------');
      if (diffs > 0) {
        console.error(`${diffs} 个文件与仓库不一致：请重跑 node scripts/gen-sprites.mjs 并提交产物。`);
        process.exitCode = 1;
      } else {
        console.log(`全部 ${files.length} 张 PNG 与仓库逐字节一致（幂等可复现）。`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }
  mkdirSync(args.out, { recursive: true });
  runDraw({ out: args.out, only: args.only, sheet: join(args.out, '_contact-sheet.png') });
  printManifest(args.out, args.only);
}

main();
