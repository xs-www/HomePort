# 01 · 架构总览

## 1. 目标与边界

**目标**：部署在 Docker 内的动态门户网站，作为部署在 Windows（初代测试环境）或 NAS（最终部署目标）上的控制面板。

**功能范围（v1）**

| 编号 | 功能 | 说明 |
| --- | --- | --- |
| F1 | 容器入口墙 | 展示本机所有 **可经 tailnet 访问** 的 Docker 容器，给出可直接点击的访问入口 |
| F2 | tailnet 设备状态 | 查询当前 tailnet 账号下的设备列表、在线状态、OS、tailnet IP、最后握手时间 |
| F3 | 宿主资源占用 | CPU / GPU / 内存 / 硬盘 占用查询，含实时推送 |
| F4 | 本机工具入口 | Ollama、DSH、ComfyUI 等工具的入口、可用性探测、模型/队列等可选深度信息 |
| F5 | 登录权限管理 | 本地账号 + 角色（admin/viewer）+ 会话持久化 + 首次启动管理员初始化 |

**明确不做（v1 边界）**

- 不提供容器**写操作**（start/stop/restart/remove）。只读展示 + 入口跳转。决策见 `09-changelog.md` 记录。
- 不做反向代理来"内嵌"其它 Web 应用（v1 只给出**入口链接**，方案见 §6）。
- 不做 Tailscale ACL / OAuth 免密登录。

## 2. 部署形态

```
┌──────────────────────── 宿主（Windows 11 / NAS Linux） ────────────────────────┐
│                                                                                │
│   tailscaled ──> tailnet (100.x.x.x / MagicDNS)                                │
│                                                                                │
│   Docker Engine ──┬── 业务容器 A (0.0.0.0:8080->80)   ← tailnet 可达            │
│                   ├── 业务容器 B (127.0.0.1:4173->8080) ← 仅宿主本地可达         │
│                   └── 业务容器 C (ts-sidecar)          ← 经 tailscale serve 暴露 │
│                                                                                │
│   宿主服务：Ollama(11434) / DSH(3080) / ComfyUI(8188) ...                       │
│                                                                                │
│   ┌─────────────── homepage-portal 容器（本门户，唯一新增容器） ───────────────┐  │
│   │  Node.js 22 + Fastify  :  API + 静态前端                                │  │
│   │  ├─ /var/run/docker.sock  (ro)     → 容器清单/端口/网络                  │  │
│   │  ├─ 宿主 /proc 挂载      (ro)      → CPU/内存 真实占用（Linux 宿主）      │  │
│   │  ├─ 宿主磁盘路径         (ro)      → 磁盘占用                            │  │
│   │  ├─ nvidia-smi 挂载      (ro)      → GPU 占用（可选）                    │  │
│   │  └─ tailscale 可执行       (ro)      → tailnet 设备状态                   │  │
│   │  SQLite (data/ 卷持久化) → 用户 / 会话 / 偏好 / 审计                     │  │
│   └────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**关键点**：门户自身只暴露一个端口（默认 `8899`），通过宿主端口映射与 tailnet 打通。所有被监控对象都是**同宿主的邻居**，因此门户必须能拿到宿主视角的信息 —— 这是全部挂载点存在的原因。

> **实测修正（2026-10-16）**：上图列出的挂载点在 Linux/NAS 上确实提供宿主真实值，
> 但在 **Windows + Docker Desktop** 上有两个例外，已实测确认并更正文档：
> 1. **`/proc` 挂载对 Windows 容器化无意义** —— Docker Desktop 把容器跑在 WSL2 虚拟机里，
>    容器内挂载的 `/proc` 与 `os.cpus()` 是同一来源，都只报 4 线程 / 3.9 GB，
>    而宿主是 20 线程 / 31.6 GB。要拿 Windows 真实值只能**原生运行**门户。
> 2. **GPU 在 Windows 容器化下不可用** —— `/usr/lib/wsl/lib` 不被容器看到，
>    且 Linux 容器无法执行 `nvidia-smi.exe`。
>
> 因此容器化部署在 Windows 上的定位是"**容器入口 + 磁盘 + tailnet**"，
> 硬件指标以 Linux/NAS 为准。详见 `08-operations.md` §2。

## 3. 代码组织

```
HomePage/
├── docs/static/              # 静态函数文档（本目录）
├── server/                   # 后端 workspace @homepage/server
│   ├── src/
│   │   ├── index.ts               # 进程入口：装配 app 并监听
│   │   ├── app.ts                 # Fastify 实例装配（插件/路由/错误处理）
│   │   ├── config.ts              # 环境变量 → 强类型配置
│   │   ├── logger.ts              # 结构化日志
│   │   ├── db/                    # SQLite 连接 + 迁移 + 仓储
│   │   ├── http/                  # 通用 HTTP 层：错误、鉴权钩子、SSE
│   │   ├── modules/
│   │   │   ├── auth/              # F5 账号、会话、bootstrap
│   │   │   ├── users/             # F5 用户与偏好管理
│   │   │   ├── docker/            # F1 容器数据源
│   │   │   ├── tailscale/         # F2 设备数据源
│   │   │   ├── system/            # F3 指标数据源
│   │   │   ├── tools/             # F4 工具目录与探测
│   │   │   └── overview/          # 首页聚合
│   │   ├── routes/                # 路由注册（薄层，仅做校验 + 调用 module）
│   │   └── util/                  # net/format/cache/proc 等纯函数
│   └── tests/                     # vitest 单测
├── web/                      # 前端 workspace @homepage/web（React + Vite + Tailwind）
│   └── src/
│       ├── main.tsx / App.tsx     # 入口与路由
│       ├── api/                   # 类型化 API 客户端
│       ├── auth/                  # 会话上下文与守卫
│       ├── layout/                # 侧边栏/顶栏布局
│       ├── components/            # 可复用 UI 原子
│       └── pages/                 # 页面
├── deploy/                   # nginx/系统配置模板、clash 无关的部署辅助
├── tools-catalog.json        # 可选：自定义工具目录（挂载进容器）
├── docker-compose.yml        # 一键启动
├── Dockerfile                # 多阶段构建（web → server → runtime）
├── .env.example              # 全部可配置项样例
└── README.md                 # 面向使用者的说明
```

**分层铁律**

1. `routes/` 只做 **校验 → 调用 module → 返回**，不写业务逻辑。
2. `modules/*/service.ts` 是业务出口，**只依赖** `db/`、`util/`、同模块 `provider`。
3. `modules/*/provider.ts` 是与外界（docker / tailscale / 宿主 / HTTP 服务）交互的**唯一**位置，必须可被 fake 替换以便测试。
4. 跨模块聚合只允许出现在 `modules/overview/`。
5. 前端不直接拼后端 URL 语义，一律经 `web/src/api/` 的类型化客户端。

## 4. 数据流

```
浏览器
  │  1) GET /                     → 静态前端（SPA）
  │  2) GET /api/auth/session     → 会话/角色/CSRF token
  │  3) GET /api/overview         → 首屏聚合（并行取 4 个数据源）
  │  4) GET /api/system/stream    → SSE 实时指标（默认 3s 一帧）
  │  5) GET /api/containers       → 容器墙
  │  6) GET /api/tailscale/devices→ 设备表
  │  7) GET /api/tools            → 工具卡
  ▼
Fastify
  ├─ 鉴权钩子（会话 cookie → 用户/角色）
  ├─ DockerProvider   ← /var/run/docker.sock
  ├─ TailscaleProvider← tailscale CLI 或 Tailscale API
  ├─ SystemProvider   ← 宿主 /proc、df、nvidia-smi
  └─ ToolProbe        ← 缓存 + 并发探测本机端口/HTTP
```

**缓存策略**：`util/cache.ts` 提供 TTL 缓存。容器列表 TTL 2s、tailnet 设备 5s、工具探测 10s、系统指标 1s（SSE 直取实时值）。缓存的作用是防止多标签页把宿主打爆。

## 5. tailnet 可达性判定（F1 核心算法）

对每个运行中容器，读取 `NetworkSettings.Ports` 与 `HostConfig.PortBindings`，逐条发布端口判定：

| 宿主绑定地址 | 判定 | 入口 URL 主机 |
| --- | --- | --- |
| `0.0.0.0` / `::`（空 HostIp） | `tailnet` 可达 | portal 当前访问主机（或 `PORTAL_PUBLIC_HOST`） |
| 具体 Tailscale IP（`100.x` / `fd7a:...`） | `tailnet` 可达 | 该 IP |
| 宿主 LAN IP | `lan` 可达 | 该 IP |
| `127.0.0.1` / `::1` | `localhost-only` | 标记为"需 SSH 隧道"，不给直接入口 |
| 容器 network mode = host | 视为与宿主同栈，直接按容器内端口判定 | portal 当前主机 |
| 容器在 tailnet 侧有 `TS_*` 环境变量 / 标签含 `tailscale` | `tailnet` 可达（经 serve） | `https://<hostname>.<tailnet>.ts.net` |

判定为 `tailnet` / `lan` 的端口才会渲染成可点击入口；`localhost-only` 容器在 UI 上以灰色卡片展示并给出提示，避免"点了打不开"的困惑。

## 6. 为什么 v1 用入口链接而非反向代理

内嵌其它 Web 应用需要处理：绝对路径资源、WebSocket、Cookie 域名、CSP、以及每个应用不同的 base path 要求。逐个适配的维护成本远高于价值。v1 采用**新标签页跳转**，保持零适配成本；文档在 `08-operations.md` 保留后续引入可选反代的方案位置。

## 7. 相关文档

- 配置项全表 → [02-configuration.md](./02-configuration.md)
- 后端逐函数说明 → [03-server-modules.md](./03-server-modules.md)
- 接口契约 → [04-api-contract.md](./04-api-contract.md)
