/**
 * 极简结构化日志。
 *
 * 设计取舍：不引入 pino，避免与 Fastify 内置 logger 的配置耦合成本；
 * 输出为单行 JSON（生产）或可读文本（开发），字段固定便于 grep。
 */
import type { LogLevel } from './config.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 取级别权重（显式收窄，避免 noUncheckedIndexedAccess 干扰）。 */
function weightOf(level: LogLevel): number {
  return LEVEL_WEIGHT[level];
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  pretty?: boolean;
  /** 注入到每行的固定字段，如 { mod: 'docker' } */
  bindings?: LogFields;
  /** 测试用：捕获输出 */
  sink?: (line: string, level: LogLevel) => void;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function normalizeFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

/**
 * 创建一个 logger。
 *
 * @param options 级别、是否人类可读、固定字段、输出接收器
 */
export function createLogger(options: LoggerOptions): Logger {
  const { level, pretty = false, bindings = {}, sink } = options;

  const emit = (levelName: LogLevel, msg: string, fields?: LogFields): void => {
    if (weightOf(levelName) < weightOf(level)) return;
    const merged = { ...bindings, ...normalizeFields(fields) };
    const time = new Date().toISOString();
    const line = pretty
      ? `${time} ${levelName.toUpperCase().padEnd(5)} ${msg}${Object.keys(merged).length ? ' ' + JSON.stringify(merged) : ''}`
      : JSON.stringify({ time, level: levelName, msg, ...merged });
    if (sink) {
      sink(line, levelName);
      return;
    }
    if (levelName === 'error' || levelName === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** 测试用静默 logger。 */
export function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
