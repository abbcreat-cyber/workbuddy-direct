<div align="center">

# wb-direct

**把 WorkBuddy 订阅里的模型，直连给 Codex、DSH 和任何 OpenAI 兼容客户端。**

一个文件 · 零依赖 · 不用开着 WorkBuddy

```
prompt 开销    3632 tokens  →  7 tokens
首字延迟       3.7 s        →  1.1 s
常驻内存       2.4 GB       →  57 MB
进程数         9 个         →  1 个
```

[中文](#中文) · [English](#english)

</div>

---

## 中文

### 起因

桌面上有个 `WorkBuddy.lnk`。点进去，里面有一堆好模型 —— 比如 `DeepSeek-V4.1-Flash`：**1M 上下文、原生多模态、积分倍率低到 0.03x**。

但它们被关在 WorkBuddy 的界面里。想在 Codex 里用？想在 DSH 里用？想在 Cherry Studio 里用？

**不行。**

这个项目只做一件事：**把模型放出来**，用一个标准 OpenAI 接口暴露给任何客户端。

### 它和别的方案差在哪

现有方案大多是**驱动官方 CLI** —— 起一个 `codebuddy.js` 进程、走它自己的协议、把答案转出来。

能跑，但代价很大：

| | 驱动官方 CLI | **wb-direct** |
|---|---|---|
| 每次请求的 prompt | **约 3632 tokens**<br>（工具定义 2848 + 技能 393 + 系统提示 323） | **约 7 tokens**<br>（只算你真正说的话） |
| 首字延迟 | 3.7 s | **1.1 s** |
| 常驻内存 | 约 2.4 GB（7 个 CLI 实例 + 桥接层） | **57 MB**（1 个进程） |
| 依赖 | 必须开着 WorkBuddy 桌面端 | **不需要** |
| 工具调用 | CLI 自己执行，客户端看不见过程 | **原生透传，由客户端执行** |
| 输出 | 被 CLI 的系统提示和技能污染 | **裸模型原样输出** |

**为什么差这么多？**

因为 CLI 本质是一个完整的 Agent —— 每次请求它都要带上工具定义、技能目录、系统提示，才能"扮演"一个编码助手。而如果你只是想调个模型，**这些全是白付的钱**。

> 试过 `--tools ""` 想关掉它？没用的。那只能禁用工具的**调用**，禁不掉工具的**定义** —— 实测仍占 2848 tokens。

**要真正省掉，只能绕开 CLI。** 这就是本项目做的事：直接调后端。

### 快速开始

提供凭据有**两种方式，任选一种** —— 方式 B 连 Key 都不用申请。

---

#### 方式 A：用 API Key

适合长期部署、服务器等「不想依赖桌面端」的场景。

**第 1 步：拿一个访问密钥**

从 WorkBuddy 客户端生成，形如 `ck_xxxxx.yyyyy`。

**第 2 步：放好它**（任选一种）

```bash
# 写进项目目录
echo "ck_your_key_here" > wb-api-key.txt

# 或环境变量
export CODEBUDDY_API_KEY=ck_your_key_here

# 或指向你自己的 Key 文件
export WB_KEY_FILE=/path/to/your/key.txt
```

---

#### 方式 B：不用 Key（借用桌面端的登录态）

**一个 Key 都不需要申请。**

只要桌面端**登录过一次**，它就会把凭据写到下面这个位置，程序会自动找到并读取：

| 平台 | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |

**你不需要做任何事** —— 程序启动时若找不到 API Key，会自动 fallback 到这里。

文件里有什么：

```
auth.accessToken    JWT，实测有效期约 60 天
auth.refreshToken   可续期
account.type        personal / SaaS …，会作为 X-Product 发给上游
account.uid         会作为 X-User-Id 发给上游
```

> 想指定别的文件：`export WB_AUTH_FILE=/path/to/workbuddy-desktop.info`

---

#### 两种方式怎么选

| | 方式 A（API Key） | 方式 B（登录态） |
|---|---|---|
| 要不要申请 Key | 要 | **不要** |
| 依赖桌面端 | **完全不依赖** | 需要登录过（之后可关掉） |
| 凭据有效期 | 长期，手动轮换 | 约 60 天，可自动续期 |
| 适合 | 长期部署 / 服务器 / 多机共用 | 本机自用、不想申请 Key |

**程序的选择顺序**：先找 API Key；找不到就自动用桌面端登录态。
**启动日志会写明用的是哪种**，一眼可辨：

```
凭据: api-key  (59 字符)
凭据: desktop-auth (workbuddy-desktop.info)  (1321 字符)  uid=xxxxxxxx…
```

**3. 启动**

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File start-direct.ps1

# 任意平台
node direct.js
```

**4. 验证**

```bash
curl http://127.0.0.1:3090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

### 接入各类客户端

任何支持 OpenAI 协议的客户端，填这三行就行：

```
Base URL : http://127.0.0.1:3090/v1
API Key  : 任意非空值（本地默认不校验）
Model    : deepseek-v4.1-flash
```

**Codex** 走的是 Responses API，本项目同时实现了 `/v1/responses`，所以也能直接接：

```toml
# ~/.codex/config.toml
model_provider = "custom"

[model_providers.custom]
base_url = "http://127.0.0.1:3090"
wire_api = "responses"
```

**已验证可用的客户端**：Codex · DeepSeek Harness (DSH) · Cherry Studio · ChatBox · LobeChat · Open WebUI · 任何 OpenAI SDK

### 可用模型（25 个）

```
deepseek-v4.1-flash   deepseek-v4-pro       deepseek-v4-flash   deepseek-v3-2-volc
deepseek-v3-1-volc    deepseek-v3-1         glm-5.2             glm-5.1
glm-5.0               glm-5.0-turbo         glm-4.7             glm-4.6
kimi-k3-1             kimi-k2.7             kimi-k2.6           kimi-k2.5
kimi-k2-thinking      minimax-m3            minimax-m2.7        minimax-m2.5
hy3                   hy3-preview           hunyuan-2.0-thinking hunyuan-chat
auto
```

想增删改：编辑 `direct.js` 顶部的 `MODELS` 数组。

### 上下文窗口：默认 30 万，可以开到 100 万

模型定义里的真实参数（从产品配置里读出来的）：

```json
"contextWindow": {
  "defaultLength": 300000,              // 默认只有 30 万
  "supportedLengths": [300000, 1000000]  // 可以选到 100 万
},
"maxAllowedSize": 1000000,
"maxInputTokens": 1000000
```

**默认 30 万，要 100 万得显式选。** 好消息是上游确实吃得下 —— 实测 55 万 tokens 的请求一次就过（`prompt_tokens=550010`）。

⚠️ **但客户端并不知道这件事。** 你必须告诉 Codex / DSH 这个模型有多大，否则它会按错误的窗口做上下文管理 —— **该压缩时不压缩，然后撞上 `11115`**。

**为什么直连要特别当心压缩？见下面第 5 条。**

### 踩过的坑

**这些坑我们替你踩完了 —— 尤其第 1 个，网上几乎没有中文资料。**

#### 1. `role: "developer"` 会触发 11128，而且错误信息是骗你的

用 Codex 或 Cursor 这类新客户端接入时，很可能撞上这个：

```json
HTTP 400
{"code":11128,
 "msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

看到「**被安全策略拦截**」，第一反应一定是"我是不是被封号了？"

**不是。这个文案是误导。**

**真实原因**：上游对 `messages[].role` 做**白名单校验**，而 **`developer` 不在白名单里**。

`developer` 是 OpenAI 新规范里 `system` 的别名 —— **Codex、Cursor 等新一代客户端用它承载系统级指令**，老式客户端才用 `system`。

**对照实验**（逐字相同的 prompt，只改 `role` 字段的值）：

| role 值 | 结果 |
|---|---|
| `system` | ✅ 正常返回 |
| `developer` | ❌ `{"code":11128}` |

**修复**：把 `developer` 归一化成 `system` 即可。本项目已内置（`normalizeRoles()`）。

> 这个坑的定位来自社区：[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) issue #25。感谢。

#### 2. 上游不接受非流式请求

```json
{"code":11101,"msg":"Non-stream chat request is currently not supported"}
```

所以本代理对上游**恒定使用流式**，客户端要非流式时在本地聚合 —— 对客户端完全透明。

#### 3. 用 Key 认证时拿不到模型列表

`GET /v3/config` 会返回 `200`，但 `models` 是 `null`（列表只有登录态才给）。所以模型 ID 只能硬编码 —— 内置了 25 个。

#### 4. 上游的 usage 里藏着一个 `credit` 字段

每次返回都带**真实积分消耗**，可以直接拿来做成本归因：

```json
"usage": { "prompt_tokens": 87, "completion_tokens": 1104, "credit": 2.72 }
```

这个是驱动 CLI 的方案看不到的。

#### 5. `11115 input length too long` —— 直连之后，压缩这活得你自己管

```json
HTTP 400
{"code":11115,"msg":"input length too long",
 "extError":{"code":"context_length_exceeded","message":"input length too long",
             "type":"invalid_request_error","StatusCode":400}}
```

**根因往往不是"没配到 100 万"，而是"压缩没接上"** —— 这是**直连方案的结构性代价**：

| | 驱动官方 CLI | **直连（本项目）** |
|---|---|---|
| 谁负责压缩 | **CLI 自带一整套**（`AUTO_COMPACT_WINDOW`、`CompactStrategy`、`ContextCompactSummarizer`、按窗口算触发点） | **客户端**（Codex / DSH） |

CLI 本身是个 agent，**内置完整的自动压缩流水线**。你把 CLI 绕开，这活就落到客户端头上。客户端若按「1M 上下文」算、到 90% 才压缩 —— **而压缩那一刻需要把完整上下文发给模型做总结**，这一发本身可能就已经顶到上限 → `11115`。

**解法：把触发点提前，留出余量。**

**Codex**（`models.json` 里该模型的字段）：

```json
"context_window": 1000000,
"max_context_window": 1000000,
"effective_context_window_percent": 80
```

> 如果 `models.json` 是脚本生成的，记得改**生成源**，否则客户端下次启动会把它覆盖回去。

**DSH**（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: compaction-basic
  disabled: false
  config:
    thresholdRatio: 0.8        # 80% 触发压缩

- id: command-compact           # 可选：保留 /compact 手动压一次兜底
  disabled: false
```

⚠️ **两个容易踩的 DSH 坑**：

**第 1 个：`dsh-web-app` 默认把压缩关掉了。**
它的 bundle patch 会把 `compaction-basic` 和 `command-compact` 都设为 `disabled: true`，而 web profile 里**没有任何替代实现** —— 等于 **web 界面下自动压缩是完全失效的**。必须在 profile patch 里显式改回 `disabled: false`。

**第 2 个：配置放错文件就完全不生效。**

| 文件 | 格式 | 用途 |
|---|---|---|
| `~/.dsh/settings.yaml` | 映射（`key: value`） | **设置项**。把插件 `config` 写这里**不生效** |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | **顶层 YAML 数组** | **插件 config 的正确位置** |
| `~/.dsh/cordis.patch.yml` | 数组 | 全局 patch —— **会让 headless profile 加载皮肤插件失败**，别用 |

验证是否真的生效：

```bash
dsh --profile <name> --dump-config | grep -A 4 compaction-basic
```

#### 6. 接 Codex 时：本机转发器把「本地请求」也送进了系统代理

**症状**：Codex 一律报

```
502 Bad Gateway: 本机模型转发失败：ECONNRESET
```

而 wb-direct 侧**只收到请求头**（日志里只有 `← POST /responses`），**请求体从未接收完整**。

**根因**：介于 Codex 与本代理之间的本机转发器，**把发往 `127.0.0.1:3090` 的请求也交给了系统代理**：

```js
const env = process.env.HTTPS_PROXY || process.env.https_proxy || ...;
if (env) return env;                            // ← 命中系统代理
dispatcherState = { proxy, dispatcher: proxy ? new ProxyAgent(proxy) : new Agent() };
//                    ↑ 所有请求都走代理 —— 包括回环地址
```

链路于是变成 `Codex → 转发器 → 系统代理 → wb-direct`，
**系统代理在转发回环地址时失败，返回 502**。

> **★ 判据**：`502 Bad Gateway` 是**代理 / 网关语义**的错误码。
> 本代理**不会产生 502**（它只返回 200 / 4xx / JSON 错误）。
> **看到 502，第一个要问的就是「这一跳中间有没有代理」。**

**修法**：本地回环地址直连，绕开代理：

```js
const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(u || ''));
dispatcher: isLoopback(target) ? getDirectDispatcher() : getDispatcher(),
```

#### 7. 两端的请求体上限必须对齐

```
转发器     上限 128 MB
wb-direct  上限  32 MB     ← 比转发器还严，中间那段区间的请求会在这里被掐断
```

被掐断时执行的是 `req.destroy()`，**产生的错误码恰好也是 `ECONNRESET`**。

**修法**：
1. 两端**对齐到同一个值**（本代理已统一为 512MB，可用 `WB_MAX_BODY` 调整）；
2. 内部累积请求体要用 **Buffer 数组**，**不要用字符串 `raw += chunk`** ——
   后者对大请求体会产生 O(n²) 拷贝，且 JS 字符串是 UTF-16、约占 2 倍内存。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CODEBUDDY_API_KEY` | — | 直接提供 Key（优先级最高） |
| `WB_KEY_FILE` | — | 指向你的 Key 文件 |
| `WB_AUTH_FILE` | — | 指向桌面端登录态文件（方式 B 用，一般不用设，会自动找） |
| `WB_DIRECT_PORT` | `3090` | 监听端口 |
| `WB_DIRECT_HOST` | `127.0.0.1` | 监听地址（不建议改） |
| `WB_DIRECT_KEY` | 空 | 本地访问口令；设置后客户端须带 `Authorization: Bearer <值>` |
| `WB_MIN_INTERVAL_MS` | `1200` | 两次上游请求的最小间隔（反风控） |
| `WB_MAX_RETRIES` | `3` | 429 / 5xx 的指数退避重试次数 |
| `WB_USER_AGENT` | 空（不发） | 需要给上游带 UA 时才设 |
| `WB_UPSTREAM` | 腾讯后端 | 换端点用 |

### 工作原理

```
客户端 ──HTTP──> wb-direct:3090 ──HTTPS──> copilot.tencent.com
                （一个进程）                 /v2/chat/completions
                                            Authorization: Bearer ck_xxx
```

- **对外**：标准 OpenAI 协议（Chat Completions + Responses 两种）
- **对内**：固定流式、角色归一化、限速 + 抖动 + 指数退避
- **不碰**：不启动 CLI、不跑 Agent、不读桌面端登录态、不注入工具定义

### 文件

```
direct.js            主程序（零依赖单文件）
start-direct.ps1     Windows 启动器（自动找 node、幂等、无窗口）
wb-api-key.txt       你的 Key（不要提交到 git）
logs/                运行日志（含每次请求的 ttft / tokens / credit）
```

### 免责声明

- 本项目仅供**个人学习与研究**使用
- 请遵守你与模型服务提供方之间的**服务条款**
- **请勿**用于商业转售、批量分发或共享给他人
- 请自行评估使用风险；密钥请妥善保管并定期轮换

---

## English

### Why this exists

There is a `WorkBuddy.lnk` on the desktop. Behind it: a whole shelf of good models — one of them, `DeepSeek-V4.1-Flash`, packs a **1M context window, native vision, and a credit multiplier as low as 0.03x**.

But they're locked inside the WorkBuddy UI. Want them in Codex? In DSH? In Cherry Studio?

**No.**

This project does exactly one thing: **it lets the models out**, exposing them behind a standard OpenAI-compatible endpoint that any client can talk to.

### How it differs from other approaches

Most existing projects **drive the official CLI** — spawn a `codebuddy.js` process, speak its protocol, translate the answer back out.

It works. But it costs a lot:

| | Driving the official CLI | **wb-direct** |
|---|---|---|
| Prompt per request | **~3632 tokens**<br>(2848 tool defs + 393 skills + 323 system prompt) | **~7 tokens**<br>(only what you actually typed) |
| Time to first token | 3.7 s | **1.1 s** |
| Resident memory | ~2.4 GB (7 CLI instances + bridge) | **57 MB** (one process) |
| Dependency | WorkBuddy desktop must be running | **none** |
| Tool calls | Executed inside the CLI, invisible to your client | **Native passthrough, executed by your client** |
| Output | Polluted by CLI system prompt and skills | **Raw model output** |

**Why the gap?**

Because the CLI *is* a full agent — every single request drags along tool definitions, a skill catalog, and a system prompt so it can "act like" a coding assistant. If all you want is to call a model, **you're paying for all of that, every time.**

> Tried `--tools ""` to turn it off? Doesn't help. That disables tool *invocation*, not tool *definitions* — measured at 2848 tokens, still there.

**The only way to actually cut it is to bypass the CLI entirely.** That's what this project does: it talks to the backend directly.

### Quick start

There are **two ways to supply credentials — pick either one.** Option B doesn't even need a key.

---

#### Option A: use an API Key

Best for long-running deployments, servers, or anything that shouldn't depend on the desktop app.

**Step 1 — get an access key**

Generate one from the WorkBuddy client. It looks like `ck_xxxxx.yyyyy`.

**Step 2 — provide it** (any one of these)

```bash
# drop it in the project folder
echo "ck_your_key_here" > wb-api-key.txt

# or an environment variable
export CODEBUDDY_API_KEY=ck_your_key_here

# or point at your own file
export WB_KEY_FILE=/path/to/your/key.txt
```

---

#### Option B: no key at all (reuse the desktop login)

**You never have to request a key.**

If the desktop app has signed in **once**, it writes its credentials to the path below — and the proxy finds and reads them automatically:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |

**Nothing else to do** — when no API key is found, the proxy falls back to this file by itself.

What's inside:

```
auth.accessToken    a JWT, measured validity ≈ 60 days
auth.refreshToken   used for renewal
account.type        personal / SaaS … — sent upstream as X-Product
account.uid         sent upstream as X-User-Id
```

> Prefer a different file? `export WB_AUTH_FILE=/path/to/workbuddy-desktop.info`

---

#### Which one to pick

| | Option A (API Key) | Option B (desktop login) |
|---|---|---|
| Need to request a key | Yes | **No** |
| Depends on desktop app | **Not at all** | One sign-in required (can close it afterwards) |
| Credential lifetime | Long-lived, rotate manually | ~60 days, auto-renewable |
| Good for | Long-running / servers / shared across machines | Local use, or just don't want to request a key |

**Resolution order**: API key first; if absent, the desktop login is used.
**The startup log tells you which one is active**, at a glance:

```
凭据: api-key  (59 字符)
凭据: desktop-auth (workbuddy-desktop.info)  (1321 字符)  uid=xxxxxxxx…
```

**3. Launch**

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File start-direct.ps1

# Any platform
node direct.js
```

**4. Verify**

```bash
curl http://127.0.0.1:3090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

### Wiring up clients

Any OpenAI-compatible client needs just three lines:

```
Base URL : http://127.0.0.1:3090/v1
API Key  : any non-empty string (local auth is off by default)
Model    : deepseek-v4.1-flash
```

**Codex** speaks the Responses API — this project implements `/v1/responses` too, so it plugs in directly:

```toml
# ~/.codex/config.toml
model_provider = "custom"

[model_providers.custom]
base_url = "http://127.0.0.1:3090"
wire_api = "responses"
```

**Tested with**: Codex · DeepSeek Harness (DSH) · Cherry Studio · ChatBox · LobeChat · Open WebUI · any OpenAI SDK

### Available models (25)

```
deepseek-v4.1-flash   deepseek-v4-pro       deepseek-v4-flash   deepseek-v3-2-volc
deepseek-v3-1-volc    deepseek-v3-1         glm-5.2             glm-5.1
glm-5.0               glm-5.0-turbo         glm-4.7             glm-4.6
kimi-k3-1             kimi-k2.7             kimi-k2.6           kimi-k2.5
kimi-k2-thinking      minimax-m3            minimax-m2.7        minimax-m2.5
hy3                   hy3-preview           hunyuan-2.0-thinking hunyuan-chat
auto
```

To add or remove models, edit the `MODELS` array at the top of `direct.js`.

### Context window: 300K by default, can go up to 1M

The real numbers, straight from the model definition:

```json
"contextWindow": {
  "defaultLength": 300000,               // 300K by default
  "supportedLengths": [300000, 1000000]  // 1M is available
},
"maxAllowedSize": 1000000,
"maxInputTokens": 1000000
```

**300K by default — 1M is opt-in.** The good news: the upstream really does accept it. A 550K-token request went straight through (`prompt_tokens=550010`).

⚠️ **But your client has no idea.** You must tell Codex / DSH how large this model is, otherwise it manages context against the wrong window — **it won't compact when it should, and you'll slam into `11115`.**

**Why compaction matters so much once you bypass the CLI — see pitfall #5.**

### Pitfalls we already hit so you don't have to

#### 1. `role: "developer"` triggers error 11128 — and the error message lies to you

If you connect from Codex or Cursor, you may run straight into this:

```json
HTTP 400
{"code":11128,
 "msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"en":"The request was blocked by security policy. Please retry later or contact support."}}
```

"Blocked by security policy" makes you think you've been banned. **You haven't. The message is misleading.**

**The real cause**: the upstream validates `messages[].role` against a **whitelist**, and **`developer` is not on it**.

`developer` is the OpenAI-spec alias for `system` — **Codex, Cursor and other modern clients use it to carry system-level instructions**, while older clients use `system`.

**Controlled test** (byte-identical prompt, only the `role` value changed):

| `role` value | Result |
|---|---|
| `system` | ✅ returns normally |
| `developer` | ❌ `{"code":11128}` |

**The fix**: normalize `developer` to `system`. This project does it for you (`normalizeRoles()`).

> Credit for pinpointing this goes to the community: [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) issue #25.

#### 2. The upstream refuses non-streaming requests

```json
{"code":11101,"msg":"Non-stream chat request is currently not supported"}
```

So this proxy **always streams upstream**, and aggregates locally when a client asks for a non-streaming response — completely transparent to the client.

#### 3. With key auth you can't fetch the model list

`GET /v3/config` returns `200` but `models` is `null` (the list requires a logged-in session). Model IDs must be hardcoded — 25 are built in.

#### 4. There's a hidden `credit` field in the usage payload

Every response carries the **actual credit cost**, which you can use for cost attribution:

```json
"usage": { "prompt_tokens": 87, "completion_tokens": 1104, "credit": 2.72 }
```

The CLI-driven approach never gets to see this.

#### 5. `11115 input length too long` — once you go direct, compaction is on you

```json
HTTP 400
{"code":11115,"msg":"input length too long",
 "extError":{"code":"context_length_exceeded","message":"input length too long",
             "type":"invalid_request_error","StatusCode":400}}
```

**The root cause is usually not "you forgot to set 1M" — it's "compaction never kicked in."** That is the structural cost of going direct:

| | Driving the official CLI | **Direct (this project)** |
|---|---|---|
| Who compacts | **The CLI ships the whole pipeline** (`AUTO_COMPACT_WINDOW`, `CompactStrategy`, `ContextCompactSummarizer`, trigger-point math) | **Your client** (Codex / DSH) |

The CLI *is* an agent — it carries a complete auto-compaction pipeline. Bypass the CLI and that job lands on your client. If the client assumes a 1M window and only compacts at 90%, **the compaction request itself has to send the full context to the model for summarization** — and that very request may already be over the limit → `11115`.

**The fix: move the trigger earlier and leave headroom.**

**Codex** (the model entry inside `models.json`):

```json
"context_window": 1000000,
"max_context_window": 1000000,
"effective_context_window_percent": 80
```

> If `models.json` is script-generated, edit the **generator** — otherwise the client overwrites your change on next launch.

**DSH** (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: compaction-basic
  disabled: false
  config:
    thresholdRatio: 0.8        # compact at 80%

- id: command-compact           # optional: keep /compact as a manual fallback
  disabled: false
```

⚠️ **Two DSH gotchas worth knowing**

**One: `dsh-web-app` disables compaction by default.**
Its bundle patch sets both `compaction-basic` and `command-compact` to `disabled: true`, and the web profile ships **no replacement** — so **auto-compaction is completely dead in the web UI**. You have to flip it back to `disabled: false` in your own profile patch.

**Two: put the config in the right file, or it silently does nothing.**

| File | Format | Purpose |
|---|---|---|
| `~/.dsh/settings.yaml` | mapping (`key: value`) | **Settings only.** Plugin `config` placed here is **ignored** |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | **top-level YAML array** | **Where plugin config actually goes** |
| `~/.dsh/cordis.patch.yml` | array | Global patch — **breaks skin-plugin loading on the headless profile**. Don't use |

Verify it actually took effect:

```bash
dsh --profile <name> --dump-config | grep -A 4 compaction-basic
```

#### 6. When wiring up Codex: the local forwarder routes loopback requests through the system proxy

**Symptom**: Codex always reports

```
502 Bad Gateway: 本机模型转发失败：ECONNRESET
```

while on the wb-direct side you **only ever see the request headers** (just `← POST /responses` in the log) — **the request body never arrives in full**.

**Root cause**: the local forwarder sitting between Codex and this proxy **also sends requests destined for `127.0.0.1:3090` through the system proxy**:

```js
const env = process.env.HTTPS_PROXY || process.env.https_proxy || ...;
if (env) return env;                            // ← picks up the system proxy
dispatcherState = { proxy, dispatcher: proxy ? new ProxyAgent(proxy) : new Agent() };
//                    ↑ every request goes through it — loopback included
```

The chain becomes `Codex → forwarder → system proxy → wb-direct`,
and **the proxy fails when forwarding a loopback address, returning 502**.

> **★ Key tell**: `502 Bad Gateway` is a **proxy / gateway**-semantic error code.
> This proxy **never produces a 502** (it returns 200 / 4xx / JSON errors only).
> **When you see a 502, the first question to ask is "is there a proxy in this hop?"**

**Fix**: bypass the proxy for loopback targets:

```js
const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(u || ''));
dispatcher: isLoopback(target) ? getDirectDispatcher() : getDispatcher(),
```

#### 7. Body-size limits must match on both ends

```
forwarder   limit 128 MB
wb-direct   limit  32 MB     ← stricter than the forwarder; anything in between gets cut here
```

Cutting a request off executes `req.destroy()`, whose **error code is exactly `ECONNRESET`**.

**Fix**:
1. **Align both ends to the same value** (this proxy now uses 512MB, tunable via `WB_MAX_BODY`);
2. Accumulate the body into a **Buffer array** — **never `raw += chunk`**.
   The string form costs O(n²) copying on large bodies, and JS strings are UTF-16 (~2× memory).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODEBUDDY_API_KEY` | — | Provide the key directly (highest priority) |
| `WB_KEY_FILE` | — | Path to your key file |
| `WB_AUTH_FILE` | — | Path to the desktop login file (Option B; usually auto-detected, no need to set) |
| `WB_DIRECT_PORT` | `3090` | Listen port |
| `WB_DIRECT_HOST` | `127.0.0.1` | Listen address (not recommended to change) |
| `WB_DIRECT_KEY` | empty | Local access token; if set, clients must send `Authorization: Bearer <value>` |
| `WB_MIN_INTERVAL_MS` | `1200` | Minimum interval between upstream requests (anti-throttling) |
| `WB_MAX_RETRIES` | `3` | Exponential-backoff retries on 429 / 5xx |
| `WB_USER_AGENT` | empty (omitted) | Set only if upstream needs a UA |
| `WB_UPSTREAM` | Tencent backend | Override the upstream endpoint |

### How it works

```
client ──HTTP──> wb-direct:3090 ──HTTPS──> copilot.tencent.com
                 (one process)              /v2/chat/completions
                                            Authorization: Bearer ck_xxx
```

- **Outward**: standard OpenAI protocol (both Chat Completions and Responses)
- **Inward**: always streaming, role normalization, rate limiting + jitter + exponential backoff
- **Never**: spawns a CLI, runs an agent, reads desktop login state, or injects tool definitions

### Files

```
direct.js            main program (single file, zero dependencies)
start-direct.ps1     Windows launcher (auto-finds node, idempotent, windowless)
wb-api-key.txt       your key (do NOT commit this)
logs/                runtime logs (per-request ttft / tokens / credit)
```

### Disclaimer

- This project is for **personal study and research** only
- Follow the **terms of service** between you and the model provider
- **Do not** resell, redistribute, or share access with others
- Evaluate the risk yourself; keep your key safe and rotate it periodically

---

<div align="center">

**MIT License**

如果这个项目帮你省下了时间和 token，给个 star 就好。

*If this saved you some time and tokens, a star is all we ask.*

</div>
