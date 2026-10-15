/**
 * 鉴权上下文。
 *
 * 关键设计：`AuthProvider` 是唯一持有会话状态的地方，并在挂载时把
 * 「CSRF 取值函数」与「401 回调」注入 API 客户端单例 —— 这样其它页面
 * 直接用 `api.xxx()` 即可，无需关心令牌与失效跳转。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, ApiError } from '../api/client.js';
import type { SessionUser, SessionView, UserPreferences } from '../api/types.js';

export interface AuthContextValue {
  /** 类型化 API 客户端（已注入 CSRF 与 401 处理） */
  api: ApiClient;
  /** 初始会话探测是否完成（未完成前不渲染路由，避免闪屏） */
  ready: boolean;
  user: SessionUser | null;
  preferences: UserPreferences | null;
  /** 系统尚未初始化（需要走 bootstrap 流程） */
  setupRequired: boolean;
  /** 后端健康信息中的版本号等（非必需，失败为 null） */
  apiVersion: string | null;
  login: (input: { username: string; password: string; remember: boolean }) => Promise<void>;
  bootstrap: (input: { token: string; username: string; password: string; displayName: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  updatePreferences: (input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>) => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** localStorage 键：用于在会话探测前先应用主题，避免闪白 */
const THEME_STORAGE_KEY = 'hp-theme';

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [apiVersion, setApiVersion] = useState<string | null>(null);

  const csrfRef = useRef<string | null>(null);

  /** 惰性创建客户端：注入 CSRF 取值与 401 处理。 */
  const client = useMemo(
    () =>
      new ApiClient({
        getCsrfToken: () => csrfRef.current,
        onUnauthorized: () => {
          csrfRef.current = null;
          setUser(null);
          setPreferences(null);
        },
      }),
    [],
  );

  // 暴露给非 React 模块（如 SSE 重连逻辑）复用同一实例
  useEffect(() => {
    globalThis.__hpApi = client;
  }, [client]);

  const applyPreferences = useCallback((next: UserPreferences | null) => {
    setPreferences(next);
    const theme = next?.theme ?? readStoredTheme() ?? 'dark';
    applyTheme(theme);
  }, []);

  /** 拉取会话 + 用户偏好。 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const session: SessionView = await client.session();
      csrfRef.current = session.csrfToken || null;
      setSetupRequired(session.setupRequired);
      setUser(session.user);
      if (session.authenticated) {
        try {
          const me = await client.me();
          applyPreferences(me.preferences);
        } catch {
          applyPreferences(null);
        }
      } else {
        applyPreferences(null);
      }
    } catch (error) {
      // 会话接口失败不应让页面白屏：退回未登录态并记录
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.warn('[auth] 会话探测失败', error);
      }
      setUser(null);
    } finally {
      setReady(true);
    }
  }, [client, applyPreferences]);

  useEffect(() => {
    // 首屏先应用本地主题，避免闪白，再拉会话
    applyTheme(readStoredTheme() ?? 'dark');
    void refresh();
  }, [refresh]);

  /** 定期拉取健康信息（版本号展示 + 数据源角标）。 */
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const health = await client.health();
        if (!cancelled) setApiVersion(health.version);
      } catch {
        if (!cancelled) setApiVersion(null);
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  const login = useCallback(
    async (input: { username: string; password: string; remember: boolean }): Promise<void> => {
      const result = await client.login(input);
      csrfRef.current = result.csrfToken;
      setUser(result.user);
      setSetupRequired(false);
      try {
        const me = await client.me();
        applyPreferences(me.preferences);
      } catch {
        applyPreferences(null);
      }
    },
    [client, applyPreferences],
  );

  const bootstrap = useCallback(
    async (input: { token: string; username: string; password: string; displayName: string }): Promise<void> => {
      await client.bootstrap(input);
      // 初始化完成后直接登录，省去用户再输一次密码
      await login({ username: input.username, password: input.password, remember: false });
    },
    [client, login],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await client.logout();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // 会话已失效也视为登出成功
    } finally {
      csrfRef.current = null;
      setUser(null);
      setPreferences(null);
    }
  }, [client]);

  const updatePreferences = useCallback(
    async (input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>): Promise<void> => {
      const result = await client.updatePreferences(input);
      applyPreferences(result.preferences);
      if (result.preferences.theme) storeTheme(result.preferences.theme);
    },
    [client, applyPreferences],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      api: client,
      ready,
      user,
      preferences,
      setupRequired,
      apiVersion,
      login,
      bootstrap,
      logout,
      refresh,
      updatePreferences,
      isAdmin: user?.role === 'admin',
    }),
    [client, ready, user, preferences, setupRequired, apiVersion, login, bootstrap, logout, refresh, updatePreferences],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 读取当前用户的鉴权上下文。 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}

/** 取 API 客户端（与 AuthProvider 使用同一实例，保证 CSRF 一致）。 */
export function useApi(): ApiClient {
  return useAuth().api;
}

declare global {
  // eslint-disable-next-line no-var
  var __hpApi: ApiClient | undefined;
}

// ---------------------------------------------------------------- 主题

/** 把主题应用到 <html>：system 时按系统偏好解析。 */
export function applyTheme(theme: 'dark' | 'light' | 'system'): void {
  const prefersDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

function readStoredTheme(): 'dark' | 'light' | 'system' | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: 'dark' | 'light' | 'system'): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略
  }
}
