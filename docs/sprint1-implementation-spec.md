# Sprint 1 实施规格（冻结契约）

> 本文件是 Sprint 1 的**唯一实现依据**。所有并行实施（server 核心 / server API / web）都必须严格
> 按本文的字段名与行为实现，不得各自发挥；发现本文有问题时**先改本文再改代码**。
>
> 目标来源：`docs/HomePort_2.0_Balanced_Development_Plan.md` §4（S1-01…S1-05 与 4 条验收用例）。

---

## 0. 现状与复用（禁止重造）

已有原语（Sprint 1 直接复用，不改语义）：

| 能力 | 位置 | 用途 |
| --- | --- | --- |
| 端口可达性判定、候选入口、serve 路由映射 | `server/src/modules/docker/mapper.ts`（`REACHABILITY_RANK`、`buildCandidates`、`attachHostContext`、`rebuildPortUrls`、`pickPrimaryUrl`、`mapServeRoutes`、`collectReachableHostPorts`） | 服务的候选入口与可达性**不由服务层重新发明** |
| 容器清单/详情（带 TTL 缓存） | `server/src/modules/docker/service.ts` | 服务发现的容器输入 |
| serve 路由 | `server/src/modules/tailscale/serveProvider.ts`（`ServeRoute`）+ `docker/service.ts` 的 `serveRoutes` | Serve 入口来源；CLI 模式才可用，API 模式会如实报不可用 |
| 设备清单 | `server/src/modules/tailscale/*` | 搜索索引（设备） |
| 工具清单 | 现有 tools/settings 能力 | 搜索索引（工具） |
| host 上下文 | `server/src/modules/docker/hostContext.ts` | localhost/tailnet/MagicDNS/LAN 候选主机 |

**关键约束（既有铁律，不得违反）**

1. `process.env` 只允许 `server/src/config.ts` 读取（`server/tests/envBoundary.test.ts` 会扫源码断言）。
2. 所有写接口：认证 + 角色 + CSRF 三件套；匿名 401、viewer 写操作 403。
3. 不得把敏感环境变量、Socket、API Token、私钥返回前端（容器视图已脱敏，服务层不得新开泄露面）。
4. 「容器 ID 不可做长期业务标识」——见 §2 的稳定标识规则。
5. 迁移 append-only、每个版本独立事务、幂等、兼容旧数据（`server/src/db/database.ts` 的 `MIGRATIONS`）。

---

## 1. 数据模型（迁移 v4）

版本：`version: 4, name: 'services_registry'`。三张表，全部 `CREATE TABLE`（新库直接跑 v1→v4）。

```sql
-- 服务注册表：一行 = 用户看到的一个「服务」
CREATE TABLE services (
  id            TEXT PRIMARY KEY,           -- 稳定业务 id：crypto.randomUUID()
  slug          TEXT NOT NULL UNIQUE,       -- 稳定可读键（[a-z0-9-]，由名称派生，冲突加后缀）
  display_name  TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,                       -- 内置图标键（如 'calendar'）或 https URL；见 §6
  category      TEXT,                       -- 自由文本，UI 提供建议值；NULL = 未分类
  preferred_url TEXT,                       -- 用户指定并验证的首选入口（最高优先级）
  source_type   TEXT NOT NULL,              -- 'docker' | 'serve' | 'manual'
  source_ref    TEXT NOT NULL,              -- 稳定来源标识，见 §2；与 source_type 唯一
  binding_refs  TEXT NOT NULL DEFAULT '[]', -- JSON 数组：稳定绑定标识（服务身份用）
  visibility    TEXT NOT NULL DEFAULT 'visible',  -- 'visible' | 'hidden'
  sort_order    INTEGER NOT NULL DEFAULT 100,     -- 越小越靠前
  favorite      INTEGER NOT NULL DEFAULT 0,       -- 0/1
  health_target TEXT,                       -- 可选：显式授权的健康探测目标（URL）
  health_path   TEXT,                       -- 可选：追加到首选入口的路径（如 '/healthz'）
  user_edited   INTEGER NOT NULL DEFAULT 0, -- 1 = 用户改过展示属性（自动发现不得覆盖）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT,
  UNIQUE (source_type, source_ref)
);

-- 当前绑定明细：自动发现每次**重建**（可丢可重算），只用于展示与诊断
CREATE TABLE service_bindings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,            -- 'container' | 'serve'
  ref             TEXT NOT NULL,            -- 稳定标识：容器 = source_ref；serve = serve:<host>:<port><path>
  container_id    TEXT,                     -- 当前容器 ID（**会变**，仅作当前关联，不参与身份）
  container_name  TEXT,
  compose_project TEXT,
  compose_service TEXT,
  scheme          TEXT,
  host            TEXT,
  port            INTEGER,
  path            TEXT,
  url             TEXT,
  reachability    TEXT,                     -- mapper 的 Reachability 原值
  accessible      INTEGER NOT NULL DEFAULT 0,
  rank            INTEGER NOT NULL DEFAULT 100,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (service_id, kind, ref)
);
CREATE INDEX idx_service_bindings_service ON service_bindings(service_id);
CREATE INDEX idx_services_sort ON services(visibility, sort_order, display_name);

-- 单例偏好（KV）：视图模式、上次搜索、折叠的分类等；不含权限敏感内容
CREATE TABLE service_preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**不放进数据库的东西**：候选入口明细、可达性、容器运行态、健康检查结果——全部**实时计算**，
不落库（避免"缓存住的谎话"）。`service_bindings` 只是"上一次发现结果"的快照，用于诊断与重建关联。

---

## 2. 稳定标识与自动发现（S1-01 核心）

### 2.1 稳定来源标识 `source_ref`

| source_type | source_ref 规则 | 说明 |
| --- | --- | --- |
| `docker` | 有 Compose 标签时 `docker:<composeProject>/<composeService>`；否则 `docker:<normalizedName>` | **不含容器 ID** |
| `serve` | `serve:<host-lowercase-no-trailing-dot>:<port><normalizedPath>` | 例 `serve:family-nas.tail585599.ts.net:8443/calendar` |
| `manual` | `manual:<uuid>` | 管理员手工创建 |

`normalizedName`：容器名小写，去掉结尾的副本后缀 `-\d+` / `_\d+`（`xxx-1` → `xxx`）。

**为什么**：容器被重建（ID 变化）时 `source_ref` 不变 → 复用同一行 `services` →
用户改过的名称/图标/顺序/收藏/首选入口**全部保留**，无需重新绑定（验收用例 2）。

### 2.2 发现与合并算法（纯函数，可单测）

输入：`containers: ContainerSummary[]`、`serveRoutes: ServeRouteInput[]`、`hostContext`、
`discovery: { dockerAvailable: boolean; serveAvailable: boolean; serveDetail: string | null }`。

1. **容器 → 服务**：每个容器按 §2.1 得到 `source_ref`，产出候选服务（`source_type='docker'`）。
   同 `source_ref` 的多个容器合并为一个服务（副本场景）。
2. **serve 归属**：对每条 serve 路由，用 `targetPort` 匹配容器的**已发布宿主端口**
   （`ContainerPortView.hostPort`）：
   - 命中唯一容器 → 作为该服务的 `serve` 绑定（例：`8443 /calendar` → `sisi-calendar`）；
   - 命中多个容器（端口冲突）→ 不猜，作为**独立 serve 服务**并在 `reasons` 里说明；
   - 未命中 → 独立 serve 服务（`source_type='serve'`，例：指向门户自身的 443 `/`）。
3. **门户自身**：`targetPort` 命中门户自身宿主端口（如 8899）或路径 `/` 的 serve 路由 →
   归到门户容器对应的服务（验收：HomePort 首选根域名 443 的 `https://…/`）。
4. **自动字段 vs 用户字段**（`user_edited=1` 时一律不覆盖）：
   - 自动可写：`source_ref`/`binding_refs`/`description`（仅当用户没写）、`display_name`（仅当用户没改）、
     `icon`/`category`（仅当为空）、`slug`（仅在服务新建时生成）。
   - 用户字段：`display_name`、`description`、`icon`、`category`、`preferred_url`、`visibility`、
     `sort_order`、`favorite`、`health_target`、`health_path`。**发现过程绝不修改这些**。
   - 用户一旦 PATCH 过展示属性 → 置 `user_edited=1`。
   - 删除语义：`DELETE` 对 `manual` 是删除行；对自动服务是 `visibility='hidden'`；
     `?mode=reset` 则清掉全部用户覆盖（`user_edited=0`、展示属性回自动值）。
5. **不存在的服务不删**：发现结果里消失的自动服务保留行并标记 `status.container='absent'`，
   避免"容器临时没起来 → 用户配置被清空"。

### 2.3 自动展示属性规则（内置默认，仅作初值）

按容器名/镜像小写匹配（**顺序即优先级**，命中即停）：`calendar` → `家庭日历`/`家庭`/`calendar`；
`gitea|git` → `Gitea`/`开发`/`git`；`worldforge` → `WorldForge`/`开发`/`game`；
`homeport|portal` → `HomePort`/`基础设施`/`homeport`；`cs22` → `CS22`/`项目`/`box`；
`jellyfin|plex|emby` → `媒体`/`媒体`/`media`；`pihole|adguard|dns` → `DNS`/`网络`/`network`；
`portainer|docker` → `Docker`/`基础设施`/`container`；`code-server|dsh` → `代码`/`开发`/`code`；
`db|postgres|mysql|redis|mongo` → `数据库`/`基础设施`/`database`；其余 → 容器名原样 / `未分类` / `container`。

---

## 3. 入口优先级与去重（S1-02）

### 3.1 排序（rank 越小越优先）

| rank | kind | 来源 | 标签（UI） |
| --- | --- | --- | --- |
| 0 | `user` | `services.preferred_url`（管理员保存并验证过） | 用户指定 |
| 1 | `serve` | 绑定的 serve 路由 `url`（HTTPS） | Serve HTTPS |
| 2 | `tailnet` | 容器端口可达性 = `tailnet` | Tailnet |
| 3 | `lan` | 容器端口可达性 = `lan` | 局域网 |
| 4 | `localhost` | `localhost-only`（仅本机可达，UI 必须标注） | 仅本机 |

同 rank 内的次序：serve → 路径浅的优先（`/` < `/calendar` < `/calendar.ics`），再按端口升序、URL 字典序
（稳定排序，测试可断言）。tailnet/lan/localhost → 沿用 `REACHABILITY_RANK` 与 mapper 的候选顺序。

**验收对照**：`sisi-calendar` 的首选必须是 `https://family-nas.tail585599.ts.net:8443/calendar`，
而不是 `http://…:36065/`（rank 1 胜 rank 3）；Gitea 取 `/git/`；门户取 443 根域名 `https://…/`。

### 3.2 去重

URL 规范化后去重：host 小写；去默认端口（https:443 / http:80）；路径去尾斜杠（根路径保留 `/`）；
`0.0.0.0`、`::`、`[::]` 一律替换为 host 上下文的主机名（这条对应"相同容器的 `::` 与 `0.0.0.0`
映射不得重复出现"）；`127.0.0.1` 与 `localhost` 视为同一主机（保留先出现者）。

### 3.3 可达性诚实（不得误称可达）

每个候选入口带 `accessible: boolean` 与 `reachability`：`localhost-only` / `none` 的入口
`accessible=false`，UI 必须显示为"仅本机/不可达"而不是可点击的主入口。
**首选入口只从 `accessible=true` 的候选中选**；若一个都没有 → `entry=null`，UI 显示"无可达入口"+
诊断入口按钮。保留**全部**候选入口（含不可达）供「查看所有候选入口」。

### 3.4 状态语义（S1-05）

三个维度**永远分开**，不允许合并成一个「down」：

```json
{ "container": "running" | "stopped" | "absent" | null,
  "reachable": true | false | null,
  "health": "ok" | "fail" | "unknown" | "skipped",
  "reasons": ["…面向人的解释…"] }
```

- `container=null`：无容器绑定的纯 serve/手工服务。
- `reachable=null`：数据源不可用（例如 Docker 不可达），**不确定 ≠ 不可达**。
- `health='skipped'`：没有配置 `health_target`（默认状态，不探测）。
- 反例（必须避免）：`127.0.0.1` 宿主绑定但经 Serve 可达时，不能同时出现"仅本机不可访问"这类误导结论
  ——此时 `reachable=true`（经 Serve），`reasons` 说明"容器端口仅绑本机，经 Serve 提供 tailnet 入口"。

---

## 4. API 契约

响应遵循现有惯例（与既有 `/api/*` 一致；错误体沿用现有 code/message 结构）。
下表 `auth` 列：`any` = 已登录即可（viewer 允许），`admin` = 仅管理员 + CSRF。

| 方法 | 路径 | auth | 说明 |
| --- | --- | --- | --- |
| GET | `/api/services` | any | 列表；`?query=&category=&favorite=1&includeHidden=1`（`includeHidden` 仅 admin 生效） |
| GET | `/api/services/:id` | any | 详情（含全部候选入口与诊断）；hidden 服务对非 admin 返回 404 |
| POST | `/api/services` | admin | 新建手工服务 |
| PATCH | `/api/services/:id` | admin | 改展示属性/首选入口/可见性/排序/收藏/健康配置 |
| DELETE | `/api/services/:id` | admin | `manual` 删除；自动服务隐藏；`?mode=reset` 清用户覆盖 |
| POST | `/api/services/reorder` | admin | `{ order: [{ id, sortOrder }] }` 批量排序 |
| POST | `/api/services/discover` | admin | 强制重新发现（返回最新列表与来源状态） |
| POST | `/api/services/:id/health` | admin | 一次性健康探测（显式授权动作） |
| GET | `/api/search` | any | `?q=&limit=`，按角色过滤的聚合搜索 |

### 4.1 `ServiceSummary`（列表项）

```json
{
  "id": "0f9c…", "slug": "sisi-calendar", "displayName": "家庭日历",
  "description": "家庭共享日历", "icon": "calendar", "category": "家庭",
  "sourceType": "docker", "sourceRef": "docker:sisi-calendar",
  "visibility": "visible", "favorite": true, "sortOrder": 10,
  "preferredUrl": "https://family-nas.tail585599.ts.net:8443/calendar",
  "entry": "https://family-nas.tail585599.ts.net:8443/calendar",
  "entries": [
    { "kind": "serve", "label": "Serve HTTPS", "url": "https://family-nas.tail585599.ts.net:8443/calendar",
      "rank": 1, "accessible": true, "detail": "serve → http://127.0.0.1:36065/calendar" }
  ],
  "entryCount": 4,
  "status": { "container": "running", "reachable": true, "health": "ok", "reasons": ["…"] },
  "container": { "id": "…", "name": "sisi-calendar", "state": "running", "image": "sisi-calendar:latest" },
  "userEdited": true,
  "createdAt": "2026-10-16T…", "updatedAt": "2026-10-16T…"
}
```

`GET /api/services` 额外返回：`{ "items": [...], "categories": ["家庭","开发"], "discovery": { "dockerAvailable": true, "serveAvailable": false, "serveDetail": "API 模式读不到 serve 配置", "discoveredAt": "…" }, "generatedAt": "…" }`

`GET /api/services/:id` 额外返回：
`{ "service": {...}, "candidates": [ ...全部候选含不可达... ], "diagnostics": { "containerPorts": [...], "serveRoutes": [...] } }`

### 4.2 请求体（PATCH/POST 严格校验，未知字段拒绝）

```jsonc
// POST /api/services
{ "displayName": "我的服务", "description": "…", "icon": "calendar", "category": "家庭",
  "preferredUrl": "https://example.ts.net/app", "healthTarget": "http://127.0.0.1:8080/healthz" }
// PATCH：以上任意子集 + visibility | sortOrder | favorite
{ "favorite": true, "visibility": "hidden", "sortOrder": 5 }
```

**URL 校验（S1-03 验收：拒绝危险链接）**：`preferredUrl`/`healthTarget` 必须 `http`/`https`；
拒绝 `javascript:`、`data:`、`file:`、`vbscript:` 等一切其它 scheme；禁止 URL 内嵌凭据
（`user:pass@`）；host 必须是合法主机名或 IP；长度上限 2048。
非法值 → 400（现有校验错误结构），**不落库**。

### 4.3 搜索

`GET /api/search?q=<≥1 字符>&limit=<默认 8，上限 20>` →

```json
{ "items": [ { "kind": "service|container|device|tool", "id": "…", "title": "家庭日历",
               "subtitle": "家庭 · Serve HTTPS", "url": "https://…", "keywords": ["calendar"] } ] }
```

只索引调用者**有权查看**的内容：非 admin 只索引 `visibility='visible'` 的服务；
容器/设备沿用现有只读权限；工具按现有可见性。**绝不索引设置、用户、审计、Token**。

### 4.4 健康探测（防 SSRF，S1-03 验收）

- 只在管理员显式动作时执行：已保存 `health_target`（或请求显式传 `healthTarget`，同样需校验）。
- 探测 URL 校验同 §4.2，另加**拒绝清单**（即使显式请求也拒绝）：
  `169.254.0.0/16`（含 `169.254.169.254` 云元数据）、`fd00:ec2::254`、`metadata.google.internal`、
  `0.0.0.0`、`::`、unix socket 路径（含 `docker.sock`）。
- 请求：`method=GET`（可选 HEAD），`redirect: 'manual'`（**不跟随跳转**），超时 3s，
  响应体最多读 16KB 后丢弃；只取状态码与耗时。
- 判定：2xx/3xx → `ok`；其余 → `fail`；超时/网络错误 → `fail` 且 `reasons` 写明原因（不无限重试）。
- 探测目标**不落库为信任**：每次执行都重新校验。
- 允许 loopback/私网（家用场景刚需，例：`http://127.0.0.1:36065/health`），因为"目标由管理员显式保存"
  即计划中所说的「可信明确授权范围」；文档必须写明这一点与风险。

---

## 5. 前端（S1-03 / S1-04）

### 5.1 首页 = 服务墙

- 顶部：搜索框（占位"搜索服务、容器、设备…"，点击聚焦，右侧提示 `Ctrl/Cmd K`）。
- 「收藏」区（`favorite=1`，置顶）→ 分类分组（每个分类可折叠，空分类不显示；"未分类"最后）。
- 卡片内容：图标、`displayName`（**点击进服务详情页 `/services/:id`**）、分类、**三个独立状态点**（容器运行 / 入口可达 / 健康检查）+ 悬停说明、
  首选入口（`entry`，外部新窗口打开）、`entryCount>1` 时「查看所有候选入口」（抽屉列出全部入口 + 标签 + 可达性）、
  管理员可见的「编辑」与收藏切换。
- 降级/空态：Docker 不可达 → 顶部提示条（`discovery.dockerAvailable=false`）；Serve 不可达 →
  说明"serve 配置读不到，Serve 入口可能缺失（CLI 模式才可读）"；0 个服务 → 引导"新建自定义服务"。
- 移动端：单列卡片、搜索框占满、抽屉全屏；≥640px 两列、≥1024px 三列。
- 权限：viewer 只看到 `visibility='visible'`；无任何管理入口（不渲染编辑/新建按钮）。

### 5.2 服务详情页 `/services/:id`

任何已登录用户可看（`visibility='hidden'` 的服务对非 admin 返回 404 → 页面给可读错误，不白屏）。
`GET /api/services/:id` 是它的数据源，页面展示：图标、名称、分类、归属（`sourceType` + 容器名）、
**三个独立状态点**、`status.reasons` 逐条列出、首选入口（外部新窗口）、`UrlCandidateList` 展示**全部候选**
（含不可达）、诊断区块（`diagnostics.containerPorts` / `serveRoutes` / `notes`）；admin 额外有「编辑」与
「健康检查」（`POST /api/services/:id/health`）。

存在这个页面的理由（S1 的最终验收）："管理员能解释某个服务为什么不可达" —— 卡片放不下诊断信息，
而 `entry=null` 时必须有一个地方能说清楚"为什么没有入口"。

### 5.3 管理页 `/admin/services`

列表（按 `sortOrder`）+ 上/下移排序、收藏、可见性切换、编辑表单（名称/描述/图标选择器/分类/首选入口/
健康路径）、新建自定义服务、删除（手工）/隐藏（自动）/重置用户覆盖（自动）、「重新发现」按钮。
所有写操作显示后端错误信息（校验失败要能看到"scheme 不允许"这类原因）。

**E2E 依赖的稳定选择器（不得随意更名）**：表单输入 `#service-name` / `#service-description` / `#service-icon` /
`#service-category` / `#service-url` / `#service-health-path`（每个都要有 `<label htmlFor>`）；
按钮可访问名 `新建服务` / `保存` / `取消` / `重新发现` / `上移` / `下移` / `隐藏` / `重置为自动`。

### 5.4 快捷搜索 `Ctrl/Cmd+K`

- 全局快捷键（输入框内也要能开；Esc 关闭）；实现同时接受 `e.ctrlKey || e.metaKey`（E2E 统一用 `Control+K`）。
- 弹层：`role="dialog"` + `aria-modal="true"`，输入框 `aria-label="搜索服务、容器、设备与工具"`，
  结果 `role="listbox"` / 选项 `role="option"` + `aria-selected`。
- 键盘：↑↓ 移动、Enter 打开、Esc 关闭、Tab 焦点不逃逸；无结果时给出可读文案。
- 数据：`GET /api/search`（服务端按角色过滤）。
- **Enter 的跳转行为固定**（E2E 断言 URL，服务条目**不得**用 `window.open`）：

  | `kind` | 行为 |
  | --- | --- |
  | `service` | `navigate('/services/' + hit.id')`（内部） |
  | `container` | `navigate('/containers/' + hit.id)`（内部） |
  | `device` | `navigate('/devices')`（内部） |
  | `tool` | 外部新窗口打开 `hit.url` |

---

## 6. 图标

- `icon` 字段两种取值：**内置图标键**（白名单，如 `calendar`/`git`/`container`/`database`…）或
  `https://` URL（严格校验，拒绝其它 scheme）。
- 前端 `ServiceIcon` 组件：白名单键 → 内联 SVG；URL → `<img>`（`loading="lazy"`、`referrerPolicy="no-referrer"`）。
- **CSP 影响**：默认 CSP 为 `img-src 'self' data:`，外部图标 URL 会被拦；因此 UI 在输入外部 URL 时提示
  "外部图标需在 `PORTAL_CSP` 的 img-src 中放行其来源"，文档同步说明。**不为了图标放宽默认 CSP。**
- 未知键按 `container` 兜底。

---

## 7. 测试要求（缺一不可）

**server**
1. `servicesDiscovery.test.ts`：容器重建（新 ID、同 Compose 名）→ 同一服务、用户字段保留；
   自动发现不覆盖用户字段；`::`/`0.0.0.0` 去重；serve 归属（`/calendar` → `sisi-calendar`）；
   多容器端口冲突不猜；门户 443 根域名；Gitea `/git/`；日历首选 Serve `/calendar` 而非 `:36065`；
   路径浅优先；serve 不可用时的解释文案；0/1/20/100 个服务的解析耗时（100 个 < 150ms）。
2. `servicesApi.test.ts`：匿名 401 / viewer 写 403 / admin 成功；CSRF 缺失 403；hidden 过滤；
   `javascript:` 等危险 URL 400；重名 slug；reorder；DELETE 三种语义；健康探测拒绝清单 + 注入 fetch 断言
   **不跟随跳转、超时 3s、不发请求给元数据地址**。
3. `servicesSearch.test.ts`：角色过滤（viewer 搜不到 hidden 服务）、limit 上限、空查询。
4. `migrationV4.test.ts`：v3 库升级到 v4 后用户/会话/设置无损；重复运行幂等；服务行与用户覆盖在
   重新发现后保留；回退策略说明（只能前滚 + 备份恢复）。

**web**：`ServiceIcon`/`ServiceCard`/`ServiceWall`/`ServiceForm`/`CommandPalette` 组件测试（含
aria 属性断言、键盘导航、危险 URL 提示、viewer 无管理入口）。

**E2E**：首页服务墙渲染（含分类与状态点）；`Ctrl+K` 搜索并进入服务详情；管理员新建自定义服务 → 刷新后仍在；
viewer 不出现管理按钮；Docker/Serve 降级提示可见。

> 实施细节：E2E 环境的 `.e2e-data` 只在**整轮开始时**清空一次，且 admin/viewer 账号由
> `e2e/smoke.spec.ts` 的第 2、5 条用例创建（`workers: 1`、文件内顺序敏感）。因此 Sprint 1 的用例
> **追加在 `smoke.spec.ts` 末尾**（而不是新建 spec 文件，避免文件名排序导致先于建号用例运行），
> 同时把首页迁移（`/` 从总览改为服务墙）影响到的既有断言一并修正。新用例必须断言：
> ① `/` 的降级提示里出现 `Docker` 字样；② 新建服务 → 刷新仍在 → 首页出现且首选入口正确；
> ③ `Ctrl+K` 搜索后 Enter 落到 `/services/:id`；④ viewer 侧栏没有「服务管理」、页面没有「新建服务」按钮。

---

## 8. 交付与文档

1. `IMPLEMENTATION_REPORT_S1.md`（完成项/跳过项/决策/冲突）。
2. `docs/static/`：`03`（新模块与函数表）、`04`（API 契约新增章节）、`05`（首页/管理页/命令面板）、
   `02`（无新环境变量则不改）、`06`（健康探测 SSRF 策略与图标 CSP 说明）、`08`（运维：迁移与回退）、
   `09`（changelog 新条目）、`01`（架构：服务层在数据流中的位置）。
3. `README.md`、`todo.md` 同步。
4. 部署说明：NAS 升级（保留持久化卷、不动 Serve 443/8443）、迁移 v3→v4 的命令与备份、回退策略。
5. 风险清单：健康探测的授权边界、外部图标 CSP、Serve 在 API 模式不可读、`service_bindings` 快照性质。