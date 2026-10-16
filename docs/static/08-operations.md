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

CI 在 GitHub runner 上构建 **多架构**（`linux/amd64` + `linux/arm64`）镜像并推送到 GHCR，
产出 manifest list，拉取时由 Docker 自动挑选匹配本机架构的那一份。
架构受限或不想在 NAS 上跑编译时，直接拉镜像即可：

```bash
# 公开镜像，无需登录
docker pull ghcr.io/xs-www/homeport:latest

# 用具体版本（回滚比 latest 可靠）
docker pull ghcr.io/xs-www/homeport:sha-85159b8

# 确认拿到的是哪个架构
docker image inspect ghcr.io/xs-www/homeport:latest --format '{{.Os}}/{{.Architecture}}'
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

- **构建哪些架构**由 `.github/workflows/docker-publish.yml` 的 `PLATFORMS` 单点控制，
  当前为 `linux/amd64,linux/arm64`。只想出单架构（更快）可写 `linux/amd64`。
- 镜像**不含** provenance / SBOM attestation —— 这类 manifest 会让较老的 Docker
  （如 NAS 上的 20.10）报 `no match for platform in manifest`，故有意关闭。
  **多架构 manifest list 本身没问题，但必须同时关掉 attestation**，否则较老 Docker 依然挑不中平台。
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

compose 的 `volumes` 里磁盘挂载**默认是注释掉的**（Sprint 0 起）。
默认挂 `C:/` 会让 Linux/NAS 上的 `docker compose` 直接报错（宿主没有该路径，
个别版本还会悄悄建出目录），因此改成按需启用。要读磁盘指标就把下面这行
**取消注释**，并同步 `.env` 的 `PORTAL_DISK_MOUNTS`：

```yaml
      # Windows（Docker Desktop）：盘符必须写成 "C:/"（带斜杠）并加引号
      - "C:/:/host/disk/C:ro"
```

```dotenv
PORTAL_DISK_MOUNTS=C:=/host/disk/C
```

盘符写成 `C:` 会被 Compose 当成相对路径，解析成 `<项目目录>/C:` 而挂载失败。
**挂载与登记两边都写了，门户才会展示该磁盘**（只写一边等于没配）。

> **推荐做法：写进 `docker-compose.override.yml`，而不是改动仓库里的 compose。**
> Compose 会自动把 `docker-compose.yml` 与 `docker-compose.override.yml` 合并，
> 而这个文件依赖具体机器的路径，因此已在 `.gitignore` 中忽略 —— 本机改挂载不会
> 污染仓库，`git pull` 也不会有冲突。上面那段 YAML 原样写进覆盖文件即可：
>
> ```yaml
> services:
>   homeport:
>     volumes:
>       - "C:/:/host/disk/C:ro"        # NAS 上换成 - "/volume1:/host/volume1:ro"
> ```
>
> 覆盖文件只写"本机特有"的增量项，别把 `cap_drop`、`security_opt`、`docker.sock:ro`
> 这些硬化项抄进去 —— 那些在主 compose 里，抄一份反而会在日后主文件更新时留下不一致。

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

### 3.2 NAS（Synology / QNAP / TrueNAS / 绿联 UGOS）

NAS 上**推荐直接用预构建镜像**，不在 NAS 上编译（见 §1.1）。
仓库提供了现成的部署文件 `docker-compose.nas.yml`：

```bash
# 1) 先在 NAS 上跑发现脚本，拿到四项关键值（见下）
# 2) 按发现结果改 docker-compose.nas.yml 里标注 TODO 的地方
# 3) 启动
docker compose -f docker-compose.nas.yml up -d

# 4) 取首启令牌
docker compose -f docker-compose.nas.yml logs homeport | grep 初始化令牌
```

#### 部署前必须确认的四项

NAS 的路径与权限差异很大（尤其是绿联 UGOS、群晖套件），**不要照抄路径**，先跑：

```bash
# ① CPU 架构：决定拉哪一份镜像（多架构会自动选，单架构选错会 exec format error）
uname -m                       # x86_64 → amd64 ；aarch64 → arm64

# ② docker 组 ID：容器内访问 docker.sock 报 EACCES 时要用它
getent group docker || stat -c '%g' /var/run/docker.sock

# ③ 存储卷实际路径：填进 PORTAL_DISK_MOUNTS 与 compose 的 volumes
df -h | grep -Ev 'tmpfs|overlay|udev'

# ④ tailscale 安装位置（只用 CLI 模式时才需要；API 模式可跳过）
which tailscale; readlink -f "$(which tailscale)"; ls -l /var/run/tailscale/
```

拿到结果后按需修改的对应关系：

| 发现结果 | 改哪里 |
| --- | --- |
| `uname -m` | 无需改（多架构 manifest 自动匹配） |
| docker 组 ID | `DOCKER_GID=xxx`（写在 `.env` 或直接改 compose 的 `group_add`） |
| 存储卷路径 | `PORTAL_DISK_MOUNTS` 与 compose `volumes` 的磁盘挂载 |
| tailscale 路径 | 仅 CLI 模式：compose 里被注释的两行 tailscale 挂载 |

#### tailnet 数据源：优先 API 模式

NAS 上 Tailscale 多为套件/系统包安装，二进制与 sock 的路径、权限各不相同，
**挂载常常失败**。最省事的做法是用 API 模式，只填一个只读 Token，
不需要挂任何 tailscale 文件：

```dotenv
PORTAL_TAILSCALE_MODE=api
PORTAL_TAILSCALE_API_TOKEN=tskey-api-xxxxxxxx
```

Token 在 https://login.tailscale.com/admin/settings/keys 生成（选 access token，
不是 auth key），保存后可在「账号管理 → 系统设置」里点「测试连接」验证。

#### 传统 `.env` 写法（用仓库根 compose 时）

```dotenv
DOCKER_ENDPOINT=unix:///var/run/docker.sock
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_GID=998
PORTAL_HOST_PROC=/host/proc
PORTAL_DISK_MOUNTS=/volume1=/host/volume1,/volume2=/host/volume2
PORTAL_TAILSCALE_MODE=api
PORTAL_TAILSCALE_API_TOKEN=tskey-api-xxxxxxxx
```

**群晖注意**：默认没有 `/usr/bin/tailscale`（Tailscale 以套件形式安装，路径多为
`/var/packages/Tailscale/target/bin/tailscale`）。要用 CLI 模式就用实际路径挂载，
否则用 API 模式避开。

**绿联 DX4600 Pro 注意**：该机型是 **x86-64（amd64）**，不是 arm64 ——
用多架构镜像没问题，但若手工指定单架构镜像务必选 amd64。

**性能**：NAS 上建议把 `PORTAL_METRICS_INTERVAL_MS` 调到 10000 降低采样压力（见 §8）。

> **先确认 NAS 的 CPU 架构再选镜像**：`uname -m` 返回 `x86_64` 就是 amd64，
> 返回 `aarch64` 才是 arm64。多架构 manifest 会自动选对，但**单架构镜像选错会以
> `exec format error` 失败**。

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

### 两步验证（TOTP）：设备丢了怎么办

按"先试不动数据库的办法"排序，三种情况选一种。

#### 情况一：还有动态码或恢复码

- 验证器还在（换手机前迁移过、或另一台设备也配了）→ 直接用动态码登录。
- 验证器丢了但**保存过恢复码** → 在登录第二步输入 `XXXX-XXXX` 形式的恢复码即可
  （每个只能用一次）。登录后到「账号管理 → 安全与偏好 → 两步验证」可以**重新生成**
  10 个新恢复码，重新生成会让**旧码全部作废**。
- 两步验证是**可选**的：没绑定的账号一直只用密码，不受影响。

#### 情况二：让另一个管理员帮忙重置（推荐路径）

用另一个 admin 账号登录 →「账号管理」→ 目标用户 →「重置两步验证」。
语义是**清绑定 + 删除全部恢复码 + 吊销该用户全部会话**：

- 目标用户会立刻掉线，需要用密码重新登录（此时不再要求第二步）；
- 重新登录后可在「安全与偏好」里重新绑定验证器；
- 操作会写审计 `auth.totp_reset`，并记录吊销的会话数（界面提示里也会显示）。

#### 情况三：唯一的管理员自己丢了设备（离线兜底）

没有别的 admin 能帮你，只能直接在数据库里清除绑定。
**先按 §10 备份数据卷（密钥与数据库必须一起备）**，然后：

```bash
# 1) 先看清账号现状：id / 角色 / 是否绑定两步验证
docker compose exec homeport node -e "
const D=require('/app/node_modules/better-sqlite3');
const db=new D('/data/portal.sqlite',{readonly:true});
console.log(db.prepare('SELECT id,username,role,disabled,totp_enabled,totp_confirmed_at FROM users ORDER BY id').all());
"

# 2) 清除目标账号的两步验证绑定并吊销其会话（把 'admin' 换成你的用户名）
docker compose exec homeport node -e "
const D=require('/app/node_modules/better-sqlite3');
const db=new D('/data/portal.sqlite');
const now=new Date().toISOString();
const u=db.prepare('SELECT id,username FROM users WHERE username_ci=?').get('admin');
if(!u){ console.log('未找到该账号'); process.exit(1); }
db.prepare('UPDATE users SET totp_secret=NULL, totp_enabled=0, totp_confirmed_at=NULL, totp_last_counter=NULL, updated_at=? WHERE id=?').run(now,u.id);
db.prepare('DELETE FROM totp_recovery_codes WHERE user_id=?').run(u.id);
db.prepare('DELETE FROM totp_challenges WHERE user_id=?').run(u.id);
const revoked=db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,u.id).changes;
console.log('已清除', u.username, '的两步验证绑定，吊销会话数:', revoked);
"
```

等价的 SQL（容器内/宿主上有 `sqlite3` 时）。**注意两点**：
用户名要按 `username_ci`（即 `username.toLowerCase()`）比较，直接比 `username` 会漏；
时间戳用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 生成 ISO-8601 UTC，
与应用（`new Date().toISOString()`）写的格式保持一致：

```sql
UPDATE users
   SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL,
       totp_last_counter = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE username_ci = 'admin';

DELETE FROM totp_recovery_codes
 WHERE user_id = (SELECT id FROM users WHERE username_ci = 'admin');

DELETE FROM totp_challenges
 WHERE user_id = (SELECT id FROM users WHERE username_ci = 'admin');

UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE user_id = (SELECT id FROM users WHERE username_ci = 'admin')
   AND revoked_at IS NULL;
```

改完后 `docker compose restart homeport`（让进程内的用户缓存失效），再用密码登录
并重新绑定验证器。

相关列（表 `users`，由迁移 v3 `totp_two_factor` 添加）：

| 列 | 含义 |
| --- | --- |
| `totp_secret` | 种子**密文**（`enc:v1:…`，AES-256-GCM），不是明文 Base32 |
| `totp_enabled` | `1` = 已确认启用；`setup` 阶段会先写种子但保持 `0`（"扫了码没输码"不算启用） |
| `totp_confirmed_at` | 确认启用的时间（界面显示"启用时间"） |
| `totp_last_counter` | 最后成功使用的 30 秒时间步，用于**登录**防重放 |

恢复码与挑战分别在 `totp_recovery_codes`（只存 sha256 摘要、`used_at` 标记核销）与
`totp_challenges`（只存令牌摘要、带 `attempts`/`consumed_at`/`expires_at`）两张表里。
清绑定时一并删掉恢复码；残留的挑战行不会挡住后续登录（登录时会新建挑战），
但留着既无用又扩大了令牌摘要的暴露面，所以顺手清掉。

> ⚠️ 直接改库**不会**写审计、也不经过"最后一个管理员"之类的应用层保护 —— 这是最后手段。
> 另外 `docker compose exec` 要求容器在跑；容器起不来时，用
> `docker run --rm -v homeport-data:/data -v "$PWD:/backup" alpine ...` 之类的方式
> 挂同一个卷来操作，或先按 §10 恢复备份。

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
- 建议升级前备份（见 §10 —— **别只拷 `portal.sqlite`**，WAL 模式会丢最新写入）。

### 7.1 升级到 Sprint 1（服务注册表 / 服务墙）

**结论先说：这次升级不动任何已有数据，也不需要改 compose 或 Serve 配置。**

| 项 | 变化 |
| --- | --- |
| 数据库 | 迁移 **v4 `services_registry`** 追加三张新表（`services` / `service_bindings` / `service_preferences`） |
| 已有表 | 用户、会话、偏好、设置、审计、TOTP **一列未改**（升级不改写任何既有行） |
| 环境变量 | **无新增**（发现规则与探测超时是代码常量；健康目标按服务存在库里） |
| 卷 | 不变（`homeport-data:/data`） |
| Tailscale Serve | 不变（门户**只读** serve 配置，不会去写 `tailscale serve`） |
| 首页 | **`/` 从「总览」变为「服务墙」，总览迁到 `/overview`**（书签请更新；侧栏已同时提供两个入口） |

升级步骤（NAS / 任意 Docker 主机，保持数据卷不动）：

```bash
# 1) 一致性备份（§10 方案 A：不停服务；或方案 B：停容器后整卷打包）
docker exec -e NODE_PATH=/app/node_modules homeport-portal \
  node -e "const D=require('better-sqlite3');const db=new D('/data/portal.sqlite');db.exec(\"VACUUM INTO '/tmp/snap.sqlite'\");db.close()"
docker cp homeport-portal:/tmp/snap.sqlite ./portal-pre-sprint1.sqlite

# 2) 给当前镜像打回滚标签（出问题能秒退）
docker tag homeport:local homeport:pre-sprint1     # CI 镜像换成对应 tag

# 3) 升级（数据卷不动！绝对不要 docker compose down -v）
docker compose stop homeport
docker compose up -d --build homeport              # 或 docker compose pull homeport && docker compose up -d

# 4) 确认迁移已应用 + 数据无损
docker compose logs homeport | grep -i migration   # 若日志级别未开启，用 §5 的方式进库查
docker exec -e NODE_PATH=/app/node_modules homeport-portal node -e "const D=require('better-sqlite3');const db=new D('/data/portal.sqlite',{readonly:true});console.log(db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all());db.close()"
```

打开首页后应能看到服务墙；若提示 `serve` 数据源不可用，说明当前是 **API 模式** ——
serve 路由需要 CLI 模式（§4 与 `02-configuration.md` §2 的说明），不是升级失败。

**回滚**（迁移 v4 是纯追加，回滚安全 —— 旧版本代码看不到这三张表也不会报错）：

```bash
docker compose stop homeport
docker tag homeport:pre-sprint1 homeport:local      # 或改 compose 里的 image 标签
docker compose up -d homeport                       # 旧镜像照常启动，v3 数据结构完好
```

只有在**确认不再回滚**时才清理新表（可选，且务必先备份）：

```sql
DROP TABLE IF EXISTS service_bindings;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS service_preferences;
DELETE FROM schema_migrations WHERE version = 4;
```

> 手工删 `schema_migrations` 那行是为了让下次升级能重跑 v4；如果只删表不删这行，
> 新版代码启动会认为迁移已应用 → 表不存在 → 接口 500。**两者必须一起处理**。

### 7.2 升级到 Sprint 2（轻量历史监控、健康与告警）

**结论先说：这次升级同样不动任何已有数据，不需要改 compose 或 Serve 配置；
而且默认什么都不会往外发、也不会去重启任何容器。**

| 项 | 变化 |
| --- | --- |
| 数据库 | 迁移 **v5** 追加三张新表（`metric_buckets` / `alert_rules` / `alert_events`）；**迁移只建结构，不塞业务数据**（四条内置规则由启动时 `ensureBuiltinRules()` 幂等补齐） |
| 已有表 | 用户、会话、偏好、设置、审计、TOTP、服务注册表 **一列未改** |
| 环境变量 | 新增 6 个，**全部有默认值，可以不设**（见 `02-configuration.md`） |
| 卷 | 不变（`homeport-data:/data`）—— 但库会**持续增长**，见下面"库增长预算" |
| 首页 | 不变；侧栏新增 `历史`（`/history`）与 `告警`（`/alerts`）两个入口 |
| 出站行为 | **无**：Sprint 2 没有任何通知通道（邮件/Webhook 是 Sprint 4）。告警只写站内事件 + 审计 |
| 容器操作 | **无**：后台任务只有读能力（源码级守卫测试 `backgroundBoundary.test.ts` 钉住） |

升级步骤（与 §7.1 相同节奏，保持数据卷不动）：

```bash
# 1) 一致性备份（§10 方案 A；不要用 docker cp 直接拷运行中的 WAL 库）
docker exec -e NODE_PATH=/app/node_modules homeport-portal \
  node -e "const D=require('better-sqlite3');const db=new D('/data/portal.sqlite');db.exec(\"VACUUM INTO '/tmp/snap.sqlite'\");db.close()"
docker cp homeport-portal:/tmp/snap.sqlite ./portal-pre-sprint2.sqlite

# 2) 打回滚标签
docker tag homeport:local homeport:pre-sprint2

# 3) 升级（数据卷不动！绝对不要 docker compose down -v）
docker compose stop homeport
docker compose up -d --build homeport

# 4) 确认 v5 已应用，并看采集是否在跑
docker exec -e NODE_PATH=/app/node_modules homeport-portal node -e "const D=require('better-sqlite3');const db=new D('/data/portal.sqlite',{readonly:true});console.log(db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all());console.log(db.prepare('SELECT resolution,COUNT(*) n FROM metric_buckets GROUP BY resolution').all());db.close()"
```

打开 `/history`：**刚升级完是空的，这是正确的** —— 历史只能从"装上新版之后"开始积累，
它不会、也不该凭空补出升级之前的数据（空态文案会说明这一点）。
`/alerts` 会列出四条内置规则且**默认全部关闭**（"装了但不吵"）。

**库增长预算**（依据 `docs/sprint2-implementation-spec.md` §1.1，按"3 磁盘 + 10 容器 + 7 服务"基准）：

| 项 | 数值 |
| --- | --- |
| 每分钟写入 | ≈ 36 行（host 3 + 磁盘 6 + 容器 20 + 服务 7） |
| minute 分辨率 | 约 51,840 行/天，**只保留 24h → 稳态不累积**（≈10–12 MB） |
| hour 分辨率 | 864 行/天，保留 30 天（≈5–6 MB） |
| **稳态总量** | **≤ 32 MB**（含索引与空闲页） |
| 单次 tick 开销 | 一次 `SystemProvider.snapshot()`（原本 SSE 也在用）+ 一次容器列表**缓存**读；不新增 docker API 频率 |

随时用 `GET /api/metrics/storage` 核对实际值（行数、`page_count × page_size`、保留配置、
按当前速率外推的日增）。**判断有没有泄漏看这一条**：minute 行数应当**不随运行时长增长**
（保留窗口滚动）；如果它持续单调上升，说明保留清理没生效，而不是"数据多"。

调优（界面上改，`live` 生效、无需重启）：

| 键 | 建议 | 说明 |
| --- | --- | --- |
| `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` | `60` | 采样间隔。拉到 60 后 minute 桶期望样本数为 1，库与 CPU 都更省 |
| `PORTAL_METRICS_CONTAINER_LIMIT` | `5` | 只采前 N 个关键容器；`0` = 完全不采容器指标 |
| `PORTAL_METRICS_RETENTION_MINUTE_HOURS` | `12` | 只要 12 小时细粒度曲线 |
| `PORTAL_HEALTH_PROBE_INTERVAL_SEC` | `600` | HTTP 探测间隔；`0` = **关闭自动探测**（只留容器维度判定与手动探测） |
| `PORTAL_HEALTH_PROBE_CONCURRENCY` | `2` | 同时最多几个探测在飞，超出的轮到下一轮 |

**告警运维**

- 默认四条内置规则（磁盘 >85% 持续 10 分钟、内存 >90% 持续 5 分钟、容器异常退出、
  服务连续 3 次失败）**全部 `enabled = 0`**。开启方式：`/alerts` 页（管理员）打开开关、
  改阈值/持续时长/静默周期，或 `PATCH /api/alerts/rules/:id`。
- **静默周期（`silenceSec`，默认 3600）**决定"多久之内不重复刷屏"：同一规则同一目标在恢复后
  一小时内再次触发，只会**重开同一条事件**（`reopenCount` 递增），不会新增一条。
- **确认（ack）**只表示"人已看到"，不改变判定；已确认的事件若再次重开会**清空确认**
  （说明它又需要人关注了）。
- 状态变化全部进审计，动作名：`alert.rule_updated` / `alert.fired` / `alert.reopened` /
  `alert.resolved` / `alert.acknowledged`（不含任何凭据）。
- "没有告警"有两种可能，必须分清：条件没成立，还是**被静默压掉了**。后者计入 `suppressed`，
  在 `GET /api/alerts/summary` 与日志里可见。

**回滚**（v5 也是纯追加，回滚安全）：

```bash
docker compose stop homeport
docker tag homeport:pre-sprint2 homeport:local
docker compose up -d homeport                       # 旧镜像照常启动，v4 数据结构完好
```

确认不再回滚后才清理（先备份）：

```sql
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS alert_rules;
DROP TABLE IF EXISTS metric_buckets;
DELETE FROM schema_migrations WHERE version = 5;
```

> 与 v4 同理：**删表和删 `schema_migrations` 那行必须一起做**。
> v5 的三张表是**互相独立**的追加，不会影响服务注册表（v4）。

## 8. 资源占用与调优

| 场景 | 调整 |
| --- | --- |
| 容器很多（>30） | `PORTAL_CACHE_CONTAINERS_TTL_MS=5000`，减少 inspect 次数 |
| NAS 性能弱 | `PORTAL_METRICS_INTERVAL_MS=10000`，降低采样与推送频率 |
| tailnet 设备多 | `PORTAL_CACHE_TAILSCALE_TTL_MS=30000`，减少 fork `tailscale` |
| 工具很多 | `PORTAL_TOOLS_PROBE_TTL_MS=60000`，减少探测 |
| 内存紧张 | 镜像基于 alpine，运行时无 devDependencies；实测常驻约 60-90 MB |
| NAS 性能弱（含历史采集） | `PORTAL_METRICS_INTERVAL_MS=10000` 降推送；后台采集另见 §7.2 的表：`PORTAL_METRICS_SAMPLE_INTERVAL_SEC=60`、`PORTAL_METRICS_CONTAINER_LIMIT=5`、`PORTAL_HEALTH_PROBE_INTERVAL_SEC=600` |

> **后台采集与 SSE 是两回事**：`PORTAL_METRICS_INTERVAL_MS` 只管"往浏览器推多快"，
> 影响的是打开页面时的推送频率；**历史采集由 `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` 决定，
> 与浏览器开不开、开几个标签页都无关**（进程内只有一个采样器，见 §7.2 与
> `docs/sprint2-implementation-spec.md` §3）。调优时别只调前者。

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

反代不在回环地址上时，还要显式配 `PORTAL_TRUST_PROXY`（默认 `loopback`），
否则登录限流会把所有请求归到同一个 IP 桶。设成 `1` 等于"相信任何来源的转发头"，
只有确认反代**不可绕过**时才这么配（安全侧理由见 `06-security.md` §5）。

## 10. 主密钥与备份（Sprint 0 起必读）

**加密的东西只有配对的密钥才能读回。** 主密钥默认由门户自己生成在数据卷里：

```
/data/portal.sqlite      # 业务数据（敏感设置项与 TOTP 种子在里面是 enc:v1:… 密文）
/data/secret.key         # 主密钥（0600），与数据库同一个卷
/data/setup-token.txt    # 首启令牌（初始化后可删）
```

| 项 | 说明 |
| --- | --- |
| 密钥来源优先级 | `PORTAL_SECRET_KEY`（宿主环境变量）→ `PORTAL_SECRET_KEY_FILE`（默认 `/data/secret.key`，文件存在即读取）→ 自动生成并写入该文件（`0600`） |
| 加密范围 | `settings` 表里标 `sensitive` 的键（如 Tailscale API Token）**+ 用户的 TOTP 种子** |
| 轮换密钥 | 把**旧**密钥填进 `PORTAL_SECRET_KEY_PREVIOUS`（逗号分隔，只用于解密），再换主密钥；启动时 `reencryptAll()` 会把老密文升级到新密钥，升级完成后日志里会有一条 `info`（含条数），确认无误再摘掉 `PORTAL_SECRET_KEY_PREVIOUS` |
| 密钥丢失 | 已加密值**不可逆**：敏感设置按"未设置"处理（重填一次即恢复）；已绑定 TOTP 的账号动态码校验不通过 —— 但**恢复码仍可用**（它走 sha256 摘要校验，不经过主密钥），否则走 §5 的重置流程重新绑定 |
| 底线 | 未启用两步验证的账号照旧用密码登录，门户不会整体锁死 |

### 备份

**必须把密钥与数据库一起备份**（分开备份 = 恢复时读不出敏感字段）：

> **⚠️ 千万不要只拷 `portal.sqlite`。** 数据库跑在 **WAL 模式**下，已提交的数据可能还留在
> `portal.sqlite-wal` 里没有 checkpoint 回主文件。Sprint 1 实测：主库文件停在 `03:59`，
> 而同目录的 `portal.sqlite-wal` 有 140KB —— **v3 迁移记录与近期审计全在 WAL 里**，
> 直接拷主文件的"备份"能正常打开、看起来没问题，却悄悄少了几小时的数据（含迁移状态，
> 恢复后可能被判定为"未迁移"而重跑）。`portal.sqlite-shm` / `portal.sqlite-wal` 是数据库的一部分。

推荐两种做法，按"能不能停容器"选：

**A. 不停服务：用 SQLite 自己导出一致快照（推荐，日常用它）**

```bash
# 容器内导出到 /tmp（不动正在服务的库）
docker exec -e NODE_PATH=/app/node_modules homeport-portal \
  node -e "const D=require('better-sqlite3');const db=new D('/data/portal.sqlite');db.exec(\"VACUUM INTO '/tmp/snap.sqlite'\");db.close()"
docker cp homeport-portal:/tmp/snap.sqlite ./portal-$(date +%Y%m%d-%H%M%S).sqlite
```

Windows（PowerShell）把脚本落成文件再拷进去，避免嵌套引号被 PowerShell 吃掉：

```powershell
# 脚本内容见仓库外维护的 db-consistent-export.js（Sprint 1 验证时使用）
docker cp .\db-consistent-export.js homeport-portal:/tmp/
docker exec -e NODE_PATH=/app/node_modules homeport-portal node /tmp/db-consistent-export.js
docker cp homeport-portal:/tmp/consistent.sqlite .\portal-live.sqlite
```

导出完成后务必核对（脚本已内置）：`schema_migrations` 的版本列表、`users`/`audit_log` 条数、
`pragma integrity_check` = `ok`。这条路径**必须再单独备份 `secret.key`**，否则密文读不回来。

**B. 能停服务：整卷打包（最稳，且顺带包含密钥）**

```bash
docker compose stop homeport     # 停写，保证 WAL 已 checkpoint
docker run --rm -v homeport-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/homeport-data-$(date +%Y%m%d-%H%M%S).tgz -C /data .
docker compose start homeport
```

Windows（PowerShell）：

```powershell
docker compose stop homeport
docker run --rm -v homeport-data:/data -v "${PWD}:/backup" alpine `
  tar czf /backup/homeport-data-$(Get-Date -Format yyyyMMdd-HHmmss).tgz -C /data .
docker compose start homeport
```

> 注意 `docker run ... tar` 在**容器仍在写**的情况下读取卷，理论上是活文件拷贝，
> 一致性没有保证 —— 所以这里显式 `stop` 再打包。若不能停机，用 A 方案。

恢复：`docker compose down` → 把压缩包解回卷 → `docker compose up -d`：

```bash
# 先确认要恢复的是哪个归档（<时间戳> 换成实际值）
docker run --rm -v homeport-data:/data -v "$PWD:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/homeport-data-<时间戳>.tgz -C /data'
docker compose up -d
```

换机器恢复时确认 `secret.key` 也在包里，否则 Token 需要重填、TOTP 需要重新绑定。

> 需要更强隔离时，显式提供 `PORTAL_SECRET_KEY`（宿主环境变量或 compose 的 `secrets`），
> 把密钥与数据卷**分开**存放 —— 这样"数据库卷被拷走"也不足以解密。
> 注意：改用显式密钥后，原来的 `/data/secret.key` 就作废了，迁移期间要先用
> `PORTAL_SECRET_KEY_PREVIOUS` 过渡。

## 11. 容器最小权限（`docker.sock`）

门户要读 Docker 才能展示容器墙，所以必须碰到 socket。Sprint 0 起默认 compose 已收紧：

| 措施 | 作用 |
| --- | --- |
| `docker.sock` 以 **`:ro`** 挂载 | 容器内进程无法改写 socket 文件本身 |
| `cap_drop: ALL` | 去掉全部 Linux capability（门户不需要任何一项） |
| `security_opt: no-new-privileges:true` | 禁止通过 setuid/setgid 提权 |
| 非 root `node` 用户 + 只读展示 | 门户在类型层面就不存在 Docker 写方法 |
| 宿主磁盘挂载**默认全部注释** | 默认挂 `C:/` 会让 Linux/NAS 起不来；按需启用并同步 `PORTAL_DISK_MOUNTS`（见 §3.1） |

### 为什么 `:ro` 不够

`:ro` 只是**挂载层面**的只读：Docker 的 HTTP API 完全看不到挂载选项，
容器内的进程依然可以对 socket 发 `POST /containers/{id}/stop` 这类**写请求**。
也就是说，`:ro` 挡得住"改写 socket 文件"，挡不住"通过 socket 指挥 Docker 守护进程"。

### 可选的只读 socket 代理（推荐给"门户进程可能被攻破"的场景）

仓库提供了覆盖文件 `docker-compose.socket-proxy.yml`：门户不再直连 socket，
而是连一个只放行读取接口的 HAProxy 代理（`tecnativa/docker-socket-proxy`）。

```bash
docker compose -f docker-compose.yml -f docker-compose.socket-proxy.yml up -d --build
```

- 放行清单按代码实际用到的接口列：`CONTAINERS` / `INFO` / `VERSION` / `PING`
  （即 list / inspect / logs / stats / info / 探活）；`POST` / `EXEC` / `BUILD` /
  `SECRETS` / `SYSTEM` 等写接口显式关闭。
- 代理**不 publish 到宿主端口**（只在 compose 网络内 `expose: 2375`），
  门户通过服务名 `tcp://docker-socket-proxy:2375` 访问。
- 收益：任何写操作在代理层被拒，与门户代码是否有漏洞**无关** —— 这是结构性保证。
- 代价：多一个约 20MB 的容器，每次 Docker API 调用多一跳 HTTP（同 compose 网络内，<1ms）。
- 以后门户需要展示镜像/网络/卷的**额外**信息时，再把对应开关置 `1`（如 `IMAGES: 1`），
  不要图省事全开。

### 没有默认开启的：只读根文件系统

`docker-compose.yml` 里 `read_only: true` 与 `tmpfs: /tmp` 是**注释示例**，默认不开。
原因：NAS 上的 Docker/Compose 版本差异较大，个别版本对
`read_only` + 命名卷 + `group_add` 的组合处理不一致，而它带来的额外收益
小于"部署直接起不来"的风险。要开就按注释里那两行开（`/data` 必须保持可写：
SQLite、首启令牌与主密钥都写在那里），并在验证过版本后再用于生产。

## 12. CI 质量门与本地 E2E

### 12.1 两个工作流的分工

| 工作流 | 触发 | 做什么 | 权限 |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | 所有 `pull_request`、`master` 的 push、手动 `workflow_dispatch` | `quality`（typecheck → `npm test` → `npm run build` → 校验构建产物存在）+ `e2e`（Playwright 冒烟，`needs: quality`） | 仅 `contents: read`，**不引用任何 secret** |
| `.github/workflows/docker-publish.yml` | `master` 的 push、`v*` tag、手动 | `quality`（同样的 typecheck / test / build）+ `build-and-push`（多架构镜像推 GHCR） | `quality` 为 `contents: read`；`build-and-push` 另需 `packages: write` |

- **`ci.yml` 刻意没有 `paths-ignore`**：如果 CI 只在代码变动时跑，纯文档 PR 就不产生任何
  check；一旦分支保护要求"check 必须通过"，这类 PR 会永久停在 pending。宁可多跑一次。
- `docker-publish.yml` **有** `paths-ignore`（`**.md` / `docs/**` / `LICENSE` /
  `docker-compose*.yml`），因为纯文档与 compose 改动不影响镜像内容。
- 发布门禁**重复**了 `ci.yml` 的步骤而不是复用它：两个工作流触发条件不同，
  且门禁必须**自证**（依赖另一个工作流的结论会引入"那个工作流被跳过或改名后门禁静默失效"
  的风险）。`server/tests/ciWorkflow.test.ts` 会在两边步骤不一致时打红。
- 权限边界：`docker-publish.yml` 没有 `pull_request` 触发，外部 fork 的 PR 拿不到
  `secrets.GITHUB_TOKEN` 与 `packages: write`。

### 12.2 E2E 是不是发布前置？

- 在 `ci.yml` 里 `e2e` 依赖同文件的 `quality`，因此 PR 上是**必过检查**（配合分支保护）。
- 在 `docker-publish.yml` 里 `build-and-push` **只**依赖同文件的 `quality`：
  **E2E 目前不是发布依赖** —— 镜像发布只被"类型检查 + 单测 + 构建"卡住。
- 想让 E2E 也成为发布前置，需要两步：①在 `docker-publish.yml` 里也定义一个 `e2e` job；
  ②把依赖改成一行：

  ```yaml
    build-and-push:
      needs: [quality, e2e]
  ```

  ⚠️ `needs` 只能引用**同一个工作流文件内**的 job —— 不能写 `needs: e2e` 去引用 `ci.yml`
  的 job（GitHub Actions 不支持跨工作流依赖）。所以只改这一行而不加 job 会让工作流直接失效。

### 12.3 本地跑 E2E

```bash
npm run test:e2e          # = playwright test
```

| 项 | 值 | 原因 |
| --- | --- | --- |
| 默认端口 | **8988**，`PORTAL_E2E_PORT` 可覆盖（PowerShell：`$env:PORTAL_E2E_PORT='9001'; npm run test:e2e`） | 刻意避开生产端口 **8899**：开发机上常跑着 `homeport-portal` 容器占着 8899，而配置要求 `reuseExistingServer: false`（绝不复用可能在跑的旧代码），两者相撞会直接报端口已被占用 |
| 启动方式 | `npm run e2e:serve`（= `node e2e/start-server.mjs`），由 Playwright 的 `webServer` 拉起 | 启动脚本**先跑完整生产构建**（`npm run build`），保证被测的就是生产产物，而不是某次遗留的旧 dist |
| 数据目录 | 每次启动前**清空** `.e2e-data`（已在 `.gitignore`） | 「首启初始化」这条流程必须能反复运行，否则第二次会撞上"系统已初始化" |
| 数据源 | `DOCKER_ENDPOINT=/nonexistent/docker.sock`、`PORTAL_TAILSCALE_MODE=off` | 冒烟要验证的正是"数据源不可用时显示降级提示而不是白屏"，所以不连真 Docker |
| 首启令牌 | 固定测试值 `E2E-TEST-TOKEN-0000-0000`（`PORTAL_E2E_SETUP_TOKEN` 可覆盖） | 不是任何真实密钥 |
| 执行方式 | 串行（`workers: 1`、`fullyParallel: false`） | 所有用例共用同一个 SQLite 库与同一个服务进程，首启初始化只能执行一次 |
| 首次耗时 | 数十秒到数分钟 | 先完成完整生产构建，`webServer.timeout` 给到 5 分钟，单用例 60 秒 |
| 失败产物 | `playwright-report/`、`test-results/`（均被忽略） | CI 上失败会自动上传 `playwright-report/` |

覆盖范围（**不写具体用例数**，数字会随迭代变化）：首启初始化（错误令牌被拒 / 正确令牌
创建管理员）→ 登录与登出、受保护路由回跳 → 关键页面在 Docker 与 tailnet 均不可用时显示
降级提示而非白屏 → viewer/admin 权限边界 → 安全响应头（首页带 CSP 与 `nosniff`，
且 CSP 不阻断门户自身前端产物）。用例见 `e2e/smoke.spec.ts` 与 `e2e/security-headers.spec.ts`。
