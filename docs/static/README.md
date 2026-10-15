# 架构总览（静态文档 · 索引）

> 本目录是 HomePage 门户的**静态函数文档**。任何代码改动完成后，必须按本目录既有格式把全量变更归档到对应文档（见 `09-changelog.md`）。
> 编写代码前先阅读 `01-architecture.md` 与 `04-api-contract.md`，不要一上来通读全部源码。

## 文档地图

| 文档 | 内容 | 何时看 |
| --- | --- | --- |
| [01-architecture.md](./01-architecture.md) | 系统架构、目录结构、数据流、部署形态 | 需要理解全局时 |
| [02-configuration.md](./02-configuration.md) | 全部环境变量、配置文件、挂载点 | 部署/改配置时 |
| [03-server-modules.md](./03-server-modules.md) | 后端逐模块逐函数说明（函数级静态文档） | 修改后端时 |
| [04-api-contract.md](./04-api-contract.md) | HTTP / SSE 接口契约与错误码 | 改接口或写前端时 |
| [05-web-modules.md](./05-web-modules.md) | 前端组件、路由、状态管理逐模块说明 | 修改前端时 |
| [06-security.md](./06-security.md) | 鉴权、会话、CSRF、权限矩阵、威胁模型 | 改动安全相关逻辑时 |
| [07-data-model.md](./07-data-model.md) | SQLite 表结构、迁移历史 | 改数据库时 |
| [08-operations.md](./08-operations.md) | 构建、启动、NAS/Windows 部署、排障、指标取数边界 | 部署与排障时 |
| [09-changelog.md](./09-changelog.md) | 按 git diff 归档的全量变更记录 | **每次任务结束时必写** |

## 一句话定位

一个跑在 Docker 里的**本机 tailnet 控制面板**：把本机所有可经 tailnet 访问的容器、tailnet 设备在线状态、宿主 CPU/GPU/内存/硬盘占用、以及 Ollama/DSH/ComfyUI 等本机工具，聚合成一个带登录权限管理的入口页。

## 快速导航

- 想加一个新页面 → 先读 [04-api-contract.md](./04-api-contract.md) 与 [05-web-modules.md](./05-web-modules.md)
- 想加一个新工具入口（如 Jellyfin） → 读 [02-configuration.md](./02-configuration.md) 的 `PORTAL_TOOLS_FILE` 与 [03-server-modules.md](./03-server-modules.md) 的 `tools/catalog.ts`
- 想在 NAS 上跑 → 读 [08-operations.md](./08-operations.md) 的「部署矩阵」
- 指标显示为 0 或不可用 → 读 [08-operations.md](./08-operations.md) 的「指标取数边界」
