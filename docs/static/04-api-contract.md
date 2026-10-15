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
    "health": "healthy",
    "stats": { "cpuPercent": 0.4, "memUsedBytes": 1, "memLimitBytes": 2 }
  }],
  "total": 5,
  "summary": { "total": 5, "running": 5, "tailnetReachable": 2, "localhostOnly": 1, "stopped": 0 },
  "source": { "available": true, "mode": "socket", "detail": null }
}
```
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

## 8. 权限矩阵

| 接口 | 匿名 | viewer | admin |
| --- | :-: | :-: | :-: |
| `/api/health` | ✅ | ✅ | ✅ |
| `/api/auth/session`、`login`、`bootstrap` | ✅ | ✅ | ✅ |
| `/api/auth/logout`、`/api/auth/password` | ❌ | ✅ | ✅ |
| `/api/overview`、`/api/containers*`、`/api/tailscale/*`、`/api/system/*`、`/api/tools*` | ❌ | ✅ | ✅ |
| `/api/users/me*` | ❌ | ✅ | ✅ |
| `/api/users` 及 `/api/users/:id*` | ❌ | ❌ | ✅ |

## 9. 变更记录

接口的任何变动必须同步更新本文件，并在 [09-changelog.md](./09-changelog.md) 记录。
