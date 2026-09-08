"""
生成图标与启动屏源图。

设计 v3「实心番茄钟」：
  一个实心的陶土橙番茄圆面（底部一弯深色收出体积感），
  表盘正中是奶油色的两根圆头指针，摆成经典的 10:10 微笑角度，
  顶部一短梗两片低饱和青灰叶。几何极简，小到 48px 依然清晰。
纯代码绘制，不依赖任何外部图片素材。

产出（都在 resources/）：
  icon.png             1024x1024  图标源图
  icon-foreground.png  1024x1024  自适应图标前景（内容收在安全区内）
  icon-background.png  1024x1024  自适应图标背景（纯色）
  splash.png           2732x2732  启动屏（浅色）
  splash-dark.png      2732x2732  启动屏（深色模式，仍用暖米白，避免闪白）
"""
import math
import os
from PIL import Image, ImageDraw

BG = (240, 238, 230)        # #f0eee6 暖米白
ORANGE = (217, 119, 87)     # #d97757 陶土橙（番茄主体）
DEEP = (180, 83, 42)        # #b4532a 深陶土（体积暗面 / 果梗）
CREAM = (246, 243, 236)     # 指针，比背景略亮一档
LEAF = (122, 150, 141)      # #7a968d 低饱和青灰

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources")
os.makedirs(OUT, exist_ok=True)

SS = 4  # 超采样倍数，画完再缩小，边缘更干净


def _dot(d, x, y, radius, color):
    """圆头：线段端点的圆帽"""
    d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)


def _leaf(img, cx, cy, w, h, angle, color):
    """一片旋转的椭圆叶：先在临时图上画正椭圆，旋转后按 alpha 合成"""
    pad = 4 * SS
    tmp = Image.new("RGBA", (int(w) + pad * 2, int(h) + pad * 2), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    td.ellipse([pad, pad, pad + w, pad + h], fill=color)
    rot = tmp.rotate(angle, resample=Image.BICUBIC, expand=True)
    img.alpha_composite(rot, (int(cx - rot.width / 2), int(cy - rot.height / 2)))


def draw_mark(size, inset_ratio):
    """
    画「实心番茄钟」标记，返回 RGBA 图。
    r 是番茄半径；果梗和叶子会超出 2r，total 高约 2.55r，调用方自行留边。
    """
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx = S / 2
    cy = S * 0.54                 # 番茄中心略低，给叶子和梗留呼吸空间
    r = S * inset_ratio / 2

    # --- 果梗与叶（先画，让它们的根部藏在番茄身后）---
    stem_top_x = cx + r * 0.10
    stem_top_y = cy - r * 1.30
    d.line([(cx, cy - r * 1.02), (stem_top_x, stem_top_y)],
           fill=DEEP, width=max(2, int(r * 0.075)))
    _dot(d, stem_top_x, stem_top_y, r * 0.05, DEEP)

    leaf_l = r * 0.46             # 叶长
    leaf_w = r * 0.17             # 叶宽
    _leaf(img, cx - r * 0.26, cy - r * 1.10, leaf_l, leaf_w, 38, LEAF)
    _leaf(img, cx + r * 0.30, cy - r * 1.14, leaf_l, leaf_w, -30, LEAF)

    # --- 番茄主体 ---
    # 深色整圆垫底，主色圆向左上偏移一点点，右下露出一弯暗面，体积感就有了
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DEEP)
    off = r * 0.055
    d.ellipse([cx - r - off, cy - r - off, cx + r - off, cy + r - off], fill=ORANGE)

    # --- 表针（10:10，微笑角度）：时针短粗、分针细长，拉开对比不像对勾 ---
    def hand(angle_deg, length, width_ratio):
        rad = math.radians(angle_deg)
        x2 = cx + math.sin(rad) * length
        y2 = cy - math.cos(rad) * length
        hw = r * width_ratio
        d.line([(cx, cy), (x2, y2)], fill=CREAM, width=max(2, int(hw * 2)))
        _dot(d, x2, y2, hw, CREAM)

    hand(-56, r * 0.40, 0.105)    # 时针指 10 点
    hand(60, r * 0.72, 0.075)     # 分针指 2 点
    _dot(d, cx, cy, r * 0.095, CREAM)   # 中轴

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print(f"  {name:24s} {img.size[0]}x{img.size[1]}")


print("generating icons into resources/ ...")

# 图标源图：满底 + 标记整体收在 78% 内（标记本身竖向 2.55r，留出梗叶空间）
icon = Image.new("RGBA", (1024, 1024), BG + (255,))
icon.alpha_composite(draw_mark(1024, 0.62))
save(icon, "icon.png")

# 自适应前景：透明底，系统会裁圆形，内容收得更小
fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
fg.alpha_composite(draw_mark(1024, 0.42))
save(fg, "icon-foreground.png")

# 自适应背景：纯暖米白
save(Image.new("RGBA", (1024, 1024), BG + (255,)), "icon-background.png")

# 启动屏：大画布居中小标记，缩放到任何屏幕都不会糊
for name in ("splash.png", "splash-dark.png"):
    sp = Image.new("RGBA", (2732, 2732), BG + (255,))
    mark = draw_mark(720, 0.86)
    sp.alpha_composite(mark, ((2732 - 720) // 2, (2732 - 720) // 2))
    save(sp, name)

print("done.")
