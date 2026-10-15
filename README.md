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

门户展示的是**宿主**资源，但它跑在容器里，两者可见范围不同。以下是**实测结论**：

| 部署方式 | CPU / 内存 | 磁盘 | GPU |
| --- | --- | --- | --- |
| **容器化 · Linux / NAS** | 宿主 `/proc` → **真实值** | 真实值 | 挂 `nvidia-smi` → 真实值 |
| **容器化 · Windows** | ⚠ **只有 WSL2 虚拟机的资源**（实测 4 线程 / 3.9 GB，宿主其实是 20 线程 / 31.6 GB） | 挂 `C:/` → **真实值**（实测 952 GB，与资源管理器一致） | ❌ 容器内不可用 |
| **原生运行 · Windows** | `os` 接口 → **真实值**（实测 20 线程 / 31.63 GB，与任务管理器一致） | 需配 `PORTAL_DISK_MOUNTS` | ✅ 真实值 |

**Windows 容器化拿不到宿主 CPU/内存**，原因是 Docker Desktop 把容器跑在 WSL2 虚拟机里，
容器只能看到这个虚拟机的 4 线程 / 4 GB。我实测确认：**挂载 WSL 的 `/proc` 也没用**
（它和 `os.cpus()` 是同一个来源，都报 4 线程）。

想在 Windows 上拿到真实硬件数据，两条路：

1. **原生运行**（推荐）：`npm run build` 后直接 `node server/dist/index.js`。
   实测 20 线程 / 31.63 GB / `nvidia-smi` 可读，全部为真实值。
   此时 `DOCKER_ENDPOINT` 需用 npipe 写法。
2. **调大 WSL2 配额**：编辑 `%USERPROFILE%\.wslconfig` 设 `processors` 与 `memory`，
   再 `wsl --shutdown`。但这仍只是让虚拟机视图更接近宿主，**不是** Windows 真实占用。

GPU 同理：Docker Desktop 的容器内看不到 `/usr/lib/wsl/lib`，也无法执行
`nvidia-smi.exe`（Linux 容器跑不了 Windows 可执行文件），因此报"不可用"是正确行为。
需要 GPU 指标请用原生运行。

界面上每张卡片都会标注数据源（如"宿主 /proc（真实值）"或"容器视图（受 cgroup 限制）"）。
**看到黄色提示条说明取数降级了，不是服务坏了** —— 提示条里会写清原因。
详见 [docs/static/08-operations.md](docs/static/08-operations.md) §2。

## 平台配置要点

### Windows 11 + Docker Desktop

```dotenv
# 容器内必须是 unix socket！Docker Desktop 会把 named pipe 转发成 /var/run/docker.sock
DOCKER_ENDPOINT=unix:///var/run/docker.sock
DOCKER_SOCKET=//var/run/docker.sock
PORTAL_DISK_MOUNTS=C:=/host/disk/C
PORTAL_TAILSCALE_MODE=api
PORTAL_TAILSCALE_API_TOKEN=tskey-api-xxxxxxxx
```

compose 的 volume 里盘符**必须**写成 `"C:/:/host/disk/C:ro"`（写成 `C:` 会被当相对路径）。

不要加 `/proc:/host/proc:ro` —— 挂进来的是 WSL2 虚拟机视图，与任务管理器对不上。

两个实测踩到的坑：

- **在容器里写 `npipe://` 会报 ENOENT**。npipe 只适用于"在 Windows 上原生跑 Node"。
- **盘符 `C:` 不加引号和斜杠会被解析成 `<项目目录>/C:`**，导致挂载失败。

Windows 上容器内执行不了 `tailscale.exe`，所以 tailnet 查询必须用 API 模式
（Tailscale 管理后台 → Settings → Keys，只读 scope 即可）。

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

## 在界面里改配置（不用重建容器）

很多配置项可以直接在**账号管理 → 系统设置**里改，保存后立即生效：

| 能立即改 | 说明 |
| --- | --- |
| **tailnet API Token / 模式** | 粘贴 Token → 点「测试连接」验证 → 保存。数据源自动重建，设备页立即有数据 |
| **Docker 引擎地址** | 保存后重建连接 |
| **缓存 TTL / 各类超时 / 指标推送间隔** | 调大降低宿主压力，调小更新更快 |
| **工具端口与追加项** | 改完立刻出现在工具页 |
| **磁盘挂载点（显示层面）** | 改显示哪些、怎么标注 |

优先级是 **界面设置 > `.env` > 内置默认**。没在界面改过的项完全不受影响，
继续按 `.env` 生效；界面里可随时「恢复默认」。

### 但有些东西界面改不了（这是容器架构的硬边界）

**端口映射、数据卷、新增磁盘挂载路径、HTTPS Cookie** 等属于容器创建参数，
任何网页界面都改不了 —— 必须编辑 `docker-compose.yml` 后 `docker compose up -d`。
界面里这些项**不提供编辑控件**，只展示当前值并说明原因，不会让你白改一遍。

> 磁盘挂载点是"半自动"：能改显示与标注，但路径本身必须已经挂进容器。

## 拿到 tailnet API Token

Tailscale 的 API Token 需要在管理后台自己生成（Windows 容器化部署必须用它，
因为容器是 Linux 环境、执行不了 `tailscale.exe`）：

1. 打开 **https://login.tailscale.com/admin/settings/keys**
2. 在 **Keys** 区块点 **Generate access token…**（不是 auth key）
3. 有效期按需选（这是只读查询，90 天够用），**立刻复制** —— 只显示一次
4. 回到门户 →「账号管理 → 系统设置 → tailnet 数据源」→ 粘贴 → **点「测试连接」**
   → 显示"连通，读到 N 台设备"后再**保存**

因为可以"先测再存"，即使 Token 抄错了也不会污染配置，测试结果会直接告诉你原因
（401 = Token 无效/过期；403 = 权限不足需检查 ACL；超时 = 容器访问不了外网）。

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

### 可用性是怎么判定的

门户跑在容器里，而容器内的 `localhost` 指向**容器自己**，不是宿主。
所以探测会按顺序尝试三个目标，任一成功即判为"可用"：

```
门户对外主机名  →  host.docker.internal  →  127.0.0.1
```

命中兜底目标时，工具卡片上的 `detail` 会写明"经 xxx 探测"，
并显示一个「探测目标 xxx」徽标 —— 避免"端口通但入口链接打不开"这类问题变成一个说不清的红点。

实测案例：本机 DSH 监听 `3080`，容器内只有 `host.docker.internal:3080` 可达
（`127.0.0.1` 与 tailnet IP 都不通），兜底链覆盖后正确判为"可用 · 4 ms"。
`docker-compose.yml` 已带 `extra_hosts: host.docker.internal:host-gateway`，
Linux/NAS 上该域名才会解析。

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

1. **Windows 容器化部署下，CPU/内存只有 WSL2 虚拟机的数（4 线程 / 3.9 GB）**，
   与宿主（20 线程 / 31.6 GB）不符；GPU 也不可用。需要真实硬件数据请原生运行。
2. Windows 上 tailnet 查询需用 API 模式（容器内无法执行 Windows 可执行文件）。
3. 未做 TOTP 二次验证，未设置 CSP/HSTS 等安全响应头。
4. 不提供容器写操作（有意的产品边界）。
5. arm64（NAS）镜像构建尚未实测。

详见 [todo.md](todo.md)。
