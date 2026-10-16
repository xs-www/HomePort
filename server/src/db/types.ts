/**
 * 数据库行类型与「行 → 应用对象」映射。
 *
 * 约定：`*Row` 是 SQLite 的原始形态（snake_case、0/1 布尔），
 * 无后缀类型是 API 层使用的形态（camelCase、真实布尔）。
 * 映射函数必须保持纯函数。
 */

export type UserRole = 'admin' | 'viewer';
export type ThemePreference = 'dark' | 'light' | 'system';
export type DensityPreference = 'comfortable' | 'compact';

export interface UserRow {
  id: number;
  username: string;
  username_ci: string;
  display_name: string;
  role: string;
  password_hash: string;
  disabled: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  /** TOTP 种子**密文**（`enc:v1:…`）；未开始绑定为 null */
  totp_secret: string | null;
  /** 是否已完成两步验证绑定（0/1） */
  totp_enabled: number;
  /** 绑定确认时间 */
  totp_confirmed_at: string | null;
  /** 最后成功使用的时间步，用于防重放 */
  totp_last_counter: number | null;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /** 是否已启用两步验证（前端据此显示徽标与"关闭"入口） */
  totpEnabled: boolean;
  /** 两步验证绑定确认时间 */
  totpConfirmedAt: string | null;
}

/** 带密码哈希的内部用户模型，**禁止**直接返回给 API。 */
export interface UserWithSecret extends User {
  passwordHash: string;
  /** TOTP 种子密文，仅服务端内部使用（解密只在 auth service 里发生） */
  totpSecretEncrypted: string | null;
  /** 最后成功使用的时间步 */
  totpLastCounter: number | null;
}

export interface TotpRecoveryCodeRow {
  id: number;
  user_id: number;
  code_hash: string;
  created_at: string;
  used_at: string | null;
}

export interface TotpChallengeRow {
  id: string;
  token_hash: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  csrf_token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
  remote_addr: string | null;
  revoked_at: string | null;
}

export interface Session {
  id: string;
  userId: number;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  remoteAddr: string | null;
  revokedAt: string | null;
}

export interface PreferenceRow {
  user_id: number;
  theme: string;
  density: string;
  default_page: string;
  updated_at: string;
}

export interface UserPreferences {
  userId: number;
  theme: ThemePreference;
  density: DensityPreference;
  defaultPage: string;
  updatedAt: string;
}

export interface AuditRow {
  id: number;
  at: string;
  actor_id: number | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorId: number | null;
  actorName: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

/** 规范化角色字符串；非法值回退 viewer（最小权限原则）。 */
export function normalizeRole(value: string | null | undefined): UserRole {
  return value === 'admin' ? 'admin' : 'viewer';
}

/** 用户名大小写不敏感键（用于唯一索引）。 */
export function usernameCi(username: string): string {
  return username.trim().toLowerCase();
}

export function mapUserRow(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: normalizeRole(row.role),
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    totpEnabled: row.totp_enabled === 1,
    totpConfirmedAt: row.totp_confirmed_at,
  };
}

export function mapUserWithSecret(row: UserRow): UserWithSecret {
  return {
    ...mapUserRow(row),
    passwordHash: row.password_hash,
    totpSecretEncrypted: row.totp_secret,
    totpLastCounter: row.totp_last_counter,
  };
}

export function mapSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    remoteAddr: row.remote_addr,
    revokedAt: row.revoked_at,
  };
}

export function mapPreferenceRow(row: PreferenceRow): UserPreferences {
  const theme = row.theme === 'light' || row.theme === 'system' ? row.theme : 'dark';
  const density = row.density === 'compact' ? 'compact' : 'comfortable';
  return {
    userId: row.user_id,
    theme,
    density,
    defaultPage: row.default_page,
    updatedAt: row.updated_at,
  };
}

export function mapAuditRow(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    target: row.target,
    detail: row.detail,
    ip: row.ip,
  };
}

export const DEFAULT_PREFERENCES: Omit<UserPreferences, 'userId' | 'updatedAt'> = {
  theme: 'dark',
  density: 'comfortable',
  defaultPage: 'overview',
};

/* ------------------------------------------------------------------ *
 * 服务注册表（迁移 v4）
 *
 * 三张表的职责分工（对应 docs/sprint1-implementation-spec.md §1）：
 * - `services`：唯一需要**长期保留**的东西（用户改过的名称/图标/顺序/收藏/首选入口）。
 * - `service_bindings`：发现结果的快照，可丢可重算，只用于展示与诊断。
 * - `service_preferences`：单例偏好 KV。
 * ------------------------------------------------------------------ */

export type ServiceSourceType = 'docker' | 'serve' | 'manual';
export type ServiceVisibility = 'visible' | 'hidden';
export type ServiceBindingKind = 'container' | 'serve';

export interface ServiceRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  preferred_url: string | null;
  source_type: string;
  source_ref: string;
  binding_refs: string;
  visibility: string;
  sort_order: number;
  favorite: number;
  health_target: string | null;
  health_path: string | null;
  user_edited: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface ServiceBindingRow {
  id: number;
  service_id: string;
  kind: string;
  ref: string;
  container_id: string | null;
  container_name: string | null;
  compose_project: string | null;
  compose_service: string | null;
  scheme: string | null;
  host: string | null;
  port: number | null;
  path: string | null;
  url: string | null;
  reachability: string | null;
  accessible: number;
  rank: number;
  created_at: string;
  updated_at: string;
}

export interface ServicePreferenceRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface Service {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  preferredUrl: string | null;
  sourceType: ServiceSourceType;
  sourceRef: string;
  bindingRefs: string[];
  visibility: ServiceVisibility;
  sortOrder: number;
  favorite: boolean;
  healthTarget: string | null;
  healthPath: string | null;
  userEdited: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ServiceBinding {
  id: number;
  serviceId: string;
  kind: ServiceBindingKind;
  ref: string;
  containerId: string | null;
  containerName: string | null;
  composeProject: string | null;
  composeService: string | null;
  scheme: string | null;
  host: string | null;
  port: number | null;
  path: string | null;
  url: string | null;
  reachability: string | null;
  accessible: boolean;
  rank: number;
  createdAt: string;
  updatedAt: string;
}

/** 规范化来源类型；非法值回退 `manual`（最保守：不会与自动发现撞车）。 */
export function normalizeSourceType(value: string | null | undefined): ServiceSourceType {
  return value === 'docker' || value === 'serve' ? value : 'manual';
}

/** 规范化可见性；非法值回退 `visible`（注册表的默认语义）。 */
export function normalizeVisibility(value: string | null | undefined): ServiceVisibility {
  return value === 'hidden' ? 'hidden' : 'visible';
}

/** `binding_refs` 是 JSON 数组；解析失败当作空数组（老库/脏数据的兜底）。 */
export function parseBindingRefs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function mapServiceRow(row: ServiceRow): Service {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    icon: row.icon,
    category: row.category,
    preferredUrl: row.preferred_url,
    sourceType: normalizeSourceType(row.source_type),
    sourceRef: row.source_ref,
    bindingRefs: parseBindingRefs(row.binding_refs),
    visibility: normalizeVisibility(row.visibility),
    sortOrder: row.sort_order,
    favorite: row.favorite === 1,
    healthTarget: row.health_target,
    healthPath: row.health_path,
    userEdited: row.user_edited === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function mapServiceBindingRow(row: ServiceBindingRow): ServiceBinding {
  return {
    id: row.id,
    serviceId: row.service_id,
    kind: row.kind === 'serve' ? 'serve' : 'container',
    ref: row.ref,
    containerId: row.container_id,
    containerName: row.container_name,
    composeProject: row.compose_project,
    composeService: row.compose_service,
    scheme: row.scheme,
    host: row.host,
    port: row.port,
    path: row.path,
    url: row.url,
    reachability: row.reachability,
    accessible: row.accessible === 1,
    rank: row.rank,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
