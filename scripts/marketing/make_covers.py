#!/usr/bin/env python3
"""
make_covers.py —— 宣传封面生成器（知识侠客）

为什么要有它：仓库里的像素素材都是 **64×64 / 32×32**，直接拉到 1080 宽会糊；
而且宣传封面需要"放大到整数倍 + 大字排版"这件重复劳动。与其每次手工在剪映/Canva 里对齐，
不如把排版写成脚本：**素材改了重新跑一遍就是新封面**。

做法（都很保守，方便日后改）：
- 像素图用 **NEAREST 整数倍**放大（保持像素风，不做平滑）；
- 背景用 App 自己的墨色 + 极淡点阵网格（和游戏内观感一致）；
- 标题用 Noto Sans CJK（系统自带），关键词用金色高亮；
- 页脚固定写一句"诚实卖点"（没有账号 / 没有云 / 数据在你手机）。

用法：
    python3 scripts/marketing/make_covers.py            # 默认输出到 docs/marketing/covers/
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPRITES = os.path.join(ROOT, 'assets', 'sprites')
OUT = os.path.join(ROOT, 'docs', 'marketing', 'covers')

# 与 src/ui/styles.css 同一套色（封面和游戏内观感一致）
INK = (11, 14, 20)
INK_2 = (18, 23, 33)
PAPER = (233, 228, 214)
WASH = (150, 163, 180)
GOLD = (232, 196, 106)

FONT_SANS = '/system/fonts/NotoSansCJK-Regular.ttc'
FONT_MONO = '/system/fonts/DroidSansMono.ttf'
FONT_SERIF = '/system/fonts/NotoSerifCJK-Regular.ttc'

SIZES = {'xiaohongshu': (1080, 1440), 'douyin': (1080, 1920)}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def load_sprite(name: str) -> Image.Image:
    return Image.open(os.path.join(SPRITES, name)).convert('RGBA')


def punch_up(img: Image.Image, contrast: float = 1.12, color: float = 1.18) -> Image.Image:
    """像素素材在暗底上会显得"灰"，补一点对比与饱和（幅度很小，不改画风）。"""
    from PIL import ImageEnhance
    out = ImageEnhance.Contrast(img).enhance(contrast)
    return ImageEnhance.Color(out).enhance(color)


def darken(img: Image.Image, alpha: int = 110) -> Image.Image:
    """把一个亮底图压到暗色调（保证和封面同色系，也让主角/怪更跳）。"""
    base = img.convert('RGBA')
    shade = Image.new('RGBA', base.size, (9, 12, 17, alpha))
    return Image.alpha_composite(base, shade)


def scale_nearest(img: Image.Image, factor: int) -> Image.Image:
    """整数倍放大：像素风的命门（非整数倍会出半像素，一眼脏）。"""
    return img.resize((img.width * factor, img.height * factor), Image.NEAREST)


def backdrop(size: tuple[int, int]) -> Image.Image:
    """墨色底 + 极淡点阵网格（点够淡，不抢字）。"""
    w, h = size
    img = Image.new('RGB', size, INK)
    d = ImageDraw.Draw(img)
    for x in range(0, w, 24):
        for y in range(0, h, 24):
            d.point((x, y), fill=INK_2)
    # 上方一条更深的色带，给标题留出视觉区
    d.rectangle([0, 0, w, int(h * 0.42)], fill=(9, 12, 17))
    return img


def draw_text_block(
    img: Image.Image,
    lines: list[tuple[str, tuple[int, int, int], int]],
    top: int,
    margin: int = 72,
) -> int:
    """逐行画字，返回最后一行的底部 y。每行是 (文字, 颜色, 字号)。"""
    d = ImageDraw.Draw(img)
    y = top
    for text, color, size in lines:
        f = font(FONT_SANS, size)
        d.text((margin, y), text, font=f, fill=color)
        y += int(size * 1.28)
    return y


def layout(size: tuple[int, int], art_height: int, title_lines: int) -> tuple[int, int, int]:
    """返回 (画面顶部 y, 页脚 y, 画面可用高度)。三段硬性不重叠。"""
    w, h = size
    title_bottom = int(72 + title_lines * 118 * 1.28)
    art_top = max(title_bottom + 48, int(h * 0.30))
    footer_h = 130
    art_room = h - art_top - footer_h - 24
    return art_top, h - footer_h, max(120, min(art_height, art_room))


def cover_scholar(size: tuple[int, int]) -> Image.Image:
    """C1：主钩子「学霸学新知识，根本不看论文」+ 序章「大遗忘」。"""
    w, h = size
    img = backdrop(size)
    art_top, footer_y, room = layout(size, 1024, 2)
    art = punch_up(scale_nearest(load_sprite('prologue-03-great-forgetting.png'), 16))
    if art.height > room:
        art = art.resize((int(art.width * room / art.height), room), Image.NEAREST)
    art = darken(art, 90)  # 大遗忘这一幕本来就灰，压暗后与暗底融为一体
    img.paste(art.convert('RGB'), ((w - art.width) // 2, art_top + (room - art.height) // 2))
    draw_text_block(img, [('学霸学新知识，', PAPER, 104), ('根本不看论文', GOLD, 128)], top=int(h * 0.06))
    draw_text_block(img, [('像素风知识闪卡 · 答对一题砍一刀', WASH, 42)], top=footer_y + 40)
    return img


def cover_battle(size: tuple[int, int]) -> Image.Image:
    """C2：「他们玩这个」+ 竞技场（背景 + 主角 + 小怪，手工摆位）。"""
    w, h = size
    img = backdrop(size)
    art_top, footer_y, room = layout(size, 1024, 2)
    arena = darken(punch_up(scale_nearest(load_sprite('bg-arena.png'), 15)), 130)
    if arena.height > room:
        arena = arena.resize((int(arena.width * room / arena.height), room), Image.NEAREST)
    ax = (w - arena.width) // 2
    img.paste(arena.convert('RGB'), (ax, art_top + (room - arena.height) // 2))
    hero = scale_nearest(punch_up(load_sprite('hero.png')), 11)   # 32→352
    mob = scale_nearest(punch_up(load_sprite('mob-1.png')), 12)
    ground = art_top + (room - arena.height) // 2 + arena.height - int(arena.height * 0.30)
    img.paste(hero, (ax + int(arena.width * 0.10), ground - hero.height), hero)
    # 怪**右对齐在舞台内**（首版按比例摆，右边缘溢出到暗底上了）
    img.paste(mob, (ax + arena.width - mob.width - 36, ground - mob.height), mob)
    draw_text_block(img, [('学霸学新知识，不看论文', PAPER, 76), ('他们玩这个', GOLD, 136)], top=int(h * 0.05))
    draw_text_block(img, [('答对一张卡 = 砍敌人一刀', WASH, 42)], top=footer_y + 40)
    return img


def cover_rule(size: tuple[int, int]) -> Image.Image:
    """C3：机制反直觉钩子（纯排版，不依赖截图）。"""
    w, h = size
    img = backdrop(size)
    draw_text_block(img, [('同一天练三次，', PAPER, 100), ('不算你掌握', GOLD, 136)], top=int(h * 0.08))
    draw_text_block(img, [('要隔天回来还记得，才算。', WASH, 48)], top=int(h * 0.42))
    art = darken(punch_up(scale_nearest(load_sprite('prologue-05-old-art.png'), 11)), 70)
    art_top, footer_y, room = layout(size, art.height, 3)
    img.paste(art.convert('RGB'), ((w - art.width) // 2, art_top + (room - art.height) // 2))
    draw_text_block(img, [('间隔重复不是"多刷几遍"', WASH, 42)], top=footer_y + 40)
    return img


def cover_build(size: tuple[int, int]) -> Image.Image:
    """C4：实现线（AI 一起做）——做成"终端"版式，用的都是**真实命令与真实输出**。"""
    w, h = size
    img = backdrop(size)
    draw_text_block(
        img,
        [('做梦梦到的设定', PAPER, 92), ('5 天 163 次提交', GOLD, 118)],
        top=int(h * 0.06),
    )
    # 终端框
    lines = [
        ('$ git log --oneline | wc -l', WASH),
        ('163', GOLD),
        ('$ npm test', WASH),
        ('Tests  1402 passed (1402)', (126, 200, 140)),
        ('Test Files  93 passed (94)', (126, 200, 140)),
        ('$ ls docs/marketing/', WASH),
        ('script-01.md   checklist.md   covers/', PAPER),
    ]
    box_x, box_w = 72, w - 144
    line_h = 62
    box_h = line_h * len(lines) + 90
    box_y = int(h * 0.30)
    d = ImageDraw.Draw(img)
    d.rectangle([box_x, box_y, box_x + box_w, box_y + box_h], fill=(8, 10, 15), outline=(38, 46, 60), width=3)
    d.rectangle([box_x, box_y, box_x + box_w, box_y + 54], fill=(20, 26, 36))
    for i, (cx, cy) in enumerate([(box_x + 26, box_y + 27), (box_x + 58, box_y + 27), (box_x + 90, box_y + 27)]):
        d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=[(196, 90, 84), (214, 178, 92), (126, 176, 118)][i])
    mf = font(FONT_MONO, 38)
    y = box_y + 84
    for text, color in lines:
        d.text((box_x + 36, y), text, font=mf, fill=color)
        y += line_h
    hero = scale_nearest(punch_up(load_sprite('hero.png')), 6)   # 32→192
    img.paste(hero, (w - hero.width - 60, h - 300), hero)
    draw_text_block(img, [('全部代码和 AI 一起写 · 没有账号 · 数据在你手机', WASH, 38)], top=h - 150)
    return img


COVERS = {
    'c1-学霸不看论文': cover_scholar,
    'c2-他们玩这个': cover_battle,
    'c3-同一天练三次': cover_rule,
    'c4-AI五天': cover_build,
}


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    made = []
    for name, fn in COVERS.items():
        for label, size in SIZES.items():
            img = fn(size)
            path = os.path.join(OUT, f'{name}-{label}.png')
            img.save(path, optimize=True)
            made.append(path)
    for p in made:
        print(os.path.relpath(p, ROOT), Image.open(p).size)


if __name__ == '__main__':
    main()
