#!/usr/bin/env node
/**
 * GPT-Image-2 图片生成脚本
 *
 * 输出协议（学习 WorkBuddy 官方 ImageGen 工具设计）:
 *   stdout = 结构化 JSON 结果（唯一给 LLM 的 Observation 主体）
 *   stderr = 人类可读进度日志（不影响 LLM 判断）
 *
 * stdout JSON 格式:
 *   成功: {"type":"image_gen_result","status":"completed","image_path":"...","size_kb":123,"elapsed_s":45.2}
 *   失败: {"type":"image_gen_result","status":"failed","error":"...","hint":"..."}
 *   超时: {"type":"image_gen_result","status":"timeout","error":"...","hint":"..."}
 *   参数错误: {"type":"image_gen_result","status":"invalid_params","error":"..."}
 *
 * 支持两种 API 模式：
 *   --mode direct   OpenAI 官方直调 (api.openai.com)
 *   --mode relay    ICU 中转站 (rehdasu.cn)
 *   未指定时自动判断：配置了 OPENAI_API_KEY 则优先 direct，否则 relay
 *
 * 零依赖，纯 Node.js 内置模块
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { extname, basename } from 'path';
import { connect } from 'net';
import { request as httpsRequest } from 'https';
import { connect as tlsConnect } from 'tls';
import { execSync } from 'child_process';

// ---- 统一输出函数：stdout = JSON 结果，stderr = 进度日志 ----
function log(msg)  { console.error(msg); }           // 进度日志 → stderr
function result(obj, exitCode = 0) {                  // 最终结果 → stdout
  console.log(JSON.stringify(obj));
  process.exit(exitCode);
}

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
      const lines = services.split('\n').slice(1);
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
        return { source: 'Clash Verge 进程', address: '127.0.0.1:7897' };
      }
      if (ps.includes('clash') || ps.includes('Clash')) {
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

        const remaining = buffer.slice(headerEnd + 4);
        if (remaining.length > 0) {
          tcpSocket.unshift(remaining);
        }

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

// ---- 帮助信息（纯文本到 stdout，非生成结果） ----
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

输出协议:
  stdout = 结构化 JSON 结果（给 LLM 解析）
  stderr = 人类可读进度日志（不影响 LLM 判断）

  成功: {"type":"image_gen_result","status":"completed","image_path":"...","size_kb":N,"elapsed_s":N}
  失败: {"type":"image_gen_result","status":"failed","error":"...","hint":"..."}

示例:
  # 官方直调文生图 (配置了 OPENAI_API_KEY 时默认)
  node generate.mjs --prompt "一只猫在太空" --save ./cat.png

  # 中转站文生图 (配置了 GPT_IMAGE_API_KEY 时默认)
  node generate.mjs --prompt "一只猫在太空" --save ./cat.png

  # 官方直调图生图 (base64 参考图编辑)
  node generate.mjs --edit \\
    --reference ./photo.png --prompt "将背景替换为纯白色" --save ./edited.png`);
  process.exit(showHelp ? 0 : 1);
}

// ---- 基础校验（参数错误输出 JSON 到 stdout） ----
if (!savePath) {
  result({ type: 'image_gen_result', status: 'invalid_params', error: '缺少 --save 参数' }, 1);
}

if (mode !== 'direct' && mode !== 'relay') {
  result({ type: 'image_gen_result', status: 'invalid_params', error: `无效的 --mode: ${mode}，仅支持 direct 或 relay` }, 1);
}

if (isEdit && !reference) {
  result({ type: 'image_gen_result', status: 'invalid_params', error: '--edit 模式下必须提供 --reference <路径>' }, 1);
}

// ---- API Key 选择 ----
let API_KEY;
if (mode === 'direct') {
  API_KEY = process.env.OPENAI_API_KEY;
  if (!API_KEY) {
    result({ type: 'image_gen_result', status: 'invalid_params', error: 'direct 模式需要设置环境变量 OPENAI_API_KEY', hint: '请先执行: export OPENAI_API_KEY="sk-xxxxxx"' }, 1);
  }
} else {
  API_KEY = process.env.GPT_IMAGE_API_KEY;
  if (!API_KEY) {
    result({ type: 'image_gen_result', status: 'invalid_params', error: 'relay 模式需要设置环境变量 GPT_IMAGE_API_KEY', hint: '请先执行: export GPT_IMAGE_API_KEY="sk-xxxxxx"' }, 1);
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
    result({ type: 'image_gen_result', status: 'failed', error: `无法读取参考图: ${filePath}`, detail: err.message }, 1);
  }

  if (buffer.length > MAX_REFERENCE_SIZE) {
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
    result({ type: 'image_gen_result', status: 'failed', error: `参考图过大: ${sizeMB} MB (限制 ${MAX_REFERENCE_SIZE / 1024 / 1024} MB)`, hint: '请压缩图片后重试' }, 1);
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

  if (isEdit) {
    const dataURI = imageToDataURI(reference);
    base.images = [{ image_url: dataURI }];
  }

  if (format !== 'png') {
    base.output_format = format;
  }

  if (background === 'transparent') {
    if (mode === 'direct') {
      base.background = 'transparent';
    } else {
      log('[WARN] relay 模式可能不支持透明背景，已忽略 --background 参数');
    }
  }

  return base;
}

// ---- 主流程 ----
async function sendRequest(fetchFn, url, options) {
  const controller = new AbortController();
  const FETCH_TIMEOUT_MS = 360_000; // 360s
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

const VPN_HINT = '请检查 VPN 连接：1.VPN是否已开启 2.当前节点是否通畅 3.切换其他节点尝试 4.或通过 --proxy 手动指定代理端口';

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

  // ---- 进度信息全部输出到 stderr ----
  log(`  模式: ${mode}${isEdit ? ' (编辑)' : ' (生图)'}`);
  log(`  端点: ${endpoint}`);
  log(`  模型: ${model}`);
  log(`  质量: ${quality}  |  尺寸: ${size}`);
  if (format !== 'png') log(`  格式: ${format}`);
  if (background) log(`  背景: ${background}`);
  if (proxyAddress && mode === 'direct') log(`  代理: ${proxyAddress} (${proxySource})`);
  if (isEdit) log(`  参考图: ${basename(reference)}`);
  log(`  Prompt 长度: ${prompt.length} 字符`);
  log(`  输出: ${savePath}`);
  log(`\n正在请求图片生成...`);

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
        log(`  ⚠ 直连失败 (${err.message})，自动降级为代理: ${detected.address} (${detected.source})`);
        const retryFetch = createProxyFetch(detected.address);
        try {
          resp = await sendRequest(retryFetch, endpoint, requestOpts);
        } catch (err2) {
          result({ type: 'image_gen_result', status: 'failed', error: `网络请求失败（代理重试）: ${err2.message}`, detail: `原始错误: ${err.message}`, hint: VPN_HINT }, 1);
        }
      } else {
        result({ type: 'image_gen_result', status: 'failed', error: `网络请求失败: ${err.message}`, hint: VPN_HINT }, 1);
      }
    } else {
      if (err.name === 'AbortError') {
        result({ type: 'image_gen_result', status: 'timeout', error: '本地超时 (360s) —— 服务端未响应', hint: '1. Prompt 过于复杂导致服务端处理超时 2. VPN 节点不稳定，尝试切换节点' }, 1);
      } else {
        result({ type: 'image_gen_result', status: 'failed', error: `网络请求失败: ${err.message}`, hint: VPN_HINT }, 1);
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    let hint = '';
    if (isEdit && mode === 'relay' && (resp.status === 404 || resp.status === 400)) {
      hint = '中转站可能不支持图像编辑端点，请尝试 --mode direct';
    }
    result({ type: 'image_gen_result', status: 'failed', error: `HTTP ${resp.status} ${resp.statusText}`, detail: errText.slice(0, 500), hint }, 1);
  }

  let json;
  try {
    json = await resp.json();
  } catch (err) {
    result({ type: 'image_gen_result', status: 'failed', error: '响应不是有效 JSON' }, 1);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    result({ type: 'image_gen_result', status: 'failed', error: '响应中未找到 b64_json 字段', detail: JSON.stringify(json).slice(0, 300) }, 1);
  }

  // 解码 Base64 并写入文件
  try {
    const buffer = Buffer.from(b64, 'base64');
    writeFileSync(savePath, buffer);
  } catch (err) {
    result({ type: 'image_gen_result', status: 'failed', error: `写入文件失败: ${err.message}` }, 1);
  }

  const stats = statSync(savePath);
  log(`\n✅ 图片已保存: ${savePath} (${(stats.size / 1024).toFixed(0)} KB, 耗时 ${elapsed}s)`);

  // ---- stdout 输出结构化 JSON 结果 ----
  result({
    type: 'image_gen_result',
    status: 'completed',
    image_path: savePath,
    size_kb: Math.round(stats.size / 1024),
    elapsed_s: parseFloat(elapsed),
  });
}

main();
