import { type ReactNode, useState } from 'react'
import { TabIcon } from './components/TabIcon'

type TabKey = 'add' | 'entries' | 'stats' | 'budget' | 'me'

interface Tab {
  key: TabKey
  label: string
  icon: ReactNode
  placeholder: string
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
    placeholder: '记一笔 · T6 交付',
  },
  {
    key: 'entries',
    label: '明细',
    icon: (
      <TabIcon>
        <path d="M4 6h16M4 12h16M4 18h10" />
      </TabIcon>
    ),
    placeholder: '支出明细 · T7 交付',
  },
  {
    key: 'stats',
    label: '统计',
    icon: (
      <TabIcon>
        <path d="M5 20V10M12 20V4M19 20v-7" />
      </TabIcon>
    ),
    placeholder: '统计报表 · T10 交付',
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
    placeholder: '预算管理 · T11 交付',
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
    placeholder: '设置与账户 · T5/T13 交付',
  },
]

export default function App() {
  const [tab, setTab] = useState<TabKey>('add')
  const current = TABS.find((t) => t.key === tab)

  return (
    <div className="app">
      <header className="app-header">
        <h1>家庭记账</h1>
        <span className="sync-badge" data-state="offline">
          未接入同步
        </span>
      </header>
      <main className="app-main">
        <p className="placeholder">{current?.placeholder}</p>
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
