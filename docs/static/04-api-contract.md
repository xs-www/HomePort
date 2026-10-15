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
  "user": { "id": 1, "username": "admin", "displayName": "管理员", "role": "admin" },
  "expiresAt": "2026-03-01T12:00:00.000Z"
}
```
未登录时 `authenticated=false`、`user=null`（`csrfToken` 仍下发，供登录请求使用 —— 登录接口是唯一豁免 CSRF 的变更接口）。

### `POST /api/auth/login`
无需登录、豁免 CSRF、限流 10/min/IP。
```json
{ "username": "admin", "password": "••••••", "remember": true }
```
→ `200 { "user": {...}, "csrfToken": "..." }`（同时 `Set-Cookie`）
错误：`INVALID_CREDENTIALS` / `SETUP_REQUIRED` / `RATE_LIMITED`

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

## 7. 用户与偏好

### `GET /api/users/me`
需登录。`{ "user": {...}, "preferences": { "theme": "dark", "defaultPage": "overview", "density": "comfortable" } }`

### `PATCH /api/users/me/preferences`
需登录。`{ "theme"?: "dark|light|system", "defaultPage"?: string, "density"?: "comfortable|compact" }` → `200`

### `GET /api/users` （admin）
`{ "items": [{ "id":1, "username":"admin", "displayName":"管理员", "role":"admin", "createdAt":"...", "lastLoginAt":"..." }], "total": 1 }`

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
| `/api/auth/session`、`login`、`bootstrap` | ✅ | ✅ | ✅ |
| `/api/auth/logout`、`/api/auth/password` | ❌ | ✅ | ✅ |
| `/api/overview`、`/api/containers*`、`/api/tailscale/*`、`/api/system/*`、`/api/tools*` | ❌ | ✅ | ✅ |
| `/api/users/me*` | ❌ | ✅ | ✅ |
| `/api/users` 及 `/api/users/:id*` | ❌ | ❌ | ✅ |
| `/api/settings` 及 `/api/settings/*` | ❌ | ❌ | ✅ |

## 10. 变更记录

接口的任何变动必须同步更新本文件，并在 [09-changelog.md](./09-changelog.md) 记录。
