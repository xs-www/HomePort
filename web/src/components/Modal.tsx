/**
 * 通用模态框（新建/编辑服务、命令面板共用）。
 *
 * 无障碍与交互约定（这三点是硬要求，不是"锦上添花"）：
 * 1. `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题永远渲染，保证有可访问名）；
 * 2. **焦点管理**：打开时移入面板（优先 `initialFocusRef`），关闭/卸载后归还给触发元素；
 * 3. Esc 关闭、点遮罩关闭、Tab 在面板内循环（不逃逸到背景页面）。
 *
 * 为什么用 `useRef` 记录"打开前的焦点"：React 19 的 StrictMode 会双跑 effect，
 * effect 的 cleanup 必须**幂等**且只做"归还焦点"这一件事，否则第二次挂载会丢掉触发元素。
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './ui.js';

/** 可聚焦元素（Tab 循环用）。禁用元素与 `tabindex="-1"` 刻意排除。 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface ModalProps {
  open: boolean;
  /** 请求关闭（Esc / 遮罩 / 关闭按钮 / 显式调用） */
  onClose: () => void;
  /** 可见标题；同时作为 `aria-labelledby` 的目标 */
  title: ReactNode;
  /** 标题下的说明文字（可选，会挂在 `aria-describedby` 上） */
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 面板最大宽度 */
  size?: 'sm' | 'md' | 'lg';
  /** 关闭按钮的可访问名 */
  closeLabel?: string;
  /** 打开时优先聚焦的元素（如命令面板的搜索框）；省略则聚焦面板内第一个可聚焦元素 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 额外类名（作用于面板） */
  className?: string;
}

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeLabel = '关闭',
  initialFocusRef,
  className = '',
}: ModalProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // 用 ref 持有最新的 onClose：避免父组件传内联箭头函数时 effect 反复重跑（会抢焦点）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement;
    restoreRef.current = previouslyFocused instanceof HTMLElement ? previouslyFocused : null;

    const panel = panelRef.current;
    const preferred = initialFocusRef?.current ?? null;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null;
    (preferred ?? first ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = panelRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) {
        event.preventDefault();
        node.focus();
        return;
      }
      const active = document.activeElement;
      if (active === null || !node.contains(active)) {
        event.preventDefault();
        firstItem.focus();
        return;
      }
      if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
        return;
      }
      if (event.shiftKey && active === firstItem) {
        event.preventDefault();
        lastItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const restore = restoreRef.current;
      restoreRef.current = null;
      // 只在触发元素仍然挂在文档里时归还焦点（它可能已被卸载）
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      {/* 遮罩：点击关闭（纯装饰，可访问名交给对话框本身） */}
      <div
        aria-hidden
        data-modal-backdrop="true"
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`card fade-in relative z-10 w-full ${SIZE_CLASS[size]} max-h-[90vh] overflow-y-auto scroll-thin shadow-xl ${className}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-5 py-3.5 dark:border-white/8">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-sm font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="muted mt-0.5 text-xs">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost shrink-0 px-2 py-1.5"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <Icon name="close" className="size-3.5" />
          </button>
        </header>

        <div className="px-5 py-4">{children}</div>

        {footer ? (
          <footer className="border-t border-slate-200/70 px-5 py-3.5 dark:border-white/8">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}