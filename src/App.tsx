import { type ComponentType, useEffect, useState } from 'react'
import MdiAccountOutline from '~icons/mdi/account-outline'
import MdiChartDonut from '~icons/mdi/chart-donut'
import MdiFormatListBulleted from '~icons/mdi/format-list-bulleted'
import MdiPlusCircleOutline from '~icons/mdi/plus-circle-outline'
import MdiWalletOutline from '~icons/mdi/wallet-outline'
import { SyncBadge } from './components/SyncBadge'
import { AddExpensePage } from './pages/AddExpensePage'
import { BudgetPage } from './pages/BudgetPage'
import { CategoriesPage } from './pages/CategoriesPage'
import { EntriesPage } from './pages/EntriesPage'
import { LoginPage } from './pages/LoginPage'
import { MembersPage } from './pages/MembersPage'
import { MePage } from './pages/MePage'
import { RecurringPage } from './pages/RecurringPage'
import { SetupPage } from './pages/SetupPage'
import { StatsPage } from './pages/StatsPage'
import type { AppState } from './state/app-controller'
import { appController } from './state/runtime'
import { useAppState } from './state/use-app'

type TabKey = 'add' | 'entries' | 'stats' | 'budget' | 'me'

interface Tab {
  key: TabKey
  label: string
  icon: ComponentType<{ className?: string }>
}

const TABS: Tab[] = [
  { key: 'add', label: '记一笔', icon: MdiPlusCircleOutline },
  { key: 'entries', label: '明细', icon: MdiFormatListBulleted },
  { key: 'stats', label: '统计', icon: MdiChartDonut },
  { key: 'budget', label: '预算', icon: MdiWalletOutline },
  { key: 'me', label: '我的', icon: MdiAccountOutline },
]

export default function App() {
  const state = useAppState(appController)

  useEffect(() => {
    void appController.boot()
    return appController.startConnectivityListeners()
  }, [])

  if (state.phase === 'booting') {
    return (
      <div className="app app-centered">
        <p className="placeholder">正在打开账本…</p>
      </div>
    )
  }

  if (state.phase === 'setup') {
    return <SetupPage controller={appController} state={state} />
  }

  if (state.phase === 'login') {
    return <LoginPage controller={appController} state={state} />
  }

  return <Shell state={state} />
}

function Shell({ state }: { state: AppState }) {
  const [tab, setTab] = useState<TabKey>('add')
  const [view, setView] = useState<'categories' | 'members' | 'recurring' | null>(null)

  const openTab = (key: TabKey): void => {
    setTab(key)
    setView(null)
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>家庭记账</h1>
        <SyncBadge status={state.syncStatus} />
      </header>
      <main className="app-main">
        {view === 'categories' ? (
          <CategoriesPage controller={appController} state={state} onBack={() => setView(null)} />
        ) : null}
        {view === 'members' ? (
          <MembersPage controller={appController} state={state} onBack={() => setView(null)} />
        ) : null}
        {view === 'recurring' ? (
          <RecurringPage controller={appController} state={state} onBack={() => setView(null)} />
        ) : null}
        {view === null ? (
          <>
            {tab === 'add' ? <AddExpensePage controller={appController} state={state} /> : null}
            {tab === 'entries' ? <EntriesPage controller={appController} state={state} /> : null}
            {tab === 'stats' ? <StatsPage state={state} /> : null}
            {tab === 'budget' ? <BudgetPage controller={appController} state={state} /> : null}
            {tab === 'me' ? (
              <MePage
                controller={appController}
                state={state}
                onOpenCategories={() => setView('categories')}
                onOpenMembers={() => setView('members')}
                onOpenRecurring={() => setView('recurring')}
              />
            ) : null}
          </>
        ) : null}
      </main>
      <nav className="grid grid-cols-5 border-t border-border bg-card pb-[var(--safe-area-inset-bottom)]">
        {TABS.map((t) => {
          const active = tab === t.key && view === null
          return (
            <button
              key={t.key}
              type="button"
              className={`flex cursor-pointer flex-col items-center gap-0.5 border-0 bg-transparent px-0 pt-2 pb-2.5 text-[11px] ${
                active ? 'text-foreground' : 'text-muted-foreground'
              }`}
              onClick={() => openTab(t.key)}
            >
              <t.icon className="size-6" />
              <span>{t.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
