/**
 * 命令面板（`Ctrl/Cmd+K`）。
 *
 * 设计要点：
 * 1. **快捷键是全局的**：`CommandPaletteProvider` 挂在应用外壳里，输入框内按 Ctrl/Cmd+K 也能打开
 *    （只拦这一个组合键，绝不劫持输入框内的其它按键）；Esc 关闭由 `Modal` 统一处理。
 * 2. **数据来自 `/api/search`**（服务端按角色过滤），前端不再自行拼装权限判断 ——
 *    否则 viewer 有可能在本地索引里看到 hidden 服务。
 * 3. **防抖 + 竞态保护**：150ms 防抖，并用递增序号丢弃过期响应（后到的旧响应不得覆盖新结果）。
 * 4. 无障碍：输入框 `role="combobox"` + `aria-activedescendant`，结果 `role="listbox"`，
 *    选项 `role="option"` + `aria-selected`，焦点始终留在输入框内（不靠移动焦点选条目）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import type { ServiceSearchHit, ServiceSearchKind } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Modal } from './Modal.js';
import { Badge, Spinner, Icon } from './ui.js';

/** 防抖间隔（spec：输入后不立刻打服务端）。 */
const DEBOUNCE_MS = 150;

const KIND_LABEL: Record<ServiceSearchKind, string> = {
  service: '服务',
  container: '容器',
  device: '设备',
  tool: '工具',
};

const KIND_TONE: Record<ServiceSearchKind, 'ok' | 'warn' | 'bad' | 'idle' | 'brand'> = {
  service: 'brand',
  container: 'ok',
  device: 'idle',
  tool: 'warn',
};

// ---------------------------------------------------------------- 全局开关

export interface CommandPaletteContextValue {
  visible: boolean;
  open: () => void;
  close: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

/** 没有 Provider 时的安全兜底：页面单独渲染（如单测）不会因为缺上下文而崩。 */
const FALLBACK_VALUE: CommandPaletteContextValue = { visible: false, open: () => {}, close: () => {} };

/** 读取命令面板控制器（可在外壳之外的组件里安全调用）。 */
export function useCommandPalette(): CommandPaletteContextValue {
  return useContext(CommandPaletteContext) ?? FALLBACK_VALUE;
}

/**
 * 命令面板宿主：注册全局 `Ctrl/Cmd+K`，渲染面板本体。
 *
 * 挂在 `AppShell` 里，因此**任意页面**都能用快捷键唤起；首页的搜索框通过 `useCommandPalette().open()` 打开同一个面板。
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }): ReactNode {
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 只处理 Ctrl+K / Cmd+K：不碰输入框里的任何其它按键
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      event.preventDefault();
      setVisible(true);
    };
    document.addEventListener('keydown', onKeyDown);
    // StrictMode 下会挂载两次：add/remove 必须成对，保证只有一个监听器
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo<CommandPaletteContextValue>(() => ({ visible, open, close }), [visible, open, close]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette open={visible} onClose={close} />
    </CommandPaletteContext.Provider>
  );
}

// ---------------------------------------------------------------- 面板本体

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): ReactNode {
  const { api } = useAuth();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const listId = useId();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ServiceSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都回到干净状态（避免上次的关键词与结果残留）
  useEffect(() => {
    if (!open) return;
    seqRef.current += 1;
    setQuery('');
    setHits([]);
    setActiveIndex(0);
    setSearching(false);
    setError(null);
  }, [open]);

  // 防抖查询 + 竞态保护：序号不匹配的响应一律丢弃
  useEffect(() => {
    if (!open) return;
    const keyword = query.trim();
    if (keyword === '') {
      seqRef.current += 1;
      setHits([]);
      setActiveIndex(0);
      setSearching(false);
      setError(null);
      return;
    }

    const seq = ++seqRef.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .search(keyword, 8)
        .then((response) => {
          if (seq !== seqRef.current) return;
          setHits(response.items ?? []);
          setActiveIndex(0);
          setError(null);
          setSearching(false);
        })
        .catch((err: unknown) => {
          if (seq !== seqRef.current) return;
          setHits([]);
          setSearching(false);
          setError(err instanceof ApiError ? err.message : '搜索失败');
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [api, open, query]);

  /** 打开命中的条目：服务/容器/设备走站内路由，工具走外部新窗口。 */
  const activate = useCallback(
    (hit: ServiceSearchHit): void => {
      onClose();
      switch (hit.kind) {
        case 'service':
          navigate(`/services/${encodeURIComponent(hit.id)}`);
          return;
        case 'container':
          navigate(`/containers/${encodeURIComponent(hit.id)}`);
          return;
        case 'device':
          navigate('/devices');
          return;
        default:
          if (hit.url) {
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(hit.url, '_blank', 'noopener,noreferrer');
            }
            return;
          }
          navigate('/tools');
      }
    },
    [navigate, onClose],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (hits.length === 0) return;
      setActiveIndex((index) => (index + 1) % hits.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length === 0) return;
      setActiveIndex((index) => (index - 1 + hits.length) % hits.length);
      return;
    }
    if (event.key === 'Enter') {
      const hit = hits[activeIndex];
      if (!hit) return;
      event.preventDefault();
      activate(hit);
    }
  };

  const keyword = query.trim();
  const activeHit = hits[activeIndex];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="命令面板"
      description="搜索服务、容器、设备与工具（Esc 关闭）"
      initialFocusRef={inputRef}
      size="lg"
    >
      <div className="space-y-3">
        <div className="relative">
          <Icon name="search" className="muted pointer-events-none absolute top-2.5 left-3 size-4" />
          <input
            ref={inputRef}
            id="command-palette-input"
            className="input pl-9"
            type="text"
            value={query}
            aria-label="搜索服务、容器、设备与工具"
            placeholder="搜索服务、容器、设备与工具…"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeHit ? `${listId}-option-${activeIndex}` : undefined}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <span className="muted pointer-events-none absolute top-2.5 right-3 text-[10px]">
            <kbd className="rounded border border-slate-300/70 px-1.5 py-0.5 dark:border-white/12">Esc</kbd>
          </span>
        </div>

        {error ? (
          <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        <ul
          id={listId}
          role="listbox"
          aria-label="搜索结果"
          className="max-h-80 space-y-1 overflow-y-auto scroll-thin"
        >
          {hits.map((hit, index) => (
            <li
              key={`${hit.kind}:${hit.id}`}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              data-kind={hit.kind}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs transition ${
                index === activeIndex ? 'bg-sky-500/15 ring-1 ring-sky-500/30' : 'hover:bg-slate-100 dark:hover:bg-white/6'
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => activate(hit)}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{hit.title}</span>
                {hit.subtitle ? <span className="muted block truncate text-[11px]">{hit.subtitle}</span> : null}
              </span>
              <Badge tone={KIND_TONE[hit.kind]}>{KIND_LABEL[hit.kind]}</Badge>
            </li>
          ))}
        </ul>

        {hits.length === 0 ? (
          <p role="status" className="muted px-1 py-3 text-center text-xs">
            {searching
              ? '搜索中…'
              : keyword === ''
                ? '输入关键词开始搜索（服务、容器、设备与工具）'
                : `未找到与「${keyword}」匹配的服务、容器、设备或工具`}
          </p>
        ) : null}

        {searching && hits.length > 0 ? (
          <p className="px-1">
            <Spinner label="搜索中…" />
          </p>
        ) : null}

        <p className="muted flex flex-wrap items-center gap-2 border-t border-slate-200/70 px-1 pt-2.5 text-[10px] dark:border-white/8">
          <span>
            <kbd className="rounded border border-slate-300/70 px-1 py-0.5 dark:border-white/12">↑</kbd>{' '}
            <kbd className="rounded border border-slate-300/70 px-1 py-0.5 dark:border-white/12">↓</kbd> 选择
          </span>
          <span>
            <kbd className="rounded border border-slate-300/70 px-1 py-0.5 dark:border-white/12">Enter</kbd> 打开
          </span>
          <span>服务与容器在站内打开，工具在新窗口打开</span>
        </p>
      </div>
    </Modal>
  );
}