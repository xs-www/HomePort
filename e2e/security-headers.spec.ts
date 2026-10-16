/**
 * 安全响应头冒烟（Sprint 0 · S0-03，作为 S0-05 的顺带验证）。
 *
 * 为什么单独成文件：S0-03（安全响应头）与 S0-05（E2E 冒烟）在并行开发，
 * 这条断言依赖后端 `registerSecurityHeaders()` 已接入 `app.ts`。
 * 单独成文件可以让「冒烟主流程是否通过」与「安全头是否已接线」互不混淆。
 *
 * 断言的是**首页 HTML 响应**（浏览器实际加载的那一份），不是随便一个 API 响应。
 */
import { expect, test } from '@playwright/test';

/** 必须出现在 CSP 里的指令（与 config.ts 的 DEFAULT_CSP 对应）。 */
const REQUIRED_CSP_DIRECTIVES = ['default-src', 'script-src', 'object-src', 'frame-ancestors'];

test('首页 HTML 响应带 content-security-policy 与 x-content-type-options: nosniff', async ({ request }) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);

  const headers = response.headers();

  const csp = headers['content-security-policy'];
  expect(
    csp,
    '缺少 content-security-policy 响应头：后端需在 app.ts 中注册 registerSecurityHeaders()',
  ).toBeTruthy();
  for (const directive of REQUIRED_CSP_DIRECTIVES) {
    expect(csp, `CSP 缺少 ${directive} 指令，当前为：${csp}`).toContain(directive);
  }

  expect(headers['x-content-type-options'], '缺少 x-content-type-options: nosniff').toBe('nosniff');
});

test('CSP 不阻断门户自身前端产物：页面能挂载且无 CSP 违规', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy/i.test(text)) violations.push(text);
  });

  await page.goto('/');

  // 前端挂载成功的证据（三种可能落地页都覆盖：初始化页 / 登录页 / 已登录首页）
  await expect(page.locator('#root')).toContainText(/门户|首次启动|你好/);

  expect(violations, `出现 CSP 违规（说明头配得太紧、会阻断门户自身资源）：${violations.join(' | ')}`).toEqual([]);
});