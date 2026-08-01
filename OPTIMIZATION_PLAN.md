# LibreTV (my/libreTV) 优化计划

> 待办清单，按优先级分阶段执行。
>
> 创建时间：2026-08-01
>
> 范围：根目录（前端 + 后端代理 + 部署配置 + 文档）

---

## 阶段 0 · 改动原则

- 任何文件改动后**不**主动 `git add / commit`，由用户确认。
- 不跑 `npm run lint --fix` / `prettier --write`（项目无 lint 脚本，但保险起见）。
- `git status --porcelain` 圈定边界后再改。
- 优先 `Edit`，避免 `Write` 整文件覆盖。
- 关键改动（鉴权、CORS、URL 解析、DOM 注入）改完 spot-check。

---

## 阶段 1 · 后端：消除 4 套代理的代码重复 🔴

> 这是本项目最大的问题：4 个代理文件（Express / Cloudflare / Vercel / Netlify）90% 的代码完全一样，每次修一个 bug 都要在 4 处重复改，极易漏改。

### 1.1 抽出共享模块 `proxy-core/`
- 目标目录：`my/libreTV/proxy-core/`（新建）
- 内容：所有平台无关的纯函数
  - `m3u8.js` — `getTargetUrlFromPath`、`getBaseUrl`、`resolveUrl`、`rewriteUrlToProxy`、`isM3u8Content`、`processKeyLine`、`processMapLine`、`processMediaPlaylist`、`processM3u8Content`、`processMasterPlaylist`
  - `auth.js` — `validateAuth(authHash, timestamp, serverPassword)` 平台无关版（参数显式传入，不依赖 `req`）
  - `cors.js` — CORS 头生成函数
  - `ua.js` — `parseUserAgents(envJson)` + `getRandomUserAgent()`
  - `index.js` — 聚合导出
- 注意：CF Workers / Vercel / Netlify 各自不支持直接 import `.js` 模块（如 Vercel 用 `.mjs`，CF 用 ES Modules 严格模式，Netlify 用 `.mjs`），需要每个平台写一个薄壳包装：
  - `functions/proxy/[[path]].js`：直接 `import` `proxy-core/index.js`（CF 原生支持）
  - `api/proxy/[...path].mjs`：从 `proxy-core/index.js` 导入
  - `netlify/functions/proxy.mjs`：从 `proxy-core/index.mjs` 导入（Node.js ESM 需明确扩展名）
  - `server.mjs`：从 `proxy-core/index.js` 导入（Node.js 自定义解析规则）

### 1.2 抽出共享中间件模块 `inject-env-core/`
- 目标目录：`my/libreTV/inject-env-core/`
- 内容：`getSha256Hash(password)` + `injectPassword(html, hash)`
- 同样每个平台写薄壳：
  - `middleware.js`（Vercel Edge）
  - `functions/_middleware.js`（Cloudflare Pages）
  - `netlify/edge-functions/inject-env.js`（Netlify）

### 1.3 抽取的预期收益
- 4 × 250 ~ 595 = ~1700 行后端代码，预计可压缩到 **~700 行（含 4 个薄壳各 30 行）**
- 修一个 M3U8 解析 bug 只需改一处
- 新增第 5 个部署平台（如 Cloudflare Workers 独立部署）只需新增一个 ~30 行薄壳

---

## 阶段 2 · 后端：鉴权 / 安全加固 🔴

### 2.1 Cloudflare Proxy `validateAuth` 被调用 2 次
- 文件：`functions/proxy/[[path]].js`
- 行号：32–46 与 122–131
- 现状：进入 `onRequest` 后立即调用 `validateAuth` 返回 401，紧接着函数体内又调用一次 `validateAuth` —— 重复执行。
- 方案：删除第二处（行 122–131），只保留入口处的一次。

### 2.2 Netlify Proxy `validateAuth` 被调用 2 次
- 文件：`netlify/functions/proxy.mjs`
- 行号：219 与 263–271
- 现状：handler 顶部 219 行调用一次，try 块内 263 行再调用一次。
- 方案：删掉第二次（行 263–271）。

### 2.3 Netlify 与 Node 服务的 PASSWORD 校验策略不一致
- 文件：`server.mjs`、`netlify/functions/proxy.mjs`
- 现状：
  - `server.mjs`（行 127–141）：未设置 PASSWORD → 鉴权失败（拒绝代理）。
  - `netlify/functions/proxy.mjs`（行 100–103）：未设置 PASSWORD → 鉴权失败。
  - `functions/proxy/[[path]].js`（行 86–88）：未设置 PASSWORD → 视为无密码模式，跳过鉴权。
  - `api/proxy/[...path].mjs`（行 314–317）：未设置 PASSWORD → 视为无密码模式，跳过鉴权。
- 方案：统一为「未设置 PASSWORD → 视为无密码模式」（与 CF/Vercel 一致），并在 README 强调生产部署必须设置 PASSWORD。

### 2.4 `validateAuth` 时间戳 NaN 防护
- 文件：所有 4 个代理的 `validateAuth`
- 现状：`parseInt(timestamp)` 在非法时间戳下返回 NaN，`now - NaN = NaN`，条件判断 `> maxAge` 为 false（侥幸通过），但恶意时间戳可绕过。
- 方案：`const t = parseInt(timestamp); if (isNaN(t) || now - t > maxAge) return false;`

### 2.5 `server.mjs` 同步 SHA-256 阻塞事件循环
- 文件：`server.mjs`
- 行号：47–53（`sha256Hash`）、134（`crypto.createHash('sha256')`）
- 方案：改为异步（`crypto.promises` 或 `worker_threads`），或在请求路径下用一次性 memoize。

### 2.6 `server.mjs` `isValidUrl` 不防 IPv6 字面量
- 文件：`server.mjs`
- 行号：97–119
- 现状：只检查 `parsed.hostname` 字符串前缀，IPv6（如 `http://[::1]/`）的 `hostname` 是 `[::1]`，前缀规则可能漏掉。
- 方案：解析后用 `parsed.hostname` 转换（IPv6 字面量要专门处理）；增加 `parsed.hostname` 黑名单正则，覆盖 `169.254.`（link-local）、`100.64.`（CGNAT）、`fc00:/fd00:`（IPv6 ULA）。

### 2.7 `server.mjs` `makeRequest` 重试 4xx 不合理
- 文件：`server.mjs`
- 行号：179–198
- 现状：捕获 `axios` 任何错误就重试，包含 4xx。
- 方案：仅重试网络错误 / 超时 / 5xx。

### 2.8 Cloudflare Proxy KV 静默失败
- 文件：`functions/proxy/[[path]].js`
- 行号：437–443、515–540、547–559
- 现状：KV 命名空间未绑定时 catch 后继续运行，不抛错，运维看不见。
- 方案：在 `onRequest` 入口处启动期检测一次 KV，若不可用则 `console.warn` 一次性提示；保留运行时的 catch。

### 2.9 Cloudflare Proxy `getTargetUrlFromPath` 回退路径有 XSS/SSRF 风险
- 文件：`functions/proxy/[[path]].js`
- 行号：141–167
- 现状：`encodedUrl.match(/^https?:\/\//i)` 命中时直接用未编码的字符串作为 URL，未二次校验。
- 方案：解码后再次校验协议（只允许 http/https）和主机名（不走内网）。

### 2.10 Vercel Proxy `console.info` 日志泛滥
- 文件：`api/proxy/[...path].mjs`
- 行号：343–347、349–357、402–415 等
- 现状：每次请求 8+ 行日志，生产环境 Vercel 日志配额很快耗尽。
- 方案：把详细日志改为 `console.debug`（默认不输出），仅保留 `console.warn` / `console.error`。

### 2.11 Vercel Proxy "Assignment to constant variable" hack
- 文件：`api/proxy/[...path].mjs`
- 行号：456–468
- 现状：catch 块专门处理「const 被重新赋值」错误（说明代码本身有问题）。
- 方案：定位真正的 `const` 被重新赋值的位置（搜索 `const ` 后是否有赋值），改为 `let` 后删除此 hack。

### 2.12 所有代理 `fetchContentWithType` 无大小限制
- 文件：所有 4 个代理
- 现状：`response.text()` 读整个 body 到内存，恶意源返回 GB 级内容会爆内存。
- 方案：增加 Content-Length 检查（> 50MB 直接拒绝）；CF Workers 默认 128MB 上限可借助 `content-length` 头判断；Vercel/Netlify/Node 同理。

### 2.13 所有代理 `MAX_RECURSION = 5` 偏小
- 现状：5 层不足以处理部分多层嵌套的 M3U8。
- 方案：默认 10 层；用户可通过环境变量覆盖。

---

## 阶段 3 · 前端：与 libretv-app 共有的问题 🟠

> `my/libreTV/js/` 与 `libretv-app/www/js/` 几乎完全一致（`diff` 结果显示仅 `app.js` / `config.js` / `customer_site.js` / `password.js` / `proxy-auth.js` 有差异，主要是默认值不同）。所以前 10 条问题全适用，此处仅列新增的：

### 3.1 [新增] `customer_site.js` 比 libretv-app 多 8 行
- 文件：`js/customer_site.js`
- 方案：对比两份 diff，确认新增内容是否需要合并回主前端。

### 3.2 [新增] `password.js` 多 21 行
- 方案：对比两份 diff，检查新增逻辑（是否增加暴力破解防护等）。

### 3.3 [新增] `service-worker.js` 未审计
- 文件：`service-worker.js`（my/libreTV 独有）
- 现状：未读源码，不知策略。
- 方案：完整读取 → 评估是否启用（cache-first 对代理内容有意义吗？分片 TS 不应缓存）。

### 3.4 [新增] `about.html` 未审计
- 文件：`about.html`（my/libreTV 独有）
- 现状：未读源码。
- 方案：检查内容 / SEO / 内嵌资源。

### 3.5 复用的 libretv-app 阶段 1–4 问题
- 详见 `libretv-app/OPTIMIZATION_PLAN.md` 阶段 1–4（XSS onclick、内存泄漏、tailwind CDN、renderEpisodes 重复、filterAdsFromM3U8 弱过滤等），同步处理。
- 注：my/libreTV 的 `index.html` / `player.html` / `watch.html` 与 libretv-app 完全相同（`diff` 无输出）。

---

## 阶段 4 · 部署 / 配置 🟡

### 4.1 `Dockerfile` 加 `.dockerignore`
- 文件：根目录新建 `.dockerignore`
- 内容：`node_modules/`、`.git/`、`*.md`、`OPTIMIZATION_PLAN.md`、`.env*`、`docs/` 等
- 收益：减小镜像体积，避免把敏感 `.env` 打入镜像。

### 4.2 `docker-compose.yml` 默认密码占位符
- 文件：`docker-compose.yml`
- 行号：9–11（`PASSWORD=${PASSWORD:-111111}`）
- 现状：默认密码 111111 太弱。
- 方案：默认改为空字符串并强制警告用户设置；或保留 111111 但在 README 加红字提醒。

### 4.3 `vercel.json` rewrite 顺序
- 文件：`vercel.json`
- 现状：`/:path*` 在最后会捕获 `/proxy/...`，但因为前面有 `/proxy/:path*` 优先匹配，OK。
- 方案：保留现状，但加注释说明匹配顺序。

### 4.4 `netlify.toml` 注释掉 headers 配置
- 文件：`netlify.toml`
- 行号：26–32
- 方案：补充示例（例如静态资源 1 天缓存）。

### 4.5 `render.yaml` 缺少 env 提示
- 文件：`render.yaml`
- 方案：加 `envVars` 段声明 `PASSWORD` 为 required。

### 4.6 `package.json` scripts 完善
- 文件：`package.json`
- 现状：只有 `dev` / `start`。
- 方案：
  - 增加 `lint`、`format`、`test` 占位脚本（即使无内容）；
  - 增加 `engines.node` 字段（要求 >= 18，因为 ESM + Express 5）。

---

## 阶段 5 · 文档 🟡

### 5.1 `README.md` 校准
- 文件：`README.md`
- 改动：
  - 加一段「⚠️ PASSWORD 必须设置」红字提醒（已在第 30 行提及，移到更醒目位置）；
  - 「快速部署」加一句「首次部署后请访问主页测试密码保护是否生效」；
  - 「本地开发环境」补充 `npm install` 后默认无密码（与生产不同），并提醒如何在 `.env` 设置 `PASSWORD`；
  - 「API 兼容性」补一段「PROXY_URL 默认指向 `/proxy/`，部署到 Cloudflare / Netlify / Vercel 时由 rewrite 规则处理；自托管 Node 时由 `server.mjs` 直接挂载」。

### 5.2 `CONTRIBUTING.md` 校准
- 改动：「本地运行」一节加 `node --version` 要求（>= 18）。

### 5.3 `VERSION.txt`
- 现状：未读取。
- 方案：检查版本号与 `package.json` 是否一致。

### 5.4 新增 `OPTIMIZATION_LOG.md`
- 跟踪每次改动（与 libretv-app 同步）。

---

## 阶段 6 · 验证清单

| 项 | 工具 / 命令 |
|---|---|
| JS / Node 语法 | `node --check <file>` |
| Node 服务启动 | `npm install && PASSWORD=test npm run dev`，访问 `http://localhost:8080` |
| 代理 | 搜索「战狼」→ 详情 → 播放 → 网络面板确认走 `/proxy/...` → M3U8 内容被改写 |
| 鉴权（启用 PASSWORD） | 用错的 `auth` hash 请求 `/proxy/...` → 401 |
| 鉴权（禁用 PASSWORD） | 无 `auth` 仍可访问 |
| M3U8 递归 | 找一个嵌套 3+ 层的源，验证分片 URL 全部改写 |
| 鉴权时间戳 | 用 11 分钟前的时间戳 → 401 |
| Cloudflare Pages（可选） | `wrangler pages dev ./` 本地跑 |
| Vercel（可选） | `vercel dev` |
| Netlify（可选） | `netlify dev` |
| Docker | `docker build -t libretv .` 然后 `docker run -e PASSWORD=test -p 8080:8080 libretv` |

---

## 执行顺序建议

1. **阶段 1**（抽共享模块）→ 一次性把 `proxy-core/` + 4 个薄壳搭起来 → 4 套代理瘦身。
2. **阶段 2**（鉴权 / 安全）→ 在 1 的基础上统一修复，避免重复改动 4 处。
3. **阶段 3**（前端）→ 复用 libretv-app 计划，按优先级依次处理。
4. **阶段 4**（部署配置）→ 配合 1–2 阶段一起改。
5. **阶段 5**（文档）→ 全部改完后集中校准。
6. **阶段 6**（验证）→ 每个阶段改完跑对应测试。

---

## 关键改动预演（Stage 1 抽模块的具体目录结构）

```
my/libreTV/
├── proxy-core/                       ← 新建
│   ├── m3u8.js                       ← 11 个 M3U8 处理函数
│   ├── auth.js                       ← validateAuth 纯函数版
│   ├── cors.js                       ← CORS 头生成
│   ├── ua.js                         ← User-Agent 加载
│   ├── security.js                   ← isValidUrl（统一 4 平台）
│   ├── package.json                  ← { "type": "module" } 兼容 CF/Vercel
│   └── index.js                      ← 聚合 export
├── inject-env-core/                  ← 新建
│   ├── sha256.js                     ← 统一 SHA-256 实现
│   ├── inject.js                     ← HTML 注入函数
│   └── index.js
├── server.mjs                        ← 改为 ~80 行薄壳
├── middleware.js                     ← 改为 ~20 行薄壳
├── functions/
│   ├── _middleware.js                ← ~15 行
│   └── proxy/
│       └── [[path]].js               ← ~60 行薄壳
├── api/
│   └── proxy/
│       └── [...path].mjs             ← ~70 行薄壳
├── netlify/
│   ├── functions/
│   │   └── proxy.mjs                 ← ~60 行薄壳
│   └── edge-functions/
│       └── inject-env.js             ← ~15 行薄壳
└── ...（前端不变）
```

---

## 待确认事项

开工前请确认：

- [ ] **是否允许新建 `proxy-core/` 与 `inject-env-core/` 子目录**（影响 4 个部署平台的路径）
- [ ] **鉴权策略**统一为「未设 PASSWORD = 无密码模式」还是「必须设置」（前者更接近 CF/Vercel 现状，但会改变 netlify / server.mjs 行为，需在 README 强提示）
- [ ] **`MAX_RECURSION` 默认值**改 10 还是保持 5
- [ ] **是否启用 `.dockerignore`**（新建小文件，无副作用）
- [ ] **`service-worker.js` 是否启用**（如启用需先审计其缓存策略）

确认后我按阶段 1 → 2 → 3 → 4 → 5 顺序开工，每阶段结束汇报 diff 摘要，**不自动 commit**。