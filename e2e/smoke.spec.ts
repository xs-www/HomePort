/**
 * 冒烟用例：Sprint 0（首启初始化 / 登录登出 / 关键页面降级展示 / 角色权限）
 * + Sprint 1（服务墙、手工服务持久化、Ctrl+K 搜索、viewer 管理边界）。
 *
 * 前置条件由 `e2e/start-server.mjs` 保证（Playwright 的 webServer）：
 * 每次运行都会**清空 `.e2e-data`** 后重新构建并启动生产服务，因此：
 * - 数据集是"尚未初始化"的空库，首启流程可重复执行；
 * - Docker socket 指向不存在的路径、tailnet 模式为 `off`，用于验证降级展示。
 *
 * 约定：
 * - 断言落在**可见文案或 URL** 上，不只断言 HTTP 200 —— "接口通但页面白屏"必须能被发现；
 * - 每个用例仍用默认的独立浏览器上下文（Cookie 不跨用例），但**每个角色只真正登录一次**，
 *   其余用例复用缓存的会话 —— 原因见 `loginAs` 上方关于登录限速的说明；
 *
 * 顺序敏感：用例按声明顺序串行执行（`workers: 1`），第 2 条会真正创建管理员，
 * 倒数第 2 条创建 viewer，末尾两条 Sprint 1 用例依赖这两类账号。
 */
import { expect, test, type Cookie, type Page } from '@playwright/test';

/** 与 e2e/start-server.mjs 保持一致的固定测试凭据（不是真实密钥）。 */
const SETUP_TOKEN = process.env.PORTAL_E2E_SETUP_TOKEN ?? 'E2E-TEST-TOKEN-0000-0000';
const ADMIN_USERNAME = 'admin';
/** 满足项目密码规则：≥10 位 + 至少两类字符（这里四类齐备） */
const ADMIN_PASSWORD = 'E2eAdmin!2026';
const VIEWER_USERNAME = 'viewer01';
const VIEWER_PASSWORD = 'E2eViewer!2026';

/**
 * 出现这些文案说明渲染崩了。
 *
 * 说明：当前前端**没有** ErrorBoundary 组件（全仓检索无 `componentDidCatch`），
 * 所以"错误边界文案"只能作为兜底断言；真正的崩溃检测靠 `pageerror` 事件。
 */
const CRASH_TEXTS = ['页面出错了', '出了点问题', 'Something went wrong', 'Application error'];

/** 收集页面未捕获异常，用例结束时统一断言（避免只看到"页面是空的"却不知原因）。 */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * 已建立会话的角色 → cookies（**每个角色只真正登录一次**）。
 *
 * 为什么必须复用：登录接口的限速是**硬编码的安全常量**
 * `LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }`（`server/src/api/auth.ts`，防暴力破解）。
 * 而本套件每条用例都要以某个身份进入，用例数一多就会把 10 次/分钟的额度用光 ——
 * Sprint 2 新增两条用例后**真的发生了**：末尾那条（移动端排版）被 429 挡在登录页上，
 * 服务端日志里留下 `RATE_LIMITED` + `"ip":"127.0.0.1"`，症状却表现为"登录页标题一直不消失"。
 *
 * 处理原则：**绝不为测试放宽安全控制**（那是对真实攻击面的削弱），而是让每个角色
 * 只走一次真实登录表单（登录流程本身仍有覆盖），其余用例复用同一份 cookies。
 * `workers: 1` 且同源，因此进程内缓存就足够；这也是以后再加用例不会再撞上限速的原因。
 */
const sessions = new Map<string, Cookie[]>();

/**
 * 走真实登录表单登录，并**确定性地**落到服务墙。
 *
 * 为什么要显式回到 `/`：登录页会用 React Router 的 `state.from` 把用户送回"当初想去的页面"，
 * 而 `state.from` 存在 history entry 里，**同 URL 的 goto 会保留它**（等价于刷新）。
 * 例如"在 /admin 点退出"之后的 from 就是 `/admin`，viewer 登录后会被 AdminOnly 拦在权限不足页。
 * 这是产品预期行为（用例 3 专门验证它），但会让"以某身份登录"的辅助函数变得不确定，
 * 所以这里统一在登录完成后显式导航到首页。
 */
/**
 * 试着重放缓存里的会话；若已被撤销（见下）就返回 `false`，交由调用方走真实登录。
 *
 * 为什么要"试用 + 兜底"而不是直接用：缓存的是**会话令牌本身**，而"登录登出"是
 * Sprint 0 的验收项 —— 用例会真的点「退出」，退出会在服务端**撤销该会话**。
 * 于是缓存里那枚令牌从那一刻起就作废了，硬用它只会落到登录页，
 * 症状是"登录后服务墙标题找不到"（且日志里不会有 401 警告，因为那是正常的未认证响应）。
 * 这里用短超时探测，失效就重新登录并刷新缓存 —— 自愈，且不会因此多花多少次登录额度。
 */
async function restoreSession(page: Page, cookies: Cookie[]): Promise<boolean> {
  await page.context().addCookies(cookies);
  await page.goto('/');
  try {
    await expect(page.getByRole('heading', { level: 1, name: '服务' })).toBeVisible({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function loginAs(page: Page, username: string, password: string): Promise<void> {
  // 先清空：同一用例里可能要换身份（例如"viewer 看不到、管理员可见"要在两条会话间切换），
  // 若不清，上下文里会同时存在两个同名 `hp_session`，服务端解析不出有效会话。
  await page.context().clearCookies();

  const cached = sessions.get(username);
  if (cached && (await restoreSession(page, cached))) return;

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'HomePort 门户' })).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: '登录' }).click();

  // 等登录真正完成（离开登录页）再导航，否则整页跳转会打断还在飞的登录请求
  await expect(page.getByRole('heading', { name: 'HomePort 门户' })).toHaveCount(0);
  // 登录成功即缓存会话：由于上面已清空，这里捕获到的**只有本次登录**产生的 cookie，
  // 不会把上一个身份的会话一起缓存进去（限速额度对每个角色只花一次）
  sessions.set(username, await page.context().cookies());
  await page.goto('/');
  // Sprint 1 起 `/` 是服务墙（总览迁到 `/overview`），登录成功的落点断言也随之改变
  await expect(page.getByRole('heading', { level: 1, name: '服务' })).toBeVisible();
}

/**
 * 侧栏导航里的链接。
 *
 * 必须限定在 `<nav>` 内：页面正文里也有同名词（如总览页的「查看容器入口 →」、
 * 「查看设备列表 →」），不限定范围会触发 Playwright 的 strict mode 报错。
 */
function navLink(page: Page, name: string) {
  return page.getByRole('navigation').getByRole('link', { name, exact: true });
}

/** 断言页面没有未捕获异常与崩溃文案。 */
async function expectNoCrash(page: Page, errors: string[]): Promise<void> {
  for (const text of CRASH_TEXTS) {
    await expect(page.getByText(text), `出现了疑似崩溃文案：${text}`).toHaveCount(0);
  }
  expect(errors, `页面出现未捕获异常：${errors.join(' | ')}`).toEqual([]);
}

test('首启初始化：首次访问被引导到初始化页，错误令牌被拒绝', async ({ page }) => {
  const errors = trackPageErrors(page);

  // 未初始化时访问任何路径都应被引导到 /setup
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: '首次启动 · 创建管理员' })).toBeVisible();

  await page.locator('#token').fill('WRONG-TOKEN-000000');
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.locator('#confirm').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '创建管理员并进入门户' }).click();

  // 后端文案：ApiError.message =「初始化令牌不正确」
  await expect(page.getByText('初始化令牌不正确').first()).toBeVisible();
  // 失败后必须停留在初始化页，且没有进入已登录状态
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('button', { name: '创建管理员并进入门户' })).toBeVisible();

  await expectNoCrash(page, errors);
});

test('首启初始化：正确令牌创建管理员并直接进入已登录状态', async ({ page }) => {
  const errors = trackPageErrors(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  await page.locator('#token').fill(SETUP_TOKEN);
  await page.locator('#username').fill(ADMIN_USERNAME);
  await page.locator('#displayName').fill('管理员');
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.locator('#confirm').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '创建管理员并进入门户' }).click();

  // bootstrap 成功后前端会立刻用同一凭据登录并跳回首页（`/` = 服务墙）
  await expect(page.getByRole('heading', { level: 1, name: '服务' })).toBeVisible();
  expect(new URL(page.url()).pathname, '初始化成功后应回到首页').toBe('/');

  // 已登录的直接证据：侧栏出现管理员专属入口
  await expect(navLink(page, '账号管理')).toBeVisible();

  await expectNoCrash(page, errors);
});

test('登录/登出：未登录访问受保护路由被挡回登录页，登录后回到原页面', async ({ page }) => {
  const errors = trackPageErrors(page);

  // 未登录直接访问受保护路由 → 挡回登录页
  await page.goto('/containers');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'HomePort 门户' })).toBeVisible();

  // 登录后应回到当初想去的页面（LoginPage 的 state.from）
  await page.locator('#username').fill(ADMIN_USERNAME);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/containers$/);
  await expect(page.getByRole('heading', { level: 1, name: '容器' })).toBeVisible();

  // 登出 → 回到登录页
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'HomePort 门户' })).toBeVisible();

  await expectNoCrash(page, errors);
});

test('关键页面可加载：Docker 与 tailnet 均不可用时显示降级提示而非白屏', async ({ page }) => {
  const errors = trackPageErrors(page);
  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  // ---- 总览（Sprint 1 起在 `/overview`）：聚合告警卡列出各数据源故障原因
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: '数据源提示' })).toBeVisible();
  await expect(page.locator('li').filter({ hasText: '容器：' }).first()).toBeVisible();
  await expect(page.locator('li').filter({ hasText: 'tailnet：' }).first()).toBeVisible();

  // ---- 容器页：Docker 数据源不可用卡片（而不是空列表或白屏）
  await page.goto('/containers');
  await expect(page.getByRole('heading', { level: 1, name: '容器' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Docker 数据源不可用' })).toBeVisible();
  await expect(page.getByText('在 Docker 内部署时，请确认 compose 中已挂载引擎 socket')).toBeVisible();

  // ---- 设备页：tailnet 数据源不可用卡片 + 明确原因
  await page.goto('/devices');
  await expect(page.getByRole('heading', { level: 1, name: 'tailnet 设备' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'tailnet 数据源不可用' })).toBeVisible();
  await expect(page.getByText('tailnet 查询已通过 PORTAL_TAILSCALE_MODE=off 关闭')).toBeVisible();

  // ---- 系统页：CPU / 内存 / 磁盘 / GPU 四张卡片都要渲染（GPU 不可用时给出原因）
  await page.goto('/system');
  await expect(page.getByRole('heading', { level: 1, name: '系统指标' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CPU' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '内存' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '磁盘' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GPU' })).toBeVisible();

  // ---- 工具页：内置目录不依赖 Docker/tailnet，应能正常统计
  await page.goto('/tools');
  await expect(page.getByRole('heading', { level: 1, name: '工具入口' })).toBeVisible();
  await expect(page.getByText(/共 \d+ 个工具 · 可用 \d+ · 不可用 \d+ · 未探测 \d+/)).toBeVisible();

  await expectNoCrash(page, errors);
});

test('权限：viewer 看不到「账号管理」入口，管理员可见；viewer 直接被挡出 /admin', async ({ page }) => {
  const errors = trackPageErrors(page);

  // ---- 管理员创建一个只读账号
  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: '账号管理' })).toBeVisible();

  await page.getByRole('button', { name: '新建用户' }).click();
  // 用 placeholder 反查新建表单，避免与用户表里的角色下拉混淆（strict mode）
  const createForm = page.locator('form', { has: page.getByPlaceholder('viewer01') });
  await createForm.getByPlaceholder('viewer01').fill(VIEWER_USERNAME);
  await createForm.getByPlaceholder('访客').fill('访客');
  await createForm.getByPlaceholder('至少 10 位').fill(VIEWER_PASSWORD);
  await createForm.locator('select').selectOption('viewer');
  await createForm.getByRole('button', { name: '创建' }).click();

  // 创建成功后表单收起，新账号出现在用户表里
  await expect(page.getByPlaceholder('viewer01')).toHaveCount(0);
  await expect(page.getByText(VIEWER_USERNAME).first()).toBeVisible();
  // 新账号的角色下拉必须是「只读」（viewer）
  await expect(page.locator('tbody tr', { hasText: VIEWER_USERNAME }).locator('select')).toHaveValue('viewer');

  // ---- viewer 登录：看不到「账号管理」入口
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await loginAs(page, VIEWER_USERNAME, VIEWER_PASSWORD);

  await expect(navLink(page, '账号管理')).toHaveCount(0);
  await expect(page.getByText('只读用户').first()).toBeVisible();
  // 其它入口仍应可见（viewer 能看全部只读页面）
  await expect(navLink(page, '容器')).toBeVisible();

  // viewer 直接敲 /admin → 权限不足页（后端也会独立拒绝）
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: '权限不足' })).toBeVisible();
  await expect(page.getByText('需要管理员权限')).toBeVisible();

  // ---- 换回管理员：入口恢复
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await expect(navLink(page, '账号管理')).toBeVisible();

  await expectNoCrash(page, errors);
});

/* ------------------------------------------------------------------ *
 * Sprint 1：服务注册表与首页服务墙
 *
 * 为什么追加在本文件末尾而不是新建 spec 文件：`.e2e-data` 只在整轮开始时清空一次，
 * 而 admin/viewer 两个账号是由本文件上面的用例创建的，Playwright 按文件名排序执行文件
 * （`services.spec.ts` 会排到 `smoke.spec.ts` 之前），新建文件就会在"还没有账号"时运行。
 * 放在文件末尾即可确定性地复用已建好的账号。
 *
 * 另一件必须知道的事：E2E 环境里 Docker 指向不存在的 socket、Tailscale 为 off，
 * 也就是**自动发现一定拿不到数据**。这不是缺陷，而是最值得验的场景 ——
 * 服务墙必须在数据源全挂时依然可读、可解释，并允许管理员手工建服务。
 * ------------------------------------------------------------------ */

test('服务墙：数据源全不可用时给出可解释的降级提示，管理员可手工新建服务且刷新后仍在', async ({ page }) => {
  const errors = trackPageErrors(page);
  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);

  // 首页就是服务墙（Sprint 1 起 `/` 不再是总览）
  await expect(page.getByRole('heading', { level: 1, name: '服务' })).toBeVisible();
  // 降级必须被解释，而不是静默空白（Docker 源在 E2E 里是故意故障的）
  await expect(page.getByText(/Docker/).first()).toBeVisible();

  // ---- 管理员新建一个自定义服务（不依赖任何数据源）
  await page.goto('/admin/services');
  await expect(page.getByRole('heading', { level: 1, name: '服务管理' })).toBeVisible();

  await page.getByRole('button', { name: '新建服务' }).click();
  await page.locator('#service-name').fill('测试服务');
  await page.locator('#service-category').fill('测试');
  await page.locator('#service-url').fill('https://example.ts.net/app');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByText('测试服务').first()).toBeVisible();

  // 刷新后仍在 = 真的落库了（用户配置不得只活在内存里）
  await page.reload();
  await expect(page.getByText('测试服务').first()).toBeVisible();

  // ---- 首页服务墙能看到它，首选入口就是刚填的那个
  await page.goto('/');
  await expect(page.getByRole('link', { name: '测试服务' })).toBeVisible();
  await expect(page.locator('a[href="https://example.ts.net/app"]').first()).toBeVisible();

  await expectNoCrash(page, errors);
});

test('服务墙：Ctrl+K 搜索并进入服务详情；viewer 看不到任何管理入口', async ({ page }) => {
  const errors = trackPageErrors(page);

  // ---- 管理员：Ctrl+K → 搜到服务 → Enter 落到详情页
  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // 输入框是 `role="combobox"`（显式 role 会覆盖隐式的 textbox，所以不能用 getByRole('textbox')）
  await dialog.getByRole('combobox').fill('测试服务');
  await expect(dialog.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/services\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: '服务详情' })).toBeVisible();

  // ---- viewer：只读，服务可见但没有管理入口
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await loginAs(page, VIEWER_USERNAME, VIEWER_PASSWORD);

  await expect(navLink(page, '服务')).toBeVisible();
  await expect(navLink(page, '服务管理')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建服务' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '测试服务' })).toBeVisible();

  // 直接敲管理页 → 权限不足（后端也会独立拒绝写接口）
  await page.goto('/admin/services');
  await expect(page.getByRole('heading', { level: 1, name: '权限不足' })).toBeVisible();

  await expectNoCrash(page, errors);
});

/**
 * Sprint 2：历史与告警（S2-01…S2-04 的生产产物验收）。
 *
 * 这一条**故意不验曲线形状**：缺口断开、部分缺测、百分比/字节不混淆这些语义，
 * 在后端"可注入时钟的一昼夜仿真"与前端"图表纯函数单测"里验得更准更稳。
 * E2E 的价值是另外三件事：生产产物真能打开这两页、空库时不白屏也不画假线、
 * 权限边界在**真实 HTTP** 上确实拦住。
 *
 * 空态为什么确定：`e2e/start-server.mjs` 把 `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` 设为 3600
 * （后台采集仍开着），所以整个用例集内库里不会出现任何历史行。
 */
test('历史与告警：导航可达、空历史不画 0 线、四条内置规则默认关闭', async ({ page }) => {
  const errors = trackPageErrors(page);

  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await expect(navLink(page, '历史')).toBeVisible();
  await expect(navLink(page, '告警')).toBeVisible();

  // ---- 历史页：空态可读（"没有数据"必须说出来，而不是给一条 0 的平线）
  await navLink(page, '历史').click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByText('还没有历史数据')).toBeVisible();

  // 接口层同样要诚实：没有样本时 points 为空、summary 的统计量是 null 而不是 0
  const historyResponse = await page.request.get(
    '/api/metrics/history?metric=host.cpu.percent&target=host&range=1h',
  );
  expect(historyResponse.status()).toBe(200);
  const history = await historyResponse.json();
  expect(history.points).toEqual([]);
  expect(history.summary.count).toBe(0);
  expect(history.summary.avg).toBeNull();
  expect(history.unit).toBe('percent');
  expect(history.sampling.intervalSec).toBe(3600);

  // 存储与保留配置真的通到了接口（"历史数据量与库大小被记录"这条验收要靠它）
  const storageResponse = await page.request.get('/api/metrics/storage');
  expect(storageResponse.status()).toBe(200);
  const storage = await storageResponse.json();
  expect(storage.retention).toMatchObject({ minuteHours: 24, hourDays: 30 });
  // 库大小按 §1.1 的口径报出（`page_count × page_size`），而不是"文件多大"这种含 WAL 的模糊量
  expect(storage.size.bytes).toBeGreaterThan(0);
  expect(storage.size.pageCount).toBeGreaterThan(0);
  // 预算判据必须可读，且稳态上限就是 §1.1 冻结的 32 MB（"数据量符合预算"这条验收靠它）
  expect(storage.budget.steadyLimitBytes).toBe(32 * 1024 * 1024);
  expect(storage.budget.withinBudget).toBe(true);

  // ---- 规则状态用同源 API 断言真实值：UI 上的"关闭"可能是渲染假象
  const rulesResponse = await page.request.get('/api/alerts/rules');
  expect(rulesResponse.status()).toBe(200);
  const rules = await rulesResponse.json();
  expect(rules.items.map((rule: { name: string }) => rule.name).sort()).toEqual(
    ['内存使用率过高', '容器异常退出', '磁盘使用率过高', '服务连续探测失败'].sort(),
  );
  expect(rules.items.every((rule: { enabled: boolean }) => rule.enabled === false)).toBe(true);
  expect(rules.items.every((rule: { builtin: boolean }) => rule.builtin === true)).toBe(true);

  await navLink(page, '告警').click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByText('磁盘使用率过高')).toBeVisible();

  await expectNoCrash(page, errors);
});

test('告警页：viewer 只读（没有写入口，带有效 CSRF 的写请求也被后端拒绝）', async ({ page }) => {
  const errors = trackPageErrors(page);

  await loginAs(page, VIEWER_USERNAME, VIEWER_PASSWORD);
  await expect(navLink(page, '告警')).toBeVisible();
  await navLink(page, '告警').click();
  await expect(page).toHaveURL(/\/alerts$/);

  // viewer 能看规则（只读），但界面上没有任何写入口。
  await expect(page.getByText('磁盘使用率过高')).toBeVisible();
  // 只断言**按钮的可访问名**、并尽量用 exact：规则列表里的状态文案（「启用中」「已关闭」）
  // 会误命中宽泛的正则 —— `确认|保存|启用` 就会命中「启用中」，
  // 那种失败是测试自己的问题，不是权限问题。
  await expect(page.getByRole('button', { name: '确认', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^编辑规则/ })).toHaveCount(0);

  // 后端独立拒绝。**必须带上有效的 CSRF 令牌**，否则这个 403 只是因为缺 CSRF 才出现，
  // 就证明不了角色鉴权（两个不同的拒绝理由不能混为一谈）。
  const sessionResponse = await page.request.get('/api/auth/session');
  expect(sessionResponse.status()).toBe(200);
  const { csrfToken } = await sessionResponse.json();
  expect(typeof csrfToken).toBe('string');

  const rulesResponse = await page.request.get('/api/alerts/rules');
  const rules = await rulesResponse.json();
  const patchResponse = await page.request.patch(`/api/alerts/rules/${rules.items[0].id}`, {
    data: { enabled: true },
    headers: { 'x-csrf-token': csrfToken },
  });
  expect(patchResponse.status()).toBe(403);

  await expectNoCrash(page, errors);
});

/**
 * 移动端排版验收（计划 §4 明确要求"移动端"）。
 *
 * 为什么必须用真实视口而不是单测：卡片是 Tailwind 断点驱动的（`grid sm:grid-cols-2 xl:grid-cols-3`），
 * jsdom 不做布局，单测里 `getComputedStyle` 拿不到真实轨道数；横向溢出这类破版更是只有真浏览器能发现。
 * 用 iPhone 13 的视口（390×844）。
 */
test('服务墙：移动视口下单列排版、无横向溢出，命令面板可用且不溢出', async ({ page }) => {
  const errors = trackPageErrors(page);

  await loginAs(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '服务' })).toBeVisible();

  const grid = page.getByTestId('service-grid');
  await expect(grid).toBeVisible();

  // 1) 单列：<640px 不该出现两列（这是移动端最常见的破版）
  const tracks = await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(tracks).toBe(1);

  // 2) 卡片落在视口内，且页面不横向滚动
  const card = grid.locator('article').first();
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowX).toBeLessThanOrEqual(1);

  // 3) 小屏下命令面板照样能用，且不溢出视口
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(391);

  await expectNoCrash(page, errors);
});