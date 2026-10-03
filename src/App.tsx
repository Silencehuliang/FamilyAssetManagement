import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { AppNav, type AppRoute } from './components/AppNav'
import { PopupLayout, useDialog } from './components/dialog'
import { SyncBadge } from './components/SyncBadge'
import { useTheme } from './components/theme'
import { AddExpensePage } from './pages/AddExpensePage'
import { BudgetPage } from './pages/BudgetPage'
import { CategoriesPage } from './pages/CategoriesPage'
import { EntriesPage } from './pages/EntriesPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { MembersPage } from './pages/MembersPage'
import { MePage } from './pages/MePage'
import { RecurringPage } from './pages/RecurringPage'
import { SetupPage } from './pages/SetupPage'
import { StatsPage } from './pages/StatsPage'
import type { AppState } from './state/app-controller'
import { appController } from './state/runtime'
import { useAppState } from './state/use-app'

export default function App() {
  const state = useAppState(appController)
  const { resolved } = useTheme()
  const previousSync = useRef(state.syncStatus)

  useEffect(() => {
    void appController.boot()
    return appController.startConnectivityListeners()
  }, [])

  // 同步失败第一次出现时给一次 toast(重复失败不刷屏)
  useEffect(() => {
    if (state.syncStatus === 'error' && previousSync.current !== 'error') {
      toast.error(
        state.syncError ? `同步失败:${state.syncError}` : '同步失败,本地记录不受影响,可稍后重试',
      )
    }
    previousSync.current = state.syncStatus
  }, [state.syncStatus, state.syncError])

  let content: ReactNode
  if (state.phase === 'booting') {
    content = (
      <div className="app app-centered">
        <p className="placeholder">正在打开账本…</p>
      </div>
    )
  } else if (state.phase === 'setup') {
    content = <SetupPage controller={appController} state={state} />
  } else if (state.phase === 'login') {
    content = <LoginPage controller={appController} state={state} />
  } else {
    content = <Shell state={state} />
  }

  return (
    <>
      {content}
      <Toaster position="top-center" theme={resolved} richColors closeButton />
    </>
  )
}

function Shell({ state }: { state: AppState }) {
  const [route, setRoute] = useState<AppRoute>('home')
  const [view, setView] = useState<'categories' | 'members' | 'recurring' | null>(null)
  const { showDialog } = useDialog()

  const navigate = (next: AppRoute): void => {
    setRoute(next)
    setView(null)
  }

  /** FAB:记账编辑器(V7)接入前先给占位对话框,可跳转到现有表单 */
  const openEditor = (): void => {
    void showDialog<void>(
      ({ close }) => (
        <PopupLayout title="记一笔">
          <p className="member-meta">
            全屏记账编辑器(计算器键盘 / 再记)将在 v1.1 第二批接入;现在可以先用完整记账表单。
          </p>
          <button
            type="button"
            className="primary-button mt-4"
            onClick={() => {
              close(undefined)
              navigate('add')
            }}
          >
            打开记账表单
          </button>
        </PopupLayout>
      ),
      { label: '记一笔' },
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>家庭记账</h1>
        <SyncBadge status={state.syncStatus} />
      </header>
      {/* 竖轨补偿(≥768px 的 84px 左内边距)统一在 app.css 的 rail 媒体查询里给页头与正文加 */}
      <main className="app-main pb-[calc(5.5rem+var(--safe-area-inset-bottom))] md:pb-8">
        <div key={view ?? route} className="page-show">
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
              {route === 'home' ? (
                <HomePage
                  controller={appController}
                  state={state}
                  onOpenAdd={() => navigate('add')}
                  onOpenStats={() => navigate('stats')}
                  onOpenBudget={() => navigate('budget')}
                />
              ) : null}
              {route === 'entries' ? (
                <EntriesPage controller={appController} state={state} />
              ) : null}
              {route === 'stats' ? <StatsPage state={state} /> : null}
              {route === 'budget' ? <BudgetPage controller={appController} state={state} /> : null}
              {route === 'me' ? (
                <MePage
                  controller={appController}
                  state={state}
                  onOpenCategories={() => setView('categories')}
                  onOpenMembers={() => setView('members')}
                  onOpenRecurring={() => setView('recurring')}
                />
              ) : null}
              {route === 'add' ? <AddExpensePage controller={appController} state={state} /> : null}
            </>
          ) : null}
        </div>
      </main>
      <AppNav route={route} onNavigate={navigate} onCreate={openEditor} />
    </div>
  )
}
