---
name: gpt-image-gen
description: 通过 OpenAI 官方直调或 ICU 中转站调用 GPT-Image-2 生成/编辑高质量图片。支持 base64 参考图编辑。零依赖 Node.js 脚本，同步接口，Base64 响应直接解码保存。
agent_created: true
owner: 谢弘毅
status: stable
---

# GPT-Image-2 图片生成 Skill

支持双模式调用 GPT-Image-2 模型：
- **direct**：OpenAI 官方直调（配置了 `OPENAI_API_KEY` 时默认启用）
- **relay**：ICU 中转站（rehdasu.cn，无官方 Key 时回退）

模式自动判断：`OPENAI_API_KEY` 存在时优先 direct，否则 relay。可通过 `--mode` 手动覆盖。

## 触发条件

用户提出以下任一需求时触发：
- "用 GPT-Image-2 生成图片"
- "用 openai 生图" / "openai 直调生图"
- "用 image-2 生图" / "调用中转站生图"
- "编辑这张图" / "用参考图生图"（需配合图片编辑模式）
- 需要高质量、写实风格的图片生成

## 前置条件

| 优先级 | 环境变量 | 获取方式 | 说明 |
|--------|----------|----------|------|
| 1 | `OPENAI_API_KEY` | OpenAI 官方平台获取 | 存在时默认启用 **direct** 模式 |
| 2 | `GPT_IMAGE_API_KEY` | ICU 平台获取 | 无官方 Key 时默认启用 **relay** 模式 |

可同时配置两者，脚本会优先使用官方 API。也可通过 `--mode` 手动强制指定。

Node.js v22.16.0+（系统预装），零第三方依赖。

## 快速使用

### 文生图

```bash
# 官方直调（配置了 OPENAI_API_KEY 时默认，无需 --mode）
export OPENAI_API_KEY="sk-xxxxxx"
node {baseDir}/scripts/generate.mjs --prompt "描述" --save ./output.png

# 中转站（配置了 GPT_IMAGE_API_KEY 且无官方 Key 时默认）
export GPT_IMAGE_API_KEY="sk-xxxxxx"
node {baseDir}/scripts/generate.mjs --prompt "描述" --save ./output.png

# 手动强制指定 relay 模式（覆盖自动判断）
node {baseDir}/scripts/generate.mjs --mode relay --prompt "描述" --save ./output.png

# 官方直调（手动指定代理）
node {baseDir}/scripts/generate.mjs --mode direct --proxy 127.0.0.1:7897 --prompt "描述" --save ./output.png

# 官方直调（禁用代理，直接连接）
node {baseDir}/scripts/generate.mjs --mode direct --no-proxy --prompt "描述" --save ./output.png
```

### 图生图（base64 参考图编辑）

```bash
# 官方直调编辑模式（配置了 OPENAI_API_KEY 时自动走 direct）
export OPENAI_API_KEY="sk-xxxxxx"
node {baseDir}/scripts/generate.mjs --edit \
  --reference ./photo.png \
  --prompt "将背景替换为纯白色，保持主体不变" \
  --save ./edited.png
```

## 参数说明

### 基础参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--prompt` | 是 | 图片描述提示词，中英文均可，最长 32,000 字符 |
| `--save` | 是 | 输出文件路径（建议 `.png`） |
| `--model` | 否 | 模型名称，默认 `gpt-image-2` |
| `--help, -h` | 否 | 显示帮助 |

### API 模式

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--mode` | 否 | **自动判断** | `direct` = OpenAI 官方 / `relay` = ICU 中转站。配置了 `OPENAI_API_KEY` 时默认 direct，否则 relay |

### 代理（仅 direct 模式）

| 参数 | 必填 | 说明 |
|------|------|------|
| `--proxy` | 否 | HTTP 代理地址，如 `127.0.0.1:7890` 或 `http://127.0.0.1:7890`。省略时自动检测（环境变量 → 系统代理 → 常见进程） |
| `--no-proxy` | 否 | 禁用所有代理，直接连接目标服务器。适用于 VPN 全局直连场景 |

### 图生图编辑模式

| 参数 | 必填 | 说明 |
|------|------|------|
| `--edit` | 是（启用编辑时） | 启用图像编辑模式，调用 `/v1/images/edits` |
| `--reference` | 是（--edit 时必填） | 参考图片路径，脚本自动转 base64 传入 API |

### 画质与尺寸

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--quality` | 否 | `auto` | `low` / `medium` / `high` / `auto` |
| `--size` | 否 | `1024x1024` | 分辨率，支持 `1024x1536`、`1536x1024`、`2048x2048` 等 |
| `--format` | 否 | `png` | 输出格式：`png` / `jpeg` / `webp` |
| `--background` | 否 | — | 设为 `transparent` 可生成透明背景（仅 direct 模式） |

## 模式对比

| 维度 | direct（官方直调） | relay（中转站） |
|------|-------------------|-----------------|
| 端点 | `api.openai.com` | `rehdasu.cn` |
| API Key | `OPENAI_API_KEY` | `GPT_IMAGE_API_KEY` |
| 文生图 | ✅ | ✅ |
| 图生图（base64 参考图） | ✅ | ⚠️ 取决于中转站支持 |
| 透明背景 | ✅ | ⚠️ 可能不支持 |
| 默认启用 | **OPENAI_API_KEY 存在时** | 无官方 Key 时回退 |

## 与即梦 AI 的对比

| 维度 | GPT-Image-2 | 即梦 AI 4.6 |
|------|------------|------------|
| 接口类型 | **同步**（直接返回 Base64） | 异步（需轮询 task_id） |
| 响应速度 | 快（无需轮询） | 慢（创建任务 + 轮询 ~10-30s） |
| 输出格式 | Base64 → 本地 PNG | 图片 URL → 下载 |
| 风格倾向 | 写实、高质量产品/场景图 | 示意图、插画、设计感 |
| 参考图编辑 | ✅ base64 Data URI | ❌ |
| 适用场景 | 高质量实物图、写实渲染、图片编辑 | 学术示意图、概念图、流程图 |

## Prompt 写作建议

GPT-Image-2 擅长写实和高质量渲染，建议在 prompt 中描述：
- 主体是什么
- 场景/背景在哪里
- 风格（写实/插画/极简/商业）
- 光线、构图、色彩要求

**图生图编辑 prompt 建议**：明确要修改什么、保留什么。示例：
- ✅ "将背景替换为纯白色，保持商品主体不变，添加柔和阴影"
- ❌ "美化一下"

## 定价参考

| 质量 | 1024×1024 | 适用场景 |
|------|-----------|----------|
| `low` | ~$0.006/张 | 快速预览、草图 |
| `medium` | ~$0.053/张 | 标准生产 |
| `high` | ~$0.211/张 | 高清印刷 |

计费方式：按 token 计费（图像输出 $30/M tokens），非简单按张计费。

## API 详情

### 官方直调端点
- **文生图**：`POST https://api.openai.com/v1/images/generations`
- **图生图**：`POST https://api.openai.com/v1/images/edits`

### 中转站端点
- **文生图**：`POST https://rehdasu.cn/v1/images/generations`
- **图生图**：`POST https://rehdasu.cn/v1/images/edits`

### 认证
`Authorization: Bearer <API_KEY>`

### 图生图请求体示例
```json
{
  "model": "gpt-image-2",
  "images": [{"image_url": "data:image/png;base64,iVBORw0KGgoAAAA..."}],
  "prompt": "将背景替换为纯白色",
  "size": "1024x1024",
  "quality": "high"
}
```

## 批量与代理说明

**本脚本采用同步调用，一次一张图。** 如需批量后台处理，可使用 OpenAI Batch API（支持图片端点，50% 折扣，24h 完成窗口），但本 skill 暂不封装。

**代理自动检测**：direct 模式访问 `api.openai.com` 时，脚本按以下优先级自动检测代理：
1. 环境变量 `http_proxy` / `https_proxy`
2. macOS / Windows 系统代理设置（`networksetup` / 注册表）
3. 常见代理进程推断端口（Clash Verge 7897、Clash 7890、V2Ray 10809、Shadowsocks 1080、Surge 6152）

检测失败时可手动通过 `--proxy host:port` 指定。如已开启 VPN 全局直连，可通过 `--no-proxy` 禁用代理直接连接。relay 模式通常无需代理。

## Agent 执行约束

> **重要**：本脚本是同步阻塞调用，Agent 执行时必须遵守以下规则，避免提前中断或无效轮询。

### 1. 必须等待脚本进程退出

```
node generate.mjs --prompt "..." --save ./out.png
```

- 上述命令会**阻塞直到图片生成完成**，不要看到"正在请求图片生成..."就中断对话
- 脚本成功时会输出 `✅ 图片已保存: ./out.png (XXX KB, 耗时 X.Xs)`，此时才算完成
- 失败时会输出 `[ERROR] ...` 并 `process.exit(1)`，此时才算结束
- **不要中途停止或开新对话**，等进程自然结束

### 2. 禁止轮询

- 本 skill 是**同步 API**（直接返回 base64），不是异步任务
- **不需要、也不应该**轮询查询生成状态
- 不要执行类似 "检查图片是否生成完成" 的额外操作
- 单次 `node generate.mjs` 调用即完成全部工作

### 3. 超时处理

- 脚本内置 360s 超时保护（AbortController）
- 如果超时，脚本会输出 `[ERROR] 本地超时 (360s)` 并退出
- 此时应向用户报告超时，不要尝试重试或轮询

### 4. 网络请求失败处理

> **核心原则：遇到网络请求失败，直接停止生图任务，不盲目重试。**

当脚本输出 `[ERROR] 网络请求失败` 时，**不要**：
- ❌ 自动重试同一请求
- ❌ 切换参数后重试
- ❌ 轮询检查网络是否恢复

**应该**：向用户报告错误，并引导用户按以下顺序检查 VPN：

| 步骤 | 检查内容 | 操作 |
|------|----------|------|
| 1 | VPN 是否已开启 | 确认 VPN 软件（如 Clash Verge）正在运行 |
| 2 | 当前节点是否通畅 | 在浏览器中打开 `https://api.openai.com` 确认能访问 |
| 3 | 节点通畅但仍失败 | 切换其他 VPN 节点后重试 |
| 4 | 以上均无效 | 通过 `--proxy host:port` 手动指定代理端口 |

脚本会在错误输出中自动包含上述提示，Agent 只需将错误信息原文转达给用户即可。

**例外：直连→代理降级**。当 direct 模式未使用代理且直连失败时，脚本会自动检测代理并降级重试一次（非盲目重试，而是从直连切换到代理）。此降级仅执行一次，降级失败后直接停止。

### 5. 与即梦 AI 的本质区别

| 行为 | GPT-Image-2（本 skill） | 即梦 AI |
|------|------------------------|---------|
| 调用方式 | 一次 `node` 命令，阻塞等待 | 创建任务 → 轮询 task_id |
| Agent 应该 | 等进程退出 | 轮询状态 |
| 完成标志 | `✅ 图片已保存` | 状态变为 "success" |
| 是否需要额外查询 | ❌ 否 | ✅ 是 |

### 6. 典型执行流程（Agent 参考）

```
1. 构建命令: node generate.mjs --prompt "..." --save ./out.png
2. 执行命令，等待进程退出
3. 检查退出码 + 输出内容
   - 包含 "✅ 图片已保存" → 成功，向用户展示图片
   - 包含 "[ERROR]" → 失败，向用户报告错误
4. 结束，不要执行任何额外查询/轮询操作
```

## 注意事项

- API Key 通过环境变量传入，切勿硬编码在脚本中
- direct 模式访问 `api.openai.com` 如遇网络问题，可通过 `--proxy` 指定 HTTP 代理；如已开启 VPN 全局直连，使用 `--no-proxy` 直接连接
- 保存路径会自动创建文件，不会自动创建目录（需确保目标目录存在）
- 参考图文件限制 < 10MB，超出时脚本会提示压缩
- 图生图模式下，中转站可能不支持 edits 端点，建议使用 direct 模式
- 生成失败时检查：API Key 是否正确、账户余额是否充足、prompt 是否触发了内容审核

## 超时机制

- **服务端超时**：Cloudflare HTTP 524（~100s，最常见），复杂中文信息图 Prompt 触发概率高
- **本地兜底**：脚本内置 AbortController 360s 超时保护
- **Bash 兜底**：调用侧超时（最高层保护，取决于调用方配置）
- 详见 mods-pptx skill 的 GPT-Image-2 超时应对策
