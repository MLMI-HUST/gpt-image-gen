#!/usr/bin/env node
/**
 * GPT-Image-2 图片生成脚本
 *
 * 支持两种 API 模式：
 *   --mode direct   OpenAI 官方直调 (api.openai.com)
 *   --mode relay    ICU 中转站 (rehdasu.cn)
 *   未指定时自动判断：配置了 OPENAI_API_KEY 则优先 direct，否则 relay
 *
 * 支持两种生成模式：
 *   文生图：--prompt "描述"
 *   图生图：--edit --reference ./ref.png --prompt "修改描述"
 *
 * 用法:
 *   # 官方直调文生图（配置了 OPENAI_API_KEY 时默认）
 *   export OPENAI_API_KEY="sk-xxxxxx"
 *   node generate.mjs --prompt "描述" --save ./output.png
 *
 *   # 中转站文生图（配置了 GPT_IMAGE_API_KEY 且无 OPENAI_API_KEY 时默认）
 *   export GPT_IMAGE_API_KEY="sk-xxxxxx"
 *   node generate.mjs --prompt "描述" --save ./output.png
 *
 *   # 手动强制指定模式（覆盖自动判断）
 *   node generate.mjs --mode relay --prompt "描述" --save ./output.png
 *   node generate.mjs --mode direct --prompt "描述" --save ./output.png
 *
 *   # 官方直调图生图（base64 参考图）
 *   node generate.mjs --edit --reference ./photo.png --prompt "改背景" --save ./out.png
 *
 * 零依赖，纯 Node.js 内置模块 (fetch + Buffer + fs + path + net + https + tls + child_process)
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { extname, basename } from 'path';
import { connect } from 'net';
import { request as httpsRequest } from 'https';
import { connect as tlsConnect } from 'tls';
import { execSync } from 'child_process';

// ---- 代理地址规范化：无 scheme 时默认 http:// ----
function normalizeProxyAddress(addr) {
  if (!addr) return null;
  return addr.includes('://') ? addr : `http://${addr}`;
}

// ---- 端点配置 ----
const ENDPOINTS = {
  direct: {
    generate: 'https://api.openai.com/v1/images/generations',
    edit:     'https://api.openai.com/v1/images/edits',
  },
  relay: {
    generate: 'https://rehdasu.cn/v1/images/generations',
    edit:     'https://rehdasu.cn/v1/images/edits',
  },
};

const MAX_REFERENCE_SIZE = 10 * 1024 * 1024; // 10MB

// ---- 代理自动检测 ----
function detectProxy() {
  // 1. 环境变量（最高优先级，用户主动设置）
  const envProxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (envProxy) {
    try {
      const url = new URL(envProxy);
      return { source: '环境变量', address: `${url.hostname}:${url.port || 80}` };
    } catch { /* ignore */ }
  }

  // 2. macOS 系统代理（networksetup）
  if (process.platform === 'darwin') {
    try {
      const services = execSync('networksetup -listallnetworkservices 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const lines = services.split('\n').slice(1); // 跳过首行说明
      for (const service of lines) {
        const s = service.trim();
        if (!s || s.startsWith('*')) continue;
        try {
          const out = execSync(`networksetup -getwebproxy "${s}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
          const enabled = out.match(/Enabled:\s*(\S+)/);
          const server = out.match(/Server:\s*(\S+)/);
          const port = out.match(/Port:\s*(\S+)/);
          if (enabled && enabled[1] === 'Yes' && server && port) {
            return { source: `系统代理 (${s})`, address: `${server[1]}:${port[1]}` };
          }
        } catch { /* ignore this service */ }
      }
    } catch { /* ignore */ }
  }

  // 3. Windows 系统代理（注册表）
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable 2>nul && reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul', { encoding: 'utf8', timeout: 3000 });
      const enabled = out.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/);
      if (enabled && enabled[1] !== '0') {
        const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
        if (server) {
          return { source: '系统代理', address: server[1] };
        }
      }
    } catch { /* ignore */ }
  }

  // 4. 常见代理进程 → 推断端口（macOS / Linux）
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const ps = execSync('ps aux 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      if (ps.includes('clash-verge')) {
        // Clash Verge 默认 HTTP 端口 7897
        return { source: 'Clash Verge 进程', address: '127.0.0.1:7897' };
      }
      if (ps.includes('clash') || ps.includes('Clash')) {
        // Clash / ClashX 默认 HTTP 7890
        return { source: 'Clash 进程', address: '127.0.0.1:7890' };
      }
      if (ps.includes('v2ray')) {
        return { source: 'V2Ray 进程', address: '127.0.0.1:10809' };
      }
      if (ps.includes('shadowsocks')) {
        return { source: 'Shadowsocks 进程', address: '127.0.0.1:1080' };
      }
      if (ps.includes('surge')) {
        return { source: 'Surge 进程', address: '127.0.0.1:6152' };
      }
    } catch { /* ignore */ }
  }

  return null;
}

// ---- 零依赖代理 fetch（HTTPS over HTTP CONNECT） ----
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  const url = proxyStr.includes('://') ? new URL(proxyStr) : new URL(`http://${proxyStr}`);
  return { host: url.hostname, port: parseInt(url.port, 10) || 80 };
}

function createProxyFetch(proxyStr) {
  const proxy = parseProxy(proxyStr);
  if (!proxy) return fetch;

  return function proxyFetch(url, options = {}) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      let tcpSocket;
      let aborted = false;

      if (options.signal) {
        if (options.signal.aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        options.signal.addEventListener('abort', () => {
          aborted = true;
          if (tcpSocket) tcpSocket.destroy();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }

      tcpSocket = connect(proxy.port, proxy.host);

      tcpSocket.once('connect', () => {
        if (aborted) return;
        tcpSocket.write(`CONNECT ${target.host}:443 HTTP/1.1\r\nHost: ${target.host}:443\r\n\r\n`);
      });

      // Accumulate data until we find the end of the HTTP CONNECT response.
      let buffer = Buffer.alloc(0);
      let resolved = false;

      const cleanup = () => {
        tcpSocket.off('data', onData);
        tcpSocket.off('error', onError);
      };

      const onError = (err) => {
        if (!aborted && !resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      };

      const onData = (data) => {
        if (aborted || resolved) return;
        buffer = Buffer.concat([buffer, data]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        resolved = true;
        cleanup();

        const responseText = buffer.slice(0, headerEnd).toString();
        const statusLine = responseText.split('\r\n')[0];
        if (!statusLine.includes('200')) {
          tcpSocket.destroy();
          reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
          return;
        }

        // Push any bytes after \r\n\r\n back so TLS reads them first.
        const remaining = buffer.slice(headerEnd + 4);
        if (remaining.length > 0) {
          tcpSocket.unshift(remaining);
        }

        // Upgrade the TCP socket to TLS.  Do NOT pause — tls.connect
        // needs the socket readable to perform its own handshake.
        const tlsSocket = tlsConnect({
          socket: tcpSocket,
          servername: target.hostname,
        }, () => {
          if (aborted) return;

          const req = httpsRequest({
            host: target.hostname,
            path: target.pathname + target.search,
            method: options.method || 'GET',
            headers: options.headers,
            createConnection: () => tlsSocket,
          }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              if (aborted) return;
              const buf = Buffer.concat(chunks);
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                statusText: res.statusMessage,
                text: () => Promise.resolve(buf.toString()),
                json: () => Promise.resolve(JSON.parse(buf.toString())),
              });
            });
            res.on('error', (err) => { if (!aborted) reject(err); });
          });

          req.on('error', (err) => { if (!aborted) reject(err); });
          if (options.body) req.write(options.body);
          req.end();
        });

        tlsSocket.on('error', (err) => { if (!aborted) reject(err); });
      };

      tcpSocket.on('data', onData);
      tcpSocket.on('error', onError);
    });
  };
}

// ---- 参数解析 ----
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
function hasFlag(flag) {
  return args.includes(flag);
}

const prompt      = getArg('--prompt');
const savePath    = getArg('--save');
const showHelp    = hasFlag('--help') || hasFlag('-h');

// 模式自动判断：OPENAI_API_KEY 存在时优先 direct，否则 relay
let mode = getArg('--mode');
if (!mode) {
  if (process.env.OPENAI_API_KEY) {
    mode = 'direct';
  } else {
    mode = 'relay';
  }
}

const isEdit      = hasFlag('--edit');
const reference   = getArg('--reference');
const model       = getArg('--model') || 'gpt-image-2';
const quality     = getArg('--quality') || 'auto';
const size        = getArg('--size') || '1024x1024';
const format      = getArg('--format') || 'png';
const background  = getArg('--background') || null;
const proxy       = getArg('--proxy');
const noProxy     = hasFlag('--no-proxy');

// ---- 帮助信息 ----
if (showHelp || !prompt) {
  console.log(`GPT-Image-2 图片生成

用法:
  node generate.mjs --prompt "描述" --save ./output.png [选项]

参数:
  --prompt <文字>       图片描述提示词 (必填)
  --save <路径>         输出文件路径 (必填)
  --model <名称>        模型名称 (默认: gpt-image-2)
  --help, -h            显示帮助

API 模式:
  --mode <direct|relay> 强制指定 API 模式
    direct  → OpenAI 官方直调 (需 OPENAI_API_KEY)
    relay   → ICU 中转站 (需 GPT_IMAGE_API_KEY)
    省略时自动判断：配置了 OPENAI_API_KEY 则优先 direct，否则 relay

代理 (仅 direct 模式):
  --proxy <host:port>   HTTP 代理地址，如 127.0.0.1:7890 或 http://127.0.0.1:7890
                        省略时自动检测（环境变量 / 系统代理 / 进程）
  --no-proxy            禁用所有代理，直接连接目标服务器

图生图模式:
  --edit                启用图像编辑模式
  --reference <路径>    参考图片路径 (--edit 时必填)

画质与尺寸:
  --quality <档位>      质量: low / medium / high / auto (默认: auto)
  --size <尺寸>         分辨率 (默认: 1024x1024)
  --format <png|jpeg>   输出格式 (默认: png)
  --background transparent  透明背景 (仅 direct 模式)

环境变量:
  OPENAI_API_KEY        官方直调 API Key (存在时默认启用 direct)
  GPT_IMAGE_API_KEY     中转站 API Key (无 OPENAI_API_KEY 时默认启用 relay)

示例:
  # 官方直调文生图 (配置了 OPENAI_API_KEY 时默认)
  node generate.mjs --prompt "一只猫在太空" --save ./cat.png

  # 中转站文生图 (配置了 GPT_IMAGE_API_KEY 时默认)
  node generate.mjs --prompt "一只猫在太空" --save ./cat.png

  # 手动强制指定 relay 模式（覆盖自动判断）
  node generate.mjs --mode relay --prompt "一只猫在太空" --save ./cat.png

  # 官方直调文生图 (手动指定代理)
  node generate.mjs --mode direct --proxy 127.0.0.1:7897 \\
    --prompt "一只猫在太空" --save ./cat.png

  # 官方直调文生图 (禁用代理直接连接)
  node generate.mjs --mode direct --no-proxy \\
    --prompt "一只猫在太空" --save ./cat.png

  # 官方直调图生图 (base64 参考图编辑)
  node generate.mjs --edit \\
    --reference ./photo.png --prompt "将背景替换为纯白色" --save ./edited.png`);
  process.exit(showHelp ? 0 : 1);
}

// ---- 基础校验 ----
if (!savePath) {
  console.error('[ERROR] 缺少 --save 参数');
  process.exit(1);
}

if (mode !== 'direct' && mode !== 'relay') {
  console.error(`[ERROR] 无效的 --mode: ${mode}，仅支持 direct 或 relay`);
  process.exit(1);
}

if (isEdit && !reference) {
  console.error('[ERROR] --edit 模式下必须提供 --reference <路径>');
  process.exit(1);
}

// ---- API Key 选择 ----
let API_KEY;
if (mode === 'direct') {
  API_KEY = process.env.OPENAI_API_KEY;
  if (!API_KEY) {
    console.error('[ERROR] direct 模式需要设置环境变量 OPENAI_API_KEY');
    console.error('请先执行: export OPENAI_API_KEY="sk-xxxxxx"');
    process.exit(1);
  }
} else {
  API_KEY = process.env.GPT_IMAGE_API_KEY;
  if (!API_KEY) {
    console.error('[ERROR] relay 模式需要设置环境变量 GPT_IMAGE_API_KEY');
    console.error('请先执行: export GPT_IMAGE_API_KEY="sk-xxxxxx"');
    process.exit(1);
  }
}

// ---- 端点选择 ----
const endpoint = isEdit ? ENDPOINTS[mode].edit : ENDPOINTS[mode].generate;

// ---- 辅助函数: 本地图片 → Data URI ----
function imageToDataURI(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (err) {
    console.error(`[ERROR] 无法读取参考图: ${filePath}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  if (buffer.length > MAX_REFERENCE_SIZE) {
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
    console.error(`[ERROR] 参考图过大: ${sizeMB} MB (限制 ${MAX_REFERENCE_SIZE / 1024 / 1024} MB)`);
    console.error('  请压缩图片后重试');
    process.exit(1);
  }

  const b64 = buffer.toString('base64');
  const ext = extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${b64}`;
}

// ---- 构建请求体 ----
function buildRequestBody() {
  const base = {
    model: model,
    prompt: prompt,
    quality: quality,
    size: size,
  };

  // 图生图: 附加 base64 参考图
  if (isEdit) {
    const dataURI = imageToDataURI(reference);
    base.images = [{ image_url: dataURI }];
  }

  // 输出格式 (非默认时传入)
  if (format !== 'png') {
    base.output_format = format;
  }

  // 透明背景 (仅 direct 模式支持)
  if (background === 'transparent') {
    if (mode === 'direct') {
      base.background = 'transparent';
    } else {
      console.warn('[WARN] relay 模式可能不支持透明背景，已忽略 --background 参数');
    }
  }

  return base;
}

// ---- 主流程 ----
async function sendRequest(fetchFn, url, options) {
  const controller = new AbortController();
  const FETCH_TIMEOUT_MS = 360_000; // 360s，适配复杂提示词
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetchFn(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function main() {
  const reqBody = buildRequestBody();

  // 代理解析：--no-proxy > 参数 > 自动检测
  let proxyAddress = proxy;
  let proxySource = '参数';
  if (noProxy) {
    proxyAddress = null;
    proxySource = '禁用';
  } else if (mode === 'direct' && !proxyAddress) {
    const detected = detectProxy();
    if (detected) {
      proxyAddress = normalizeProxyAddress(detected.address);
      proxySource = detected.source;
    }
  } else if (proxyAddress) {
    proxyAddress = normalizeProxyAddress(proxyAddress);
  }

  const requestOpts = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  };

  console.log(`  模式: ${mode}${isEdit ? ' (编辑)' : ' (生图)'}`);
  console.log(`  端点: ${endpoint}`);
  console.log(`  模型: ${model}`);
  console.log(`  质量: ${quality}  |  尺寸: ${size}`);
  if (format !== 'png') console.log(`  格式: ${format}`);
  if (background) console.log(`  背景: ${background}`);
  if (proxyAddress && mode === 'direct') console.log(`  代理: ${proxyAddress} (${proxySource})`);
  if (isEdit) console.log(`  参考图: ${basename(reference)}`);
  console.log(`  Prompt 长度: ${prompt.length} 字符`);
  console.log(`  输出: ${savePath}`);

  console.log(`\n正在请求图片生成...`);

  // 首次尝试：使用解析出的 fetch 函数
  const doFetch = proxyAddress ? createProxyFetch(proxyAddress) : fetch;

  const start = Date.now();
  let resp;
  try {
    resp = await sendRequest(doFetch, endpoint, requestOpts);
  } catch (err) {
    // 直连失败时，尝试自动降级为代理重试（仅 direct 模式且未使用代理时）
    if (!proxyAddress && mode === 'direct') {
      const detected = detectProxy();
      if (detected) {
        console.log(`  ⚠ 直连失败 (${err.message})，自动降级为代理: ${detected.address} (${detected.source})`);
        const retryFetch = createProxyFetch(detected.address);
        try {
          resp = await sendRequest(retryFetch, endpoint, requestOpts);
        } catch (err2) {
          console.error(`[ERROR] 网络请求失败（代理重试）: ${err2.message}`);
          console.error(`  原始错误: ${err.message}`);
          process.exit(1);
        }
      } else {
        console.error(`[ERROR] 网络请求失败: ${err.message}`);
        console.error('  提示: 直连失败且未检测到代理，可通过 --proxy 手动指定');
        process.exit(1);
      }
    } else {
      if (err.name === 'AbortError') {
        console.error(`[ERROR] 本地超时 (360s) —— 服务端未响应`);
      } else {
        console.error(`[ERROR] 网络请求失败: ${err.message}`);
      }
      process.exit(1);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`[ERROR] HTTP ${resp.status} ${resp.statusText}`);
    if (errText) console.error(`  响应: ${errText.slice(0, 500)}`);

    // 中转站 edits 端点可能不支持，给出提示
    if (isEdit && mode === 'relay' && (resp.status === 404 || resp.status === 400)) {
      console.error('\n💡 中转站可能不支持图像编辑端点，请尝试 --mode direct');
    }
    process.exit(1);
  }

  let json;
  try {
    json = await resp.json();
  } catch (err) {
    console.error('[ERROR] 响应不是有效 JSON');
    process.exit(1);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    console.error('[ERROR] 响应中未找到 b64_json 字段');
    console.error(`  实际响应: ${JSON.stringify(json).slice(0, 300)}`);
    process.exit(1);
  }

  // 解码 Base64 并写入文件
  try {
    const buffer = Buffer.from(b64, 'base64');
    writeFileSync(savePath, buffer);
  } catch (err) {
    console.error(`[ERROR] 写入文件失败: ${err.message}`);
    process.exit(1);
  }

  const stats = statSync(savePath);
  console.log(`\n✅ 图片已保存: ${savePath} (${(stats.size / 1024).toFixed(0)} KB, 耗时 ${elapsed}s)`);
}

main();
