"""
生成图标与启动屏源图。

设计 v5「翻页卡片 · 25」：
  App 的灵魂是全屏机械翻页时钟，图标直接就是它——
  一张陶土橙翻页卡片：上亮下暗的受光渐变、中间一道深棕缝道把衬线
  数字「25」精确劈成两半（数字层按缝线对半裁切，绝不错位）、
  下方露出一条米色底卡，暗示下一页。数字用 Playfair Display
  Bold（OFL 开源，Didot 系高对比衬线，随仓库脚本从 google/fonts 获取）。

产出（都在 resources/）：
  icon.png                  1024x1024  图标源图（大密度用）
  icon-small.png            384x384    小密度简化版（更粗数字、无底卡、细节少）
  icon-foreground.png       1024x1024  自适应图标前景
  icon-foreground-small.png 384x384    小密度自适应前景
  icon-background.png       1024x1024  自适应图标背景（纯色）
  splash.png / splash-dark.png         启动屏
"""
import os
from PIL import Image, ImageDraw, ImageFont

BG = (241, 239, 231)         # #f1efe7 暖米白
CREAM = (247, 244, 237)      # 数字奶油白
CARD_TOP = (221, 122, 82)    # 卡片上半（受光，柿子橙）
CARD_BOTTOM = (192, 95, 56)  # 卡片下半（背光，只压一档亮度保住饱和）
SEAM = (74, 35, 23)          # 中缝深棕（转轴的暗）
UNDER = (223, 216, 201)      # 下层底卡（米色深一档）

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
os.makedirs(OUT, exist_ok=True)

SS = 4  # 超采样倍数

_FONT = r"D:\dev\fonts\PlayfairDisplay.ttf"   # OFL 开源，见文件头
_FONT_FALLBACKS = [
    r"C:\Windows\Fonts\palab.ttf",    # Palatino Linotype Bold
    r"C:\Windows\Fonts\BOOKOSB.TTF",  # Book Antiqua Bold
]


def _load_font(px):
    if os.path.exists(_FONT):
        try:
            f = ImageFont.truetype(_FONT, px)
            try:
                f.set_variation_by_name("Bold")
            except Exception:
                f.set_variation_by_axes([700])
            return f
        except OSError:
            pass
    for p in _FONT_FALLBACKS:
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return ImageFont.load_default()


def _v_gradient(w, h, top, bottom):
    g = Image.new("RGBA", (w, h))
    gd = ImageDraw.Draw(g)
    for y in range(h):
        t = y / max(1, h - 1)
        gd.line([(0, y), (w, y)], fill=(
            int(top[0] + (bottom[0] - top[0]) * t),
            int(top[1] + (bottom[1] - top[1]) * t),
            int(top[2] + (bottom[2] - top[2]) * t),
            255,
        ))
    return g


def _digit_layer(target_w, stroke_ratio):
    """
    渲染一行「25」到透明图层并裁到紧致边界。
    宽度精确调到 target_w，保证数字在卡片上的占比稳定。
    """
    size = max(16, int(target_w))
    font = _load_font(size)
    probe = Image.new("RGBA", (size * 3, size * 3), (0, 0, 0, 0))
    pd = ImageDraw.Draw(probe)
    stroke = max(0, int(size * stroke_ratio))
    pd.text((size * 3 // 2, size * 3 // 2), "25", font=font, fill=CREAM + (255,),
            anchor="mm", stroke_width=stroke, stroke_fill=CREAM + (255,))
    bbox = probe.getbbox()
    return probe.crop(bbox)


def draw_mark(size, inset_ratio, small=False):
    """
    画「翻页卡片 25」标记。small=True 时是小密度简化版：
    纯色卡片、无底卡、缝更细、数字笔画更粗。
    """
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx = S / 2
    cy = S * 0.5
    cw = S * inset_ratio
    ch = cw * 1.26
    rad = cw * 0.18
    x0 = cx - cw / 2
    y0 = cy - ch / 2
    x1 = x0 + cw
    y1 = y0 + ch

    # 下层底卡：主向下露边（堆叠的"下一页"，不是投影）；小尺寸省略
    if not small:
        offx, offy = cw * 0.028, cw * 0.052
        d.rounded_rectangle(
            [x0 + offx, y0 + offy, x1 + offx, y1 + offy],
            radius=rad, fill=UNDER + (255,),
        )

    # 主卡：小尺寸纯色，大尺寸上亮下暗渐变（底部只压一档，不发褐）
    if small:
        card = Image.new("RGBA", (int(cw) + 8, int(ch) + 8), (211, 108, 68, 255))
    else:
        card = _v_gradient(int(cw) + 8, int(ch) + 8, CARD_TOP, CARD_BOTTOM)
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, int(cw), int(ch)], radius=int(rad), fill=255)
    img.paste(card, (int(x0), int(y0)), mask)

    # 数字层：宽度调到卡片的 62%，紧致裁边后按缝线对半裁开再分别贴合，
    # 上下两半来自同一层像素，绝不出现错位
    dw_target = cw * 0.66
    layer = _digit_layer(dw_target, 0.012 if small else 0.0)
    lw, lh = layer.size
    seam_y = y_mid = y0 + ch * 0.5
    dx = cx - lw / 2
    dy = cy - lh / 2
    split = int(seam_y - dy)
    split = max(1, min(lh - 1, split))
    top_half = layer.crop((0, 0, lw, split))
    bot_half = layer.crop((0, split, lw, lh))
    img.alpha_composite(top_half, (int(dx), int(dy)))
    img.alpha_composite(bot_half, (int(dx), int(dy + split)))

    # 机械缝道：深棕缝 + 下缘一丝高光，压在数字上（真翻页钟的转轴）
    seam_w = max(2, int(cw * (0.013 if small else 0.02)))
    d.rectangle([x0, seam_y - seam_w, x1, seam_y], fill=SEAM + (255,))
    if not small:
        d.rectangle([x0, seam_y, x1, seam_y + max(2, seam_w // 3)],
                    fill=(255, 244, 232, 60))

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print(f"  {name:26s} {img.size[0]}x{img.size[1]}")


print("generating icons into resources/ ...")

# 图标源图：满底 + 卡片收在 66% 内（卡片竖长，高度是限制边）
icon = Image.new("RGBA", (1024, 1024), BG + (255,))
icon.alpha_composite(draw_mark(1024, 0.52))
save(icon, "icon.png")

# 小密度简化版（mdpi/hdpi/xhdpi 的启动器图标源）
small = Image.new("RGBA", (384, 384), BG + (255,))
small.alpha_composite(draw_mark(384, 0.52, small=True))
save(small, "icon-small.png")

# 自适应前景：透明底，系统裁圆形，内容收得更小
fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
fg.alpha_composite(draw_mark(1024, 0.36))
save(fg, "icon-foreground.png")

fgs = Image.new("RGBA", (384, 384), (0, 0, 0, 0))
fgs.alpha_composite(draw_mark(384, 0.36, small=True))
save(fgs, "icon-foreground-small.png")

# 自适应背景：纯暖米白
save(Image.new("RGBA", (1024, 1024), BG + (255,)), "icon-background.png")

# 启动屏：大画布居中小标记，缩放到任何屏幕都不会糊
for name in ("splash.png", "splash-dark.png"):
    sp = Image.new("RGBA", (2732, 2732), BG + (255,))
    mark = draw_mark(760, 0.62)
    sp.alpha_composite(mark, ((2732 - 760) // 2, (2732 - 760) // 2))
    save(sp, name)

print("done.")
