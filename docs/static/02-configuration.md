# 02 · 配置参考

> 所有配置都通过**环境变量**注入（`.env` → `docker compose` → 容器）。
> 本文件是唯一权威说明；`.env.example` 是可直接复制的样例。

## 1. 规则与约定

- 所有变量都可省略，**最小可用配置是空 `.env`**。
- 布尔值接受 `1/0`、`true/false`、`yes/no`、`on/off`。
- 非法值会**在启动时抛错并退出**（而不是静默取默认值），避免"配置写错了但看起来在跑"。
- 唯一的 `process.env` 读取点是 `server/src/config.ts`；其余模块只从强类型 `config` 取值。

## 2. 门户自身

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_HOST_PORT` | `8899` | compose 映射到宿主的端口 |
| `PORTAL_BIND_ADDR` | `0.0.0.0` | compose 端口绑定地址。填宿主 tailnet IP 可做到"只经 tailnet 访问" |
| `PORTAL_PORT` | `8899` | 容器内监听端口（一般不改） |
| `PORTAL_HOST` | `0.0.0.0` | 容器内监听地址 |
| `PORTAL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORTAL_PUBLIC_HOST` | 空 | 门户对外主机名。空 = 按访问者请求头推导。填 MagicDNS 名或 tailnet IP 可让所有入口链接固定 |
| `PORTAL_PUBLIC_PORT` | `0` | 对外端口；`0` = 跟随请求 |
| `PORTAL_PUBLIC_SCHEME` | `http` | `http` / `https` |
| `PORTAL_SECURE_COOKIES` | `0` | 部署在 HTTPS 反代之后时置 `1`，会话 Cookie 带 `Secure` |
| `PORTAL_TRUST_PROXY` | `1` | 是否信任 `X-Forwarded-*`（反代后需要） |
| `PORTAL_SETUP_TOKEN` | 空 | 首启令牌；空 = 自动生成并写入 `/data/setup-token.txt` + 打印到日志 |
| `PORTAL_DATA_DIR` | `/data`（镜像内） | SQLite 与令牌目录 |
| `PORTAL_DB_PATH` | `<dataDir>/portal.sqlite` | 数据库文件路径 |
| `PORTAL_VERSION` | `0.1.0` | 展示用版本号 |
| `PORTAL_BUILD_REVISION` | `dev` | 展示用构建号/提交号（CI 里可注入） |
| `TZ` | `Asia/Shanghai` | 日志与界面时区 |

### 会话

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_SESSION_TTL_HOURS` | `12` | 常规会话有效期 |
| `PORTAL_SESSION_REMEMBER_TTL_HOURS` | `720`（30 天） | 勾选"记住我"时的有效期 |
| `PORTAL_SESSION_COOKIE` | `hp_session` | 会话 Cookie 名 |

### 缓存与实时推送

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_METRICS_INTERVAL_MS` | `3000` | SSE 指标推送间隔 |
| `PORTAL_CACHE_CONTAINERS_TTL_MS` | `2000` | 容器列表缓存。容器多（>30）时可调到 5000 降低 inspect 压力 |
| `PORTAL_CACHE_TAILSCALE_TTL_MS` | `5000` | tailnet 状态缓存，避免频繁 fork `tailscale` 进程 |

## 3. Docker 数据源（F1）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOCKER_ENDPOINT` | `unix:///var/run/docker.sock` | 引擎地址。**Windows 必须**用 `npipe:////./pipe/dockerDesktopLinuxEngine` |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | compose 的宿主侧 socket 路径。Windows 用 `//var/run/docker.sock` |
| `DOCKER_GID` | `0` | `group_add` 的组 ID。NAS 上出现 `EACCES` 时设为其 docker 组 ID（群晖常见 `998`） |
| `PORTAL_DOCKER_INCLUDE_STOPPED` | `1` | 是否默认包含已停止容器 |
| `PORTAL_DOCKER_STATS_TIMEOUT_MS` | `4000` | `docker stats` 超时 |

支持的 endpoint 写法（`resolveDockerEndpoint`）：

| 写法 | 结果 |
| --- | --- |
| `npipe:////./pipe/dockerDesktopLinuxEngine` | `{ socketPath: '//./pipe/dockerDesktopLinuxEngine' }` |
| `unix:///var/run/docker.sock` | `{ socketPath: '/var/run/docker.sock' }` |
| `/var/run/docker.sock` | 同上 |
| `tcp://host:2375` / `http://host:2375` | `{ host, port, protocol: 'http' }` |
| `https://host:2376` | `{ host, port, protocol: 'https' }` |

> named pipe 的斜杠数量不规范（2~4 个都合法），代码统一归一化为 `//./pipe/...`。
> 传给 dockerode 的路径若不以 `//` 开头会被当成相对文件路径，报 `ENOENT`。

## 4. tailnet 数据源（F2）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_TAILSCALE_MODE` | `auto` | `auto` / `cli` / `api` / `off`。`auto` = 有 API Token 走 API，否则走 CLI |
| `PORTAL_TAILSCALE_BIN` | `tailscale`（镜像内为 `/usr/local/bin/tailscale`） | CLI 可执行文件路径 |
| `PORTAL_TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock` | 非默认值时会追加 `--socket` 参数 |
| `PORTAL_TAILSCALE_API_TOKEN` | 空 | Tailscale API Token（只读 scope 即可） |
| `PORTAL_TAILSCALE_TAILNET` | `-` | API 模式的 tailnet 标识；`-` 表示当前 Token 所属 tailnet |
| `PORTAL_TAILSCALE_TIMEOUT_MS` | `5000` | CLI/API 超时 |

**两种模式的取舍**

| | CLI 模式 | API 模式 |
| --- | --- | --- |
| 需要 | 宿主 `tailscale` 可执行文件挂载进容器 | `PORTAL_TAILSCALE_API_TOKEN` |
| 网络 | 不需要外网 | 需要访问 `api.tailscale.com` |
| 数据新鲜度 | 与宿主一致，延迟低 | 有云端延迟（数十秒） |
| 中转信息 | 有 `Relay` / `CurAddr`（可判直连/中继） | 无 |
| 适用 | NAS 上已装 Tailscale | 无法挂载宿主二进制、或想统一走云端 |

## 5. 系统指标（F3）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_HOST_PROC` | `/host/proc` | 宿主 `/proc` 的容器内挂载点。**Linux/NAS 必挂**才能拿到宿主真实 CPU/内存 |
| `PORTAL_DISK_MOUNTS` | 空 | 磁盘挂载点列表，见下方语法 |
| `PORTAL_NVIDIA_SMI` | `/usr/local/bin/nvidia-smi` | `nvidia-smi` 路径 |
| `PORTAL_NVIDIA_LD_LIBRARY_PATH` | 空 | 追加到 `LD_LIBRARY_PATH`（WSL 下通常为 `/usr/lib/wsl/lib`） |
| `PORTAL_COMMAND_TIMEOUT_MS` | `5000` | 外部命令（`nvidia-smi` 等）超时 |

### `PORTAL_DISK_MOUNTS` 语法

```
展示路径=容器内路径[|展示标签[|statfs 路径]]，多个用英文逗号分隔
```

- `展示路径`：UI 上显示给用户看的宿主路径（如 `C:` 或 `/volume1`）。
- `容器内路径`：**必须是**宿主目录在容器里的挂载点。
- `展示标签`：可选，省略时取展示路径最后一段（Windows 盘符会自动去掉冒号）。
- `statfs 路径`：可选，省略时等于 `容器内路径`。

**必须显式写 `=`**：只写一个路径时无法判断它是宿主路径还是容器路径，
静默猜测会得到错误的 `statfs` 目标，因此直接报错。

| 平台 | 示例 |
| --- | --- |
| Windows | `C:=/host/disk/C` |
| NAS | `/volume1=/host/volume1,/volume2=/host/volume2` |
| 带标签 | `/volume1=/host/volume1\|存储池1` |

## 6. 工具目录（F4）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_TOOLS_FILE` | 空 | 自定义目录 JSON 的路径（需挂载进容器） |
| `PORTAL_TOOLS_EXTRA` | 空 | 快速追加：`id:名称:端口`，逗号分隔 |
| `PORTAL_TOOLS_PROBE_TTL_MS` | `10000` | 探测结果缓存时长 |
| `PORTAL_TOOLS_PROBE_TIMEOUT_MS` | `1500` | 单次 TCP/HTTP 探测超时 |

### 目录 JSON 结构

```json
{
  "replace": false,
  "tools": [
    {
      "id": "jellyfin",
      "name": "Jellyfin",
      "port": 8096,
      "category": "media",
      "probePath": "/health",
      "deepLinkPath": "/web/",
      "icon": "media",
      "description": "开源媒体服务器",
      "scheme": "http",
      "expectedStatus": 200,
      "featured": true,
      "order": 60,
      "visibleTo": ["admin", "viewer"],
      "hint": null
    },
    { "id": "ollama", "port": 11435 }
  ]
}
```

- `replace: false`（默认）：按 `id` **合并**内置目录 —— 只写要覆盖的字段即可，未写的沿用内置值。
- `replace: true`：完全以内置目录被文件内容替代。
- `id` 只允许字母数字与短横线（最长 32 位）；`port` 必须为 1-65535 或 `null`。
- `visibleTo` 为 `[]` 时自动视为对所有角色可见。

字段含义：

| 字段 | 说明 |
| --- | --- |
| `probePath` | 健康检查路径；`/` 表示只校验根路径返回码 |
| `expectedStatus` | 期望状态码；`null` = 只要不是 5xx 就算可用 |
| `deepLinkPath` | 深度链接路径（如 Jellyfin 的 `/web/`） |
| `scheme` | `http` / `https`（自签证书不会阻断探测） |
| `featured` | 是否在概览页突出显示 |
| `order` | 排序权重，越小越靠前 |
| `hint` | 展示在卡片上的附加提示 |

### 内置工具（`BUILTIN_TOOLS`）

| id | 名称 | 端口 | 探测路径 |
| --- | --- | --- | --- |
| `ollama` | Ollama | 11434 | `/api/version` |
| `dsh` | DSH | 3080 | `/` |
| `comfyui` | ComfyUI | 8188 | `/` |
| `open-webui` | Open WebUI | 3001 | `/health` |
| `portainer` | Portainer | 9000 | `/api/status` |
| `jellyfin` | Jellyfin | 8096 | `/health` |
| `qbit` | qBittorrent | 8081 | `/api/v2/app/version` |
| `code-server` | code-server | 8443 | `/healthz` |

## 7. 部署矩阵速查

| | Windows 11 + Docker Desktop | NAS（Synology / QNAP / TrueNAS） |
| --- | --- | --- |
| `DOCKER_ENDPOINT` | `npipe:////./pipe/dockerDesktopLinuxEngine` | `unix:///var/run/docker.sock` |
| `DOCKER_SOCKET` | `//var/run/docker.sock` | `/var/run/docker.sock` |
| `DOCKER_GID` | `0` | 常为 `998`（群晖），遇 `EACCES` 时设置 |
| CPU / 内存 | `os-cpus`：Node 读 Windows 性能计数器，**宿主真实值** | `host-proc`：读宿主 `/proc`，真实值 |
| 磁盘 | 挂 `C:`/`D:`，`statfs` 取真实值 | 挂 `/volume1` 等 |
| GPU | 需把 `nvidia-smi.exe` 与其依赖库挂进容器（见 README） | 多数 NAS 无独显；有则可挂 `nvidia-smi` |
| tailnet | CLI 模式：挂 `tailscale.exe` | CLI（挂 `tailscale` + `tailscaled.sock`）或 API |
| 门户访问 | `http://<宿主tailnet IP>:8899` | 同左 |

## 8. 相关文档

- 逐函数说明 → [03-server-modules.md](./03-server-modules.md)
- 指标为什么可能不准 → [08-operations.md](./08-operations.md) 的「指标取数边界」
- 部署步骤 → [README.md](../../README.md)
