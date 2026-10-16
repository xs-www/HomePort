/**
 * 服务注册表仓储（迁移 v4 的三张表）。
 *
 * 分层意图：
 * - **本文件只做存取**，不知道 Docker、不知道 serve、不知道入口优先级；
 * - 「发现什么、优先哪个入口」都在 `modules/services/registry.ts`（纯函数，可单测）；
 * - 因此这里可以放心地被迁移测试与 API 测试单独驱动。
 *
 * 写入纪律（S1-01 的核心要求，务必保持）：
 * 1. `updateUserFields` 是**唯一**改展示属性的入口，且必然置 `user_edited = 1`；
 * 2. 自动发现走 `upsertDiscovered`，**只写自动字段**（display_name 仅在未用户编辑时写），
 *    绝不触碰 preferred_url / visibility / sort_order / favorite / health_*;
 * 3. 用户字段一旦被写过，只有 `clearUserOverrides`（管理员显式"重置为自动"）才能交还给自动层。
 */
import type { Db } from './database.js';
import {
  mapServiceBindingRow,
  mapServiceRow,
  normalizeVisibility,
  type Service,
  type ServiceBinding,
  type ServiceBindingRow,
  type ServiceRow,
  type ServiceVisibility,
} from './types.js';

/** 新建服务时由调用方给出的完整初值（自动发现与手工创建共用）。 */
export interface NewServiceInput {
  id: string;
  slug: string;
  displayName: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  preferredUrl?: string | null;
  sourceType: Service['sourceType'];
  sourceRef: string;
  bindingRefs?: readonly string[];
  visibility?: ServiceVisibility;
  sortOrder?: number;
  favorite?: boolean;
  healthTarget?: string | null;
  healthPath?: string | null;
  /** 手工创建视为"用户编辑过"（避免后续自动发现改写它） */
  userEdited?: boolean;
  updatedBy?: string | null;
}

/** 自动发现要写入的字段（**不含任何用户字段**）。 */
export interface DiscoveryUpdateInput {
  displayName: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  bindingRefs?: readonly string[];
}

/** 用户可编辑字段的子集（PATCH 用）。 */
export interface UserFieldPatch {
  displayName?: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  preferredUrl?: string | null;
  visibility?: ServiceVisibility;
  sortOrder?: number;
  favorite?: boolean;
  healthTarget?: string | null;
  healthPath?: string | null;
}

/** 绑定写入项（发现结果的快照）。 */
export interface BindingInput {
  kind: 'container' | 'serve';
  ref: string;
  containerId?: string | null;
  containerName?: string | null;
  composeProject?: string | null;
  composeService?: string | null;
  scheme?: string | null;
  host?: string | null;
  port?: number | null;
  path?: string | null;
  url?: string | null;
  reachability?: string | null;
  accessible?: boolean;
  rank?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 把名称规范化为 slug：小写、非字母数字转 `-`、折叠重复、去首尾。
 * 中文等非 ASCII 会被剥掉 —— 由调用方在结果为空时回退（见 `modules/services/registry.ts`）。
 */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class ServicesRepository {
  constructor(private readonly db: Db) {}

  /* ----------------------------- 读取 ----------------------------- */

  listAll(): Service[] {
    const rows = this.db
      .prepare('SELECT * FROM services ORDER BY sort_order ASC, display_name ASC')
      .all() as ServiceRow[];
    return rows.map(mapServiceRow);
  }

  findById(id: string): Service | null {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined;
    return row ? mapServiceRow(row) : null;
  }

  findBySource(sourceType: string, sourceRef: string): Service | null {
    const row = this.db
      .prepare('SELECT * FROM services WHERE source_type = ? AND source_ref = ?')
      .get(sourceType, sourceRef) as ServiceRow | undefined;
    return row ? mapServiceRow(row) : null;
  }

  findBySlug(slug: string): Service | null {
    const row = this.db.prepare('SELECT * FROM services WHERE slug = ?').get(slug) as ServiceRow | undefined;
    return row ? mapServiceRow(row) : null;
  }

  /**
   * 一次性取回绑定（**单条 SQL**，避免 100 个服务时 N+1 查询）。
   * 传入 `serviceIds` 时只取这些服务的绑定。
   */
  listBindings(serviceIds?: readonly string[]): ServiceBinding[] {
    if (serviceIds && serviceIds.length === 0) return [];
    let rows: ServiceBindingRow[];
    if (serviceIds && serviceIds.length > 0) {
      const placeholders = serviceIds.map(() => '?').join(',');
      rows = this.db
        .prepare(`SELECT * FROM service_bindings WHERE service_id IN (${placeholders}) ORDER BY rank ASC, id ASC`)
        .all(...serviceIds) as ServiceBindingRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM service_bindings ORDER BY rank ASC, id ASC')
        .all() as ServiceBindingRow[];
    }
    return rows.map(mapServiceBindingRow);
  }

  /** 生成一个未被占用的 slug（同基名冲突时追加 `-2`、`-3`…）。 */
  uniqueSlug(base: string): string {
    const normalized = slugify(base) || 'service';
    if (!this.findBySlug(normalized)) return normalized;
    for (let index = 2; index < 500; index += 1) {
      const candidate = `${normalized}-${index}`;
      if (!this.findBySlug(candidate)) return candidate;
    }
    return `${normalized}-${Date.now()}`;
  }

  /* ----------------------------- 写入 ----------------------------- */

  /** 新建服务行（自动发现与手工创建共用）。 */
  insert(input: NewServiceInput): Service {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO services (
           id, slug, display_name, description, icon, category, preferred_url,
           source_type, source_ref, binding_refs, visibility, sort_order, favorite,
           health_target, health_path, user_edited, created_at, updated_at, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.slug,
        input.displayName,
        input.description ?? null,
        input.icon ?? null,
        input.category ?? null,
        input.preferredUrl ?? null,
        input.sourceType,
        input.sourceRef,
        JSON.stringify(input.bindingRefs ?? []),
        normalizeVisibility(input.visibility),
        input.sortOrder ?? 100,
        input.favorite ? 1 : 0,
        input.healthTarget ?? null,
        input.healthPath ?? null,
        input.userEdited ? 1 : 0,
        now,
        now,
        input.updatedBy ?? null,
      );
    const created = this.findById(input.id);
    if (!created) throw new Error(`服务写入后读回失败: ${input.id}`);
    return created;
  }

  /**
   * 自动发现写入：**只写自动字段**。
   *
   * `display_name/description/icon/category` 仅在该行 `user_edited = 0` 时更新；
   * `binding_refs` 始终更新（它是发现结果的映射，不是用户字段）。
   */
  upsertDiscovered(id: string, input: DiscoveryUpdateInput): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE services SET
           display_name = CASE WHEN user_edited = 0 THEN ? ELSE display_name END,
           description  = CASE WHEN user_edited = 0 THEN ? ELSE description  END,
           icon         = CASE WHEN user_edited = 0 THEN ? ELSE icon         END,
           category     = CASE WHEN user_edited = 0 THEN ? ELSE category     END,
           binding_refs = ?,
           updated_at   = ?
         WHERE id = ?`,
      )
      .run(
        input.displayName,
        input.description ?? null,
        input.icon ?? null,
        input.category ?? null,
        JSON.stringify(input.bindingRefs ?? []),
        now,
        id,
      );
  }

  /** 用户编辑展示属性（唯一入口，必然置 `user_edited = 1`）。 */
  updateUserFields(id: string, patch: UserFieldPatch, updatedBy: string | null): Service | null {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.displayName !== undefined) set('display_name', patch.displayName);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.icon !== undefined) set('icon', patch.icon);
    if (patch.category !== undefined) set('category', patch.category);
    if (patch.preferredUrl !== undefined) set('preferred_url', patch.preferredUrl);
    if (patch.visibility !== undefined) set('visibility', normalizeVisibility(patch.visibility));
    if (patch.sortOrder !== undefined) set('sort_order', patch.sortOrder);
    if (patch.favorite !== undefined) set('favorite', patch.favorite ? 1 : 0);
    if (patch.healthTarget !== undefined) set('health_target', patch.healthTarget);
    if (patch.healthPath !== undefined) set('health_path', patch.healthPath);

    if (assignments.length === 0) return this.findById(id);

    assignments.push('user_edited = 1', 'updated_at = ?', 'updated_by = ?');
    values.push(nowIso(), updatedBy);
    values.push(id);

    this.db.prepare(`UPDATE services SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
    return this.findById(id);
  }

  /**
   * 管理员显式"重置为自动"：清掉用户覆盖并交还给自动层。
   * `display_name` 保留旧值，等下一次发现按 `user_edited = 0` 覆盖（避免出现空名）。
   */
  clearUserOverrides(id: string): Service | null {
    this.db
      .prepare(
        `UPDATE services SET
           user_edited   = 0,
           description   = NULL,
           icon          = NULL,
           category      = NULL,
           preferred_url = NULL,
           health_target = NULL,
           health_path   = NULL,
           favorite      = 0,
           sort_order    = 100,
           updated_at    = ?
         WHERE id = ?`,
      )
      .run(nowIso(), id);
    return this.findById(id);
  }

  setVisibility(id: string, visibility: ServiceVisibility, updatedBy: string | null): Service | null {
    return this.updateUserFields(id, { visibility }, updatedBy);
  }

  /** 批量排序（单事务）。 */
  reorder(entries: readonly { id: string; sortOrder: number }[], updatedBy: string | null): void {
    const now = nowIso();
    const update = this.db.prepare(
      'UPDATE services SET sort_order = ?, user_edited = 1, updated_at = ?, updated_by = ? WHERE id = ?',
    );
    const tx = this.db.transaction(() => {
      for (const entry of entries) update.run(entry.sortOrder, now, updatedBy, entry.id);
    });
    tx();
  }

  delete(id: string): void {
    // service_bindings 有 ON DELETE CASCADE，但显式删一次更直观且不依赖 pragma
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM service_bindings WHERE service_id = ?').run(id);
      this.db.prepare('DELETE FROM services WHERE id = ?').run(id);
    });
    tx();
  }

  /** 整体替换某服务的绑定（发现结果的快照，单事务）。 */
  replaceBindings(serviceId: string, bindings: readonly BindingInput[]): void {
    const now = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO service_bindings (
         service_id, kind, ref, container_id, container_name, compose_project, compose_service,
         scheme, host, port, path, url, reachability, accessible, rank, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM service_bindings WHERE service_id = ?').run(serviceId);
      for (const binding of bindings) {
        insert.run(
          serviceId,
          binding.kind,
          binding.ref,
          binding.containerId ?? null,
          binding.containerName ?? null,
          binding.composeProject ?? null,
          binding.composeService ?? null,
          binding.scheme ?? null,
          binding.host ?? null,
          binding.port ?? null,
          binding.path ?? null,
          binding.url ?? null,
          binding.reachability ?? null,
          binding.accessible ? 1 : 0,
          binding.rank ?? 100,
          now,
          now,
        );
      }
    });
    tx();
  }

  /* --------------------------- 单例偏好 --------------------------- */

  getPreference(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM service_preferences WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setPreference(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO service_preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  /** 统计信息（发现结果摘要/测试用）。 */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM services').get() as { n: number };
    return row.n;
  }
}