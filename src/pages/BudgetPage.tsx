import { useState } from 'react'
import { aggregateMonth, budgetHistory, budgetOutcome, budgetProgress } from '../domain'
import { formatAmountInput, formatMonthLabel, shiftMonth } from '../features/entries'
import {
  formatCents,
  groupCategories,
  parseAmountToCents,
  resolveCategoryPath,
  todayKey,
} from '../features/entry'
import type { AppController, AppState } from '../state/app-controller'

type BudgetSheet =
  | { kind: 'total'; amountText: string }
  | { kind: 'category'; categoryId: string; amountText: string }

interface Feedback {
  kind: 'ok' | 'error'
  text: string
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return '操作失败,请重试'
}

function usedPercent(spentCents: number, totalCents: number): number {
  if (totalCents <= 0) return 0
  return Math.min(100, Math.round((spentCents / totalCents) * 100))
}

/**
 * 预算页(T11):当前月总预算进度(已花/余量/超支)与分类预算列表;
 * 管理员可通过弹层设置/修改/清除预算(元 → 整数分),普通成员只读;
 * 月份可切换,历史月份显示达成/超支,并提供有总预算月份的历史达成列表。
 */
export function BudgetPage({ controller, state }: { controller: AppController; state: AppState }) {
  const ledger = state.ledger
  const isAdmin = state.member?.role === 'admin'
  const currentMonth = todayKey().slice(0, 7)

  const [month, setMonth] = useState(currentMonth)
  const [sheet, setSheet] = useState<BudgetSheet | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)

  const budget = ledger.meta.budgets[month]
  const aggregate = aggregateMonth(ledger, month)
  const progress = budgetProgress(aggregate, budget)
  const outcome = budgetOutcome(ledger, month)
  const history = budgetHistory(ledger).slice(0, 12)

  const { parents, childrenByParent } = groupCategories(ledger.meta.categories)
  const categoryOptions = parents.flatMap((parent) =>
    (childrenByParent[parent.id] ?? []).map((child) => ({
      id: child.id,
      label: `${parent.name}/${child.name}`,
    })),
  )
  const firstCategory = categoryOptions[0]

  const changeMonth = (next: string): void => {
    setMonth(next)
    setFeedback(null)
    setSheet(null)
  }

  const run = (task: Promise<unknown>, okText: string): void => {
    setBusy(true)
    setFeedback(null)
    void task
      .then(() => {
        setSheet(null)
        setFeedback({ kind: 'ok', text: okText })
      })
      .catch((err: unknown) => {
        setFeedback({ kind: 'error', text: errorText(err) })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const openTotalSheet = (): void => {
    setSheet({
      kind: 'total',
      amountText: progress.hasTotalBudget ? formatAmountInput(progress.totalCents) : '',
    })
  }

  const openCategorySheet = (categoryId?: string): void => {
    const target = categoryId ?? firstCategory?.id
    if (!target) return
    const existing = budget?.categoryCents[target]
    setSheet({
      kind: 'category',
      categoryId: target,
      amountText: existing !== undefined ? formatAmountInput(existing) : '',
    })
  }

  const saveSheet = (): void => {
    if (!sheet) return
    let cents: number
    try {
      cents = parseAmountToCents(sheet.amountText)
    } catch (err) {
      setFeedback({ kind: 'error', text: errorText(err) })
      return
    }
    if (sheet.kind === 'total') {
      run(controller.setBudget(month, { totalCents: cents }), '总预算已保存')
    } else {
      run(
        controller.setBudget(month, { categoryId: sheet.categoryId, categoryCents: cents }),
        '分类预算已保存',
      )
    }
  }

  const clearSheetBudget = (): void => {
    if (!sheet) return
    if (sheet.kind === 'total') {
      run(controller.setBudget(month, { totalCents: null }), '已清除总预算')
    } else {
      run(
        controller.setBudget(month, { categoryId: sheet.categoryId, categoryCents: null }),
        '已清除该分类预算',
      )
    }
  }

  const clearMonthBudget = (): void => {
    if (!window.confirm('清除本月全部预算(总预算与分类预算)?')) return
    run(controller.clearBudget(month), '已清除本月预算')
  }

  const sheetBudgetExists =
    sheet?.kind === 'total'
      ? progress.hasTotalBudget
      : sheet?.kind === 'category' && budget?.categoryCents[sheet.categoryId] !== undefined

  return (
    <div className="page">
      <section className="card">
        <div className="month-bar">
          <button
            type="button"
            className="month-arrow"
            aria-label="上一月"
            onClick={() => changeMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          <strong className="month-title">{formatMonthLabel(month)}</strong>
          <button
            type="button"
            className="month-arrow"
            aria-label="下一月"
            onClick={() => changeMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
        <div className="month-total">
          <span className="member-meta">
            {outcome ? (outcome.achieved ? '本月达成预算' : '本月已超支') : '本月未设总预算'}
          </span>
          {outcome ? (
            <span className={outcome.achieved ? 'outcome outcome-ok' : 'outcome outcome-over'}>
              {outcome.achieved ? '达成' : '超支'}
            </span>
          ) : null}
        </div>
        {month !== currentMonth ? (
          <button type="button" className="link-button" onClick={() => changeMonth(currentMonth)}>
            回到本月
          </button>
        ) : null}
      </section>

      {feedback ? (
        <p className={feedback.kind === 'ok' ? 'form-success' : 'form-error'}>{feedback.text}</p>
      ) : null}

      <section className="card">
        <div className="stats-head">
          <h2 className="card-title">总预算</h2>
          {isAdmin && progress.hasTotalBudget ? (
            <button type="button" className="text-button" onClick={openTotalSheet}>
              修改
            </button>
          ) : null}
        </div>

        {progress.hasTotalBudget ? (
          <>
            <div className="budget-numbers">
              <div>
                <span className="member-meta">预算</span>
                <strong>{formatCents(progress.totalCents)}</strong>
              </div>
              <div>
                <span className="member-meta">已花</span>
                <strong>{formatCents(progress.spentCents)}</strong>
              </div>
              <div>
                <span className="member-meta">{progress.overspent ? '超支' : '余量'}</span>
                <strong className={progress.overspent ? 'amount-over' : 'amount-ok'}>
                  {formatCents(Math.abs(progress.remainingCents))}
                </strong>
              </div>
            </div>
            <div className="progress-track">
              <div
                className={`progress-fill ${progress.overspent ? 'progress-over' : ''}`}
                style={{ width: `${usedPercent(progress.spentCents, progress.totalCents)}%` }}
              />
            </div>
            {progress.overspent ? (
              <p className="form-error budget-alert">
                已超支 {formatCents(-progress.remainingCents)},超支不会被阻止,但请注意节流。
              </p>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={clearMonthBudget}
              >
                清除本月全部预算
              </button>
            ) : null}
          </>
        ) : isAdmin ? (
          <>
            <p className="member-meta">
              本月还没有总预算。设置上限后,记账时就能看到余量与超支提示。
            </p>
            <button type="button" className="primary-button" onClick={openTotalSheet}>
              设置总预算
            </button>
          </>
        ) : (
          <p className="member-meta">管理员尚未设置本月总预算。</p>
        )}
      </section>

      <section className="card">
        <div className="stats-head">
          <h2 className="card-title">分类预算</h2>
          {isAdmin && firstCategory ? (
            <button type="button" className="text-button" onClick={() => openCategorySheet()}>
              + 添加
            </button>
          ) : null}
        </div>

        {progress.byCategory.length === 0 ? (
          <p className="member-meta">
            {isAdmin
              ? '还没有分类预算。可为重点科目单独设限,例如餐饮、交通。'
              : '本月没有分类预算。'}
          </p>
        ) : (
          <ul className="bar-list">
            {progress.byCategory.map((item) => (
              <li key={item.categoryId} className="bar-item">
                <div className="bar-head">
                  <span>{resolveCategoryPath(ledger, item.categoryId)}</span>
                  <span className="bar-amount">
                    {formatCents(item.spentCents)} / {formatCents(item.budgetCents)}
                  </span>
                </div>
                <div className="progress-track">
                  <div
                    className={`progress-fill ${item.overspent ? 'progress-over' : ''}`}
                    style={{ width: `${usedPercent(item.spentCents, item.budgetCents)}%` }}
                  />
                </div>
                <div className="bar-head budget-row-meta">
                  <span className={item.overspent ? 'amount-over' : 'member-meta'}>
                    {item.overspent
                      ? `超支 ${formatCents(-item.remainingCents)}`
                      : `余 ${formatCents(item.remainingCents)}`}
                  </span>
                  {isAdmin ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => openCategorySheet(item.categoryId)}
                    >
                      修改
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 ? (
        <section className="card">
          <h2 className="card-title">历史达成</h2>
          <ul className="history-list">
            {history.map((item) => (
              <li key={item.month} className="history-item">
                <button
                  type="button"
                  className="history-month"
                  onClick={() => changeMonth(item.month)}
                >
                  {formatMonthLabel(item.month)}
                </button>
                <span className="member-meta">
                  {formatCents(item.spentCents)} / {formatCents(item.totalCents)}
                </span>
                <span className={item.achieved ? 'outcome outcome-ok' : 'outcome outcome-over'}>
                  {item.achieved ? '达成' : '超支'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {sheet ? (
        <div className="sheet-backdrop">
          <section className="sheet" aria-label="设置预算">
            <div className="sheet-header">
              <h2 className="card-title">
                {sheet.kind === 'total' ? '总预算' : resolveCategoryPath(ledger, sheet.categoryId)}
              </h2>
              <button
                type="button"
                className="link-button sheet-close"
                onClick={() => setSheet(null)}
              >
                关闭
              </button>
            </div>
            {sheet.kind === 'category' ? (
              <label className="field">
                <span>子分类</span>
                <select
                  value={sheet.categoryId}
                  onChange={(event) => {
                    const categoryId = event.target.value
                    const existing = budget?.categoryCents[categoryId]
                    setSheet((current) =>
                      current?.kind === 'category'
                        ? {
                            ...current,
                            categoryId,
                            amountText: existing !== undefined ? formatAmountInput(existing) : '',
                          }
                        : current,
                    )
                  }}
                >
                  {categoryOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field amount-field">
              <span>预算金额(元)</span>
              <input
                // biome-ignore lint/a11y/noAutofocus: 弹层唯一主输入,自动聚焦是刻意行为
                autoFocus
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={sheet.amountText}
                onChange={(event) =>
                  setSheet((current) =>
                    current ? { ...current, amountText: event.target.value } : current,
                  )
                }
              />
            </label>
            <p className="member-meta">{formatMonthLabel(month)}有效;超支只提示,不阻止记账。</p>
            <button
              type="button"
              className="primary-button"
              disabled={busy || sheet.amountText.trim() === ''}
              onClick={saveSheet}
            >
              {busy ? '保存中…' : '保存'}
            </button>
            {sheetBudgetExists ? (
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={clearSheetBudget}
              >
                清除该预算
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}
