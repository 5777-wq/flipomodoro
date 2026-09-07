"""
把 resources/ 的源图展开成 Android 各密度资源。

本来该用 `npx capacitor-assets generate`，但它依赖 sharp，
而 sharp 要从 GitHub 下 libvips 预编译包，本机网络连不通。
这个脚本用 Pillow 产出等价结果，覆盖同样的目录与文件名。

产出：
  mipmap-{mdpi..xxxhdpi}/ic_launcher.png            方形图标
  mipmap-{mdpi..xxxhdpi}/ic_launcher_round.png      圆形图标
  mipmap-{mdpi..xxxhdpi}/ic_launcher_foreground.png 自适应前景
  drawable-{port,land}-{mdpi..xxxhdpi}/splash.png   启动屏
  drawable/splash.png                                默认启动屏
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "resources")
ANDROID_RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
BG = (240, 238, 230, 255)   # #f0eee6

# 启动器图标基准 48dp，自适应前景基准 108dp
ICON_DP = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FG_DP = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

# 启动屏按密度给竖屏 / 横屏两套
SPLASH = {
    "mdpi": (320, 480), "hdpi": (480, 800), "xhdpi": (720, 1280),
    "xxhdpi": (960, 1600), "xxxhdpi": (1280, 1920),
}


def load(name):
    return Image.open(os.path.join(RES, name)).convert("RGBA")


def ensure(path):
    os.makedirs(path, exist_ok=True)
    return path


def round_mask(size):
    """圆形遮罩，4 倍超采样保证边缘平滑"""
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def fit_center(src, w, h, bg):
    """把 src 居中缩放进 w*h 画布，保持比例，四周填 bg"""
    canvas = Image.new("RGBA", (w, h), bg)
    # 标记占短边的 34%，两端都留足空白
    target = int(min(w, h) * 0.34)
    mark = src.resize((target, target), Image.LANCZOS)
    canvas.alpha_composite(mark, ((w - target) // 2, (h - target) // 2))
    return canvas


def main():
    icon = load("icon.png")
    fg = load("icon-foreground.png")
    splash_mark = load("icon-foreground.png")

    print("launcher icons:")
    for d, px in ICON_DP.items():
        out = ensure(os.path.join(ANDROID_RES, f"mipmap-{d}"))

        sq = icon.resize((px, px), Image.LANCZOS)
        sq.save(os.path.join(out, "ic_launcher.png"), "PNG", optimize=True)

        rd = sq.copy()
        rd.putalpha(round_mask(px))
        rd.save(os.path.join(out, "ic_launcher_round.png"), "PNG", optimize=True)

        fpx = FG_DP[d]
        fg.resize((fpx, fpx), Image.LANCZOS).save(
            os.path.join(out, "ic_launcher_foreground.png"), "PNG", optimize=True)
        print(f"  mipmap-{d:8s} icon {px}x{px}, foreground {fpx}x{fpx}")

    print("splash screens:")
    for d, (w, h) in SPLASH.items():
        for orient, (ow, oh) in (("port", (w, h)), ("land", (h, w))):
            out = ensure(os.path.join(ANDROID_RES, f"drawable-{orient}-{d}"))
            fit_center(splash_mark, ow, oh, BG).save(
                os.path.join(out, "splash.png"), "PNG", optimize=True)
        print(f"  drawable-*-{d:8s} {w}x{h} / {h}x{w}")

    # 默认兜底
    out = ensure(os.path.join(ANDROID_RES, "drawable"))
    fit_center(splash_mark, 480, 800, BG).save(
        os.path.join(out, "splash.png"), "PNG", optimize=True)
    print("  drawable/splash.png      480x800")
    print("done.")


if __name__ == "__main__":
    main()
