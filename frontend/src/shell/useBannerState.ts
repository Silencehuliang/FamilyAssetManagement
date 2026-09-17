import { useCallback, useMemo, useState } from "react";

import type { BannerState } from "./GlobalBanners";

/**
 * 四个全局元件的状态源 —— 骨架阶段的**显式空实现**。
 *
 * ⚠️ 现在它恒返回「条件不成立」（online=true、queue=0、无更新、不引导），
 *    目的是让 GlobalBanners 渲染成空。**这不是「已实现」**，是「还没接」。
 *
 * 接上各自的数据源时，逐项替换（契约落点见括号）：
 *   - `online`           ← `navigator.onLine` + `online`/`offline` 事件（offline-sync §6.3）
 *   - `queueCount`       ← IndexedDB `fam-offline` / `pending_entries` 计数（offline-sync §6.1）
 *   - `swUpdateReady`    ← workbox-window 的 `waiting` 事件（offline-sync §7.3）
 *   - `shouldShowInstallGuide` ← matchMedia('(display-mode: standalone)') 优先、
 *                          navigator.standalone 兜底；关闭后写一个「已引导」标记，
 *                          之后**永久不再自动弹**（frontend-ia §9.3）
 */
export function useBannerState(): BannerState & { setQueueCount: (n: number) => void } {
  const [queueCount, setQueueCount] = useState(0);

  const onOpenQueue = useCallback(() => {
    // TODO：navigate("/queue")
  }, []);

  const onApplyUpdate = useCallback(() => {
    // TODO：postMessage("SKIP_WAITING") → controlling → location.reload()
  }, []);

  const onDismissInstallGuide = useCallback(() => {
    // TODO：写「已引导」标记，之后不再自动弹
  }, []);

  return useMemo(
    () => ({
      online: true,
      queueCount,
      setQueueCount,
      swUpdateReady: false,
      shouldShowInstallGuide: false,
      onOpenQueue,
      onApplyUpdate,
      onDismissInstallGuide,
    }),
    [queueCount, onOpenQueue, onApplyUpdate, onDismissInstallGuide],
  );
}
