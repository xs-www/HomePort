# 04 · API 契约

所有接口前缀 `/api`。除特别标注外均返回 JSON，`Content-Type: application/json; charset=utf-8`。

## 0. 通用约定

### 0.1 认证
- 会话通过 **httpOnly Cookie** `hp_session` 传递（`SameSite=Lax`，`Path=/`，HTTPS 下自动 `Secure`）。
- 所有**变更类**请求（`POST/PUT/PATCH/DELETE`）必须带请求头 `X-CSRF-Token`，其值等于 `GET /api/auth/session` 返回的 `csrfToken`。缺失或不匹配 → `403 CSRF_MISMATCH`。
- 未登录访问受保护接口 → `401 UNAUTHENTICATED`。
- 已登录但角色不足 → `403 FORBIDDEN`。

### 0.2 成功响应
直接返回资源本体或 `{ "items": [...], "total": n }`。不额外包裹 `code/data` 信封。

### 0.3 错误响应
```json
{ "error": { "code": "FORBIDDEN", "message": "需要管理员权限", "details": null } }
```

| code | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 请求体/查询参数不合法，`details.fieldErrors` 给出字段错误 |
| `UNAUTHENTICATED` | 401 | 未登录或会话过期 |
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误 |
| `TOTP_INVALID` | 401 | 两步验证的动态码/恢复码不正确 → 前端**就地重试**（不是会话失效，不应登出） |
| `TOTP_CHALLENGE_EXPIRED` | 401 | 登录第二步的挑战已过期/已消费/尝试次数超限 → 退回第一步重新登录 |
| `TOTP_UNAVAILABLE` | 400 | 服务端未启用两步验证能力（未配置主密钥或功能被关闭） |
| `FORBIDDEN` | 403 | 角色不足 |
| `CSRF_MISMATCH` | 403 | CSRF token 缺失或不匹配 |
| `SETUP_REQUIRED` | 409 | 尚未初始化管理员，需先调用 `/api/auth/bootstrap` |
| `ALREADY_INITIALIZED` | 409 | 已初始化，bootstrap 被拒绝 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 唯一约束冲突（如用户名重复） |
| `RATE_LIMITED` | 429 | 触发限流（登录 10 次/分钟/IP） |
| `UPSTREAM_UNAVAILABLE` | 503 | 依赖的外部数据源不可用（如 docker.sock 未挂载） |
| `INTERNAL` | 500 | 未预期错误 |

### 0.4 健康检查
`GET /api/health` → `200`
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 123,
  "setupRequired": false,
  "sources": {
    "docker":    { "available": true,  "mode": "socket", "detail": null },
    "tailscale": { "available": true,  "mode": "cli",    "detail": null },
    "system":    { "available": true,  "mode": "host-proc", "detail": null },
    "gpu":       { "available": false, "mode": "none",   "detail": "nvidia-smi 不可用" }
  }
}
```
该接口**无需登录**，用于 compose healthcheck 与排障。

---

## 1. 认证与会话 `/api/auth`

### `GET /api/auth/session`
无需登录，用于前端启动判断。→ `200`
```json
{
  "setupRequired": false,
  "authenticated": true,
  "csrfToken": "b7f1...",
  "user": { "id": 1, "username": "admin", "displayName": "管理员", "role": "admin", "totpEnabled": false, "totpConfirmedAt": null },
  "expiresAt": "2026-03-01T12:00:00.000Z"
}
```
未登录时 `authenticated=false`、`user=null`（`csrfToken` 仍下发，供登录请求使用 ——
`/api/auth/login`、`/api/auth/login/totp`、`/api/auth/bootstrap` 是仅有的三个豁免 CSRF 的变更接口，
见 `server/src/http/guards.ts` 的 `CSRF_EXEMPT_PATHS`）。

### `POST /api/auth/login`
无需登录、豁免 CSRF。限流 **10 次/分钟/IP**，与下面的 `login/totp` **共用同一个计数桶**
（`LOGIN_RATE_LIMIT`，`server/src/api/auth.ts`）。
```json
{ "username": "admin", "password": "••••••", "remember": true }
```
→ 账号未启用两步验证：`200 { "user": {...}, "csrfToken": "...", "expiresAt": "..." }`（同时 `Set-Cookie`）

→ 账号已启用两步验证：`200 { "totpRequired": true, "challengeToken": "...", "expiresAt": "..." }`
**不设置会话 Cookie** —— `challengeToken` 只是一次性凭据（TTL 默认 300s），
前端拿它去调下一步；因为挑战尚未构成会话，前端**不得**把它写进 localStorage/sessionStorage。

错误：`INVALID_CREDENTIALS` / `SETUP_REQUIRED` / `RATE_LIMITED` / `TOTP_UNAVAILABLE`

### `POST /api/auth/login/totp`
无需登录、豁免 CSRF（会话尚未建立）、限流同上（与 `login` 共用 `LOGIN_RATE_LIMIT` 的桶）。

> **为什么两条路由必须共用限流**：挑战内部只有 5 次尝试上限，
> 真正的暴力尝试是"重新登录换一个新挑战、再来 5 次"。
> 两条路由各算一个桶的话，拿到密码的人可以对 6 位码无限重试（`server/src/api/auth.ts`）。

```json
{ "challengeToken": "...", "code": "123456", "remember": true }
```
`code` 既接受 6 位动态码，也接受恢复码（形如 `XXXX-XXXX`，每码只能用一次）。

→ `200 { "user": {...}, "csrfToken": "...", "expiresAt": "..." }`（同时 `Set-Cookie`）
错误：`TOTP_INVALID`（就地重试）/ `TOTP_CHALLENGE_EXPIRED` / `VALIDATION_FAILED`

`TOTP_CHALLENGE_EXPIRED` 覆盖**四种**情况，语义都是"这个挑战不能再用了，退回第一步重新登录"：
挑战不存在、已过期、已消费（此前已用它换过会话）、以及在这个挑战上**尝试次数已达 5 次**
（文案"尝试次数过多，请重新登录"；常量 `TOTP_CHALLENGE_MAX_ATTEMPTS`，`server/src/db/totp.ts`）。

> **前端语义**：`TOTP_INVALID` 是"这次输错了"，不是"会话失效"；
> 客户端**不**因它触发全局登出回调。

### `POST /api/auth/logout`
需登录。销毁当前会话 → `204`

### `POST /api/auth/bootstrap`
无需登录、豁免 CSRF。仅在用户表为空时可用（`setupRequired=true`）。
```json
{ "token": "setup-token", "username": "admin", "password": "至少10位含字母与数字", "displayName": "管理员" }
```
→ `201 { "user": {...} }`；首个用户强制为 `admin` 角色。
错误：`ALREADY_INITIALIZED` / `VALIDATION_FAILED`（token 错误也归入此类的 `token` 字段）

### `POST /api/auth/password`
需登录。`{ "currentPassword": "...", "newPassword": "..." }` → `204`

---

## 2. 概览 `/api/overview`

### `GET /api/overview`
需登录。首屏聚合，服务端并行取数。→ `200`
```json
{
  "generatedAt": "2026-02-25T10:00:00.000Z",
  "containers": { "total": 5, "running": 5, "tailnetReachable": 2, "attention": 1 },
  "tailnet": { "self": { "hostname": "Sisi-Laptop", "ipv4": "100.72.255.29", "dnsName": "sisi-laptop.tail921448.ts.net" },
               "peersTotal": 11, "peersOnline": 3 },
  "system": { "cpuPercent": 12.4, "memPercent": 48.1, "diskPercent": 61.0, "gpuPercent": 19,
              "cpuModel": "AMD Ryzen ...", "memUsedBytes": 1, "memTotalBytes": 2, "uptimeSec": 3600 },
  "tools": { "total": 6, "up": 3, "down": 3 },
  "sources": { "docker": {...}, "tailscale": {...}, "system": {...}, "gpu": {...} }
}
```

---

## 3. 容器 `/api/containers`

### `GET /api/containers`
需登录。查询参数：
| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `all` | bool | `true` | 是否含已停止容器 |
| `reachability` | `tailnet\|lan\|localhost-only\|none` | 空 | 过滤 |
| `q` | string | 空 | 名称/镜像模糊匹配 |

→ `200`
```json
{
  "items": [{
    "id": "a1b2c3d4e5f6",
    "name": "cs22-web",
    "image": "cs22-marketplace-web:local",
    "state": "running",
    "status": "Up 3 hours",
    "createdAt": "2026-02-20T08:00:00.000Z",
    "startedAt": "2026-02-25T06:00:00.000Z",
    "composeProject": "cs22",
    "composeService": "web",
    "labels": { "com.docker.compose.project": "cs22" },
    "networks": [{ "name": "cs22_default", "ipv4": "172.20.0.3" }],
    "mounts": [{ "type": "bind", "source": "D:\\data", "destination": "/data", "readOnly": true }],
    "reachability": "tailnet",
    "primaryUrl": "http://sisi-laptop.tail921448.ts.net:8080/",
    "ports": [{
      "containerPort": 80,
      "protocol": "tcp",
      "hostIp": "0.0.0.0",
      "hostPort": 8080,
      "reachability": "tailnet",
      "url": "http://sisi-laptop.tail921448.ts.net:8080/",
      "note": null
    }],
    "urlCandidates": [
      { "label": "tailnet", "url": "http://100.72.255.29:8080/" },
      { "label": "magicdns", "url": "http://sisi-laptop.tail921448.ts.net:8080/" },
      { "label": "localhost", "url": "http://localhost:8080/" }
    ],
    "tailscaleSidecar": false,
    "servePaths": ["/salecapitai"],
    "servedUrl": "https://sisi-laptop.tail921448.ts.net/salecapitai",
    "health": "healthy",
    "stats": { "cpuPercent": 0.4, "memUsedBytes": 1, "memLimitBytes": 2 }
  }],
  "total": 5,
  "summary": { "total": 5, "running": 5, "tailnetReachable": 2, "localhostOnly": 1, "stopped": 0 },
  "source": { "available": true, "mode": "socket", "detail": null },
  "serve": {
    "available": true,
    "mode": "cli",
    "detail": null,
    "routes": [{
      "host": "sisi-laptop.tail921448.ts.net",
      "port": 443,
      "scheme": "https",
      "path": "/calendar",
      "url": "https://sisi-laptop.tail921448.ts.net/calendar",
      "proxy": "http://127.0.0.1:443/calendar",
      "targetHost": "127.0.0.1",
      "targetPort": 443,
      "containerName": "sisi-calendar",
      "containerId": "f1e2d3...",
      "coveredByContainerPort": false
    }]
  }
}
```

### `serve` 字段（`tailscale serve` 路由）

**为什么需要它**：`tailscale serve` 是**路径级**反向代理，它能把**只绑定在宿主
`127.0.0.1` 的服务**暴露到 tailnet。这类服务仅按 Docker 端口绑定判定会得到
"仅本机、无入口"，但经 serve 实际是可达的 —— 只看端口映射会漏掉它们。

| 字段 | 说明 |
| --- | --- |
| `serve.available` | 能否读到 serve 配置。**CLI 模式才有**：serve 是节点本地状态，Tailscale REST API 不提供 |
| `serve.detail` | 不可用原因（含解决方式），非空时前端展示指引 |
| `routes[].url` | 可直接点击的 tailnet 入口（HTTPS） |
| `routes[].proxy` | serve 的代理目标（宿主视角），用于诊断 |
| `routes[].containerName` | 该路由指向的容器（能按目标端口匹配到时）；`null` 表示目标是宿主服务 |
| `routes[].coveredByContainerPort` | 该目标端口已作为可达端口出现在容器卡上。为 `true` 时前端**不重复**列为独立入口，仅在完整列表中标注 |
| `items[].servePaths` | 该容器被 serve 暴露的路径，用于在容器卡上打 `serve` 标记 |
| `items[].servedUrl` | 该容器经 serve 的入口 URL（卡片优先展示） |

`stats` 仅在 `?stats=1` 时返回（`docker stats` 有额外开销，容器详情页单独取）。

### `GET /api/containers/:id`
需登录。`:id` 支持完整 ID、12 位短 ID 或容器名。→ `200 { "container": {...} }`（结构同上，含 `stats`、`envMasked`、`command`、`restartPolicy`）
错误：`NOT_FOUND`

### `GET /api/containers/:id/logs`
需登录（viewer 亦可，日志视为只读）。查询参数 `tail`（默认 200，最大 2000）、`timestamps`（默认 false）。
→ `200`
```json
{ "lines": ["2026-02-25 06:00:01 start", "..."], "truncated": false, "stream": "stdout+stderr" }
```
> 日志中的疑似密钥（`*_TOKEN`、`*_KEY`、`PASSWORD` 等 `KEY=VALUE`）会被 `util/redact.ts` 脱敏为 `***`。

---

## 4. tailnet 设备 `/api/tailscale`

### `GET /api/tailscale/devices`
需登录。→ `200`
```json
{
  "self": {
    "id": "n6iu3fPyR111CNTRL", "hostname": "Sisi-Laptop", "dnsName": "sisi-laptop.tail921448.ts.net",
    "os": "windows", "ipv4": "100.72.255.29", "ipv6": "fd7a:115c:a1e0::2101:ffb9",
    "online": true, "exitNode": false, "tags": []
  },
  "tailnet": { "name": "tail921448.ts.net", "magicDnsSuffix": "tail921448.ts.net" },
  "peers": [{
    "id": "nodeid-2", "hostname": "Sisi的MacBook Air", "dnsName": "sisi-macbook-air.tail921448.ts.net",
    "os": "macOS", "ipv4": "100.67.103.66", "ipv6": "fd7a:115c:a1e0::582d:6743",
    "online": false, "lastSeen": "2026-02-24T22:10:00.000Z", "exitNode": false,
    "tags": [], "relay": "syd", "rxBytes": 0, "txBytes": 0
  }],
  "summary": { "peersTotal": 11, "peersOnline": 3, "peersOffline": 8 },
  "source": { "available": true, "mode": "cli", "detail": null }
}
```

### `GET /api/tailscale/status`
需登录。精简版，供概览页与顶栏轮询：`{ "self": {...}, "summary": {...}, "source": {...} }`

---

## 5. 系统指标 `/api/system`

### `GET /api/system/snapshot`
需登录。一次取全。→ `200`
```json
{
  "generatedAt": "2026-02-25T10:00:00.000Z",
  "host": { "hostname": "Sisi-Laptop", "platform": "win32", "kernel": "10.0.26200", "arch": "x64",
            "cpuModel": "AMD Ryzen 9 ...", "cpuCores": 16, "uptimeSec": 3600, "bootedAt": "..." },
  "cpu":  { "percent": 12.4, "perCore": [10.1, 22.0], "loadAvg": [0.5, 0.4, 0.3] },
  "memory": { "usedBytes": 1, "totalBytes": 2, "availableBytes": 1, "percent": 48.1, "swapUsedBytes": 0, "swapTotalBytes": 0 },
  "disks": [
    { "mount": "/host/disk/C", "label": "C:", "fsType": "ntfs", "usedBytes": 1, "totalBytes": 2, "availableBytes": 1, "percent": 61.0 }
  ],
  "gpu": {
    "available": true, "name": "NVIDIA GeForce RTX 4060 Laptop GPU", "percent": 19,
    "memoryUsedBytes": 1, "memoryTotalBytes": 2, "temperatureC": 39, "powerWatts": 22.5,
    "fanPercent": 30, "processes": [{ "pid": 1234, "name": "ollama", "memoryUsedBytes": 1 }]
  },
  "sources": {
    "cpu":    { "available": true, "mode": "host-proc", "detail": null },
    "memory": { "available": true, "mode": "host-proc", "detail": null },
    "disk":   { "available": true, "mode": "statfs",    "detail": null },
    "gpu":    { "available": true, "mode": "nvidia-smi","detail": null }
  }
}
```
`sources[].mode` 取值：`host-proc`（读到宿主真实值）/ `container-proc`（只能看到容器自身的 cgroup 视图，UI 会显示警告角标）/ `statfs` / `nvidia-smi` / `none`。**这是让用户区分"数据不准"与"服务坏了"的关键字段。**

### `GET /api/system/stream`
需登录。`text/event-stream`。
```
event: metrics
data: { "generatedAt": "...", "cpu": {...}, "memory": {...}, "disks": [...], "gpu": {...} }

event: ping
data: {}
```
默认 3s 一帧（`PORTAL_METRICS_INTERVAL_MS`）。断开由客户端 `EventSource` 自动重连；服务端在 15 分钟无活动后主动 `end()`。

---

## 6. 工具 `api/tools`

### `GET /api/tools`
需登录。查询参数 `probe=0|1`（默认 `1`；`0` 只返回目录不探测，用于秒开）。
```json
{
  "items": [{
    "id": "ollama", "name": "Ollama", "category": "ai", "icon": "ollama",
    "description": "本地大模型推理服务",
    "url": "http://sisi-laptop.tail921448.ts.net:11434/",
    "urlCandidates": [{ "label": "tailnet", "url": "..." }, { "label": "localhost", "url": "..." }],
    "exposed": true, "hostPort": 11434,
    "status": { "state": "up", "latencyMs": 12, "httpStatus": 200, "checkedAt": "...", "detail": null },
    "deepLink": { "label": "Web UI", "url": "http://...:11434/" },
    "visibleTo": ["admin", "viewer"]
  }],
  "summary": { "total": 6, "up": 3, "down": 2, "unknown": 1 },
  "source": { "available": true, "mode": "catalog", "detail": null }
}
```
`status.state` 取值：`up` / `down` / `unknown`（未探测）。

### `GET /api/tools/:id/probe`
需登录。强制刷新单个工具的探测结果（绕过缓存）。→ `200 { "tool": {...} }`

---

## 6.5 服务注册表 `/api/services`

把"容器 + serve 路由"归纳成用户看得懂的**服务**，并允许管理员调整展示方式。
完整设计（发现规则 / 稳定身份 / 入口优先级 / 状态语义）见
[sprint1-implementation-spec.md](../sprint1-implementation-spec.md) 与 [01-architecture.md](./01-architecture.md) §4.1。

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/services` | viewer | 服务墙数据（**聚合接口**：前端首页只调这一个） |
| `GET /api/services/:id` | viewer | 详情：全部候选入口 + 诊断；hidden 对非 admin → `NOT_FOUND` |
| `POST /api/services` | admin | 新建**手工服务**（`sourceType: "manual"`）→ `201` |
| `PATCH /api/services/:id` | admin | 改展示属性 / 首选入口 / 可见性 / 排序 / 收藏 / 健康目标 |
| `POST /api/services/reorder` | admin | 批量排序 |
| `POST /api/services/discover` | admin | 强制重新发现（跳过 TTL 缓存），返回**含 hidden** 的最新列表 |
| `DELETE /api/services/:id` | admin | 手工服务删除；自动服务改为隐藏；`?mode=reset` 重置用户覆盖 |
| `POST /api/services/:id/health` | admin | 一次性健康探测（**目标每次重新校验**，见 06-security.md §3） |

### `GET /api/services`

查询参数：`query`（子串匹配名称/分类/容器名）、`category`、`favorite=1`、`includeHidden=1`（**仅 admin 生效**，非 admin 传了也会被忽略）。未知参数一律 `400`（schema `.strict()`）。

```json
{
  "items": [
    {
      "id": "3f1c…",
      "slug": "family-calendar",
      "displayName": "家庭日历",
      "description": null,
      "icon": "calendar",
      "category": "家庭",
      "sourceType": "docker",
      "sourceRef": "docker:sisi/sisi-calendar",
      "bindingRefs": ["container:docker:sisi/sisi-calendar", "serve:family-nas.tail585599.ts.net:8443/calendar"],
      "visibility": "visible",
      "favorite": true,
      "sortOrder": 10,
      "preferredUrl": null,
      "entry": "https://family-nas.tail585599.ts.net:8443/calendar",
      "entries": [
        { "kind": "serve", "label": "Serve HTTPS", "url": "https://family-nas.tail585599.ts.net:8443/calendar", "rank": 1, "accessible": true, "detail": "tailscale serve 8443 /calendar" },
        { "kind": "tailnet", "label": "Tailnet", "url": "http://100.101.102.103:36065/", "rank": 2, "accessible": true, "detail": null },
        { "kind": "localhost", "label": "仅本机", "url": "http://127.0.0.1:36065/", "rank": 4, "accessible": false, "detail": "只能从宿主本机访问" }
      ],
      "entryCount": 3,
      "status": { "container": "running", "reachable": true, "health": "unknown", "reasons": [] },
      "container": { "id": "9c2f…", "name": "sisi-calendar", "state": "running", "image": "sisi/calendar:1.4" },
      "userEdited": true,
      "healthTarget": null,
      "healthPath": null,
      "createdAt": "2026-10-16T12:00:00.000Z",
      "updatedAt": "2026-10-16T12:30:00.000Z"
    }
  ],
  "total": 1,
  "categories": ["家庭", "基础设施"],
  "discovery": {
    "dockerAvailable": true,
    "serveAvailable": true,
    "serveDetail": null,
    "discoveredAt": "2026-10-16T12:34:56.000Z",
    "notes": []
  },
  "generatedAt": "2026-10-16T12:34:56.000Z"
}
```

**数据源不可用时不允许"静默为空"**：`discovery.dockerAvailable` / `serveAvailable` 必须为 `false`
并在 `serveDetail` / `notes` 里给出人能读懂的原因（例如 API 模式读不到 `tailscale serve` 配置），
前端据此显示降级提示条。

### 入口与状态语义（读的时候必须一起看）

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| `entries[]` | **全部**候选入口（含不可达） | 永远不丢候选，诊断靠它 |
| `entries[].rank` | 0 用户指定 / 1 Serve HTTPS / 2 Tailnet / 3 LAN / 4 仅本机 | 只用于排序，不用于隐藏 |
| `entries[].accessible` | 是否可能从旁路访问 | "仅本机"恒 `false` |
| `entry` | 首选入口 = **第一个可达候选** | 一个可达的都没有 → `null`（前端必须解释原因，不能给死链） |
| `entryCount` | `entries.length` | `>1` 时前端提供"查看所有候选入口" |
| `status.container` | 容器状态（`null` = 无关联容器） | 三维状态**分开报**，不得合成"服务挂了" |
| `status.reachable` | 是否存在可达入口（`null` = 未知） | 与容器状态独立（容器在跑但只在 127.0.0.1 上 → `reachable:false`） |
| `status.health` | `ok` / `fail` / `unknown` / `skipped` | **默认 `skipped`**：没配健康目标就不探测 |
| `status.reasons[]` | 面向人的解释 | 容器不可达、serve 不可用等都必须在里面说清 |

### `POST /api/services`（admin）

```json
{ "displayName": "家庭日历", "category": "家庭", "icon": "calendar",
  "preferredUrl": "https://family-nas.tail585599.ts.net:8443/calendar",
  "description": null, "healthPath": null }
```

`displayName` 必填；`icon` 只接受内置图标键或 `https://` URL；`preferredUrl` / `healthTarget`
只接受 `http` / `https`，且拒绝内嵌凭据、通配地址与超过 2048 字符的值（细节见 06-security.md §3）。
返回 `201` + `ServiceView`。

### `PATCH /api/services/:id`（admin）

只传要改的字段。`visibility` 为 `hidden` 时 viewer 侧完全看不到；`clearPreferredUrl: true`
用于把首选入口交还给自动优先级。**任何一次 `PATCH` 都会把该服务标记为 `userEdited`**，
此后自动发现不再覆盖它的展示属性（这是"名字/图标/顺序刷新与重启后不丢"的机制）。

校验失败 → `400 VALIDATION_FAILED`，`fieldErrors` 指出具体字段（例如 `preferredUrl: "只允许 http/https"`）。

### `DELETE /api/services/:id`（admin）

```json
{ "ok": true, "mode": "hidden", "service": { "id": "3f1c…", "visibility": "hidden" } }
```

`mode` 三态：`deleted`（手工服务，真的删）、`hidden`（自动服务，自动发现还会再出现，只是不展示）、
`reset`（清掉用户覆盖，回到自动派生）。**自动服务永远不会被"删除"** —— 它下轮发现就会回来，
假装删掉才是骗人。

### `POST /api/services/:id/health`（admin）

请求体可选 `{ "healthTarget": "http://127.0.0.1:36065/health" }`（不传则用服务自身配置的目标）。

```json
{ "service": { "id": "3f1c…", "status": { "health": "ok", "…": "…" } },
  "health": { "state": "ok", "statusCode": 200, "durationMs": 42, "detail": null, "at": "2026-10-16T12:40:00.000Z" } }
```

被拒绝的目标同样返回 `200` + `health.state: "fail"`，但 `detail` 明确写"已拒绝"，
且**不会发出任何请求**（`validateHealthTarget()` 在探测之前拦截）；未配置目标 → `400`。
探测结果**只在内存里**（不落库、不当成"该地址可信"的凭据）。

---

## 6.6 聚合搜索 `/api/search`

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/search?q=<关键词>&limit=<1-20>` | viewer | 服务 / 容器 / 设备 / 工具，**按调用者角色过滤** |

```json
{
  "items": [
    { "kind": "service", "id": "3f1c…", "title": "家庭日历", "subtitle": "家庭 · Serve HTTPS",
      "url": "https://family-nas.tail585599.ts.net:8443/calendar", "keywords": ["family-calendar", "docker:sisi/sisi-calendar"] }
  ],
  "query": "日历"
}
```

- `limit` 默认 `8`、上限 `20`（超出按 20 处理，不报错）。
- 匹配：标题与 `keywords` 的大小写不敏感**子串**匹配；分组顺序 服务 → 容器 → 设备 → 工具，
  同组内"标题命中"排在"keywords 命中"之前，其余按标题字典序。
- **只索引调用者有权查看的内容**：服务走按角色过滤的列表（非 admin 不含 hidden），
  **设置 / 用户 / 审计 / Token 一律不进索引**。设备条目 `url` 恒为 `null`（设备没有可点击入口）。
- **搜索不产生副作用**：工具走 `probe: false`，不触发端口/HTTP 探测。
- 单个数据源失败**不会**让搜索 500（降级为该组空结果，并写一条 `warn` 日志）。

---

## 7. 用户与偏好

### `GET /api/users/me`
需登录。`{ "user": {...}, "preferences": { "theme": "dark", "defaultPage": "overview", "density": "comfortable" } }`

### `PATCH /api/users/me/preferences`
需登录。`{ "theme"?: "dark|light|system", "defaultPage"?: string, "density"?: "comfortable|compact" }` → `200`

### `GET /api/users` （admin）
`{ "items": [{ "id":1, "username":"admin", "displayName":"管理员", "role":"admin", "totpEnabled": true, "totpConfirmedAt":"2026-10-16T02:00:00.000Z", "createdAt":"...", "lastLoginAt":"..." }], "total": 1 }`

### `POST /api/users` （admin）
`{ "username": "...", "password": "...", "displayName": "...", "role": "viewer" }` → `201`
错误：`CONFLICT`（用户名已存在）

### `PATCH /api/users/:id` （admin）
`{ "displayName"?, "role"?, "disabled"? }` → `200`。不允许把最后一个 admin 降级或禁用 → `409 CONFLICT`。

### `POST /api/users/:id/password` （admin）
`{ "newPassword": "..." }` → `204`。会吊销该用户的全部会话。

### `DELETE /api/users/:id` （admin）
→ `204`。不允许删除自己或最后一个 admin → `409`。

### `POST /api/users/:id/sessions/revoke` （admin）
吊销该用户全部会话（强制下线）→ `200 { "revoked": 3 }`

### 两步验证（TOTP）自助管理
均需登录 + CSRF。挂在 `/api/users/me/*` 而不是 `/api/auth/*`，因为它们是
**登录后的变更操作**（`/api/auth/*` 是匿名作用域，没有角色守卫与 CSRF 钩子）。

账号对象在两个接口里都新增了 `totpEnabled: boolean`（`GET /api/auth/session`、
`GET /api/users/me`、`GET /api/users` 的 `user` 一致）；另有 `totpConfirmedAt: string | null`
（绑定确认时间，前端显示"启用时间"）。这两个字段都来自 `AuthService.toPublicUser()` 的
**显式白名单**（`server/src/modules/auth/service.ts`）；`GET /api/users` 走的是
`UsersRepository.list()` → `mapUserRow()`（`server/src/db/types.ts`），字段集合相同。

> **种子与恢复码永远不会出现在任何响应里**：库里存的只有 AES-256-GCM 密文（`users.totp_secret`）
> 和 sha256 摘要（恢复码、挑战令牌），而对外模型 `User` 里**根本没有**这些字段 ——
> `UserWithSecret.totpSecretEncrypted` / `totpLastCounter` 只存在于服务端内部
> （`server/src/db/types.ts`），且 `toPublicUser()` 是逐个字段列举的白名单而不是"删掉密码哈希后展开"，
> 所以以后往内部模型加字段也不会默认泄漏。明文种子只在 `setup` 的响应里出现一次，
> 恢复码明文只在 `enable` 与 `recovery-codes` 的响应里各出现一次。

| 接口 | 请求体 | 成功响应 | 主要错误 |
| --- | --- | --- | --- |
| `POST /api/users/me/totp/setup` | — | `200 { "secret": "JBSW…", "otpauthUri": "otpauth://totp/HomePort:admin?secret=…", "digits": 6, "period": 30 }` | `CONFLICT`（已启用时不能重新生成，需先关闭）/ `TOTP_UNAVAILABLE` |
| `POST /api/users/me/totp/enable` | `{ "code": "123456" }` | `200 { "recoveryCodes": ["XXXX-XXXX", …], "user": {...} }` | `TOTP_INVALID` / `TOTP_UNAVAILABLE`（服务端关闭了新绑定）/ `VALIDATION_FAILED`（未先 setup） |
| `POST /api/users/me/totp/disable` | `{ "password": "...", "code": "123456"? }`（`code` 在 schema 里**可选**，但当前**已启用**两步验证时业务层必填） | `200 { "ok": true, "user": {...} }` | `VALIDATION_FAILED`（密码错误 → `fieldErrors.password`；已启用却没给 `code` → `fieldErrors.code`）/ `TOTP_INVALID` |
| `POST /api/users/me/totp/recovery-codes` | `{ "code": "123456" }` | `200 { "recoveryCodes": ["XXXX-XXXX", …] }` | `TOTP_INVALID` / `VALIDATION_FAILED`（尚未启用） |
| `POST /api/users/:id/totp/reset` （admin） | — | `200 { "ok": true, "revokedSessions": 3 }` | `NOT_FOUND` / `FORBIDDEN` |

约定与注意点：

1. `setup` 重复调用会**重新生成未确认的种子**，使上一个未确认种子立即失效；界面必须就此提示。
2. `enable` / `recovery-codes` 返回的恢复码**只出现这一次**（库里只存 SHA-256 摘要），
   界面必须一次性展示、逐条列出、要求用户确认已保存；重新生成时旧码全部作废。
3. **关闭两步验证的门槛不低于开启**：要密码，且当前已启用时还要一次动态码或恢复码。
   `code` 在 schema 上**可选**（未启用时不必给），但**已启用时业务层必填**，
   缺失按 `VALIDATION_FAILED` 400 + `fieldErrors.code` 返回
   （`totpDisableBodySchema`，`server/src/http/schemas.ts`）。
   密码错误同样是 `VALIDATION_FAILED` 400 + `fieldErrors.password`，
   **不**返回 401 `INVALID_CREDENTIALS` —— 与同文件的自助改密（`changeOwnPassword`）写法一致，
   前端对这两种响应都已能正确提示。
4. `reset`（admin 强制重置）的语义是"清空种子与恢复码 + 吊销该用户全部会话"，
   用户会立即掉线、需重新登录并重新绑定，因此界面必须二次确认并写明后果。
5. `setup` 与 `enable` 受服务端开关 `PORTAL_TOTP_ENABLED` 限制：关闭时两者都返回
   `TOTP_UNAVAILABLE`。**已绑定账号的登录第二步、以及 `disable` / `recovery-codes` 不受该开关影响**
   —— 否则关掉开关就等于静默降级或把人锁在门外（`assertTotpEnrollmentAllowed()`，
   `server/src/modules/auth/service.ts`；配置说明见 [02-configuration.md](./02-configuration.md)）。

---

## 8. 运行时设置（admin）

管理员可在界面内修改部分配置，优先级 **数据库 > 环境变量 > 内置默认**。
`.env` 部署方式完全不受影响：未在界面改过的项仍按 `.env` 生效。

### `GET /api/settings`
需 admin。→ `200`
```json
{
  "groups": [
    { "id": "tailscale", "label": "tailnet 数据源", "description": "查询 tailnet 设备与在线状态…" }
  ],
  "settings": [{
    "key": "PORTAL_TAILSCALE_API_TOKEN",
    "group": "tailscale",
    "label": "API Token",
    "description": "在 Tailscale 管理后台 → Settings → Keys → Generate access token 生成…",
    "effect": "reload",
    "valueType": "string",
    "envVar": "PORTAL_TAILSCALE_API_TOKEN",
    "value": "tskey-api-********",
    "masked": true,
    "source": "database",
    "defaultValue": "",
    "envValue": null,
    "databaseValue": "tskey-api-********",
    "sensitive": true,
    "updatedAt": "2026-10-16T01:23:45.000Z",
    "updatedBy": "admin",
    "editable": true
  }],
  "version": "3:2026-10-16T01:23:45.000Z"
}
```

| 字段 | 说明 |
| --- | --- |
| `effect` | `live`（下次读取生效）/ `reload`（保存后自动重建数据源）/ `restart`（**需重建容器**） |
| `source` | `default` / `env` / `database` —— 当前值来自哪一层 |
| `editable` | `effect === 'restart'` 时为 `false`，前端**不应**提供编辑控件 |
| `masked` | 敏感项已打码；提交 `********` 或空字符串表示"不修改" |
| `envValue` | 环境变量里的原值（便于对照"界面改了什么"），敏感项同样打码 |
| `restartReason` | `restart` 级项不可改的具体原因 |

### `PATCH /api/settings`
需 admin + CSRF。**部分成功语义**。
```json
{ "values": { "PORTAL_TAILSCALE_API_TOKEN": "tskey-api-xxx", "PORTAL_METRICS_INTERVAL_MS": 5000 } }
```
→ `200`
```json
{
  "updatedKeys": ["PORTAL_TAILSCALE_API_TOKEN", "PORTAL_METRICS_INTERVAL_MS"],
  "rejectedRestartKeys": [],
  "invalid": [{ "key": "…", "error": "不能大于 60000ms" }],
  "reloaded": { "tailscale": true, "docker": false },
  "view": { "groups": [], "settings": [], "version": "…" }
}
```
- 合法项写入并**立即生效**（`reloaded` 说明重建了哪些数据源）。
- `restart` 级键 → `rejectedRestartKeys`（服务端也会拒绝，不只是界面隐藏）。
- 非法值 → `invalid[].error`，其余项照常写入。
- 响应带回最新 `view`，前端无需二次请求。

### `POST /api/settings/reset`
需 admin + CSRF。`{ "keys": ["PORTAL_METRICS_INTERVAL_MS"] }`；省略 `keys` 表示全部重置。
→ `200 { "removed": 1, "view": { ... } }`

### `POST /api/settings/test/tailscale`
需 admin + CSRF。测试 tailnet 连通性，支持**尚未保存**的候选 Token（"先测再存"）。
```json
{ "token": "tskey-api-xxx" }
```
→ `200`
```json
{
  "ok": true,
  "mode": "api",
  "source": { "available": true, "mode": "api", "detail": null },
  "deviceCount": 12,
  "onlineCount": 4,
  "devices": [{ "hostname": "sisi-laptop", "os": "windows", "online": true, "ipv4": "100.72.255.29" }],
  "message": "API 模式可用：读到 12 台设备，其中 4 台在线。"
}
```
失败时 `ok: false` 且 `message` 给出**可操作**的下一步（401 → 重新生成 Token；403 → 检查 ACL；超时 → 检查外网出口）。

---

## 9. 权限矩阵

| 接口 | 匿名 | viewer | admin |
| --- | :-: | :-: | :-: |
| `/api/health` | ✅ | ✅ | ✅ |
| `/api/auth/session`、`login`、`login/totp`、`bootstrap` | ✅ | ✅ | ✅ |
| `/api/auth/logout`、`/api/auth/password` | ❌ | ✅ | ✅ |
| `/api/overview`、`/api/containers*`、`/api/tailscale/*`、`/api/system/*`、`/api/tools*` | ❌ | ✅ | ✅ |
| `/api/services`（GET）、`/api/services/:id`（GET）、`/api/search` | ❌ | ✅ | ✅（可见 hidden） |
| `/api/services` 及 `/api/services/:id*` 的**写**方法（POST/PATCH/DELETE） | ❌ | ❌ | ✅ |
| `/api/users/me*` | ❌ | ✅ | ✅ |
| `/api/users` 及 `/api/users/:id*` | ❌ | ❌ | ✅ |
| `/api/settings` 及 `/api/settings/*` | ❌ | ❌ | ✅ |

## 10. 变更记录

接口的任何变动必须同步更新本文件，并在 [09-changelog.md](./09-changelog.md) 记录。

- **S1-01…S1-05（服务注册表、服务墙、快捷搜索）**：新增 `/api/services` 读写接口与
  `GET /api/search`（见 §6.5 / §6.6）；`/api/services` 与 `/api/search` 已加入
  `PROTECTED_PREFIXES`（前缀守卫 = 登录 + CSRF），写方法在 handler 内再 `assertAdmin`；
  错误码沿用既有 `VALIDATION_FAILED` / `NOT_FOUND` / `FORBIDDEN`，**未新增错误码**。
- **S0-03（两步验证 TOTP）**：新增 `POST /api/auth/login/totp`；
  `POST /api/auth/login` 对已启用 TOTP 的账号改回 `{ totpRequired, challengeToken, expiresAt }` 且不发 Cookie；
  `user` 对象新增 `totpEnabled`（另有 `totpConfirmedAt`）；
  新增自助接口 `POST /api/users/me/totp/{setup,enable,disable,recovery-codes}` 与管理员的
  `POST /api/users/:id/totp/reset`；错误码新增 `TOTP_INVALID` / `TOTP_CHALLENGE_EXPIRED` / `TOTP_UNAVAILABLE`。
  - 归档补记（**对既有接口的澄清**，不是新增接口）：`disable` 的密码错误按
    `VALIDATION_FAILED` 400 + `fieldErrors.password` 返回（与自助改密写法一致，**不是** 401）；
    其 `code` 在 schema 上可选、**已启用时必填**；`login/totp` 的挑战尝试次数超限
    也返回 `TOTP_CHALLENGE_EXPIRED`；`setup` / `enable` 在 `PORTAL_TOTP_ENABLED=0` 时返回
    `TOTP_UNAVAILABLE`（不影响已绑定账号的登录第二步与 `disable`）。
