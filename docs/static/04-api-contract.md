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
| `UPSTREAM_UNAVAILABLE` | 503 | 依赖的外部数据源不可用（如 docker.sock 未挂载）；S2 起也用于"后台监视器**未装配**"这类接线缺口（见 §6.8 —— 谎报空列表等于谎报"全部健康"） |
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

## 6.7 历史指标 `/api/metrics`（Sprint 2）

三条**只读**接口，把后台采样器（`MetricsSampler`）落库的分钟/整点桶读成曲线与容量视图。
权限由 `api/index.ts` 的 `PROTECTED_PREFIXES` 统一给（`requireRole('viewer')` + CSRF 钩子），
handler 内再 `requireAuth` 兜一层（纵深防御：万一将来有人漏掉前缀条目，最坏也只是"需要登录"）。
**本域没有写接口**：`POST /api/metrics/history` → `404` —— 采样是后台单例（`BackgroundScheduler`）的事，
不开放给前端触发。

#### 可见性语义（S2 验收驳回修复后必须遵守的不变量）

> **hidden / 已删除的服务，对任何已登录会话（viewer **与** admin）都不可枚举、不可查询，
> 且不泄漏其存在性。** 这条不变量在**读取侧**也强制，不只是采集侧。

| 规则 | 具体表现 |
| --- | --- |
| 采集侧（既有） | 采样固定 `role: 'viewer'` —— 隐藏之后不再产生**新的服务健康样本**（`service.health.up_ratio` 的序列来源就是 viewer 视角的服务列表） |
| **读取侧（本轮新增）** | `catalog.targets` 与 `history` 的 target 闸门都按**当前** viewer 可见服务集合过滤（实现是共享的 `modules/visibility/serviceVisibility.ts`，与告警读路径**同一个函数** —— 见 §6.9）。**隐藏之前**已落库的历史行与进程内 `liveTargets` 一并失效：行还在库里，但读不到 |
| 不可枚举 | 隐藏后 `catalog` 里该 target 的 `target` 与 `targetLabel` 都消失，**整个响应体里连服务名都不出现**；`metrics[].availableTargets` 同步减 1（不是显示一个选不中的数量）。`storage` 响应本来就不含 target 名 |
| 不可查询 | `history` 对它返回 `400 VALIDATION_FAILED` |
| **不泄漏存在性** | 被隐藏/删除的目标与"**从未采集过**的陌生 target"返回**逐字段、逐字节一致**的 400：`error.details.targetPattern` 相同、`error` 的键集合相同、没有 `reason` / `visibility` / `hidden` 之类的区分字段。测试的判定方式是"抹平调用者自己传入的 target 串后整段响应体 `toBe` 相等" |
| **没有 404 / 403** | 刻意为之：404 或 403 等于向调用者承认"这个目标存在，只是你看不到"。**任何存在性信号都不给** |
| 不做角色特例 | admin 与 viewer 拿到的是同一套可见集合：admin 打这个接口也看不到 hidden 服务的历史（门户的"隐藏"是服务层的展示意图，与登录角色无关；要改可见性请走 `PATCH /api/services/:id`） |
| 宿主/磁盘不受影响 | `host` / `disk:<label>` 不属于任何服务，不查注册表、响应与可见性改动前逐字一致（`host.memory.used_bytes` 等照常返回） |
| 隐藏不等于删除数据 | 重新设为可见后，同一 target 的历史点、`summary`、`gaps` **与隐藏前逐字段相同** —— 访问受控，行从未被删 |
| 注册表读失败时 | **fail-closed**：服务/容器类 target 一律视为不可见（宁可少列一个也不泄露一个）；宿主与磁盘指标仍照常返回 |

> **一处口径澄清（本轮归档核对代码后发现）**：采集侧固定 `role: 'viewer'` 只覆盖
> **服务健康**序列（`collectServiceSamples` 用的是 viewer 视角的服务列表）。
> **容器序列（`container.cpu.percent` / `container.memory.used_bytes`）仍按 `containers.list()` 照采**
> —— 容器列表不看服务可见性，隐藏服务的容器照样产生新样本。因此容器指标的隐藏
> **完全靠读取侧兜住**：读取侧的强制不是"锦上添花"，而是这条不变量的必需项。

**代价（照实记）**：可见性**刻意不做任何缓存**（源码注释：任何 TTL 都是泄漏窗口），
因此每次 `catalog` 与每次针对服务/容器 target 的 `history` 都会查一次服务注册表。
默认 `PORTAL_CACHE_CONTAINERS_TTL_MS = 2000` 时这一次读被服务注册表既有的 TTL 缓存吸收
（不产生 Docker 调用，并发读由 single-flight 合并）；该 TTL 允许设为 **0（不缓存）**，
那时每次读都会真的跑一遍服务发现。**同一份可见性读现在也被告警读路径复用**：
`GET /api/alerts/summary` 徽标每 60s 轮询各多一次 `registry.list`（见 §6.9）。

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/metrics/catalog` | viewer | 指标目录 + 可用 target + range 表 + 采样/调度状态；前端据此渲染选择器 |
| `GET /api/metrics/history?metric=&target=&range=` | viewer | 一条曲线：点 + 缺口 + 窗口统计 + 数据源状态 |
| `GET /api/metrics/storage` | viewer | 行数 / 文件占用 / 保留窗口 / 存储预算 + 最近一次采样摘要 |

### `GET /api/metrics/catalog`

→ `200`
```json
{
  "metrics": [{
    "key": "host.cpu.percent", "label": "宿主 CPU 使用率", "unit": "percent",
    "targetKind": "host", "targetPattern": "host",
    "source": "SystemProvider.snapshot().cpu.percent",
    "description": "两次采样做差得出；宿主 /proc 不可用时会退化为容器/虚拟机视图（见系统页的数据源提示）。",
    "availableTargets": 1
  }],
  "targets": [{
    "metric": "host.memory.percent", "target": "host", "targetLabel": "宿主",
    "unit": "percent", "lastSeenAt": "2026-10-15T10:00:00.000Z"
  }],
  "ranges": [
    { "range": "1h",  "resolution": "minute", "windowSec": 3600,     "expectedBuckets": 60,   "label": "最近 1 小时" },
    { "range": "24h", "resolution": "minute", "windowSec": 86400,    "expectedBuckets": 1440, "label": "最近 24 小时" },
    { "range": "7d",  "resolution": "hour",   "windowSec": 604800,   "expectedBuckets": 168,  "label": "最近 7 天" },
    { "range": "30d", "resolution": "hour",   "windowSec": 2592000,  "expectedBuckets": 720,  "label": "最近 30 天" }
  ],
  "sampling": {
    "intervalSec": 30, "expectedPerMinuteBucket": 2, "containerLimit": 10,
    "containerNote": "只采关键容器：运行中的优先，按稳定身份排序取前 10 个；超出上限的容器不采（历史库大小由此封顶）",
    "aggregate": "mean", "note": "30s 采样 → 每分钟 1 条；缺测处断开，不补 0"
  },
  "scheduler": { "running": true, "lastTickAt": "2026-10-15T10:00:00.000Z", "lastDurationMs": 41, "lastError": null }
}
```

约定与边界：

- **恰好 8 个指标键**，`metrics` 的顺序即前端展示顺序：
  `host.cpu.percent`、`host.memory.percent`、`host.memory.used_bytes`、`host.disk.percent`、
  `host.disk.used_bytes`、`container.cpu.percent`、`container.memory.used_bytes`、`service.health.up_ratio`
  （`METRIC_CATALOG`，`server/src/modules/metrics/types.ts`）。
- **key 是稳定标识**：进库（`metric_buckets.metric`）、进 URL、进前端。改名等于改契约，历史数据会因此与图表对不上。
- `unit` 只有 `percent` / `bytes` / `ratio` 三种，**不做任何换算**。百分比与字节是
  **两套独立的 key**（`*.percent` 与 `*.used_bytes` 各有自己的桶）：这样"磁盘用了 91%"与
  "磁盘用了 900GB"都是原始事实，不会因为某处除了一个总数而悄悄变成另一个量纲。
- `targets` = "库里出现过的行" ∪ "本进程刚采到但还没落库的"；后者的 `lastSeenAt` 为 `null`。
  target 形态与 `targetKind` 对应：`host` / `disk:<label>` / `container:<sourceRef>` / `service:<sourceRef>`。
- `targets` **再按当前 viewer 可见性过滤**（见上文"可见性语义"）：不可见服务的 `target` 与
  `targetLabel` 都不出现，`metrics[].availableTargets` 同步减少。只有候选里**真的存在服务/容器类
  target** 时才会去查注册表 —— 纯宿主/磁盘的目录完全不触碰服务层（例如没有 Docker 的环境，
  响应与改动前逐字节一致）。
- `scheduler` 可以是 `null`（装配方没接调度器）。`running: false` **不等于"没在采"**：
  `backgroundJobs: false` 的测试里调度器被构造但定时器没起，手工 `tick()` 照样落库。
- `containerLimit` 为 `0` 时 `containerNote` 换成"完全不采容器指标（宿主与磁盘指标不受影响）"。
  把"只采前 N 个"写进响应是刻意的：否则"某个容器没有曲线"会被误读成那个容器没跑。

### `GET /api/metrics/history`

查询参数**三个都必填**（缺失 → `400`，`fieldErrors` 指出是哪一个）：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `metric` | 8 个指标键之一 | 未知 → `400`，`details.allowed` 给出**全部 8 项**（前端可直接渲染候选） |
| `target` | `host` / `disk:<label>` / `container:<sourceRef>` / `service:<sourceRef>` | 形态不匹配、**从未出现过**或**当前不可见** → 一律 `400`；后两者另带 `details.targetPattern`，好让用户知道该指标要的是哪种 target。**"被隐藏"与"从未采集过"的响应完全一致**（见下文可见性语义），没有 404/403 |
| `range` | `1h` / `24h` / `7d` / `30d` | 未知 → `400`，`fieldErrors.range` 写明"只能是 1h / 24h / 7d / 30d" |

→ `200`
```json
{
  "metric": "host.cpu.percent", "label": "宿主 CPU 使用率", "unit": "percent",
  "target": "host", "targetLabel": "宿主",
  "range": "24h", "resolution": "minute",
  "from": "2026-10-14T10:00:00.000Z", "to": "2026-10-15T10:00:00.000Z",
  "sampling": { "intervalSec": 30, "aggregate": "mean", "expectedPerBucket": 2,
                "note": "30s 采样 → 每分钟 1 条；缺测处断开，不补 0" },
  "source": { "available": true, "mode": "host-proc", "detail": null },
  "points": [{ "at": "2026-10-15T10:00:00.000Z", "value": 12.4, "min": 10.1, "max": 22,
               "samples": 2, "expected": 2, "partial": false }],
  "gaps": { "missingBuckets": 3, "partialBuckets": 5 },
  "summary": { "count": 1440, "min": 3.1, "max": 91.2, "avg": 22.7, "latest": 12.4, "latestAt": "2026-10-15T10:00:00.000Z" }
}
```

关键边界（逐条有单测：`server/tests/metricsApi.test.ts`、`metricsHistory.test.ts`）：

- **缺测没有行**。整分钟一个样本都没有 → 该桶**不写行**，只在 `gaps.missingBuckets` 里计数；
  桶存在但样本不足 → `samples < expected` 且 `partial: true`。任何情况下都不会写 `value: 0` 来表示"不知道"。
- **空窗口时 `summary.count = 0`，而 `min/max/avg/latest/latestAt` 全为 `null`，绝不是 `0`**。
  用 0 冒充"没有数据"会让前端画出一条贴着 0 的平线 —— 正是本项目反复强调要避免的谎话。
  此时 `points: []`，前端据此显示空态文案而不是平线。
- `1h/24h` → `resolution: "minute"`（桶 60s）；`7d/30d` → `"hour"`（桶 3600s，由 60 条分钟行聚合，
  缺分钟即 `partial`）。`sampling.note` 随分辨率换文案。
- `to` 也**向下对齐到桶起点**：桶是左闭右开的整数区间，未结束的当前桶不算进"应有桶数"，
  否则每个窗口都会永远缺一个桶。
- `source` 是**本进程最近一次采集**该指标的数据源状态；重启后还没采过时返回
  `{ "available": false, "mode": "none", "detail": "本进程尚未采集到该指标的数据源状态（重启后需要一次采样）" }`
  —— 宁可说"这次没采到"，也不假装可用。
- **可见性校验发生在任何存在性查找之前**（`resolveTarget` 的闸门顺序：形态 → 可见性 → 存在性）。
  因此"库里曾经有过"不构成存在性证据；被隐藏/已删除的服务与陌生 target 得到同一个 400。
  逐字节一致性由 `server/tests/metricsVisibility.test.ts` 覆盖
  （真实 `buildApp()` + 真实会话 Cookie + 真实 CSRF + 真实 SQLite；夹具是**真的采集**：
  建手工服务 → 健康判定 → 采样落库 → 隐藏 → 断言 catalog/history/storage 都不再泄漏，
  恢复可见后曲线与隐藏前逐字段相同）。
- 本接口是**手工校验**三个参数（不是 zod `.strict()`），因此多传的未知查询参数被忽略、不会 `400`；
  对比 `GET /api/alerts/events` 用的是 `.strict()`。两条路由的写法不同，不要互相推断。

### `GET /api/metrics/storage`

→ `200`
```json
{
  "generatedAt": "2026-10-15T10:00:00.000Z",
  "rows": { "minute": 36, "hour": 2, "total": 38 },
  "size": { "pageCount": 42, "pageSize": 4096, "freelistCount": 0, "bytes": 172032, "megabytes": 0.16 },
  "bounds": {
    "minute": { "oldestAt": "2026-10-15T09:00:00.000Z", "newestAt": "2026-10-15T09:59:00.000Z" },
    "hour":   { "oldestAt": "2026-10-15T08:00:00.000Z", "newestAt": "2026-10-15T09:00:00.000Z" }
  },
  "retention": {
    "minuteHours": 24, "hourDays": 30,
    "minuteCutoffAt": "2026-10-14T10:00:00.000Z", "hourCutoffAt": "2026-09-15T10:00:00.000Z"
  },
  "budget": {
    "basis": "observed", "seriesPerMinute": 36, "bytesPerRow": 200,
    "minuteRowsPerDay": 51840, "hourRowsPerDay": 864,
    "minuteSteadyRows": 51840, "hourSteadyRows": 25920,
    "estimatedBytesPerDay": 10540800, "estimatedSteadyBytes": 15552000,
    "steadyLimitBytes": 33554432, "withinBudget": true,
    "note": "按最近一小时实际出现的 36 条序列/分钟线性外推（每行约 200 B，含索引开销）；这是估算而非实测，实测占用见 size.bytes。分钟行数由保留窗口封顶，不随运行时长增长。"
  },
  "lastTick": { "at": "2026-10-15T10:00:00.000Z", "collected": 41, "samplesWritten": 36,
                "bucketsFlushed": 36, "hoursRolledUp": 0, "pruned": 0, "gaps": 0, "errors": [] }
}
```

| 字段 | 含义 |
| --- | --- |
| `rows` | 各分辨率的行数与合计；`minute` 是**当前库里真实存在的行数**，不是"理论上应有 1440 行" |
| `size` | SQLite 文件的页统计（`pageCount × pageSize`），`bytes = pageCount × pageSize`，`megabytes` 保留两位 |
| `bounds.*` | 各分辨率**实际存在**的最老/最新桶时刻；一行都没有时为 `null`（不是 `0`/空串） |
| `retention.minuteCutoffAt` / `hourCutoffAt` | 清理截止时刻。按**当前时钟**算并对齐到桶起点（不是按最后一次落库时刻），否则"很久没采样"会被误读成"还没开始清理" |
| `budget.basis` | 估算基准：`observed`（按最近一小时库里实际出现的序列数）/ `baseline`（观察不到时退回典型部署基准 36 条序列/分钟） |
| `budget.seriesPerMinute` | 每分钟落库的序列数（= metric × target 组合数） |
| `budget.bytesPerRow` | 每行估算 **200 B**（含索引开销） |
| `budget.minuteSteadyRows` | 稳态 minute 行数（= `seriesPerMinute × 60 × minuteHours`）：**只与保留窗口有关，不随运行时长增长** |
| `budget.hourSteadyRows` | 稳态 hour 行数 |
| `budget.steadyLimitBytes` | 稳态总量上限：**32 MB = `32 * 1024 * 1024`**（`STEADY_STATE_BUDGET_BYTES`） |
| `budget.withinBudget` | `estimatedSteadyBytes <= steadyLimitBytes` |
| `budget.note` | 必须写明"这是**估算**而非实测"，实测占用看 `size.bytes` |
| `lastTick` | 最近一次**采样 tick** 的摘要（不是后台调度摘要 —— 调度摘要在 catalog 的 `scheduler` 里）；进程还没 tick 过时为 `null` |

---

## 6.8 健康监测 `/api/health/monitor`（Sprint 2）

### `GET /api/health/monitor`
需登录（viewer 即可）。→ `200`，**无信封**，直接返回健康监视器的内存视图。

```json
{
  "generatedAt": "2026-10-15T10:00:00.000Z",
  "thresholds": { "failThreshold": 3, "okThreshold": 2 },
  "probe": { "intervalSec": 300, "concurrency": 4, "inFlight": 0,
             "lastRunAt": null, "probedThisTick": 0, "skippedForConcurrency": 0 },
  "services": [{
    "sourceRef": "docker:gitea", "serviceId": "3f1c…", "label": "Gitea",
    "verdict": "degraded",
    "dimensions": {
      "container":    { "state": "ok",      "consecutiveFailures": 0, "detail": null },
      "dockerHealth": { "state": "unknown", "consecutiveFailures": 0, "detail": null },
      "http":         { "state": "fail",    "consecutiveFailures": 2, "detail": "连接超时" }
    },
    "consecutiveFailures": 2, "consecutiveSuccesses": 0,
    "changedAt": "2026-10-15T09:50:00.000Z",
    "lastEvaluatedAt": "2026-10-15T10:00:00.000Z",
    "lastProbeAt": "2026-10-15T10:00:00.000Z",
    "reasons": ["HTTP 探测失败 2/3 次：连接超时"]
  }],
  "notes": []
}
```

约定与边界：

- 它**单独注册为一个前缀**（`{ prefix: '/api/health/monitor' }`），不能挂在 `/api/alerts` 下：
  前缀挂载时 Fastify 默认同时接受带尾斜杠的写法，因此只定义 `'/'` 一条路由
  （与 `/api/overview` 一致，`GET /api/health/monitor/` 同样 `200`）。
- 与 `/api/health` **不是一回事**：`/api/health` 是匿名可达的 compose healthcheck；
  本接口暴露逐服务判定与探测统计，必须登录。
- `dimensions` 的三个维度键固定为 `container` → `dockerHealth` → `http`，各自 `state` 取
  `ok` / `fail` / `unknown`（`unknown` = **没有信号，不等于坏**）；`consecutiveFailures` 是**该维度**的连续失败次数。
- `verdict` 是去抖后的结论：`healthy` / `degraded` / `down` / `unknown`（默认阈值：连续失败 3 次判 `down`，
  从失败中恢复需连续全好 2 次）。`thresholds` **一并透出**，否则前端无法解释"为什么失败了 2 次还不告警"。
- `reasons[]` 是面向人的证据（只描述有问题的维度，**没有证据就不编**）；
  `notes[]` 是**降级说明**（服务列表/容器列表取不到、自动探测已关闭、探测因并发上限被推迟、
  一个服务都没有），语义是"**不允许静默为空**"。
- `probe.intervalSec = 0` 表示关闭自动 HTTP 探测（此时只评估容器维度，`http` 维保持 `unknown`）。
- **监视器由 `app.ts` 构造一次**（与调度器共用同一实例），本路由只读它的内存状态：
  在这里 `new` 一个 `HealthMonitor` 会产生第二条探测循环，把宿主服务探两遍。
- **可见性语义（S2 验收驳回修复）**：`services[]` 只包含**当前 viewer 可见**的服务。
  hidden / 已删除的服务不在列表里，它的 `label`（服务名）、`sourceRef`、`verdict` 与
  `reasons` 一并消失 —— **整个响应体里连服务名都不出现**。
  与 `/api/metrics/*` 一致：**没有 404 / 403，也不给任何"存在但不可见"的区分字段**
  （本接口是"视图"，不可见即不在视图里；调用者无法据此判断某服务是被隐藏了还是从来不存在）。
  admin 与 viewer 看到的是同一份被过滤后的视图。
  - 三条实现细节（决定了边界行为）：**成功读到空列表 = 用户把服务全隐藏/全删了** → 状态与
    服务名**一起清空**（旧实现只在非空时清理，导致旧名字永久残留 —— 这就是被驳回的 P1）；
    **读取失败**（`list()` 抛错，或响应缺 `items` 数组）→ 旧状态与服务名**原样保留**，
    原因写进 `notes`（取数抖动 ≠ 服务消失）；**读路径再拦一道**
    （`states()` / `state()` / `view()` 都过同一个可见集合，写路径将来出问题也不会漏名字）。
  - `state(ref)` 对不可见 ref 现在返回 `null`（**语义收紧**，此前会返回内存里的旧状态）。
  - 宿主/磁盘类指标不经过注册表，因此不受影响。
- 装配方没把监视器传进来时 → `503 UPSTREAM_UNAVAILABLE`（"健康监视器尚未装配"）。
  **不返回空列表**：空数组会被读成"全部健康 / 没有服务"。
- admin 与 viewer 拿到的是同一份视图（纯只读，无角色差异）。

---

## 6.9 告警 `/api/alerts`（Sprint 2）

### 接口一览

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/alerts/rules` | viewer | 四条内置规则 + 当前配置（未启用也返回，用 `enabled` 说明状态） |
| `PATCH /api/alerts/rules/:id` | **admin** + CSRF | 部分更新（只允许 6 个字段） |
| `GET /api/alerts/events?state=&limit=` | viewer | 事件列表（episode 模型）+ **可见集合内**的全量计数（见下文"读路径的可见性语义"） |
| `POST /api/alerts/events/:id/ack` | **admin** + CSRF | 确认（幂等；已恢复的也能确认）。响应体本轮未按可见性收口 |
| `GET /api/alerts/summary` | viewer | 徽标用计数 + `top` + `suppressed` / `evaluatedAt`（**所有计数含 `suppressed` 都按可见性过滤**；`evaluatedAt` 是引擎 tick 时间，不含目标、无可见性语义） |

权限分两层，缺一不可：路由域在 `api/index.ts` 的 `PROTECTED_PREFIXES` 里统一挂
`requireRole('viewer')` + CSRF 钩子；**写操作在 handler 内再 `assertAdmin`**。
`api/alerts.ts` **另外自带一份 viewer + CSRF 钩子作为兜底**：万一前缀条目被漏掉，
最坏结果也必须是"需要登录 + 缺 CSRF 被拒"，而不是把只读的规则与事件匿名开放出去
（重复挂同一钩子是幂等的，只是多校验一次）。同样的兜底也存在于 `api/healthMonitor.ts`；
两者都有测试独立验证（`/api/alerts-unwired`、`/api/health/monitor-unwired`）。

`401`（匿名）、`403 FORBIDDEN`（角色不足）、`403 CSRF_MISMATCH`（缺/错 CSRF 令牌）是**三种不同的拒绝**，
其中两种 403 的 `code` 不同，前端与测试都必须分开处理（见 06-security.md §4）。

本域还会产生**引擎侧**的审计（不经过接口，但读取告警时看得见）：
`alert.fired` / `alert.reopened` / `alert.resolved`（`modules/alerts/engine.ts`），
以及接口侧的 `alert.rule_updated` / `alert.acknowledged`。

#### 读路径的可见性语义（同类泄漏第三处，分两组收口：`871c3dc` + `470ac16`）

> **这条不变量不止管指标**：告警事件行的 `target` / `target_label` / `message` 是**触发时落库的快照**，
> 不随可见性变化。因此 `GET /api/alerts/events` 与 `GET /api/alerts/summary` 同样遵守上面的口径：
> **不可枚举、不泄漏存在性、没有 404/403、没有 admin 特例、fail-closed。**
> （`/rules` 是**配置**类接口，口径不同 —— 见下文"第二组收口"与"口径边界"。）

| 规则 | 具体表现 |
| --- | --- |
| 读取侧强制（第一组） | 每个 `/events`、`/summary` 请求先取一次当前 viewer 可见服务集合（共享 `modules/visibility/serviceVisibility.ts` 的 `loadVisibleServiceRefs`，与 `/api/metrics/*` 是**同一个函数**、同一个 `backgroundHostRequest(config)`），再由服务层在 **SQL 层**过滤。`api/alerts.ts` **刻意不实例化 `MetricsSampler`**（避免运行时耦合）。**第二组另加**：`/rules` 只在 **viewer** 侧取（admin 不查注册表），`suppressed` 与 `rule.target` 用的是**同一份**可见集合 |
| 不可枚举 | `items` 不含不可见事件；`target` / `targetLabel`（服务名、容器名）连同 `message` 一起消失 |
| 计数同步下降 | `total` / `counts`（`open`·`resolved`·`unacknowledged`）/ `bySeverity` / `top` **全部**只统计可见集合 —— **计数本身就是存在性证据**（"未恢复从 3 掉到 2"等于告诉 viewer 少了一条什么） |
| 先过滤再分页 | `limit` 作用在可见集合上：首页不会被不可见事件占位，不出现"看得见的事件反而翻不到" |
| 不泄漏存在性 | 隐藏服务的事件与"**从未有可见服务**"的事件（如 `service:manual:<uuid>`）表现完全相同（都只是不出现），响应里没有任何区分字段 |
| 没有 404 / 403 | 读接口不因"你看不到某条事件"报错，只按可见集合少返回几行 |
| 不做角色特例 | admin 与 viewer 拿到同一套可见集合（与 §6.7 一致）：admin 打这两个接口也看不到 hidden 服务的事件；要"看全部"走管理接口（`PATCH /api/services/:id` 改可见性）。**注意范围**：这条只管**事件 / 快照类**读；**配置类**的 `GET /api/alerts/rules` 自第二组收口起**区分角色**（viewer 遮蔽 `rule.target`、admin 保留真值）—— 两套口径不要互相套用 |
| 宿主类不受影响 | `host` / `disk:<label>` 不属于任何服务 → 恒可见，字段与改动前逐字一致 |
| fail-closed | 可见集合不可得（注册表读失败 / 装配缺 `config`·`services`）→ **服务与容器类事件一律不可见**（不是"过滤不了就不过滤"），宿主类事件照常；读接口**不因此变 5xx**（少显示几条 ≠ 整个告警页打不开） |
| 隐藏 ≠ 删数据 | 库里的事件行**没被删、`resolved_at` 没被改**；恢复可见后同一事件（同 id / target / `firedAt`）原样回来 |
| 引擎语义不变 | 隐藏服务**不会**假恢复（"目标不在快照里 → 不动"是引擎既有语义）："库里仍未恢复、viewer 看不见"是有意的组合语义。运维含义是：**读响应里的未恢复列表不等于库里的未恢复故障全集**，排查要走管理侧 |

##### 第二组收口（提交 `470ac16`）：`suppressed` 按 target 求和 + `rule.target` 仅对 viewer 遮蔽

第一组（`871c3dc`）把 `/events` 与 `/summary` 的**事件快照与计数**在 **SQL 层**过滤（先过滤再 `LIMIT`）。
第二组关掉同一类泄漏的另外两处 —— 它们的载体不是事件行（一个是**数字**、一个是**规则配置行**），
所以第一组的写法套不上，**口径也不能互相套用**：

| 位置 | 收口前 | 收口后（本轮） |
| --- | --- | --- |
| `GET /api/alerts/summary` 的 `suppressed` | **引擎全局总数**：隐藏 / 已删除的服务每被压掉一次都让它涨 —— **数字本身就是存在性证据**（"有个你看不见的东西在反复失败"） | 引擎改为按 target **记账**（`AlertTickResult.suppressedByTarget` 必填 / `AlertEngine.suppressedByTarget()`），读路径用 `sumSuppressedVisible()` 按**当前**可见性求和：宿主自有（`host` / `disk:<label>`）恒计入，`service:` / `container:` 必须命中可见集合，可见集合不可得（`null`）→ **只计宿主自有（fail-closed）** |
| `GET /api/alerts/rules` 的 `rule.target` | 原样回显**隐藏 / 已删除服务**的名字（`service:<ref>` / `container:<ref>`），viewer 读一次规则列表就能把看不见的服务**枚举**出来 | **仅对 viewer 遮蔽成 `null`**；**admin 保留真值**。理由：规则是 admin 自己写的**配置**（不是触发快照），对**作者本人**遮蔽保护不了任何东西，只会让 `web/src/components/AlertRuleForm.tsx:163` 把空 target 渲染成"· 适用于全部目标"**对 admin 说假话**；该端点本就是 admin 可 PATCH / viewer 只读，角色分支与端点语义一致 |

**口径边界（代码注释已写明；两处不要互相套用）**：**事件 / 快照类**接口（`/events`、`/summary`、
`/api/metrics/*`）返回的是"触发时落库的快照"，对谁都只给当前可见的那几条 ⇒ **不分角色**；
**配置类**接口（`/rules`）返回的是 admin 自己写的配置 ⇒ **区分角色**（只在 viewer 侧遮蔽）。
两条口径不同是**有意的**，不是漂移。

**实现口径（照实记）**：`AlertsService.rules(visible, options)` 的 `options.maskServiceTargets`
**必填、无默认值** —— "给谁看"是裁定，默认值等于让某个调用方默认走某种口径，
而那正是"悄悄多显示一个服务"或"悄悄对 admin 说假话"的来源。**admin 分支不查注册表**
（传 `visible = null` 且根本不读它），免得白付一次 `registry.list`、还因注册表偶发不可用
记一条与他无关的 warn。遮蔽成 `null`（契约里既有的"未限定目标"取值）而**不引入第三种状态**：
`service:<hidden>` 之类等于直接承认"这里有一个你看不到的目标存在"。
`PATCH /rules/:id` 的响应**不遮蔽**（写路径，回显的是调用方自己刚提交的配置）。

**仍然未收口 / 待裁定（照实记）**：

| 位置 | 为什么留着 |
| --- | --- |
| `POST /api/alerts/events/:id/ack` 的**响应体** | admin 写路径，入参是调用方手上的随机 UUID 事件 ID；要拿到隐藏服务事件的 ID 得先有别的泄漏渠道。收口范围是**读**响应 |

**已知残留（照实记；本轮不修，代码注释已互相引用标注）**：`alerts/service.ts` 里同一件事
（"这个 target 算不算宿主自有"）有**两种形态、方向相反**的判据 —— SQL 形态 `HOST_OWNED_EVENT_SQL`
是**黑名单**（"不是 `service:` / `container:` 前缀就算宿主"），内存判据 `isHostOwnedAlertTarget`
是**白名单**（"就是 `host` 或 `disk:` 才算宿主自有"）。于是空串 / 未知前缀（`weird:secret`）
这类**手工脏行**：在事件列表里被**当宿主放出**，在 `suppressed` 计数与 `/rules` 的 target 上却被
**fail-closed 剔出 / 遮蔽**。两者都保守，但方向相反 ⇒ 同一批脏行在这几处的表现可能不一致。
要统一得先裁定"未知前缀到底算不算一个目标"。**本轮不改引擎判定**：`suppressed` 的计数与判定分支
一行未动，episode / 静默期 / `reopen_count` / duration 门控 / "目标不在快照 → 不假恢复" 均未触碰。

**顺带清理（同一提交）**：`AlertEngine.suppressedTotal()` 全仓零调用方 ⇒ **已删除**；
`AlertsService.recordTick(result)` 原先要求 `suppressed: number` 却完全忽略它（只传总数会**静默丢计数**）
⇒ 改为要求 `suppressedByTarget` 明细，误导签名现在**编译期**就被挡下。

**代价（同 §6.7）**：可见性不做任何缓存；`summary` 徽标每 60s 轮询会各多一次 `registry.list`
（内部走服务注册表既有的发现 / 容器 TTL 缓存，并发读由 single-flight 合并）。
**第二组新增的代价**：**viewer** 每次 `GET /api/alerts/rules` 同样多一次 `registry.list`；
**admin 侧不查注册表**（那条路径不读 `visible`），因此不付这份代价。

### `GET /api/alerts/rules`

→ `200`，**恰好只有 `items` 一个键**（服务层的 `rules()` 仍是裸数组，由路由包成 `{ items }`
—— 与 `/api/services`、`/api/alerts/events` 的列表写法保持一致）：

```json
{
  "items": [{
    "id": "rule-disk-percent", "kind": "disk_percent", "name": "磁盘使用率过高",
    "description": "任一磁盘使用率超过阈值并持续一段时间",
    "enabled": false, "threshold": 85, "durationSec": 600, "target": null,
    "silenceSec": 3600, "notifyRecovery": true,
    "severity": "warning", "builtin": true,
    "updatedAt": "2026-10-15T10:00:00.000Z"
  }]
}
```

每条规则**恰好 13 个字段**，且**不含 `createdAt`**（它是内部列，不进 HTTP 契约）。
`kind` ∈ `disk_percent` / `memory_percent` / `container_exit` / `service_health`；`severity` ∈ `warning` / `critical`。

> **`target` 的可见性口径（已裁定并落地，提交 `470ac16`；见 §6.9 开头）**：
> **仅对 viewer 遮蔽成 `null`，admin 保留真值**。它确实是管理员自己写的规则配置
> （`PATCH /rules/:id` 的入参、按 kind 校验过前缀），但里面写的是服务的**稳定身份**
> （`service:<ref>` / `container:<ref>`）—— 只按库里的行返回，viewer 靠规则列表就能把隐藏
> 或已删除的服务**枚举**出来，与事件快照是同一个泄漏面，只是载体从事件行换成规则行。
> 反向的顾虑（"遮蔽会让 viewer 看到与实际规则不一致的配置"）只在 **admin** 身上成立，
> 而 admin 本就可 PATCH 这个端点、也可经 `includeHidden` 管理接口看到隐藏服务 ——
> 对**作者本人**遮蔽保护不了任何东西，只会让 `AlertRuleForm.tsx:163` 把空 target 渲染成
> "· 适用于全部目标"**对 admin 说假话**。宿主类 target（`disk:<标签>` / `host`）与 `null`
> 在两种角色下都原样返回；响应形状（**13 个字段**）未变，遮蔽是**读时求值**（没动库里的配置，
> 恢复可见后原样回来）。

四条内置规则（`BUILTIN_ALERT_RULES`，`server/src/modules/alerts/rules.ts`；`target` 均为 `null`、
`notifyRecovery` 均为 `true`、`builtin` 均为 `true`、**默认 `enabled` 均为 `false`**）：

| id | kind | threshold | durationSec | silenceSec | severity |
| --- | --- | :-: | :-: | :-: | --- |
| `rule-disk-percent` | `disk_percent` | 85 | 600 | 3600 | `warning` |
| `rule-memory-percent` | `memory_percent` | 90 | 300 | 3600 | `warning` |
| `rule-container-exit` | `container_exit` | 0 | 0 | 3600 | `critical` |
| `rule-service-health` | `service_health` | 3 | 0 | 3600 | `critical` |

> **默认 `enabled: false` 是刻意的**（"装了但不吵"）：装了规则不等于开始告警，由管理员显式打开。
> 补齐发生在**装配期**（`ensureBuiltinRules()`，由 `app.ts` 调一次）而**不是迁移里的 INSERT**：
> 迁移只建结构，于是"迁移后新表为空"这条性质可验证；`GET` 也**不**顺手播种，
> 否则"接口一被调用表就有四条"会和迁移自检互相打脸。补齐是**幂等**的 ——
> 已存在的行（含管理员改过的阈值）一个字都不动（`server/tests/alertsApi.test.ts`）。

### `PATCH /api/alerts/rules/:id`

需 admin + CSRF。部分更新，只传要改的字段：

```json
{ "enabled": true, "threshold": 90, "durationSec": 600, "silenceSec": 3600,
  "notifyRecovery": true, "target": "disk:C:" }
```

| 字段 | 取值域 | 越界结果 |
| --- | --- | --- |
| `enabled` | boolean | 非布尔 → `400` |
| `threshold` | `disk_percent` / `memory_percent`：`(0, 100]`；`service_health`：`1..10` 整数；`container_exit`：**必须为 `0`** | 越界 / 传 `null` → `400`（`container_exit` 用 `0` 表示"非 0 退出码即触发"） |
| `durationSec` | `0..86400` 整数 | 越界 → `400` |
| `silenceSec` | `60..604800` 整数（60s ~ 7 天） | 越界 → `400` |
| `notifyRecovery` | boolean | 非布尔 → `400` |
| `target` | `null`，或与 `kind` 同源的形态：`disk:<label>` / `host` / `container:<sourceRef>` / `service:<sourceRef>` | 前缀不同源 / 含空白或控制字符 / 超 200 字符 / 空串 → `400`（清空请传 `null`） |

→ `200` + 更新后的 `AlertRuleView`（**无信封**，形状与 `items[]` 元素相同）。

- `id` / `kind` 不可改，也没有 `DELETE`：内置规则**不可删除**。未知字段 → `400`（zod `.strict()`）；
  空对象 → `400`（"至少提供一个待更新字段"）。
- 校验在**落库之前**完成：非法值直接 `400 VALIDATION_FAILED`，什么都不写 ——
  被悄悄截断的阈值（"我设了 200% 却变成 100%"）比报错危险得多。
- `target` 与 `kind` 必须同源，否则规则会永远匹配不到任何目标，那是**最难发现的"配了但不生效"**。
- 生效范围：只写门户**自己的数据库**（`alert_rules`），不会改容器、Compose 或 Tailscale 配置。
- **`notifyRecovery` 在 Sprint 2 不改变任何行为**：没有出站通道，它只被记进审计
  （"用户当初的意图"留档），等 Sprint 4 接通知渠道时才读它。字段现在就存在是为了不改契约。
- 审计：`alert.rule_updated`，`target = alert_rule:<id>`，`detail` 只放非敏感字段
  （改了哪几个字段 + 关键数值）。
- 错误：`400 VALIDATION_FAILED`（`fieldErrors.patch` 给出业务级原因）、`404 NOT_FOUND`、`403`（见上）。

### `GET /api/alerts/events`

查询参数（zod `.strict()`：**拼错参数直接 `400`，不静默忽略**）：

| 参数 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `state` | `all` / `open` / `resolved` | `all` | `open` = `resolved_at IS NULL`，`resolved` = 已恢复 |
| `limit` | `1..200` 整数 | `50` | 越界 / 非数字 → `400`（不是"按 200 处理"） |

→ `200`
```json
{
  "items": [{
    "id": "alert-…", "ruleId": "rule-disk-percent", "kind": "disk_percent",
    "ruleName": "磁盘使用率过高", "target": "disk:C:", "targetLabel": "C:",
    "severity": "warning", "state": "open", "value": 91.2, "threshold": 85, "unit": "percent",
    "message": "磁盘 C: 使用率 91.2%（阈值 85%，已持续 12 分钟）",
    "startedAt": "…", "firedAt": "…", "resolvedAt": null, "reopenCount": 0,
    "acknowledgedAt": null, "acknowledgedBy": null
  }],
  "total": 1,
  "counts": { "open": 1, "resolved": 4, "unacknowledged": 1 }
}
```

- 排序：`fired_at` **倒序**（`created_at` 倒序作同刻兜底）。
- `total` 与 `counts` 都是**当前可见集合内的全量**统计（**不是整张表**），
  且**不受 `limit` 截断、也不受 `state` 过滤影响**：徽标要的是"现在有多少未确认"，
  不是"这一页里有多少未确认"。`unacknowledged` = 未恢复**且**未确认；`resolved` 也照样计入。
  **可见性是它们的第三个维度**（见上文"读路径的可见性语义"）：隐藏服务的未恢复事件
  既不在 `items` 里，也不计进 `open` / `unacknowledged` —— 否则数字本身就承认了
  "有一条你看不见的告警"。
- `items[].target` / `targetLabel` / `message` 是**触发时**的快照，读时按**当前**可见性过滤；
  隐藏/删除服务的事件与"从未有可见服务"的事件一样只是不出现（**没有** 404/403、也没有任何标记字段）。
  宿主类（`host` / `disk:*`）事件不受影响。
- `limit` 作用在**过滤之后**：不可见事件不占页位（夹具里最新的一条恰是服务事件，
  隐藏后 `limit=1` 仍必须返回最新那条**可见**事件，`total` 也照旧是可见集合的全量）。
- `state` 过滤同样只在可见集合内生效（`?state=resolved` 只返回**可见的**已恢复事件）。
- `state` 由 `resolvedAt` 派生（`null` → `open`），是事件的**当前**状态，不是列表快照。
- 事件是 **episode 模型**：同一 `(rule, target)` 在未恢复期间最多一行；静默期内再次成立是**重开这一行**
  （`reopenCount++`、`firedAt` 更新、重新变回 `open`），而不是新增一行。

### `POST /api/alerts/events/:id/ack`

需 admin + CSRF。无请求体。→ `200` + 确认后的 `AlertEventView`（**无信封**）。

- **已恢复的事件也能确认**（"我看到了这条历史"是合法需求）。
- **幂等**：重复确认不改时间、不再写审计 —— 事先的"确认"没有新的信息量，
  若每次都刷新 `acknowledged_at`，"谁在什么时候先看到的"这个信息就丢了。
- 审计：`alert.acknowledged`，`target = alert_event:<id>`。
- **响应体仍未按可见性过滤（未收口，照实保留）**：这是 admin 写路径，入参是调用方手上的随机 UUID
  事件 ID，收口范围是读响应（`/events`、`/summary`、`/rules`）。见 §6.9 开头"仍然未收口 / 待裁定"。
- 错误：`404 NOT_FOUND`（未知事件 ID）。

### `GET /api/alerts/summary`

→ `200`，聚合对象（不是列表，直接返回对象本身）：
```json
{
  "open": 2, "unacknowledged": 1,
  "suppressed": 3,
  "bySeverity": { "warning": 1, "critical": 1 },
  "top": [{ "id": "alert-…", "ruleName": "磁盘使用率过高", "targetLabel": "C:",
            "severity": "warning", "firedAt": "2026-10-15T09:00:00.000Z" }],
  "evaluatedAt": "2026-10-15T10:00:00.000Z"
}
```

- `top` **最多 5 条**，只含**未恢复**事件，且是精简形状（只有这 5 个字段）：
  已解决的事件不该在"需要关注"里占位，徽标也不需要每条事件的完整消息
  （那会让每次轮询多传几 KB）。排序：`critical` 优先 → `fired_at` 倒序。
- `bySeverity` 只统计**未恢复**且**可见**的事件；`warning` 桶的口径是 `severity <> 'critical'`
  （非 critical 全归 warning），因此 `bySeverity.warning + bySeverity.critical = open`。
- `open` / `unacknowledged` / `bySeverity` / `top` / **`suppressed`** 全部按当前可见性过滤
  （与 `/events` 同一套口径）：隐藏服务的事件不计入任何一个数字，`top` 里也不会出现它的 `targetLabel`。
- `suppressed` **按 target 明细 + 当前可见性求和**（第二组收口，提交 `470ac16`）：宿主自有
  （`host` / `disk:<label>`）恒计入，`service:` / `container:` 必须命中可见集合，可见集合不可得（`null`）
  → **只计宿主自有（fail-closed）**。理由与"四个计数一起过滤"完全相同：
  **数字的涨落本身也是存在性证据**（"有个你看不见的东西在反复失败"）。
  一个**总数**没有归因，也就没法过滤 —— 所以引擎与服务层各自只保留按 target 的明细，读路径现算。
- `evaluatedAt` 是**上次告警引擎 tick 的时间**，引擎还没 tick 过时为 `null`
  （不是"现在"—— 它表示这份结论有多新）。它不指向任何目标，因此**没有可见性语义**，
  两种角色拿到同一个值。
- `suppressed` 是"自进程启动以来，因同一 `(rule, target)` **已有未恢复行**而未产生新通知的触发次数"（累计值）。
  **它只在那个时刻加 1**：静默期内条件再次成立是**重开**旧行，计进引擎 tick 结果的 `reopened`，
  **不算 `suppressed`**。它的唯一来源是引擎的**按 target 明细** `AlertEngine.suppressedByTarget()`
  （`suppressedTotal()` **已删除** —— 全仓零调用方，且一个没有归因的数字没法按可见性过滤），
  由 `composeAlertSummary(summary, engine, visible)` 用 `sumSuppressedVisible()` 求和后覆盖进响应；
  装配方没接引擎时退回服务层自己按 target 记的那份账（同样是明细 + 按可见性求和；
  装配期没人调 `recordTick` 时就是 `0` / `null`）
  —— **不做 `Math.max` 之类的"折中"，一个数只能有一个来源**。
  这个字段存在的唯一理由：让"没有告警"这件事可解释 —— 是被静默压掉了，还是条件根本没成立。
- `AlertsService.recordTick(result)` 现在**只收** `{ at, suppressedByTarget }`，**刻意不收** `suppressed`
  总数：收一个不参与记账的数，只会让调用方以为"传总数也行"，而那正是**静默丢计数**
  （数字看着在动，viewer 的 `suppressed` 却纹丝不动）。只想记评估时间、不涉及计数时用 `recordEvaluatedAt()`。

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
| `/api/metrics/*`（GET）、`/api/health/monitor`（GET）、`/api/alerts/{rules,events,summary}`（GET） | ❌ | ✅ | ✅ |
| `PATCH /api/alerts/rules/:id`、`POST /api/alerts/events/:id/ack` | ❌ | ❌ | ✅ |
| `/api/users/me*` | ❌ | ✅ | ✅ |
| `/api/users` 及 `/api/users/:id*` | ❌ | ❌ | ✅ |
| `/api/settings` 及 `/api/settings/*` | ❌ | ❌ | ✅ |

## 10. 变更记录

接口的任何变动必须同步更新本文件，并在 [09-changelog.md](./09-changelog.md) 记录。

- **告警读接口可见性收口（同类泄漏第三处，两组）**：**无新增接口、无新增错误码、无字段改名**。
  ①第一组（`871c3dc`）：`GET /api/alerts/events` 的 `items` / `total` / `counts` 与
  `GET /api/alerts/summary` 的 `open` / `unacknowledged` / `bySeverity` / `top` 一律只统计
  **当前可见**服务的事件（共享 `modules/visibility/serviceVisibility.ts`，与 `/api/metrics/*`
  同一口径、**无 admin 特例**、读不到可见集合时 **fail-closed**）；`limit` 由"先截断"改为作用在过滤之后。
  宿主类（`host` / `disk:*`）事件不变；隐藏不是删数据（恢复可见后原样回来）。
  ②第二组（`470ac16`）：`summary.suppressed` 改为**按 target 明细 + 当前可见性求和**
  （宿主自有恒计入、服务类需命中可见集合、可见集合不可得 → 只计宿主自有，fail-closed）；
  `GET /api/alerts/rules` 的 `rule.target` **仅对 viewer 遮蔽成 `null`**、**admin 保留真值**
  —— **配置类接口区分角色，事件 / 快照类接口不分角色**，两套口径不要互相套用。
  **仍然未收口**：`POST /api/alerts/events/:id/ack` 的响应体**不**按可见性过滤。详见 §6.9。

- **S2-01…S2-04（历史指标、健康监测、告警）**：新增 **9 个接口**，契约见 §6.7 / §6.8 / §6.9 ——
  `GET /api/metrics/catalog`、`GET /api/metrics/history`、`GET /api/metrics/storage`、
  `GET /api/health/monitor`、`GET /api/alerts/rules`、`PATCH /api/alerts/rules/:id`、
  `GET /api/alerts/events`、`POST /api/alerts/events/:id/ack`、`GET /api/alerts/summary`。
  `/api/metrics`、`/api/alerts`、`/api/health/monitor` 已加入 `PROTECTED_PREFIXES`
  （前缀守卫 = 登录 + CSRF），两个写接口在 handler 内再 `assertAdmin`。
  **未新增错误码**：沿用既有 `VALIDATION_FAILED` / `NOT_FOUND` / `FORBIDDEN` / `CSRF_MISMATCH`，
  并首次把 `UPSTREAM_UNAVAILABLE`(503) 用于"健康监视器未装配"这类接线缺口（§6.8）。
  外层形状上的两处**冻结**：`GET /api/alerts/rules` **恰好是 `{ items }`**（不是裸数组，每条 13 字段、
  不含 `createdAt`），其余新接口**都不带信封**；`GET /api/alerts/events` 的 `counts` 是**全量**计数，
  不受 `limit` / `state` 影响。缺测语义也在这里定死：空窗口的 `summary` 只有 `count: 0`，
  `min/max/avg/latest/latestAt` 全为 `null`（`0` 不是"没有数据"的合法表示）。
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
