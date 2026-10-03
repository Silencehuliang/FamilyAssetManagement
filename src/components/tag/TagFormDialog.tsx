import { useState } from 'react'
import { toast } from 'sonner'
import type { Tag } from '../../domain'
import { errorText } from '../../lib/errors'
import type { AppController } from '../../state/app-controller'
import { PopupLayout, useConfirm } from '../dialog'

/**
 * 标签编辑(嵌套对话框):新建(仅名称)与改名/删除。
 * 成员即可操作;删除前按账本统计引用笔数并确认,删除走 controller(领域清理 + 墓碑同步)。
 */
export function TagFormDialog({
  controller,
  tag,
  onClose,
}: {
  controller: AppController
  tag?: Tag
  onClose: () => void
}) {
  const [name, setName] = useState(tag?.name ?? '')
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const isEdit = tag !== undefined

  const submit = (): void => {
    setBusy(true)
    const action = isEdit ? controller.renameTag(tag.id, name) : controller.addTag(name)
    void action
      .then(() => {
        toast.success(isEdit ? '已保存标签' : '标签已创建')
        onClose()
      })
      .catch((err: unknown) => {
        toast.error(errorText(err))
      })
      .finally(() => setBusy(false))
  }

  const remove = (): void => {
    if (!tag) return
    const count = controller.tagUsageCount(tag.id)
    const message =
      count > 0
        ? `删除「#${tag.name}」?将清理 ${count} 笔支出中的引用,并同步到所有设备。`
        : `删除「#${tag.name}」?该标签尚未被任何支出引用。`
    void confirm(message, { title: '删除标签', confirmText: '删除', danger: true }).then((ok) => {
      if (!ok) return
      setBusy(true)
      void controller
        .deleteTag(tag.id)
        .then(() => {
          toast.success('标签已删除')
          onClose()
        })
        .catch((err: unknown) => {
          toast.error(errorText(err))
        })
        .finally(() => setBusy(false))
    })
  }

  return (
    <PopupLayout title={isEdit ? '编辑标签' : '新建标签'}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) submit()
        }}
      >
        <label className="field">
          <span>名称</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: 对话框唯一输入,自动聚焦是刻意行为
            autoFocus
            type="text"
            placeholder="如 微信"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button type="submit" className="primary-button" disabled={busy || name.trim() === ''}>
          {busy ? '保存中…' : isEdit ? '保存' : '创建'}
        </button>
      </form>
      {isEdit ? (
        <button type="button" className="danger-button mt-3" disabled={busy} onClick={remove}>
          删除标签
        </button>
      ) : null}
    </PopupLayout>
  )
}
