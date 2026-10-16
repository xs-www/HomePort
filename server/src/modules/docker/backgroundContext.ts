/**
 * 后台任务的"中性"主机上下文。
 *
 * 背景：`HostContextRequest` 原本只由 HTTP 路由经 `toHostContextRequest(request)` 构造，
 * 因此所有取容器/服务视图的调用都隐含"有一个访问者"。Sprint 2 引入了**第一个没有请求的调用方**
 * （后台采样器与健康监视器），它们必须能取到同样的数据，否则只能绕开服务层直接读库，
 * 那样就会漏掉发现缓存、可见性与状态计算。
 *
 * 语义：没有访问者，就以配置为准 —— `buildHostContext` 在 `headers: {}` 时取不到 Host 头，
 * 候选主机自然退化为 `PORTAL_PUBLIC_HOST` → MagicDNS → tailnet IP → localhost，
 * 正好是"后台视角"应有的顺序。**不要**在这里伪造 `x-forwarded-*` 头：
 * 那会让后台任务误以为自己在替某个访问者生成 URL。
 *
 * 这个字面量与 `ServiceRegistryService.neutralRequest()` 完全一致。
 * 抽出来的目的就是让"无访问者"只有一个定义，而不是在三个模块里各写一遍。
 */
import type { PortalConfig } from '../../config.js';
import type { HostContextRequest } from './service.js';

export function backgroundHostRequest(config: Pick<PortalConfig, 'port'>): HostContextRequest {
  return { protocol: 'http', hostname: 'localhost', headers: {}, port: config.port };
}