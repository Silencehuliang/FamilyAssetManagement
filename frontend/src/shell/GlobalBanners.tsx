/**
 * 全局元件 —— 三个条件横幅 + 一个指示器。
 *
 * 契约落点：docs/specs/frontend-ia.md §9
 *
 * 🔴 契约原文：「**统一注入外壳，不在各页重复实现**」。
 *    所以这些是外壳的一部分，不在任何页面组件里出现。
 *
 * ⚠️ 骨架阶段：条件判定所需的四个数据源（在线态 / 队列计数 / SW 更新 / 安装引导）
 *    都还没接上，由 `useBannerState` 提供。**当前它恒返回「条件不成立」**，
 *    于是四个元件都渲染成 null —— 这是有意的：宁可不显示，也不显示假状态。
 */

export interface BannerState {
  /** `navigator.onLine` 且服务端可达 */
  online: boolean;
  /** 离线队列条数（IndexedDB `fam-offline` / `pending_entries`） */
  queueCount: number;
  /** SW 检测到 waiting（新版本已就绪） */
  swUpdateReady: boolean;
  /** 已登录 + 非 standalone + 从未引导过（判定以 matchMedia 为准，navigator.standalone 兜底） */
  shouldShowInstallGuide: boolean;
  onOpenQueue: () => void;
  onApplyUpdate: () => void;
  onDismissInstallGuide: () => void;
}

export default function GlobalBanners(props: BannerState) {
  const {
    online,
    queueCount,
    swUpdateReady,
    shouldShowInstallGuide,
    onOpenQueue,
    onApplyUpdate,
    onDismissInstallGuide,
  } = props;

  return (
    <div className="banners">
      {/* ① 离线未计入横幅 —— 条件：!online && queue > 0 */}
      {!online && queueCount > 0 && (
        <div className="banner banner--offline" role="status">
          <span>离线中，另有 {queueCount} 条待同步未计入汇总。</span>
          <button type="button" onClick={onOpenQueue}>
            查看 ›
          </button>
        </div>
      )}

      {/* ② SW 更新横幅 —— 队列非空时附带「（含 N 条待同步）」，
          文案**必须含「刷新不会丢失待同步记录」**（§9.2）：
          否则用户不敢更新 —— IndexedDB 不随页面刷新丢失是事实，但用户不知道。 */}
      {swUpdateReady && (
        <div className="banner banner--update" role="status">
          <span>
            有新版本{queueCount > 0 ? `（含 ${queueCount} 条待同步）` : ""}。
            刷新不会丢失待同步记录。
          </span>
          <button type="button" onClick={onApplyUpdate}>
            刷新
          </button>
        </div>
      )}

      {/* ③ iOS 安装引导条 —— 可关闭，**关闭后永久不再自动弹**（`me` 保留入口） */}
      {shouldShowInstallGuide && (
        <div className="banner banner--install" role="status">
          <span>把它加到主屏幕，才能离线记账。</span>
          <button type="button" onClick={onDismissInstallGuide}>
            不再提示
          </button>
        </div>
      )}

      {/* ④ 待同步指示器 —— 条件：queue > 0。显示在线态 + 条数，点击跳 `queue` */}
      {queueCount > 0 && (
        <button type="button" className="queue-indicator" onClick={onOpenQueue}>
          <span className="queue-indicator__net">{online ? "在线" : "离线"}</span>
          <span>待同步 {queueCount} 条 ›</span>
        </button>
      )}
    </div>
  );
}
