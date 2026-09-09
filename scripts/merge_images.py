#!/usr/bin/env python3
"""多图纵向拼接脚本 — 为 gpt-image-gen 图生图模式准备多参考合成图

输出协议（与 generate.mjs 一致）:
  stdout = 结构化 JSON 结果（唯一给 LLM 的 Observation 主体）
  stderr = 人类可读进度日志（不影响 LLM 判断）

stdout JSON 格式:
  成功: {"type":"image_merge_result","status":"completed","image_path":"...","size_kb":N,"width":W,"height":H,"image_count":N,"titles":[...],"elapsed_s":N}
  失败: {"type":"image_merge_result","status":"failed","error":"...","hint":"..."}
  参数错误: {"type":"image_merge_result","status":"invalid_params","error":"..."}

用法:
  # 带自定义标题
  python3 merge_images.py --images a.png b.png --titles "背景" "主体" --save ./merged.png

  # 无标题（自动字母编号 A/B/C）
  python3 merge_images.py --images a.png b.png c.png --save ./merged.png
"""

import sys
import os
import json
import time

# ---- Pillow 检测（启动时） ----
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print(json.dumps({
        "type": "image_merge_result",
        "status": "failed",
        "error": "Pillow 未安装",
        "hint": "请执行: /usr/local/bin/python3 -m pip install Pillow"
    }, ensure_ascii=False))
    sys.exit(1)


# ---- 统一输出函数（与 generate.mjs 协议一致）----
def log(msg):
    """进度日志 → stderr（人类可读，不影响 LLM 判断）"""
    print(msg, file=sys.stderr)


def result(obj, exit_code=0):
    """结构化结果 → stdout（唯一给 LLM 的 Observation）"""
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(exit_code)


# ---- 布局常量 ----
LAYOUT = {
    "target_width": 1024,
    "title_bar_h": 48,
    "divider_h": 2,
    "padding": 16,
    "max_total_height": 4096,
    "max_single_height": 1200,
    "divider_color": "#D1D5DB",
    "canvas_bg": "#FFFFFF",
}

# 标题栏样式
TITLE_STYLES = {
    "dark": {"bg": "#1E293B", "text": "#FFFFFF"},
    "light": {"bg": "#F3F4F6", "text": "#1E293B"},
}

# 字体候选（macOS 系统字体，支持中文）
FONT_CANDIDATES = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]


# ---- 字体加载 ----
def load_font(size):
    """加载字体，带 fallback 链"""
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


# ---- 参数解析 ----
def collect_list(args, flag):
    """收集 flag 后的所有值，直到遇到下一个 --xxx 开头的参数"""
    if flag not in args:
        return []
    idx = args.index(flag)
    values = []
    i = idx + 1
    while i < len(args) and not args[i].startswith('--'):
        values.append(args[i])
        i += 1
    return values


def get_single(args, flag):
    """获取单个参数值"""
    if flag not in args:
        return None
    idx = args.index(flag)
    if idx + 1 < len(args) and not args[idx + 1].startswith('--'):
        return args[idx + 1]
    return None


def has_flag(args, flag):
    return flag in args


def show_help():
    """纯文本帮助 → stdout"""
    print("""多图纵向拼接脚本

用法:
  python3 merge_images.py --images <图1> <图2> [<图3> ...] --save <输出路径> [选项]

参数:
  --images <路径...>    图片路径列表，至少 2 张 (必填)
  --save <路径>         输出文件路径，建议 .png (必填)
  --titles <标题...>    每张子图标题，省略时自动 A/B/C 编号
  --width <像素>        目标宽度，默认 1024
  --max-height <像素>   合成图整体最大高度，默认 4096
  --title-style <dark|light>  标题栏样式，默认 dark
  --help, -h            显示帮助

输出协议:
  stdout = 结构化 JSON 结果（给 LLM 解析）
  stderr = 人类可读进度日志

  成功: {"type":"image_merge_result","status":"completed","image_path":"...","image_count":N,...}
  失败: {"type":"image_merge_result","status":"failed","error":"...","hint":"..."}

示例:
  # 带标题
  python3 merge_images.py --images bg.png subject.png --titles "背景" "主体" --save ./merged.png

  # 无标题（自动编号）
  python3 merge_images.py --images a.png b.png c.png --save ./merged.png""")


# ---- 标题生成 ----
def make_title(index, user_title):
    """生成 "A. xxx" 格式标题"""
    letter = chr(ord('A') + index)
    if user_title:
        return f"{letter}. {user_title}"
    return letter


# ---- 图片处理 ----
def load_image(path):
    """加载图片，带错误处理"""
    if not os.path.exists(path):
        result({
            "type": "image_merge_result",
            "status": "failed",
            "error": f"图片文件不存在: {path}",
            "hint": "请检查图片路径是否正确"
        }, 1)
    try:
        img = Image.open(path)
        img.load()  # 强制加载，避免懒加载问题
        return img
    except Exception as e:
        result({
            "type": "image_merge_result",
            "status": "failed",
            "error": f"无法读取图片: {path}",
            "detail": str(e),
            "hint": "支持 PNG/JPEG/WebP/BMP 等常见格式"
        }, 1)


def to_rgb(img):
    """转换为 RGB（处理 RGBA/PALETTE 等模式）"""
    if img.mode == 'RGB':
        return img
    if img.mode in ('RGBA', 'LA'):
        # 在透明背景上铺白底
        bg = Image.new('RGB', img.size, LAYOUT["canvas_bg"])
        bg.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
        return bg
    if img.mode == 'P':
        return img.convert('RGB')
    return img.convert('RGB')


def scale_to_width(img, target_w):
    """第一层缩放：按目标宽度等比缩放"""
    if img.width == target_w:
        return img
    new_h = int(img.height * target_w / img.width)
    return img.resize((target_w, new_h), Image.LANCZOS)


def clamp_height(img, max_h):
    """第二层缩放：单图限高"""
    if img.height <= max_h:
        return img
    new_w = int(img.width * max_h / img.height)
    return img.resize((new_w, max_h), Image.LANCZOS)


def scale_all_if_needed(images, title_bar_h, divider_h, max_total_h):
    """第三层缩放：整体限高，等比缩小所有子图"""
    total_h = sum(title_bar_h + img.height for img in images) + (len(images) - 1) * divider_h
    if total_h <= max_total_h:
        return images, title_bar_h, total_h
    scale = max_total_h / total_h
    new_images = [img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS) for img in images]
    new_title_h = max(24, int(title_bar_h * scale))  # 不低于 24px 保证文字可读
    new_total_h = sum(new_title_h + img.height for img in new_images) + (len(new_images) - 1) * divider_h
    return new_images, new_title_h, new_total_h


# ---- 标题栏渲染 ----
def render_title_bar(title, width, bar_h, font, style="dark"):
    """渲染标题栏，返回 PIL.Image"""
    colors = TITLE_STYLES.get(style, TITLE_STYLES["dark"])
    bar = Image.new("RGB", (width, bar_h), colors["bg"])
    draw = ImageDraw.Draw(bar)
    # 文字垂直居中，左侧留 padding
    # 获取文字尺寸（兼容 Pillow 不同版本）
    try:
        bbox = draw.textbbox((0, 0), title, font=font)
        text_h = bbox[3] - bbox[1]
    except AttributeError:
        text_h = font.size
    y = (bar_h - text_h) // 2
    draw.text((LAYOUT["padding"], y), title, fill=colors["text"], font=font)
    return bar


# ---- 主合成 ----
def merge_vertical(image_paths, titles, config):
    """纵向堆叠合成，返回 PIL.Image"""
    target_w = config["target_width"]
    font_size = max(20, target_w // 32)
    font = load_font(font_size)

    # 加载并缩放所有图片
    scaled_images = []
    for i, path in enumerate(image_paths):
        img = load_image(path)
        img = to_rgb(img)
        original_size = (img.width, img.height)
        img = scale_to_width(img, target_w)
        img = clamp_height(img, LAYOUT["max_single_height"])
        scaled_images.append(img)
        log(f"  [{i+1}/{len(image_paths)}] 加载: {os.path.basename(path)} ({original_size[0]}x{original_size[1]} → {img.width}x{img.height})")

    # 第三层整体限高
    scaled_images, title_bar_h, total_h = scale_all_if_needed(
        scaled_images, LAYOUT["title_bar_h"], LAYOUT["divider_h"], config["max_total_height"]
    )
    if title_bar_h != LAYOUT["title_bar_h"]:
        font = load_font(max(16, title_bar_h // 2))

    log(f"  合成尺寸: {target_w}x{total_h}")

    # 创建画布
    canvas = Image.new("RGB", (target_w, total_h), LAYOUT["canvas_bg"])
    y = 0
    for i, (img, title) in enumerate(zip(scaled_images, titles)):
        # 粘贴标题栏
        title_bar = render_title_bar(title, target_w, title_bar_h, font, config["title_style"])
        canvas.paste(title_bar, (0, y))
        y += title_bar_h
        # 粘贴图片（水平居中，若缩放后宽度 < target_w）
        x = (target_w - img.width) // 2
        canvas.paste(img, (x, y))
        y += img.height
        # 分割线（最后一张不加）
        if i < len(scaled_images) - 1:
            draw = ImageDraw.Draw(canvas)
            draw.line([(0, y), (target_w, y)], fill=LAYOUT["divider_color"], width=LAYOUT["divider_h"])
            y += LAYOUT["divider_h"]

    return canvas


# ---- 入口 ----
def main():
    start = time.time()
    args = sys.argv[1:]

    # 帮助
    if has_flag(args, '--help') or has_flag(args, '-h'):
        show_help()
        sys.exit(0)

    # 解析参数
    images = collect_list(args, '--images')
    titles = collect_list(args, '--titles')
    save_path = get_single(args, '--save')
    width_str = get_single(args, '--width')
    max_height_str = get_single(args, '--max-height')
    title_style = get_single(args, '--title-style') or 'dark'

    # 参数校验
    if not images or len(images) < 2:
        result({
            "type": "image_merge_result",
            "status": "invalid_params",
            "error": f"至少需要 2 张图片进行拼接（当前 {len(images)} 张）"
        }, 1)

    if not save_path:
        result({
            "type": "image_merge_result",
            "status": "invalid_params",
            "error": "缺少 --save 参数"
        }, 1)

    if titles and len(titles) != len(images):
        result({
            "type": "image_merge_result",
            "status": "invalid_params",
            "error": f"--titles 数量({len(titles)})与 --images 数量({len(images)})不一致"
        }, 1)

    # 解析数值参数
    target_width = 1024
    if width_str:
        try:
            target_width = int(width_str)
            if target_width < 256:
                raise ValueError()
        except ValueError:
            result({
                "type": "image_merge_result",
                "status": "invalid_params",
                "error": f"无效的 --width: {width_str}（需 ≥256 的整数）"
            }, 1)

    max_total_height = 4096
    if max_height_str:
        try:
            max_total_height = int(max_height_str)
            if max_total_height < 512:
                raise ValueError()
        except ValueError:
            result({
                "type": "image_merge_result",
                "status": "invalid_params",
                "error": f"无效的 --max-height: {max_height_str}（需 ≥512 的整数）"
            }, 1)

    if title_style not in ('dark', 'light'):
        result({
            "type": "image_merge_result",
            "status": "invalid_params",
            "error": f"无效的 --title-style: {title_style}（仅支持 dark 或 light）"
        }, 1)

    # 生成标题（用户未提供时自动字母编号）
    if not titles:
        titles = [make_title(i, None) for i in range(len(images))]
    else:
        titles = [make_title(i, t) for i, t in enumerate(titles)]

    config = {
        "target_width": target_width,
        "max_total_height": max_total_height,
        "title_style": title_style,
    }

    # 进度日志
    log(f"  图片数量: {len(images)}")
    log(f"  目标宽度: {target_width}px")
    log(f"  最大高度: {max_total_height}px")
    log(f"  标题样式: {title_style}")

    # 合成
    canvas = merge_vertical(images, titles, config)

    # 保存
    log(f"  正在保存: {save_path}")
    try:
        # 确保输出目录存在
        out_dir = os.path.dirname(save_path)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        canvas.save(save_path, 'PNG')
    except Exception as e:
        result({
            "type": "image_merge_result",
            "status": "failed",
            "error": f"保存文件失败: {e}",
            "hint": "请检查输出目录是否存在且有写入权限"
        }, 1)

    size_kb = os.path.getsize(save_path) // 1024
    elapsed = round(time.time() - start, 1)
    log(f"\n✅ 拼接完成: {save_path} ({size_kb} KB, {len(images)} 张图, 耗时 {elapsed}s)")

    # stdout 输出结构化 JSON
    result({
        "type": "image_merge_result",
        "status": "completed",
        "image_path": save_path,
        "size_kb": size_kb,
        "width": canvas.width,
        "height": canvas.height,
        "image_count": len(images),
        "titles": titles,
        "elapsed_s": elapsed,
    })


if __name__ == "__main__":
    main()
