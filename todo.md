# TODO

> 最后更新：2026-10-16

## 已完成 ✅

### 基础设施
- [x] npm workspaces 单仓库（`server` / `web`），TypeScript 5.9 strict 模式
- [x] 统一配置层 `server/src/config.ts`（唯一 `process.env` 读取点，非法值启动即报错）
- [x] 结构化日志（不引入 pino）
- [x] SQLite + 迁移框架（版本化、独立事务、失败回滚）
- [x] 统一错误契约 `{ error: { code, message, details } }`
- [x] `.gitattributes` 统一换行符

### F1 容器入口墙
- [x] Docker 只读数据源（dockerode；**类型层面不存在写方法**）
- [x] endpoint 解析：npipe / unix / tcp / http / https（含 named pipe 归一化）
- [x] 容器列表（list + 有限并发 inspect，8 路并发）
- [x] **tailnet 可达性判定**：按宿主端口绑定地址分类
- [x] 入口 URL 生成：两层设计（缓存算可达性，响应阶段按访问者算 URL）
- [x] 多候选入口（tailnet IP / MagicDNS / localhost）
- [x] 容器详情：实时占用、端口表、挂载、脱敏环境变量、日志
- [x] tailscale sidecar 识别（`TS_*` 环境变量或镜像名）

### F2 tailnet 设备
- [x] CLI 数据源（`tailscale status --json`）
- [x] REST API 数据源（`/api/v2/tailnet/-/devices`）
- [x] `auto` 策略自动选择
- [x] 设备映射（在线状态、OS、IP、直连/中继、最后可见、流量）
- [x] 单向寄存器解开 `docker ↔ tailscale` 模块环
- [x] 数据源失败时保留上次地址（避免整面容器墙误判不可达）

### F3 系统指标
- [x] 宿主 `/proc` 读取（CPU/内存/负载/运行时长/CPU 型号）
- [x] `os.cpus()` 兜底（用于无 `/proc` 的环境）
      **实测修正**：该路径在 **Windows 容器化** 下只能看到 WSL2 虚拟机资源
      （4 线程 / 3.9 GB），不是 Windows 真实值；要拿真实值需原生运行。见 `08-operations.md` §2
- [x] 采样间隔保护（避免 CPU 读数抖动）
- [x] 磁盘 `statfs`（可配多挂载点）
- [x] GPU：`nvidia-smi` 多字段查询 + 占用进程 + WSL 库路径支持
- [x] 数据源模式标注（`host-proc` / `os-cpus` / `container-proc` / …）
- [x] SSE 实时推送（心跳、最长存活、自动重连）

### F4 工具入口
- [x] 内置目录 8 个（Ollama / DSH / ComfyUI / Open WebUI / Portainer / Jellyfin / qBittorrent / code-server）
- [x] JSON 文件覆盖（按 id 合并或整体替换）
- [x] `PORTAL_TOOLS_EXTRA` 环境变量追加
- [x] 两级探测（TCP → HTTP）+ TTL 缓存 + 后台刷新（stale-while-revalidate）
- [x] 多候选入口 + 单工具强制重探

### F5 登录权限
- [x] bcrypt cost 12 + 密码强度校验
- [x] 会话令牌（DB 只存 SHA-256）+ httpOnly Cookie
- [x] CSRF 独立令牌 + 请求头校验
- [x] 首启初始化（令牌来自环境变量 / 文件 / 日志）
- [x] 角色守卫（admin / viewer）+ "最后一个管理员"保护
- [x] 用户管理：增删改、重置密码、强制下线
- [x] 审计日志（16 种动作）+ 90 天清理
- [x] 登录限流 10 次/分钟/IP
- [x] 用户枚举防护（统一报错 + 耗时抹平）
- [x] 自助改密（保留当前会话，吊销其它）

### F6 运行时设置（界面内改配置，免重建容器）
- [x] 迁移 v2 `settings` 表 + `SettingsRepository`
- [x] 三层优先级：数据库覆盖 > 环境变量 > 内置默认
- [x] 28 项设置的注册表（分组 / 生效级别 / 类型 / 范围 / 敏感标记）
- [x] 三级生效语义：`live` / `reload`（自动重建数据源）/ `restart`（拒绝写入）
- [x] 热重建：Tailscale 数据源、Docker 连接、容器缓存 TTL、/proc 读取器
- [x] `GET/PATCH /api/settings`、`POST /api/settings/reset`
- [x] `POST /api/settings/test/tailscale`：**先测再存**，401/403/超时给出可操作提示
- [x] 敏感值打码读取、占位符写入 = 不修改、审计只记键名
- [x] 前端「账号管理 → 系统设置」面板：分组展示 + 生效级别徽标 + 来源徽标 + 测试连接
- [x] 明确标注硬边界（需重建容器的项不给编辑控件）

### 前端
- [x] React 19 + Vite 6 + Tailwind 4 + React Router 7
- [x] 类型化 API 客户端（CSRF 自动注入、401 回调、超时）
- [x] 会话 Context（含主题防闪白、偏好同步）
- [x] 12 个 UI 原子组件（含内联 SVG 图标集）
- [x] 侧边栏布局（桌面固定 / 移动抽屉）
- [x] 7 个页面 + 404
- [x] 路由守卫（登录态、初始化态、管理员）
- [x] SSE 指标流订阅
- [x] 暗色/亮色/跟随系统三态主题

### 容器化与文档
- [x] 四阶段 Dockerfile（alpine、非 root、tini、healthcheck）
- [x] `docker-compose.yml`（Windows 与 NAS 同一份）
- [x] `.env.example`（含分平台部署矩阵）
- [x] `docs/static/` 9 个静态文档
- [x] `README.md`
- [x] 129 个测试用例（3 个文件）全部通过
- [x] 真实环境实测（Docker + Tailscale + 硬件，逐项交叉验证）

## 待办

### 高优先级（影响可用性）

- [x] **镜像构建实测**：Windows Docker Desktop 上 `docker compose up -d --build`
      首次即成功，容器 `Up (healthy)`，五个数据源状态符合预期（2026-10-16）
- [x] **工具探测目标主机 bug**：容器内 `localhost` 指向容器自己，导致 8 个工具全报不可用。
      已改为多目标链（对外主机 → `host.docker.internal` → `127.0.0.1`）并重新验证（2026-10-16）
- [ ] **arm64（NAS）镜像构建实测**：设计上应可成功（builder 阶段原生编译
      better-sqlite3），但尚未实跑
- [ ] **Windows 宿主真实硬件指标**：容器化部署只能看到 WSL2 虚拟机资源。
      可选方案：
      1. 补充「原生运行」的部署文档与一键启动脚本（推荐，实测可行）
      2. 增加 Windows 专用 GPU provider：容器内无法执行 `nvidia-smi.exe`，
         若坚持容器化则只能放弃 GPU 指标
      3. 在 UI 上检测到"WSL2 视图"时主动提示用户可改用原生运行
- [ ] **检测 WSL2 视图并提示**：目前 `os-cpus` 模式下无法区分
      "macOS 原生（真实值）"与"Windows 容器（WSL2 视图）"。
      可用 `cgroup` CPU 配额与 `os.cpus().length` 的差异做启发式判断
- [ ] **Windows tailnet 查询体验**：需要手动切 `PORTAL_TAILSCALE_MODE=api` 并填 Token。
      可在检测到 CLI 不可用时于设备页直接给出可点击的管理后台链接
- [ ] **首次部署引导页**：`/api/health` 已能报告各数据源问题，
      可在总览页把 warnings 变成"点这里看怎么修"的可展开清单

### 中优先级（增强）

- [ ] **敏感项加密存储**：当前 API Token 在数据库中明文保存（需回读调用外部 API）。
      可用宿主环境变量保存主密钥，对 `sensitive` 项做 AES-GCM 加密。
      见 `06-security.md` §7
- [ ] **工具目录可视化编辑**：现在只能填 JSON 文件路径，不能增删改单条工具
- [ ] **设置并发冲突检测**：两个管理员同时改会后者覆盖前者。可用 `updated_at` 做乐观锁
- [ ] **TOTP 二次验证**：为 admin 账号增加可选的两步验证
      （需要二维码生成 + 恢复码管理，见 `06-security.md` §9.1）
- [ ] **安全响应头**：引入 `@fastify/helmet`，配置 CSP（当前无 CSP/HSTS）
- [ ] **容器 list 性能**：容器数 >50 时，list+inspect 的耗时可能超过缓存 TTL。
      可改为增量：先 list 比对 ID，只对新容器 inspect
- [ ] **历史趋势图**：目前只有瞬时值。可加环形缓冲区记录最近 N 分钟 CPU/内存，
      前端画折线（注意 NAS 内存占用，建议只保留内存内数据不落盘）
- [ ] **tailscale serve 集成**：对通过 `tailscale serve` 暴露的服务，
      读取 serve 配置以生成准确的入口 URL（当前只识别 sidecar 并打 badge）
- [ ] **通知**：容器退出、磁盘将满、登录失败次数异常时推送（可选 webhook / ntfy）
- [ ] **i18n**：当前硬编码中文，可抽出词条支持英文

### 低优先级（可选）

- [ ] 容器写操作（start/stop/restart）——**需先重新评估威胁模型**，
      见 `06-security.md` §9.5。若要做，建议独立角色 `operator` 并强制二次确认
- [ ] 反向代理模式：内嵌其它 Web 应用（而非跳转）。需要处理 base path、
      WebSocket、Cookie 域、CSP，维护成本高，见 `01-architecture.md` §6
- [ ] 主题自定义色板
- [ ] 导出审计日志为 CSV
- [ ] 支持 PostgreSQL（当前 SQLite 足够，仅在多实例部署时才有必要）

## 技术债

- [ ] `server/src/modules/docker/service.ts` 已 559 行，映射逻辑（`mapPorts` 等）
      可拆到独立的 `mapper.ts`
- [ ] `web/src/pages/AdminPage.tsx` 已 651 行，三个标签页应各自拆文件
- [ ] 前端缺测试（当前只有后端 129 个用例）。建议至少为
      `api/client.ts`（CSRF 注入、错误转换）与 `lib/format.ts` 加单测
- [ ] `TtlCache` 的 `evictIfNeeded` 每次都全量遍历，条目数大时是 O(n)。
      当前 maxEntries=200，暂不构成问题
- [ ] 无 E2E 测试（Playwright）。关键路径：首启初始化 → 登录 → 各页面加载
- [ ] 未配置 CI（建议：typecheck + test + build 三件事）

## 环境备忘

本机（开发环境）实测结果：

| 项目 | 值 |
| --- | --- |
| Docker | 29.8.0，Docker Desktop，容器内 endpoint = `unix:///var/run/docker.sock` |
| 现有容器 | 6 个（cs22-backend / cs22-web / cs22-ml-service / sisi-calendar / worldforge / homepage-portal 自身） |
| Tailscale | 1.102.4，本机 `Sisi-Laptop` / `100.72.255.29`，11 台设备 |
| GPU | RTX 4060 Laptop 8G。**容器化下不可读**（容器内无 `/usr/lib/wsl/lib`）；原生运行可读 |
| Node | v22.23.2 |
| 平台 | Windows 11，宿主 20 线程 / 31.63 GB；容器内只可见 WSL2 的 4 线程 / 3.9 GB |

部署状态（2026-10-16）：

- 容器 `homepage-portal` 已构建并运行，`Up (healthy)`，映射 `0.0.0.0:8899->8899`
- 数据卷 `homepage-data` 持久化，重建容器后 admin 账号与偏好保留
- 登录账号：`admin` / `********`（**建议登录后立即修改**）
- 访问地址：`http://100.72.255.29:8899`（tailnet）或 `http://localhost:8899`
