import { type ReactNode, useEffect, useState } from 'react'
import { SyncBadge } from './components/SyncBadge'
import { TabIcon } from './components/TabIcon'
import { AddExpensePage } from './pages/AddExpensePage'
import { EntriesPage } from './pages/EntriesPage'
import { LoginPage } from './pages/LoginPage'
import { MePage } from './pages/MePage'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { SetupPage } from './pages/SetupPage'
import type { AppState } from './state/app-controller'
import { appController } from './state/runtime'
import { useAppState } from './state/use-app'

type TabKey = 'add' | 'entries' | 'stats' | 'budget' | 'me'

interface Tab {
  key: TabKey
  label: string
  icon: ReactNode
}

const TABS: Tab[] = [
  {
    key: 'add',
    label: '记一笔',
    icon: (
      <TabIcon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </TabIcon>
    ),
  },
  {
    key: 'entries',
    label: '明细',
    icon: (
      <TabIcon>
        <path d="M4 6h16M4 12h16M4 18h10" />
      </TabIcon>
    ),
  },
  {
    key: 'stats',
    label: '统计',
    icon: (
      <TabIcon>
        <path d="M5 20V10M12 20V4M19 20v-7" />
      </TabIcon>
    ),
  },
  {
    key: 'budget',
    label: '预算',
    icon: (
      <TabIcon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 12V6.5A5.5 5.5 0 0 1 17.5 12H12Z" />
      </TabIcon>
    ),
  },
  {
    key: 'me',
    label: '我的',
    icon: (
      <TabIcon>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 19c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
      </TabIcon>
    ),
  },
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>家庭记账</h1>
        <SyncBadge status={state.syncStatus} />
      </header>
      <main className="app-main">
        {tab === 'add' ? <AddExpensePage controller={appController} state={state} /> : null}
        {tab === 'entries' ? <EntriesPage controller={appController} state={state} /> : null}
        {tab === 'stats' ? <PlaceholderPage title="统计报表" note="T10 交付" /> : null}
        {tab === 'budget' ? <PlaceholderPage title="预算管理" note="T11 交付" /> : null}
        {tab === 'me' ? <MePage controller={appController} state={state} /> : null}
      </main>
      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab ${tab === t.key ? 'tab-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
