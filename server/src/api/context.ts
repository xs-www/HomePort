/**
 * 路由层依赖容器 + 请求上下文转换。
 *
 * 路由文件只从 `RouteContext` 取依赖，不直接 import 业务实现，
 * 这样测试时可以整体替换为 fake。
 */
import type { FastifyRequest } from 'fastify';
import type { PortalConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AuditRepository } from '../db/users.js';
import type { AuthService } from '../modules/auth/service.js';
import type { ContainerService, HostContextRequest } from '../modules/docker/service.js';
import type { OverviewService } from '../modules/overview/service.js';
import type { SystemService } from '../modules/system/service.js';
import type { TailscaleService } from '../modules/tailscale/service.js';
import type { ToolsService } from '../modules/tools/service.js';
import type { UsersService } from '../modules/users/service.js';

export interface RouteContext {
  config: PortalConfig;
  logger: Logger;
  auth: AuthService;
  users: UsersService;
  containers: ContainerService;
  tailscale: TailscaleService;
  system: SystemService;
  tools: ToolsService;
  overview: OverviewService;
  audit: AuditRepository;
}

/**
 * 从 Fastify 请求提取服务层需要的宿主上下文（避免 service 依赖 Fastify 类型）。
 */
export function toHostContextRequest(request: FastifyRequest): HostContextRequest {
  return {
    protocol: request.protocol,
    hostname: request.hostname,
    port: request.port,
    headers: request.headers as Record<string, string | string[] | undefined>,
  };
}
