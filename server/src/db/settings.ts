/**
 * 运行时设置仓储（settings 表）。
 *
 * 语义：**只存被显式覆盖过的键**。未覆盖的键不在此表中，由 `settings/registry.ts`
 * 回退到环境变量或内置默认值。删除某键 = 恢复该键的默认行为。
 *
 * 所有值以 TEXT 存储（布尔存 `'1'`/`'0'`），序列化/反序列化由 registry 负责，
 * 这样表结构不需要随配置项增减而迁移。
 */
import type { Db } from './database.js';

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

export interface SettingRecord {
  key: string;
  value: string;
  updatedAt: string;
  /** 最后修改者的用户名 */
  updatedBy: string | null;
}

function mapRow(row: SettingRow): SettingRecord {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export interface UpsertSettingInput {
  key: string;
  value: string;
  updatedBy: string | null;
}

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  /** 全部被覆盖的键（值均为字符串）。 */
  list(): SettingRecord[] {
    const rows = this.db.prepare('SELECT * FROM settings ORDER BY key').all() as SettingRow[];
    return rows.map(mapRow);
  }

  /** 转为便于查询的 Map。 */
  toMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of this.list()) map.set(row.key, row.value);
    return map;
  }

  /** 读取单个键；未覆盖返回 null。 */
  get(key: string): string | null {
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
    return row ? row.value : null;
  }

  /** 单条 upsert。 */
  upsert(input: UpsertSettingInput): SettingRecord {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by)
         VALUES (@key, @value, @updatedAt, @updatedBy)
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        key: input.key,
        value: input.value,
        updatedAt: new Date().toISOString(),
        updatedBy: input.updatedBy,
      });
    const row = this.db.prepare('SELECT * FROM settings WHERE key = ?').get(input.key) as SettingRow;
    return mapRow(row);
  }

  /**
   * 批量 upsert，单事务。
   *
   * @returns 受影响的键列表
   */
  upsertMany(inputs: readonly UpsertSettingInput[]): string[] {
    const tx = this.db.transaction((items: readonly UpsertSettingInput[]) => {
      for (const item of items) this.upsert(item);
    });
    tx(inputs);
    return inputs.map((item) => item.key);
  }

  /** 删除单个键（恢复默认）。返回是否存在过。 */
  delete(key: string): boolean {
    const info = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return info.changes > 0;
  }

  /** 批量删除，单事务。 */
  deleteMany(keys: readonly string[]): number {
    const tx = this.db.transaction((items: readonly string[]) => {
      let removed = 0;
      for (const key of items) {
        const info = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        removed += info.changes;
      }
      return removed;
    });
    return tx(keys);
  }

  /** 清空全部覆盖（全部恢复默认）。 */
  deleteAll(): number {
    const info = this.db.prepare('DELETE FROM settings').run();
    return info.changes;
  }
}
