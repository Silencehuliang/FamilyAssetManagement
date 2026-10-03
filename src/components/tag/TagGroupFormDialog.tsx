import { useState } from 'react'
import { toast } from 'sonner'
import type { Tag, TagColor, TagGroup, TagId } from '../../domain'
import { TAG_PALETTE } from '../../domain'
import {
  TAG_CHIP_ACTIVE_CLASS,
  TAG_CHIP_CLASS,
  TAG_DOT_CLASS,
  TAG_SWATCH_ACTIVE_CLASS,
} from '../../features/tags'
import { errorText } from '../../lib/errors'
import type { AppController } from '../../state/app-controller'
import { useAppState } from '../../state/use-app'
import { PopupLayout, useConfirm } from '../dialog'

const TAG_COLLATOR = new Intl.Collator('zh-Hans-CN')

/**
 * 标签组编辑(嵌套对话框,仅管理员):名称、颜色(7 色调色板)、包含标签(多选)、
 * 单选/必选开关、删除组(仅解散,不删标签)。新建与编辑共用;服务端/领域拒绝
 * 原样以 toast 呈现。
 */
export function TagGroupFormDialog({
  controller,
  group,
  onClose,
}: {
  controller: AppController
  group?: TagGroup
  onClose: () => void
}) {
  const state = useAppState(controller)
  const [name, setName] = useState(group?.name ?? '')
  const [color, setColor] = useState<TagColor>(group?.color ?? 'blue')
  const [tagIds, setTagIds] = useState<TagId[]>(() => [...(group?.tagIds ?? [])])
  const [singleSelect, setSingleSelect] = useState(group?.singleSelect ?? false)
  const [required, setRequired] = useState(group?.required ?? false)
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const isEdit = group !== undefined

  const tags = [...state.ledger.meta.tags].sort((a, b) => TAG_COLLATOR.compare(a.name, b.name))

  const toggleTag = (tag: Tag): void => {
    setTagIds((current) =>
      current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id],
    )
  }

  const submit = (): void => {
    setBusy(true)
    const fields = { name, color, tagIds, singleSelect, required }
    const action = isEdit
      ? controller.updateTagGroup(group.id, fields)
      : controller.addTagGroup(fields)
    void action
      .then(() => {
        toast.success(isEdit ? '已保存标签组' : '标签组已创建')
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => setBusy(false))
  }

  const remove = (): void => {
    if (!group) return
    void confirm(`删除标签组「${group.name}」?只解散分组,组内标签与支出引用都会保留。`, {
      title: '删除标签组',
      confirmText: '删除组',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void controller
        .deleteTagGroup(group.id)
        .then(() => {
          toast.success('标签组已解散')
          onClose()
        })
        .catch((err: unknown) => {
          toast.error(errorText(err))
        })
        .finally(() => setBusy(false))
    })
  }

  return (
    <PopupLayout title={isEdit ? '编辑标签组' : '新建标签组'}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) submit()
        }}
      >
        <label className="field">
          <span>组名</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: 对话框唯一主输入,自动聚焦是刻意行为
            autoFocus
            type="text"
            placeholder="如 支付方式"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <fieldset className="mb-3.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[13px] text-muted-foreground">颜色</legend>
          <div className="flex flex-wrap gap-2.5">
            {TAG_PALETTE.map((item) => (
              <button
                key={item}
                type="button"
                aria-label={`颜色 ${item}`}
                aria-pressed={color === item}
                className={`size-7 rounded-full ${TAG_DOT_CLASS[item]} ${
                  color === item
                    ? `ring-2 ring-offset-2 ring-offset-card ${TAG_SWATCH_ACTIVE_CLASS[item]}`
                    : ''
                }`}
                onClick={() => setColor(item)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mb-3.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[13px] text-muted-foreground">包含标签(可多选)</legend>
          {tags.length === 0 ? (
            <p className="member-meta">还没有标签,先到标签管理里新建。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const active = tagIds.includes(tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    aria-pressed={active}
                    className={`rounded-full border px-3 py-1.5 text-[13px] ${
                      active ? TAG_CHIP_ACTIVE_CLASS[color] : TAG_CHIP_CLASS[color]
                    }`}
                    onClick={() => toggleTag(tag)}
                  >
                    #{tag.name}
                  </button>
                )
              })}
            </div>
          )}
        </fieldset>

        <label className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm">
          <span>
            单选组
            <span className="member-meta block">组内至多选中一个标签</span>
          </span>
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={singleSelect}
            onChange={(event) => setSingleSelect(event.target.checked)}
          />
        </label>

        <label className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm">
          <span>
            必选组
            <span className="member-meta block">记账时默认选中组内第一个标签</span>
          </span>
          <input
            type="checkbox"
            className="size-5 accent-primary"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
        </label>

        <button type="submit" className="primary-button" disabled={busy || name.trim() === ''}>
          {busy ? '保存中…' : isEdit ? '保存' : '创建'}
        </button>
      </form>

      {isEdit ? (
        <button type="button" className="danger-button mt-3" disabled={busy} onClick={remove}>
          删除标签组(仅解散)
        </button>
      ) : null}
    </PopupLayout>
  )
}
