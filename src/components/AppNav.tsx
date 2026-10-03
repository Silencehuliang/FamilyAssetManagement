import type { ComponentType } from 'react'
import { createPortal } from 'react-dom'
import MdiAccountOutline from '~icons/mdi/account-outline'
import MdiChartDonut from '~icons/mdi/chart-donut'
import MdiFormatListBulleted from '~icons/mdi/format-list-bulleted'
import MdiHomeVariant from '~icons/mdi/home-variant'
import MdiPlus from '~icons/mdi/plus'
import MdiWalletOutline from '~icons/mdi/wallet-outline'

export type AppRoute = 'home' | 'entries' | 'stats' | 'budget' | 'me' | 'add'

interface NavItem {
  route: Exclude<AppRoute, 'add'>
  label: string
  icon: ComponentType<{ className?: string }>
}

/** 五个页面目的地 + 中央 FAB;顺序:左二 / FAB / 右三 */
const LEFT_ITEM = [
  { route: 'home', label: '首页', icon: MdiHomeVariant },
  { route: 'entries', label: '明细', icon: MdiFormatListBulleted },
] satisfies NavItem[]

const RIGHT_ITEM = [
  { route: 'stats', label: '统计', icon: MdiChartDonut },
  { route: 'budget', label: '预算', icon: MdiWalletOutline },
  { route: 'me', label: '我的', icon: MdiAccountOutline },
] satisfies NavItem[]

function NavButton({
  item,
  route,
  onNavigate,
}: {
  item: NavItem
  route: AppRoute
  onNavigate: (route: AppRoute) => void
}) {
  const Icon = item.icon
  const active = route === item.route
  return (
    <button
      type="button"
      className="app-nav-item"
      data-active={active}
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(item.route)}
    >
      <Icon className="size-6" />
      <span>{item.label}</span>
    </button>
  )
}

/**
 * 悬浮玻璃胶囊导航(V3):移动端底栏(≥640px 换成左侧竖轨),中央 72px FAB。
 * portal 到 body,避免被页面容器裁剪;safe-area 通过 --safe-area-* 消费。
 */
export function AppNav({
  route,
  onNavigate,
  onCreate,
}: {
  route: AppRoute
  onNavigate: (route: AppRoute) => void
  onCreate: () => void
}) {
  return createPortal(
    <>
      <nav className="app-nav-mobile" aria-label="主导航">
        {LEFT_ITEM.map((item) => (
          <NavButton key={item.route} item={item} route={route} onNavigate={onNavigate} />
        ))}
        <button type="button" className="app-nav-fab" aria-label="记一笔" onClick={onCreate}>
          <MdiPlus className="size-8" />
        </button>
        {RIGHT_ITEM.map((item) => (
          <NavButton key={item.route} item={item} route={route} onNavigate={onNavigate} />
        ))}
      </nav>
      <nav className="app-nav-rail" aria-label="主导航">
        <button type="button" className="app-nav-fab" aria-label="记一笔" onClick={onCreate}>
          <MdiPlus className="size-8" />
        </button>
        {[...LEFT_ITEM, ...RIGHT_ITEM].map((item) => (
          <NavButton key={item.route} item={item} route={route} onNavigate={onNavigate} />
        ))}
      </nav>
    </>,
    document.body,
  )
}
