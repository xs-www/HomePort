# 08 · 运维手册

## 1. 快速开始

```bash
# 1) 准备配置（Windows 用 Copy-Item）
cp .env.example .env

# 2) 构建并启动
docker compose up -d --build

# 3) 取首启令牌（二选一）
docker compose logs homeport | grep 初始化令牌          # Linux/NAS
docker compose logs homeport | Select-String 初始化令牌  # Windows

# 4) 浏览器打开
#    http://<宿主 tailnet IP>:8899   或   http://<MagicDNS 名>:8899
```

### 1.1 用预构建镜像（免本机编译）

CI 在 GitHub runner 上构建 **linux/arm64** 镜像并推送到 GHCR。架构受限或不想在
NAS 上跑编译时，直接拉镜像即可：

```bash
# 公开镜像，无需登录
docker pull ghcr.io/xs-www/homeport:latest

# 用具体版本（回滚比 latest 可靠）
docker pull ghcr.io/xs-www/homeport:sha-85159b8
```

改用镜像时，`docker-compose.yml` 把 `build:` 段去掉/注释，改成：

```yaml
    image: ghcr.io/xs-www/homeport:latest
```

镜像标签：

| 标签 | 含义 |
| --- | --- |
| `latest` | 默认分支（master）最近一次成功构建 |
| `master` | 分支名 |
| `sha-<短哈希>` | 每次提交，适合精确回滚 |
| `v1.2.3` / `1.2` | 推了 `v*` tag 时（semver） |

- **只构建 arm64**。需要 amd64 或多架构：改 `.github/workflows/docker-publish.yml`
  的 `PLATFORMS`（多架构写 `linux/amd64,linux/arm64`），再手动触发一次 workflow。
- 镜像**不含** provenance / SBOM attestation —— 这类 manifest 会让较老的 Docker
  （如 NAS 上的 20.10）报 `no match for platform in manifest`，故有意关闭。
- 拉取后 `docker compose up -d` 即可，数据库迁移照常在启动时自动执行。

## 2. 指标取数边界（重要，先看这个）

门户展示的是**宿主**资源，但它跑在容器里，两者的可见范围不同。
下表是**实测结论**（不是推断）：

| 部署方式 | CPU / 内存 | 磁盘 | GPU |
| --- | --- | --- | --- |
| **容器化 · Linux / NAS** | 读挂载的宿主 `/proc` → **宿主真实值**（`mode: host-proc`） | 挂宿主目录后 `statfs` → 真实值 | 挂 `nvidia-smi` 后 → 真实值 |
| **容器化 · Windows（Docker Desktop）** | ⚠ **只能看到 WSL2 虚拟机的资源**（实测：4 线程 / 3.9 GB，而宿主是 20 线程 / 31.6 GB） | 挂 `C:/` 后 `statfs` → **Windows 真实值**（实测 952 GB / 已用 65%，与资源管理器一致） | ❌ 不可用（原因见下） |
| **原生运行 · Windows（直接 `node`）** | `os.cpus()` / `os.totalmem()` → **Windows 宿主真实值**（实测 20 线程 / 31.63 GB，与任务管理器一致） | 无挂载概念，需通过 `PORTAL_DISK_MOUNTS` 指向本地盘符 | ✅ 直接可读 `nvidia-smi` → 真实值 |

### 为什么 Windows 容器化拿不到宿主 CPU/内存

Docker Desktop 把容器跑在一个 WSL2 虚拟机里。容器内可见的只有这个虚拟机的资源：

```
容器内 os.cpus()          → 4 线程
容器内挂载 WSL 的 /proc    → 4 线程（同一个来源，挂载也没用）
原生 node（Windows）      → 20 线程
```

**实测确认**：WSL2 的 `/proc/cpuinfo` 报告的处理器数与 `os.cpus()` 完全一致
（都是 4），`/proc/meminfo` 也与 `os.totalmem()` 一致（约 3.9 GB）。
因此**挂载 `/proc` 无法解决**这个问题 —— 之前文档里"挂 `/proc` 能拿到 Windows 真实值"
的说法是错误的，已更正。

要想拿到 Windows 宿主真实值，只有两条路：

1. **原生运行**：直接在 Windows 上 `npm run build && node server/dist/index.js`。
   此时 `DOCKER_ENDPOINT` 需改用 named pipe 写法（见 §3.1），且无需任何挂载。
   适合"只想看硬件 + 容器"的场景。
2. **调大 WSL2 资源**：编辑 `C:\Users\<你>\.wslconfig` 并把 WSL2 的资源配额提到接近宿主，
   再 `wsl --shutdown` 重启 Docker Desktop：

   ```ini
   [wsl2]
   processors=20
   memory=30GB
   ```

   注意这只是让"虚拟机视图"更接近宿主，**仍是虚拟机口径**，不是 Windows 真实占用。

### 为什么 Windows 容器化拿不到 GPU

- 容器内无法执行 `nvidia-smi.exe`（Linux 容器跑不了 Windows PE 可执行文件）。
- Docker Desktop 的 WSL GPU 直通路径 `/usr/lib/wsl/lib` **在容器内不可见**
  （实测：`ls /usr/lib/wsl/lib` → No such file or directory），因此无法从容器内读 GPU。

因此门户在 Windows 容器化部署下会把 GPU 报为"不可用"并给出原因 —— **这是正确行为，不是 bug**。
需要 GPU 指标请用原生运行方式（见 §3.1 末段）。

### 界面如何呈现

`sources[].mode` 随响应返回，`SystemPage` 会在每张卡片上标注取数来源
（如"Node os 接口（宿主整机）"或"容器视图（受 cgroup 限制）"）。
**看到黄色提示条说明取数降级了，不是服务坏了** —— 提示条里会写清原因。

## 3. 部署矩阵

### 3.1 Windows 11 + Docker Desktop

`.env`（**已实测可用**，这是本机部署实际使用的配置）：

```dotenv
# 容器内必须是 unix socket！Docker Desktop 会把 Windows named pipe 转发成容器内的
# /var/run/docker.sock。写 npipe:// 会报 ENOENT。
DOCKER_ENDPOINT=unix:///var/run/docker.sock
DOCKER_SOCKET=//var/run/docker.sock
PORTAL_DISK_MOUNTS=C:=/host/disk/C
PORTAL_TAILSCALE_MODE=api
PORTAL_TAILSCALE_API_TOKEN=tskey-api-xxxxxxxx
```

compose 的 `volumes` 需要有（磁盘盘符**必须**写成 `"C:/"` 并加引号）：

```yaml
      - "C:/:/host/disk/C:ro"
```

不要加 `/proc:/host/proc:ro`（WSL2 视图，与任务管理器对不上，挂了也没用，见 §2）。

#### 常见坑（都是实测踩到的）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `docker.available=false`，detail 为 `ENOENT //./pipe/...` | 在容器里用了 `npipe://` 写法 | 改成 `unix:///var/run/docker.sock` |
| `docker.available=false`，detail 为 `ENOENT` 且挂载显示为 `<项目目录>/C:` | compose 里盘符写成 `C:`，被当成相对路径 | 写成 `"C:/:/host/disk/C:ro"` |
| CPU 只显示 4 线程、内存只显示约 4 GB | Docker Desktop 的 WSL2 虚拟机限额 | 见 §2 —— 要么原生运行，要么调 `.wslconfig` |
| GPU 显示不可用 | 容器内看不到 `/usr/lib/wsl/lib` | 见 §2 —— 需原生运行才能读 GPU |
| tailnet 显示"未配置 API Token" | Windows 上容器内无法执行 `tailscale.exe` | 配置 `PORTAL_TAILSCALE_API_TOKEN`（只读 scope 即可） |

#### 想拿到 Windows 真实 CPU/内存/GPU：原生运行

```powershell
npm run build
$env:DOCKER_ENDPOINT='npipe:////./pipe/dockerDesktopLinuxEngine'  # 原生运行才用 npipe
$env:PORTAL_DATA_DIR='D:\桌面\sisi_apps\HomePage\data'
npm start
```

实测结果：20 线程、31.63 GB 内存（与任务管理器一致）、`nvidia-smi` 可读。
此时磁盘指标无挂载概念，需用 `PORTAL_DISK_MOUNTS` 指向本地盘符（如 `C:=C:\`）。

### 3.2 NAS（Synology / QNAP / TrueNAS）

`.env`：

```dotenv
DOCKER_ENDPOINT=unix:///var/run/docker.sock
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_GID=998
PORTAL_HOST_PROC=/host/proc
PORTAL_DISK_MOUNTS=/volume1=/host/volume1,/volume2=/host/volume2
PORTAL_TAILSCALE_MODE=cli
PORTAL_TAILSCALE_BIN=/usr/local/bin/tailscale
```

**群晖注意**：默认没有 `/usr/bin/tailscale`（Tailscale 以套件形式安装，路径多为
`/var/packages/Tailscale/target/bin/tailscale`）。挂载时用实际路径，
或直接用 API 模式避开挂载。

**arm64 NAS**：镜像用 `node:22-alpine`，`better-sqlite3` 在 builder 阶段编译，
支持 arm64。首次构建会比 amd64 慢（QEMU 模拟或原生编译）。

## 4. GPU 挂载

### Linux / NAS（NVIDIA 容器运行时）

```yaml
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [utility]   # 只需要 nvidia-smi 读指标，不需要 compute
```

或直接挂宿主二进制（更简单，无需 nvidia-container-toolkit）：

```yaml
      - /usr/bin/nvidia-smi:/usr/local/bin/nvidia-smi:ro
      - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:ro
```

### Windows（Docker Desktop）—— 容器化部署下不可用

**实测结论：Docker Desktop 的容器内拿不到 GPU 指标**，因此不需要任何挂载配置。

| 尝试过的方案 | 结果 |
| --- | --- |
| 挂 `/usr/lib/wsl/lib/nvidia-smi` | ❌ `No such file or directory` —— 该路径在容器内不可见 |
| 挂 `C:\Windows\System32\nvidia-smi.exe` | ❌ Linux 容器无法执行 Windows PE 可执行文件 |

门户会把 GPU 报为"不可用"并说明原因 —— 这是**正确行为**，不是缺陷。

想在 Windows 上看 GPU 指标，请改用**原生运行**方式（§3.1 末段）：
原生 `node` 进程可直接执行 `C:\Windows\System32\nvidia-smi.exe`，
实测可读到 RTX 4060 的利用率、显存、温度、功耗与占用进程。

> 不要为了这个需求去折腾 WSL 内安装 NVIDIA 驱动 —— WSL 的 GPU 支持由 Windows 驱动
> 通过 `/usr/lib/wsl/lib` 提供，而该目录不会被 Docker Desktop 暴露给容器。

## 5. 密码相关

### 先看清有哪些账号

门户**不提供**"查看密码"功能 —— 数据库只存 bcrypt 哈希（不可逆），这是有意的安全设计。
忘记密码只能重置，不能找回。先确认账号现状：

```bash
docker compose exec homeport node -e "
const D=require('/app/node_modules/better-sqlite3');
const db=new D('/data/portal.sqlite',{readonly:true});
console.log(db.prepare('SELECT id,username,display_name,role,disabled,last_login_at FROM users ORDER BY id').all());
"
```

### 重置密码

1. **还有另一个 admin 账号**（推荐）：用它登录 → 「账号管理」→ 目标用户「重置密码」。
   这会自动吊销该用户全部会话。
2. **唯一的 admin 密码丢了**：在容器内直接改哈希。
   把下面命令里的 `新密码` 与 `admin` 换成你要的：

   ```bash
   docker compose exec homeport node -e "
     const D=require('/app/node_modules/better-sqlite3');
     const b=require('/app/node_modules/bcryptjs');
     const db=new D('/data/portal.sqlite');
     const hash=b.hashSync('新密码', 12);
     const n=db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE username=?')
                .run(hash, new Date().toISOString(), 'admin').changes;
     const revoked=db.prepare('UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL')
                .run(new Date().toISOString()).changes;
     console.log('已更新账号数:', n, '| 已吊销会话数:', revoked);
   "
   ```

   注意：密码仍需满足策略（≥10 位、至少两类字符），但直接改库**不会**校验 ——
   写进去什么就是什么，所以请自觉用强口令。

3. **登录成功后立即自查**：右上角 → 「账号管理」→「安全与偏好」可自助改密，
   改密后除当前会话外的其它会话都会失效。

### 首启令牌在哪里（与登录密码无关）

首次启动时用于创建管理员的那个令牌，和登录密码是两回事：

- `docker compose logs homeport | grep 初始化令牌`
- 容器内文件 `/data/setup-token.txt`
- 或部署时由 `PORTAL_SETUP_TOKEN` 环境变量指定

系统初始化完成后该令牌即失效（再调用 `/api/auth/bootstrap` 会返回 `ALREADY_INITIALIZED`），
可以留着备查或删除。

### 全部账号都不可用

删除数据卷重新初始化（**会丢失全部账号与审计日志**）：

```bash
docker compose down
docker volume rm homeport-data
docker compose up -d
# 然后从日志重新取首启令牌
```

## 6. 排障

### `/api/health` 各数据源可用性

```bash
curl -s http://127.0.0.1:8899/api/health | jq .sources
```

| 症状 | 原因与处理 |
| --- | --- |
| `docker.available=false` + `mode: socket` + detail 提到 `ENOENT` | 未挂载 socket 或 `DOCKER_ENDPOINT` 写错。Windows 必须用 npipe 写法 |
| `docker.available=false` + detail 提到 `EACCES` | 权限不足。设置 `DOCKER_GID`（群晖常见 998）或确认 socket 是 `srw-rw----` 且组匹配 |
| `tailscale.available=false` + `mode: cli` + 未找到可执行文件 | 未挂载 tailscale 或路径不对。Windows 上 CLI 不可用，改 API 模式 |
| `tailscale.available=false` + `mode: api` + 401/403 | Token 无效或 scope 不足 |
| `system.mode=container-proc` | 容器视图，Linux 宿主请挂 `/proc` |
| `gpu.available=false` | 未挂 `nvidia-smi`；或 WSL 下缺 `PORTAL_NVIDIA_LD_LIBRARY_PATH` |
| `disk.available=false` | `PORTAL_DISK_MOUNTS` 里的容器内路径不存在。detail 会指出具体路径 |

### 容器列表为空但 docker 可用

- 检查是否把「含已停止」关掉了，或筛选器还停在某个可达性上（筛选条件存在 `localStorage`）。
- 若 `total=0` 且 `source.available=true`，说明宿主机上确实没有容器。

### 容器显示"仅本机"但实际能访问

判定依据是 Docker 的**宿主绑定地址**：

```bash
docker inspect <容器> --format '{{json .HostConfig.PortBindings}}'
```

- `"HostIp": "127.0.0.1"` → 判定为仅本机（正确）。
  想让 tailnet 可达，需要把应用改为监听 `0.0.0.0`（通常改 compose 的端口映射写法）。
- 若是通过 `tailscale serve` / sidecar 暴露的，门户会通过 `TS_*` 环境变量
  或镜像名识别为 tailscale sidecar 并标注 badge，但入口 URL 仍需你自行填写。

### 页面能打开但工具全显示"不可用"

工具探测从**门户容器内**发起：

- 确认工具端口确实在宿主上监听：`curl -s telnet://127.0.0.1:11434` 或 `Test-NetConnection`。
- 容器内访问宿主服务需要 `host.docker.internal`（Docker Desktop 自带）
  或 Linux 上的 `extra_hosts: ["host.docker.internal:host-gateway"]`。
  门户默认用**门户的对外主机名**作为探测目标（tailnet IP / MagicDNS），
  因此只要 tailnet 通就能探到。

### SSE 指标不更新

- 反代必须关闭缓冲：`proxy_buffering off`、`proxy_read_timeout` 调大、
  响应头 `X-Accel-Buffering: no`（门户已设置）。
- Nginx 示例：
  ```nginx
  location /api/system/stream {
      proxy_pass http://127.0.0.1:8899;
      proxy_http_version 1.1;
      proxy_set_header Connection '';
      proxy_buffering off;
      proxy_cache off;
      chunked_transfer_encoding off;
      proxy_read_timeout 3600s;
  }
  ```

### 日志怎么看

门户自身日志是单行 JSON（生产）：

```bash
docker compose logs -f --tail=100 homeport
docker compose logs homeport | jq -r 'select(.level=="warn" or .level=="error") | "\(.time) \(.msg) \(.detail // "")"'
```

## 7. 升级

两种方式，按部署形态选：

```bash
# A) 本机构建（开发机 / Windows）
git pull
docker compose up -d --build

# B) 用 CI 预构建镜像（NAS 等不适合本机编译的机器）
docker compose pull homeport      # 拉取 image: 指定的标签
docker compose up -d
```

- 数据库迁移在启动时自动执行（幂等，已应用的会跳过）。
- 前端产物打进镜像，浏览器刷新即拿到新版本（`index.html` 强制 `no-cache`）。
- 建议升级前备份（见 `07-data-model.md` §4）。

## 8. 资源占用与调优

| 场景 | 调整 |
| --- | --- |
| 容器很多（>30） | `PORTAL_CACHE_CONTAINERS_TTL_MS=5000`，减少 inspect 次数 |
| NAS 性能弱 | `PORTAL_METRICS_INTERVAL_MS=10000`，降低采样与推送频率 |
| tailnet 设备多 | `PORTAL_CACHE_TAILSCALE_TTL_MS=30000`，减少 fork `tailscale` |
| 工具很多 | `PORTAL_TOOLS_PROBE_TTL_MS=60000`，减少探测 |
| 内存紧张 | 镜像基于 alpine，运行时无 devDependencies；实测常驻约 60-90 MB |

## 9. 反向代理（可选）

门户默认直接经 tailnet 访问，无需反代。若确实需要 HTTPS：

```nginx
server {
    listen 443 ssl;
    server_name portal.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8899;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/system/stream {
        proxy_pass http://127.0.0.1:8899;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

同时设置 `PORTAL_SECURE_COOKIES=1` 与 `PORTAL_PUBLIC_HOST=portal.example.com`。
