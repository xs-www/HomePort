# HomePage · Tailnet 动态门户

跑在 Docker 里的**本机控制面板**。把宿主机上所有可经 tailnet 访问的容器、tailnet 设备在线状态、
宿主 CPU/内存/磁盘/GPU 占用，以及 Ollama / DSH / ComfyUI 等本机工具，聚合成一个带登录权限管理的入口页。

> **只读设计**：门户不提供容器启停/删除等写操作。它能看到宿主机的一切，因此故意把权限收窄到"展示 + 跳转"。

---

## 功能

| | 能力 | 说明 |
| --- | --- | --- |
| **F1** | 容器入口墙 | 列出本机全部容器，**自动判定是否可经 tailnet 访问**，给出可直接点击的入口；仅绑定 `127.0.0.1` 的容器会明确标注"仅本机"并说明原因 |
| **F2** | tailnet 设备状态 | 设备列表、在线/离线、OS、tailnet IP、直连或中继、最后可见时间 |
| **F3** | 宿主资源占用 | CPU（含各核心）、内存、磁盘、GPU（含占用显存的进程），SSE 实时推送 |
| **F4** | 本机工具入口 | Ollama / DSH / ComfyUI / Open WebUI / Portainer / Jellyfin 等，带 TCP+HTTP 可用性探测与多候选入口 |
| **F5** | 登录权限管理 | 本地账号、admin/viewer 角色、会话持久化、首启管理员初始化、审计日志 |

## 快速开始

```bash
# 1) 配置（最小可用配置就是空文件）
cp .env.example .env          # Windows: Copy-Item .env.example .env

# 2) 一键启动
docker compose up -d --build

# 3) 取首启令牌
docker compose logs homepage | grep 初始化令牌            # Linux/NAS
docker compose logs homepage | Select-String 初始化令牌    # Windows

# 4) 打开（把 IP 换成你宿主的 tailnet IP 或 MagicDNS 名）
#    http://100.x.y.z:8899
```

首次打开会引导你创建管理员账号（需要上面那个令牌）。令牌也可从
容器内 `/data/setup-token.txt` 读取。

### 本机开发

```bash
npm install

# 后端（:8899）——需要 Node 22+
npm run dev

# 前端（:5273，/api 自动代理到 8899）
npm run dev:web

# 测试与类型检查
npm test
npm run typecheck
```

Windows 本机开发时设置 `DOCKER_ENDPOINT=npipe:////./pipe/dockerDesktopLinuxEngine`。
若在 Windows 上直接跑 Node（不是容器内），无需任何挂载即可读真实硬件数据。

## 判定"tailnet 可达"的逻辑

这是 F1 的核心。门户读取每个容器在宿主上的**实际端口绑定地址**：

| 绑定地址 | 判定 | 是否给可点击入口 |
| --- | --- | --- |
| `0.0.0.0` / `::`（未指定） | tailnet 可达 | ✅ 用 tailnet IP / MagicDNS |
| 具体 tailnet IP（`100.64.0.0/10`、`fd7a:…`） | tailnet 可达 | ✅ 用该 IP |
| 宿主局域网 IP | 仅局域网 | ✅ 用该 IP |
| `127.0.0.1` / `::1` | **仅本机** | ❌ 标注"需 SSH 隧道或改绑定地址" |
| 未发布到宿主 | 无入口 | ❌ 标注"仅在容器网络内可见" |

容器卡片上会显示判定结果与依据，避免"点了打不开"的困惑。
每个可达端口还会给出**多个候选入口**（tailnet IP / MagicDNS / localhost），
方便你在不同网络环境下切换。

## 指标为什么可能不准

门户跑在容器里，展示的却是宿主资源，这个差异必须说明白：

| 宿主 | CPU / 内存 | 磁盘 / GPU |
| --- | --- | --- |
| **Linux / NAS** | 挂载宿主 `/proc` → **真实值** | 真实值 |
| **Windows** | 走 Node 的 `os` 接口 → **Windows 宿主真实值**（任务管理器可对照） | 真实值 |

界面上每张卡片都会标注数据源（如"宿主 /proc（真实值）"或"容器视图"）。
**看到黄色提示条说明取数降级了，不是服务坏了** —— 提示条里会写清原因。

若你在 Windows 的 Docker Desktop 里挂载了 `/proc`，读到的是 **WSL2 虚拟机**的占用，
与任务管理器对不上。此时请**不要**挂 `/proc`，让门户走 `os` 接口路径。
详见 [docs/static/08-operations.md](docs/static/08-operations.md)。

## 平台配置要点

### Windows 11 + Docker Desktop

```dotenv
DOCKER_ENDPOINT=npipe:////./pipe/dockerDesktopLinuxEngine
DOCKER_SOCKET=//var/run/docker.sock
PORTAL_TAILSCALE_MODE=api
PORTAL_TAILSCALE_API_TOKEN=tskey-api-xxxxxxxx
PORTAL_DISK_MOUNTS=C:=/host/disk/C
```

- 容器内**无法执行** Windows 可执行文件，所以 tailnet 查询请用 API 模式
  （Tailscale 管理后台 → Settings → Keys，只读 scope 即可）。
- compose 里请注释掉 `/proc:/host/proc:ro`（原因见上一节）。
- GPU 经 WSL 直通可用：挂 `/usr/lib/wsl/lib/nvidia-smi` 并设
  `PORTAL_NVIDIA_LD_LIBRARY_PATH=/usr/lib/wsl/lib`。

### NAS（Synology / QNAP / TrueNAS）

```dotenv
DOCKER_ENDPOINT=unix:///var/run/docker.sock
DOCKER_GID=998
PORTAL_HOST_PROC=/host/proc
PORTAL_DISK_MOUNTS=/volume1=/host/volume1,/volume2=/host/volume2
PORTAL_TAILSCALE_MODE=cli
PORTAL_TAILSCALE_BIN=/usr/local/bin/tailscale
```

群晖若报 `EACCES`，把 `DOCKER_GID` 设为实际 docker 组 ID（常见 `998`）。
Tailscale 在群晖上多以套件安装，路径通常是
`/var/packages/Tailscale/target/bin/tailscale`，挂载时用实际路径，或直接用 API 模式。

完整配置项与部署矩阵见 [docs/static/02-configuration.md](docs/static/02-configuration.md)
与 [docs/static/08-operations.md](docs/static/08-operations.md)。

## 添加工具入口

两种方式，无需改代码：

```bash
# 方式一：环境变量快速追加（id:名称:端口）
PORTAL_TOOLS_EXTRA=jellyfin:Jellyfin:8096,immich:Immich:2283

# 方式二：挂一份 JSON（可覆盖内置工具的任意字段）
# PORTAL_TOOLS_FILE=/config/tools.json
```

`tools.json` 示例：

```json
{
  "replace": false,
  "tools": [
    { "id": "jellyfin", "name": "Jellyfin", "port": 8096, "category": "media",
      "probePath": "/health", "deepLinkPath": "/web/", "featured": true },
    { "id": "ollama", "port": 11435 }
  ]
}
```

## 安全

- 密码：bcrypt cost 12；最少 10 位且至少两类字符。
- 会话：256 位随机令牌，DB **只存 SHA-256 摘要**，Cookie `HttpOnly; SameSite=Lax`。
- CSRF：独立令牌 + 请求头校验，变更类请求全部强制。
- 防护：登录限流 10 次/分钟/IP；用户枚举防护（统一报错 + 耗时抹平）。
- 脱敏：容器环境变量与日志里的密钥在**服务端**就替换为 `***`。
- 不变量：系统始终保留至少一个启用状态的管理员。

> **最大风险点**：挂载 `docker.sock` 意味着门户进程拥有等价于宿主机 root 的能力。
> 因此本门户刻意只做只读展示、以非 root 用户运行、并强制登录。
> 如需进一步收敛，可换成只读 socket 代理（如 `docker-socket-proxy` 仅放行 GET）。
> 完整威胁模型与残余风险见 [docs/static/06-security.md](docs/static/06-security.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | Node.js 22 · TypeScript · Fastify 5 · dockerode · better-sqlite3 · zod |
| 前端 | React 19 · Vite 6 · TypeScript · Tailwind CSS 4 · React Router 7 |
| 打包 | 四阶段 Dockerfile（alpine，非 root，tini） |
| 测试 | Vitest（129 个用例） |

架构与逐函数说明见 [docs/static/](docs/static/README.md)。

## 文档

**使用者**：[README.md](README.md)（本文件）· [配置参考](docs/static/02-configuration.md) · [运维手册](docs/static/08-operations.md)

**开发**：[架构总览](docs/static/01-architecture.md) · [后端逐函数](docs/static/03-server-modules.md) ·
[接口契约](docs/static/04-api-contract.md) · [前端模块](docs/static/05-web-modules.md) ·
[数据模型](docs/static/07-data-model.md) · [安全模型](docs/static/06-security.md) ·
[变更记录](docs/static/09-changelog.md)

## 已知限制

1. Windows 上 tailnet 查询需用 API 模式（容器内无法执行 Windows 可执行文件）。
2. 未做 TOTP 二次验证，未设置 CSP/HSTS 等安全响应头。
3. 不提供容器写操作（有意的产品边界）。
4. 镜像构建与 arm64 部署尚未实测。

详见 [todo.md](todo.md)。
