// server.mjs
// Node.js 自托管版本：Express + axios 流式代理
// 公共逻辑下沉到 proxy-core，本文件只剩 Express 运行时差异

import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

import {
  validateAuth,
  isValidUrl,
  parseUserAgents,
  randomUserAgent,
  buildCorsHeaders,
  isPreflight,
  checkContentLength,
  DEFAULT_MAX_RESPONSE_BYTES,
} from './proxy-core/index.mjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: randomUserAgent(parseUserAgents(process.env.USER_AGENTS_JSON, {
    onWarn: (msg) => console.warn(`[Node Proxy] ${msg}`),
  })),
  debug: process.env.DEBUG === 'true',
};

const log = (...args) => {
  if (config.debug) console.log('[DEBUG]', ...args);
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // 宽松 CSP（防御纵深）：允许内联脚本/样式（Tailwind 运行时 + 既有 onclick），
  // 媒体/图片允许任意 http(s)（播放与封面来源多样），worker 允许 blob（HLS）。
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' data: https: http:; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https: http: blob:; " +
    "media-src 'self' https: http: blob:; " +
    "connect-src 'self' https: http:; " +
    "frame-src 'self' https: http:; " +
    "font-src 'self' data:; " +
    "worker-src 'self' blob:;"
  );
  next();
});

// --- Password hash for HTML 模板占位符（仅渲染阶段用） ---
async function sha256Hash(input) {
  const hash = crypto.createHash('sha256');
  hash.update(input);
  return new Promise((resolve) => resolve(hash.digest('hex')));
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  // 阶段 2.5：异步 SHA-256，避免阻塞事件循环
  const sha256 = password ? await sha256Hash(password) : '';
  return content.replace('{{PASSWORD}}', sha256);
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    if (req.path === '/player.html') {
      filePath = path.join(__dirname, 'player.html');
    } else {
      filePath = path.join(__dirname, 'index.html');
    }
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const content = await renderPage(path.join(__dirname, 'index.html'), config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

// --- /proxy/:encodedUrl ---
// --- 代理 API 请求限流（仅限非媒体类，避免误伤视频分片播放） ---
// 媒体文件（m3u8/ts/mp4/图片等）不限流；API 搜索/详情类 60 秒窗口内每 IP 最多 60 次。
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const MEDIA_EXT_RE = /\.(m3u8|ts|mp4|flv|m4s|mp3|aac|png|jpg|jpeg|webp|gif|svg|ico)$/i;

function isRateLimited(ip) {
  const now = Date.now();
  // 定期清理过期条目，防止 Map 无限增长
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW) rateLimitMap.delete(k);
    }
  }
  const rec = rateLimitMap.get(ip);
  if (!rec || now - rec.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT_MAX;
}

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    // 阶段 2.1 / 2.3：单次鉴权，统一为「未设 PASSWORD = 无密码」
    const isAuthorized = await validateAuth({
      authHash: req.query.auth,
      timestamp: req.query.t,
      serverPassword: config.password,
    });
    if (!isAuthorized) {
      return res.status(401).json({
        success: false,
        error: '代理访问未授权：请检查密码配置或鉴权参数',
      });
    }

    const targetUrl = decodeURIComponent(req.params.encodedUrl);

    // 非媒体类代理请求限流（防刷 API；媒体分片不受限，避免误伤播放）
    if (!MEDIA_EXT_RE.test(targetUrl)) {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';
      if (isRateLimited(ip)) {
        return res.status(429).json({
          success: false,
          error: '请求过于频繁，请稍后再试',
        });
      }
    }

    // 阶段 2.6：isValidUrl 由 proxy-core 提供，含 IPv6 防护
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }
    log(`代理请求: ${targetUrl}`);

    // 阶段 2.7：仅重试网络错误 / 超时 / 5xx
    const maxRetries = config.maxRetries;
    let retries = 0;
    const makeRequest = async () => {
      try {
        const upstream = await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          headers: { 'User-Agent': config.userAgent },
        });
        // 阶段 2.11：先看 Content-Length，超限立即拒绝
        const cl = checkContentLength(upstream.headers, DEFAULT_MAX_RESPONSE_BYTES);
        if (!cl.ok && cl.length > 0) {
          upstream.data.destroy?.();
          throw new Error(`Upstream too large: Content-Length ${cl.length} bytes exceeds limit ${cl.limit}`);
        }
        return upstream;
      } catch (error) {
        const isRetryable =
          !error.response ||
          (error.response && error.response.status >= 500) ||
          error.code === 'ECONNABORTED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND';
        if (isRetryable && retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 阶段 2.9：过滤敏感头（CORS 与编码/长度信息）
    const headers = { ...response.headers };
    const sensitiveHeaders = (process.env.FILTERED_HEADERS ||
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin,content-encoding,content-length'
    ).split(',');
    sensitiveHeaders.forEach(h => delete headers[h.toLowerCase()]);
    res.set(headers);

    // 阶段 2.11：流式传输时也累计字节，触发超限立即断开
    let received = 0;
    let aborted = false;
    response.data.on('data', (chunk) => {
      received += chunk.length;
      if (received > DEFAULT_MAX_RESPONSE_BYTES && !aborted) {
        aborted = true;
        log(`上游响应超过 ${DEFAULT_MAX_RESPONSE_BYTES} 字节，主动断开: ${targetUrl}`);
        response.data.destroy?.();
        if (!res.writableEnded) res.end();
      }
    });
    response.data.pipe(res);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
});

// 静态资源缓存策略：
// - HTML 页面（watch.html / about.html 等，经静态托管）一律 no-cache，
//   避免更新后用户仍拿到旧版页面；
// - JS/CSS/图片等带指纹无关资源使用 1 天强缓存（与 config.cacheMaxAge 一致）。
app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('用户登录密码已设置');
  } else {
    console.log('警告: 未设置 PASSWORD 环境变量，代理将进入无密码模式');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});