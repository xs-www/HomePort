/**
 * 账号管理 · 安全与偏好标签页（F5 / S0-03）。
 *
 * 职责：当前账号的自助操作，分区块 ——
 * 1. 两步验证（TOTP）：绑定 / 一次性恢复码 / 重新生成恢复码 / 关闭；
 * 2. 修改我的密码（改后其它设备会话失效）；
 * 3. 显示偏好（主题、默认落地页，写入服务端偏好）；
 * 4. 当前会话（按需读取会话 ID / 签发与过期时间 / 来源 IP / 客户端）；
 * 5. 账号信息与退出登录。
 *
 * 偏好与账号信息取自 `AuthProvider`（`AdminPage` 以 props 传入偏好与更新回调），
 * 会话诊断数据由本组件按需加载；两步验证状态来自 `user.totpEnabled`，
 * 变更后调用 `refresh()` 让上下文与界面同步。
 */
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider.js';
import { Badge, Card, ErrorNotice, Icon } from '../../components/ui.js';
import { useAsync, useSubmit } from '../../hooks/useAsync.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import type { TotpSetupResponse, UserPreferences } from '../../api/types.js';

export function SecurityTab({
  preferences,
  onChange,
}: {
  preferences: UserPreferences | null;
  onChange: (input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>) => Promise<void>;
}): ReactNode {
  const { api, user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const { submitting, error, fieldErrors, submit } = useSubmit();

  const loadActivity = useCallback(() => api.sessionActivity(), [api]);
  const activity = useAsync(loadActivity, { immediate: false });

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setMessage('两次输入的新密码不一致');
      return;
    }
    const ok = await submit(async () => {
      await api.changePassword({ currentPassword, newPassword });
    });
    if (ok) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setMessage('密码已修改，其它设备的会话已失效');
      void activity.reload();
    } else {
      setMessage(null);
    }
  };

  return (
    <div className="space-y-4">
      <TotpSection />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="修改我的密码" subtitle="修改成功后，除当前会话外的其它会话都会被吊销">
          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="label">当前密码</label>
              <input
                type="password"
                className="input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              {fieldErrors.currentPassword ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.currentPassword[0]}</p> : null}
            </div>
            <div>
              <label className="label">新密码</label>
              <input
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
              {fieldErrors.newPassword ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.newPassword[0]}</p> : null}
            </div>
            <div>
              <label className="label">确认新密码</label>
              <input
                type="password"
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            {error ? <ErrorNotice message={error} /> : null}
            {message ? (
              <p className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-300">{message}</p>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={submitting || !currentPassword || !newPassword}>
              {submitting ? '提交中…' : '修改密码'}
            </button>
          </form>
        </Card>

        <div className="space-y-4">
          <Card title="显示偏好">
            <div className="space-y-3 text-xs">
              <div>
                <label className="label">主题</label>
                <select
                  className="input"
                  value={preferences?.theme ?? 'dark'}
                  onChange={(e) => void onChange({ theme: e.target.value as 'dark' | 'light' | 'system' })}
                >
                  <option value="dark">暗色</option>
                  <option value="light">亮色</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>
              <div>
                <label className="label">默认落地页</label>
                <select
                  className="input"
                  value={preferences?.defaultPage ?? 'overview'}
                  onChange={(e) => void onChange({ defaultPage: e.target.value })}
                >
                  <option value="overview">总览</option>
                  <option value="containers">容器</option>
                  <option value="devices">tailnet 设备</option>
                  <option value="system">系统指标</option>
                  <option value="tools">工具入口</option>
                </select>
              </div>
            </div>
          </Card>

          <Card
            title="当前会话"
            actions={
              <button type="button" className="btn btn-ghost" onClick={() => void activity.reload()}>
                <Icon name="refresh" className="size-3.5" />
                查看
              </button>
            }
          >
            {activity.data ? (
              <div className="space-y-1.5 text-xs">
                <p>
                  <span className="muted">会话 ID：</span>
                  <span className="font-mono">{activity.data.sessionId}</span>
                </p>
                <p>
                  <span className="muted">签发于：</span>
                  {formatDateTime(activity.data.createdAt)}
                </p>
                <p>
                  <span className="muted">过期于：</span>
                  {formatDateTime(activity.data.expiresAt)}
                </p>
                <p>
                  <span className="muted">最近活跃：</span>
                  {formatRelative(activity.data.lastSeenAt)}
                </p>
                <p className="break-all">
                  <span className="muted">来源：</span>
                  {activity.data.remoteAddr ?? '—'}
                </p>
                <p className="break-all">
                  <span className="muted">客户端：</span>
                  {activity.data.userAgent ?? '—'}
                </p>
              </div>
            ) : (
              <p className="muted text-xs">点击「查看」读取当前会话信息</p>
            )}
          </Card>

          <Card title="账号信息">
            <div className="space-y-1.5 text-xs">
              <p>
                <span className="muted">用户名：</span>
                <span className="font-mono">{user?.username}</span>
              </p>
              <p>
                <span className="muted">角色：</span>
                {user?.role === 'admin' ? '管理员' : '只读用户'}
              </p>
              <p>
                <span className="muted">创建时间：</span>
                {formatDateTime(user?.createdAt)}
              </p>
            </div>
            <button type="button" className="btn btn-danger mt-4" onClick={() => void logout()}>
              <Icon name="logout" className="size-3.5" />
              退出登录
            </button>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 两步验证（TOTP）

/** 复制文本到剪贴板；不可用（非安全上下文 / 无权限）时返回 false，由界面降级为"手动选中复制"。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 两步验证自助管理。
 *
 * 刻意**不引入二维码库**：只展示密钥文本与 otpauth 链接 ——
 * 验证器 App 都支持手动输入密钥，少一个依赖就少一份供应链风险。
 */
function TotpSection(): ReactNode {
  const { api, user, refresh } = useAuth();
  const enabled = user?.totpEnabled === true;

  /** 未确认的种子（setup 返回）；仅停留在内存中 */
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [enableCode, setEnableCode] = useState('');
  /** 一次性恢复码；非 null 表示弹窗打开中 */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [regenerated, setRegenerated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [regenCode, setRegenCode] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const setupSubmit = useSubmit();
  const enableSubmit = useSubmit();
  const regenSubmit = useSubmit();
  const disableSubmit = useSubmit();

  const flashCopied = (label: string): void => {
    setCopied(label);
    setTimeout(() => setCopied((current) => (current === label ? null : current)), 2000);
  };

  /** 生成/重新生成未确认种子。 */
  const onStartSetup = async (): Promise<void> => {
    setNotice(null);
    const ok = await setupSubmit.submit(async () => {
      const result = await api.totpSetup();
      setSetup(result);
      setEnableCode('');
    });
    if (ok) setNotice('已生成未确认的密钥，请在验证器 App 中完成绑定后回来输入验证码。');
  };

  /** 确认绑定：成功后一次性拿到恢复码。 */
  const onEnable = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const ok = await enableSubmit.submit(async () => {
      const result = await api.totpEnable({ code: enableCode.trim() });
      setSetup(null);
      setEnableCode('');
      setRegenerated(false);
      setRecoveryCodes(result.recoveryCodes);
    });
    if (ok) setNotice('两步验证已启用。');
  };

  /** 重新生成恢复码（旧码立即失效）。 */
  const onRegenerate = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const ok = await regenSubmit.submit(async () => {
      const result = await api.totpRegenerateRecoveryCodes({ code: regenCode.trim() });
      setRegenCode('');
      setRegenerated(true);
      setRecoveryCodes(result.recoveryCodes);
    });
    if (ok) setNotice('已生成新的恢复码，旧的恢复码已全部失效。');
  };

  /** 关闭两步验证（需密码）。 */
  const onDisable = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const ok = await disableSubmit.submit(async () => {
      await api.totpDisable({
        password: disablePassword,
        ...(disableCode.trim() === '' ? {} : { code: disableCode.trim() }),
      });
      setDisablePassword('');
      setDisableCode('');
      setShowDisable(false);
      await refresh();
    });
    if (ok) setNotice('两步验证已关闭，之后登录只需密码。');
  };

  return (
    <Card
      title="两步验证（TOTP）"
      subtitle="登录时额外验证验证器 App 生成的动态码；支持一次性恢复码兜底"
      actions={<Badge tone={enabled ? 'ok' : 'idle'} dot>{enabled ? '已启用' : '未启用'}</Badge>}
    >
      <div className="space-y-3 text-xs">
        {/* 状态行 */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
          <span>
            <span className="muted">启用状态：</span>
            <span className={enabled ? 'text-emerald-600 dark:text-emerald-300' : ''}>{enabled ? '已启用' : '未启用'}</span>
          </span>
          {enabled ? (
            <span>
              <span className="muted">启用时间：</span>
              {formatDateTime(user?.totpConfirmedAt)}
            </span>
          ) : null}
        </div>

        {notice ? (
          <p className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-300">{notice}</p>
        ) : null}

        {/* ---------------------------------------------- 未启用：绑定流程 */}
        {!enabled ? (
          <div className="space-y-3">
            {setup === null ? (
              <>
                <p className="muted leading-relaxed">
                  启用后，用密码登录时还需要输入验证器 App（如 Aegis、1Password、Google Authenticator）
                  生成的 6 位动态码。本门户不内置二维码，绑定方式为"手动输入密钥"或"粘贴 otpauth 链接"。
                </p>
                {setupSubmit.error ? <ErrorNotice message={setupSubmit.error} /> : null}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={setupSubmit.submitting}
                  onClick={() => void onStartSetup()}
                >
                  <Icon name="shield" className="size-3.5" />
                  {setupSubmit.submitting ? '生成中…' : '启用两步验证'}
                </button>
              </>
            ) : (
              <>
                <div className="space-y-2 rounded-xl bg-slate-500/6 px-4 py-3">
                  <div>
                    <label className="label" htmlFor="totp-secret">
                      密钥（在验证器 App 里手动输入）
                    </label>
                    <code
                      id="totp-secret"
                      className="mt-1 block select-all font-mono text-xs break-all rounded-lg bg-slate-900/5 px-3 py-2 dark:bg-white/6"
                    >
                      {setup.secret}
                    </code>
                  </div>
                  <div>
                    <span className="label">otpauth 链接（也可粘贴到 App 的"导入"里）</span>
                    <code className="mt-1 block select-all font-mono text-[11px] break-all rounded-lg bg-slate-900/5 px-3 py-2 dark:bg-white/6">
                      {setup.otpauthUri}
                    </code>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost px-2 py-1 text-[11px]"
                      onClick={() => {
                        void copyText(setup.secret).then((ok) => {
                          if (ok) flashCopied('密钥已复制');
                        });
                      }}
                    >
                      {copied === '密钥已复制' ? '已复制' : '复制密钥'}
                    </button>
                    <span className="muted text-[11px]">
                      参数：{setup.digits} 位动态码 · 每 {setup.period} 秒刷新
                    </span>
                  </div>
                </div>

                <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
                  点「重新生成密钥」会使<strong className="font-semibold">上一次未确认的种子立即失效</strong>
                  （已确认绑定的种子不受影响），请只保留当前这一个密钥。
                </p>

                <form onSubmit={onEnable} className="space-y-2">
                  <div>
                    <label className="label" htmlFor="totp-enable-code">
                      验证器 App 上的 6 位动态码
                    </label>
                    <input
                      id="totp-enable-code"
                      className="input font-mono tracking-[0.2em]"
                      value={enableCode}
                      onChange={(e) => setEnableCode(e.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="123456"
                      aria-invalid={enableSubmit.error !== null}
                    />
                  </div>
                  {enableSubmit.error ? <ErrorNotice message={enableSubmit.error} /> : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={enableSubmit.submitting || enableCode.trim().length !== 6}
                    >
                      {enableSubmit.submitting ? '验证中…' : '确认启用'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={setupSubmit.submitting}
                      onClick={() => {
                        if (!confirm('重新生成会使上一次未确认的种子失效，确定继续？')) return;
                        void onStartSetup();
                      }}
                    >
                      {setupSubmit.submitting ? '生成中…' : '重新生成密钥'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setSetup(null);
                        setEnableCode('');
                        setNotice(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        ) : (
          /* ---------------------------------------------- 已启用：恢复码与关闭 */
          <div className="space-y-4">
            <p className="muted leading-relaxed">
              保持验证器 App 与恢复码可用；验证器丢失时用恢复码登录（每个恢复码只能使用一次）。
              关闭后账号仅凭密码即可登录，安全性会下降。
            </p>

            <form onSubmit={onRegenerate} className="space-y-2">
              <div>
                <label className="label" htmlFor="totp-regen-code">
                  重新生成恢复码（需当前动态码）
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="totp-regen-code"
                    className="input max-w-40 font-mono tracking-[0.2em]"
                    value={regenCode}
                    onChange={(e) => setRegenCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    aria-invalid={regenSubmit.error !== null}
                  />
                  <button
                    type="submit"
                    className="btn btn-ghost"
                    disabled={regenSubmit.submitting || regenCode.trim().length !== 6}
                  >
                    {regenSubmit.submitting ? '生成中…' : '重新生成恢复码'}
                  </button>
                </div>
              </div>
              {regenSubmit.error ? <ErrorNotice message={regenSubmit.error} /> : null}
            </form>

            {showDisable ? (
              <form onSubmit={onDisable} className="space-y-3 rounded-xl bg-rose-500/6 px-4 py-3">
                <p className="text-rose-700 dark:text-rose-300">
                  关闭两步验证需要确认密码{user?.username ? `（当前账号 ${user.username}）` : ''}。
                </p>
                <div>
                  <label className="label" htmlFor="totp-disable-password">
                    当前密码
                  </label>
                  <input
                    id="totp-disable-password"
                    type="password"
                    className="input"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    autoComplete="current-password"
                    aria-invalid={disableSubmit.fieldErrors.password !== undefined}
                    required
                  />
                  {disableSubmit.fieldErrors.password ? (
                    <p className="mt-1 text-[11px] text-rose-500">{disableSubmit.fieldErrors.password[0]}</p>
                  ) : null}
                </div>
                <div>
                  <label className="label" htmlFor="totp-disable-code">
                    当前验证码或恢复码
                  </label>
                  <input
                    id="totp-disable-code"
                    className="input max-w-40 font-mono tracking-[0.2em]"
                    value={disableCode}
                    onChange={(e) => setDisableCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={9}
                    placeholder="123456"
                    aria-invalid={disableSubmit.fieldErrors.code !== undefined}
                  />
                  {disableSubmit.fieldErrors.code ? (
                    <p className="mt-1 text-[11px] text-rose-500">{disableSubmit.fieldErrors.code[0]}</p>
                  ) : null}
                  <p className="muted mt-1.5 text-[11px]">
                    关闭两步验证需要验证器仍在手边：请填当前的 6 位动态码，或用恢复码（形如{' '}
                    <span className="font-mono">XXXX-XXXX</span>）。
                  </p>
                </div>
                {disableSubmit.error ? <ErrorNotice message={disableSubmit.error} /> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    className="btn btn-danger"
                    disabled={disableSubmit.submitting || disablePassword === '' || disableCode.trim().length < 6}
                  >
                    {disableSubmit.submitting ? '提交中…' : '确认关闭两步验证'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setShowDisable(false);
                      setDisablePassword('');
                      setDisableCode('');
                    }}
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setShowDisable(true)}>
                关闭两步验证
              </button>
            )}
          </div>
        )}
      </div>

      {recoveryCodes ? (
        <RecoveryCodesDialog
          codes={recoveryCodes}
          regenerated={regenerated}
          onClose={() => {
            setRecoveryCodes(null);
            setRegenerated(false);
            // 绑定/关闭状态可能已变化，刷新上下文让界面与后端一致
            void refresh();
          }}
        />
      ) : null}
    </Card>
  );
}

/** 一次性恢复码弹窗：必须勾选"我已保存恢复码"才能关闭。 */
function RecoveryCodesDialog({
  codes,
  regenerated,
  onClose,
}: {
  codes: string[];
  regenerated: boolean;
  onClose: () => void;
}): ReactNode {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="totp-recovery-title"
        className="card w-full max-w-md space-y-4 px-5 py-5"
      >
        <div>
          <h3 id="totp-recovery-title" className="text-sm font-semibold">
            {regenerated ? '新的恢复码（只显示这一次）' : '恢复码（只显示这一次）'}
          </h3>
          <p className="mt-1 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
            这些码只显示这一次，请立即保存。关闭后无法再次查看；每个恢复码只能使用一次。
            {regenerated ? ' 上一次生成的恢复码已全部失效。' : ''}
          </p>
        </div>

        <ul className="grid grid-cols-2 gap-1.5">
          {codes.map((code) => (
            <li key={code} className="rounded-lg bg-slate-500/8 px-2.5 py-1.5 font-mono text-xs select-all">
              {code}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-[11px]"
            onClick={() => {
              void copyText(codes.join('\n')).then((ok) => {
                if (ok) setCopied(true);
              });
            }}
          >
            {copied ? '已复制全部' : '复制全部'}
          </button>
          <span className="muted text-[11px]">建议存进密码管理器或打印后离线保管</span>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-xs" htmlFor="totp-recovery-ack">
          <input
            id="totp-recovery-ack"
            type="checkbox"
            className="size-3.5 accent-sky-500"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已保存恢复码
        </label>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-primary" disabled={!confirmed} onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}