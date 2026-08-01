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

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge,
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