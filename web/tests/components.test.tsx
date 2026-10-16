/**
 * `web/src/components/ui.tsx` 原子组件测试（S0-05）。
 *
 * 选取 Badge / ErrorNotice / ProgressBar / EmptyState / Skeleton：
 * 断言文案、`role` 与 `aria-*`、状态类名、以及 onClick/onRetry 回调。
 * 只用原生 DOM 断言（无 @testing-library/jest-dom 依赖）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Badge, EmptyState, ErrorNotice, ProgressBar, Skeleton } from '../src/components/ui.js';

/** 取渲染出的根元素。 */
function rootOf(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('组件没有渲染出根元素');
  return root;
}

describe('Badge', () => {
  it('渲染文案并带基础类名与 tone 配色', () => {
    const { container } = render(<Badge tone="ok">运行中</Badge>);
    const badge = rootOf(container);

    expect(badge.textContent).toBe('运行中');
    expect(badge.classList.contains('badge')).toBe(true);
    expect(badge.classList.contains('text-emerald-600')).toBe(true);
  });

  it('tone 默认为 idle，且各 tone 映射到不同配色', () => {
    const idle = rootOf(render(<Badge>空闲</Badge>).container);
    expect(idle.classList.contains('text-slate-600')).toBe(true);

    const warn = rootOf(render(<Badge tone="warn">警告</Badge>).container);
    expect(warn.classList.contains('text-amber-600')).toBe(true);

    const brand = rootOf(render(<Badge tone="brand">新建</Badge>).container);
    expect(brand.classList.contains('text-sky-600')).toBe(true);
  });

  it('默认不渲染圆点；dot 时渲染 aria-hidden 圆点', () => {
    const withoutDot = rootOf(render(<Badge tone="ok">正常</Badge>).container);
    expect(withoutDot.querySelector('[aria-hidden]')).toBeNull();

    const { container } = render(
      <Badge tone="bad" dot>
        已失效
      </Badge>,
    );
    const dot = rootOf(container).querySelector('[aria-hidden]');
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains('bg-rose-500')).toBe(true);
    expect(dot?.classList.contains('pulse-online')).toBe(false);
  });

  it('pulse 为圆点追加脉冲动画类', () => {
    const { container } = render(<Badge tone="ok" dot pulse />);
    const dot = rootOf(container).querySelector('[aria-hidden]');

    expect(dot?.classList.contains('bg-emerald-500')).toBe(true);
    expect(dot?.classList.contains('pulse-online')).toBe(true);
  });

  it('无 children 时只渲染圆点', () => {
    const { container } = render(<Badge tone="ok" dot />);
    const badge = rootOf(container);

    expect(badge.textContent).toBe('');
    expect(badge.querySelectorAll('span')).toHaveLength(1);
  });

  it('title 透传到 title 属性', () => {
    const { container } = render(<Badge title="最近一次探测失败">降级</Badge>);

    expect(rootOf(container).getAttribute('title')).toBe('最近一次探测失败');
  });
});

describe('ErrorNotice', () => {
  it('渲染错误文案与装饰性叉号', () => {
    const { container } = render(<ErrorNotice message="加载概览失败" />);
    const root = rootOf(container);

    expect(screen.getByText('加载概览失败')).toBeTruthy();
    expect(root.textContent).toContain('加载概览失败');
    expect(root.querySelector('[aria-hidden]')?.textContent).toBe('✕');
    expect(root.classList.contains('bg-rose-500/10')).toBe(true);
  });

  it('没有 onRetry 时不渲染重试按钮', () => {
    render(<ErrorNotice message="出错了" />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('点击重试按钮调用 onRetry 一次', () => {
    const onRetry = vi.fn();
    render(<ErrorNotice message="加载失败" onRetry={onRetry} />);

    const button = screen.getByRole('button', { name: '重试' });
    expect(button.getAttribute('type')).toBe('button');

    fireEvent.click(button);

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ProgressBar', () => {
  it('暴露 progressbar 语义与 aria 取值范围', () => {
    render(<ProgressBar percent={42.5} label="CPU" />);
    const bar = screen.getByRole('progressbar');

    expect(bar.getAttribute('aria-valuenow')).toBe('42.5');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.style.height).toMatch(/^8(px)?$/);
  });

  it('填充宽度跟随百分比，并显示格式化后的百分比文案', () => {
    render(<ProgressBar percent={42.5} label="CPU" />);
    const bar = screen.getByRole('progressbar');
    const fill = bar.firstElementChild as HTMLElement;

    expect(fill.style.width).toBe('42.5%');
    expect(screen.getByText('42.5%')).toBeTruthy();
    expect(screen.getByText('CPU')).toBeTruthy();
  });

  it('超过 100 与小于 0 都被夹紧', () => {
    const high = rootOf(render(<ProgressBar percent={150} label="高" />).container);
    const highBar = high.querySelector('[role="progressbar"]') as HTMLElement;
    expect(highBar.getAttribute('aria-valuenow')).toBe('100');
    expect((highBar.firstElementChild as HTMLElement).style.width).toBe('100%');

    const low = rootOf(render(<ProgressBar percent={-10} label="低" />).container);
    const lowBar = low.querySelector('[role="progressbar"]') as HTMLElement;
    expect(lowBar.getAttribute('aria-valuenow')).toBe('0');
    expect((lowBar.firstElementChild as HTMLElement).style.width).toBe('0%');
  });

  it('按阈值切换配色：<70 绿、>=70 黄、>=88 红', () => {
    const fillOf = (percent: number): HTMLElement => {
      const root = rootOf(render(<ProgressBar percent={percent} label={`${percent}%`} />).container);
      return root.querySelector('[role="progressbar"]')?.firstElementChild as HTMLElement;
    };

    expect(fillOf(69).classList.contains('from-emerald-500')).toBe(true);
    expect(fillOf(70).classList.contains('from-amber-500')).toBe(true);
    expect(fillOf(87).classList.contains('from-amber-500')).toBe(true);
    expect(fillOf(88).classList.contains('from-rose-500')).toBe(true);
  });

  it('percent 为 null / undefined / NaN 时按未知处理', () => {
    for (const percent of [null, undefined, Number.NaN]) {
      // 同一用例内多次 render 会累积到 document.body，这里只查本容器。
      const { container } = render(<ProgressBar percent={percent} label="内存" />);
      const root = rootOf(container);
      const bar = root.querySelector('[role="progressbar"]') as HTMLElement;

      expect(bar.getAttribute('aria-valuenow')).toBeNull();
      expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
      expect((bar.firstElementChild as HTMLElement).classList.contains('bg-slate-400/40')).toBe(true);
      expect(root.textContent).toContain('内存');
      expect(root.textContent).toContain('—');
    }
  });

  it('hint 覆盖默认百分比文案，height 可定制', () => {
    render(<ProgressBar percent={50} label="内存" hint="2 GB / 4 GB" height={12} />);

    expect(screen.getByText('2 GB / 4 GB')).toBeTruthy();
    expect(screen.queryByText('50.0%')).toBeNull();
    expect(screen.getByRole('progressbar').style.height).toMatch(/^12(px)?$/);
  });

  it('既无 label 也无 hint 时不渲染文字头部', () => {
    const { container } = render(<ProgressBar percent={30} />);

    expect(rootOf(container).textContent).toBe('');
  });
});

describe('EmptyState', () => {
  it('渲染标题与描述', () => {
    const { container } = render(<EmptyState title="暂无容器" description="先启动一个容器" />);

    expect(screen.getByText('暂无容器')).toBeTruthy();
    expect(screen.getByText('先启动一个容器')).toBeTruthy();
    expect(rootOf(container).querySelectorAll('p')).toHaveLength(2);
  });

  it('没有描述时只渲染标题', () => {
    const { container } = render(<EmptyState title="暂无数据" />);

    expect(rootOf(container).querySelectorAll('p')).toHaveLength(1);
    expect(rootOf(container).textContent).toBe('暂无数据');
  });

  it('渲染 icon 与 action 插槽', () => {
    const onAction = vi.fn();
    render(
      <EmptyState
        title="暂无设备"
        icon={<span data-testid="empty-icon">◍</span>}
        action={
          <button type="button" onClick={onAction}>
            刷新
          </button>
        }
      />,
    );

    expect(screen.getByTestId('empty-icon').textContent).toBe('◍');

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('Skeleton', () => {
  it('默认渲染 3 行骨架', () => {
    const { container } = render(<Skeleton />);
    const root = rootOf(container);

    expect(root.classList.contains('space-y-2.5')).toBe(true);
    expect(root.children).toHaveLength(3);
    expect(root.children[0]?.classList.contains('animate-pulse')).toBe(true);
  });

  it('rows 可定制，0 行时不渲染任何占位', () => {
    expect(rootOf(render(<Skeleton rows={5} />).container).children).toHaveLength(5);
    expect(rootOf(render(<Skeleton rows={0} />).container).children).toHaveLength(0);
  });
});