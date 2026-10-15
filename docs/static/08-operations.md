# 08 · 运维手册

## 1. 快速开始

```bash
# 1) 准备配置（Windows 用 Copy-Item）
cp .env.example .env

# 2) 构建并启动
docker compose up -d --build

# 3) 取首启令牌（二选一）
docker compose logs homepage | grep 初始化令牌          # Linux/NAS
docker compose logs homepage | Select-String 初始化令牌  # Windows

# 4) 浏览器打开
#    http://<宿主 tailnet IP>:8899   或   http://<MagicDNS 名>:8899
```

## 2. 指标取数边界（重要，先看这个）

门户跑在容器里，但展示的是**宿主**资源。这个差异决定了哪些数字是"真值"：

| 指标 | Linux/NAS 宿主 | Windows 宿主（Docker Desktop） |
| --- | --- | --- |
| CPU | 读挂载的宿主 `/proc/stat` → **真实值**（`mode: host-proc`） | `/proc` 是 WSL2 虚拟机的。容器内 Node 探测到无 `/proc`，改走 `os.cpus()`（`mode: os-cpus`）—— 这是 **Windows 宿主整机**的累计时间，因此也是**真实值**，只是没有 `iowait`/`steal` 细分，`loadAvg` 恒为 0 |
| 内存 | 读宿主 `/proc/meminfo` → **真实值** | `os.totalmem()` → **Windows 宿主真实值** |
| 磁盘 | 对挂载进来的宿主目录 `statfs` → **真实值** | 同左（把 `C:`/`D:` 挂进容器） |
| GPU | 挂 `nvidia-smi` → **真实值** | WSL GPU 直通，挂 `nvidia-smi` 后可读 → **真实值** |

**例外**：若在 Docker Desktop 的 WSL2 里、且**挂载了**宿主 `/proc`
（`/proc:/host/proc:ro`，这里指的是 WSL 发行版的 `/proc`），
则 `mode` 会变成 `host-proc`，但读到的其实是 **WSL2 虚拟机**的占用，
与 Windows 任务管理器对不上。此时应改为**不挂** `/proc`，让代码走 `os-cpus` 路径。

界面上的表现：`sources[].mode` 会随响应返回，`SystemPage` 会在卡片上标注
"数据源：宿主 /proc（真实值）"或"容器视图（受 cgroup 限制）"，
`SourceNotice` 在降级时显示黄色提示条。**看到黄条说明数据可能有偏差，不是服务坏了。**

## 3. 部署矩阵

### 3.1 Windows 11 + Docker Desktop

`.env`：

```dotenv
DOCKER_ENDPOINT=npipe:////./pipe/dockerDesktopLinuxEngine
DOCKER_SOCKET=//var/run/docker.sock
PORTAL_DISK_MOUNTS=C:=/host/disk/C,D:=/host/disk/D
# 不要把 C:\ 直接挂进来（Docker Desktop 文件共享权限问题多），
# 而是只挂需要的目录并逐个加到 PORTAL_DISK_MOUNTS
```

`docker-compose.yml` 的 `volumes` 需注释掉 `/proc:/host/proc:ro`（原因见 §2），
并加上磁盘与 tailscale 挂载：

```yaml
      - /proc:/host/proc:ro                     # ← Windows 上请注释掉这一行
      - C:\:/host/disk/C:ro                     # 需要哪个盘就加哪个
      - "C:\\Program Files\\Tailscale\\tailscale.exe:/usr/local/bin/tailscale:ro"
```

> **tailscale CLI 挂载**：容器内不能执行 Windows PE 可执行文件。
> 因此 Windows 上的 CLI 模式实际不可用；请改用 **API 模式**：
> `PORTAL_TAILSCALE_MODE=api` + `PORTAL_TAILSCALE_API_TOKEN=tskey-api-...`
> （在 Tailscale 管理后台 → Settings → Keys 生成，只读 scope 即可）。
> 或者让门户跑在 WSL 内并挂载 WSL 侧的 `tailscale`（若在 WSL 里装了 Tailscale）。

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

### Windows（WSL GPU 直通）

Docker Desktop 的 WSL2 内置 GPU 直通，`nvidia-smi` 位于 `/usr/lib/wsl/lib/`：

```yaml
      - /usr/lib/wsl/lib/nvidia-smi:/usr/local/bin/nvidia-smi:ro
      - /usr/lib/wsl/drivers:/usr/lib/wsl/drivers:ro
```

并在 `.env`：

```dotenv
PORTAL_NVIDIA_LD_LIBRARY_PATH=/usr/lib/wsl/lib
```

若 `.env` 里 `PORTAL_NVIDIA_LD_LIBRARY_PATH` 为空，`nvidia-smi` 会因找不到
`libnvidia-ml.so` 而失败，此时 `/api/health` 的 `sources.gpu.detail` 会给出提示。

> **不要**尝试挂载 `C:\Windows\System32\nvidia-smi.exe` —— 容器内执行不了 Windows 可执行文件。

## 5. 忘记密码怎么办

1. 若还有另一个 admin 账号：用它登录 → 「账号管理」→ 目标用户「重置密码」。
2. 若唯一的 admin 密码丢了：
   ```bash
   docker compose exec homepage node -e "
     const D=require('/app/node_modules/better-sqlite3');
     const b=require('/app/node_modules/bcryptjs');
     const db=new D('/data/portal.sqlite');
     const hash=b.hashSync('TempReset2026!', 12);
     db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(hash,'admin');
     db.prepare('UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL').run(new Date().toISOString());
     console.log('已重置 admin 密码为 TempReset2026!，请立即登录后修改');
   "
   ```
3. 全部账号都不可用时，删除数据卷重新初始化（**会丢失全部账号与审计**）：
   ```bash
   docker compose down
   docker volume rm homepage-data
   docker compose up -d
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
docker compose logs -f --tail=100 homepage
docker compose logs homepage | jq -r 'select(.level=="warn" or .level=="error") | "\(.time) \(.msg) \(.detail // "")"'
```

## 7. 升级

```bash
git pull
docker compose up -d --build
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
