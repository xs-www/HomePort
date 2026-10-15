/**
 * 敏感信息脱敏：日志、容器环境变量、命令行参数在返回给浏览器前必须过滤。
 *
 * 规则保守：宁可多打码，不可漏密钥。
 */

/** 命中即整体打码的 key 名片段（大小写不敏感）。 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|wd|phrase)?/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /auth[_-]?key/i,
  /credential/i,
  /^auth$/i,
  /authorization/i,
  /session[_-]?id/i,
  /cookie/i,
  /salt/i,
  /_key$/i,
];

/** `KEY=VALUE` 形式中出现的敏感 KEY（用于自由文本日志行）。 */
const KV_SECRET_RE =
  /(\b[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/** 常见密钥字面量：OpenAI `sk-`、Tailscale `tskey-`、GitHub `ghp_`、AWS `AKIA`、Bearer。 */
const SECRET_LITERAL_RE =
  /(\b(?:sk-[A-Za-z0-9_-]{8,}|tskey-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*)/gi;

const MASK = '***';

/** key 名是否敏感。 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key.trim()));
}

/**
 * 对自由文本做脱敏（换行保留）。
 *
 * @example `redactText('OLLAMA_API_KEY=abc123') → 'OLLAMA_API_KEY=***'`
 */
export function redactText(input: string): string {
  return input.replace(KV_SECRET_RE, `$1${MASK}`).replace(SECRET_LITERAL_RE, MASK);
}

/** 对日志行数组逐行脱敏。 */
export function redactLines(lines: readonly string[]): string[] {
  return lines.map((line) => redactText(line));
}

/**
 * 对对象做**浅层**脱敏：key 敏感的字段值替换为 `***`。
 * 不递归，避免大对象遍历成本；嵌套对象由调用方决定。
 */
export function redactRecord<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = isSensitiveKey(key) ? MASK : value;
  }
  return out as T;
}

/**
 * 把 `["KEY=VALUE", ...]` 形式的容器环境变量转换为脱敏后的对象。
 *
 * @param env dockerode `Config.Env`
 */
export function redactEnvList(env: readonly string[] | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const entry of env) {
    const eq = entry.indexOf('=');
    if (eq === -1) {
      out[entry] = '';
      continue;
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    out[key] = isSensitiveKey(key) ? MASK : value;
  }
  return out;
}
