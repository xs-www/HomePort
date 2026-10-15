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
- [x] `os.cpus()` 兜底（Windows/macOS，仍是宿主真实值）
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
- [x] 审计日志（14 种动作）+ 90 天清理
- [x] 登录限流 10 次/分钟/IP
- [x] 用户枚举防护（统一报错 + 耗时抹平）
- [x] 自助改密（保留当前会话，吊销其它）

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

- [ ] **镜像构建实测**：在 Windows Docker Desktop 与 arm64 环境分别
      `docker compose up -d --build`，验证原生模块编译与运行时行为
      - 当前未执行，`Dockerfile` 的正确性只在设计层面验证
      - 需要确认：`npm ci` 在 alpine 上能编译 better-sqlite3；
        `npm prune --omit=dev` 后 `better-sqlite3` 的 `.node` 产物仍在
- [ ] **Windows tailnet 查询体验**：当前需手动切 `PORTAL_TAILSCALE_MODE=api`。
      可考虑在检测到 `win32` 宿主且 CLI 不可用时，在 UI 上直接提示并提供配置指引链接
- [ ] **Windows `/proc` 自动判断**：目前若用户挂了 `/proc`，会优先用 `host-proc` 模式，
      但 Docker Desktop 下那是 WSL2 视图。可按宿主平台自动跳过该挂载
- [ ] **首次部署引导页**：在 `/api/health` 显示各数据源问题时，于总览页给出
      "点这里看怎么修"的可展开清单（现在已有 warnings，但缺少操作指引）

### 中优先级（增强）

- [ ] **TOTP 二次验证**：为 admin 账号增加可选的两步验证
      （需要二维码生成 + 恢复码管理，见 `06-security.md` §8.1）
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
      见 `06-security.md` §8.5。若要做，建议独立角色 `operator` 并强制二次确认
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
| Docker | 29.8.0，Docker Desktop，endpoint = `npipe:////./pipe/dockerDesktopLinuxEngine` |
| 现有容器 | 5 个（cs22-backend / cs22-web / cs22-ml-service / sisi-calendar / worldforge） |
| Tailscale | 1.102.4，本机 `Sisi-Laptop` / `100.72.255.29`，11 台设备 |
| GPU | RTX 4060 Laptop 8G（宿主可见；容器内需挂载 nvidia-smi） |
| Node | v22.23.2 |
| 平台 | Windows，`os.cpus()` 兜底路径生效（20 线程） |
