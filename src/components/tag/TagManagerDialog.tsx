import { useCallback } from 'react'
import { toast } from 'sonner'
import MdiChevronDown from '~icons/mdi/chevron-down'
import MdiChevronUp from '~icons/mdi/chevron-up'
import MdiPencilOutline from '~icons/mdi/pencil-outline'
import MdiPlus from '~icons/mdi/plus'
import type { Tag, TagGroup } from '../../domain'
import {
  moveGroupId,
  TAG_DOT_CLASS,
  tagManagerSections,
  UNGROUPED_COLOR,
} from '../../features/tags'
import { errorText } from '../../lib/errors'
import type { AppController } from '../../state/app-controller'
import { useAppState } from '../../state/use-app'
import { PopupLayout, useDialog } from '../dialog'
import { TagChip } from './TagChip'
import { TagFormDialog } from './TagFormDialog'
import { TagGroupFormDialog } from './TagGroupFormDialog'

/**
 * 标签管理(嵌套对话框):
 * - 「未分组」区 + 各标签组区(组头带组色、单选/必选徽标);
 * - 顶部操作:新建标签(成员可用)/ 新建标签组(仅管理员可见);
 * - 点标签 chip → 标签编辑(改名、删除并确认引用清理笔数);
 * - 组头管理员可编辑/上移/下移(简单排序按钮,不引入拖拽库);
 * - 服务端/领域拒绝(如成员写组)以 toast 显示可读文案。
 */
export function TagManagerDialog({ controller }: { controller: AppController }) {
  const state = useAppState(controller)
  const isAdmin = state.member?.role === 'admin'
  const sections = tagManagerSections(state.ledger)
  const { showDialog } = useDialog()

  const openTagForm = useCallback(
    (tag?: Tag): void => {
      const label = tag ? '编辑标签' : '新建标签'
      void showDialog<void>(
        ({ close }) => (
          <TagFormDialog controller={controller} tag={tag} onClose={() => close(undefined)} />
        ),
        { label },
      )
    },
    [controller, showDialog],
  )

  const openGroupForm = useCallback(
    (group?: TagGroup): void => {
      const label = group ? '编辑标签组' : '新建标签组'
      void showDialog<void>(
        ({ close }) => (
          <TagGroupFormDialog
            controller={controller}
            group={group}
            onClose={() => close(undefined)}
          />
        ),
        { label },
      )
    },
    [controller, showDialog],
  )

  const move = (id: string, delta: number): void => {
    const ids = sections.groups.map((section) => section.group.id)
    const next = moveGroupId(ids, id, delta)
    if (next.every((groupId, index) => groupId === ids[index])) return
    void controller.reorderTagGroups(next).catch((err: unknown) => {
      toast.error(errorText(err))
    })
  }

  return (
    <PopupLayout title="标签管理">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="chip inline-flex items-center gap-1"
          onClick={() => openTagForm()}
        >
          <MdiPlus className="size-4" />
          新建标签
        </button>
        {isAdmin ? (
          <button
            type="button"
            className="chip inline-flex items-center gap-1"
            onClick={() => openGroupForm()}
          >
            <MdiPlus className="size-4" />
            新建标签组
          </button>
        ) : null}
      </div>
      {!isAdmin ? (
        <p className="member-meta mt-2">标签组由管理员维护,你仍可新建与整理标签。</p>
      ) : null}

      <section className="mt-4">
        <header className="flex items-center gap-2">
          <span
            className={`size-2.5 rounded-full ${TAG_DOT_CLASS[UNGROUPED_COLOR]}`}
            aria-hidden="true"
          />
          <h3 className="m-0 text-sm font-semibold">未分组</h3>
        </header>
        {sections.ungrouped.length === 0 ? (
          <p className="member-meta mt-2">没有未分组的标签。</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {sections.ungrouped.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                color={UNGROUPED_COLOR}
                onClick={() => openTagForm(tag)}
              />
            ))}
          </div>
        )}
      </section>

      {sections.groups.map(({ group, tags }, index) => (
        <section key={group.id} className="mt-4 border-t border-border pt-3">
          <header className="flex items-center gap-2">
            <span
              className={`size-2.5 rounded-full ${TAG_DOT_CLASS[group.color]}`}
              aria-hidden="true"
            />
            <h3 className="m-0 text-sm font-semibold">{group.name}</h3>
            {group.singleSelect ? <GroupBadge>单选</GroupBadge> : null}
            {group.required ? <GroupBadge>必选</GroupBadge> : null}
            {isAdmin ? (
              <span className="row-actions ml-auto">
                <button
                  type="button"
                  className="text-button"
                  aria-label="上移标签组"
                  disabled={index === 0}
                  onClick={() => move(group.id, -1)}
                >
                  <MdiChevronUp className="size-5" />
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label="下移标签组"
                  disabled={index === sections.groups.length - 1}
                  onClick={() => move(group.id, 1)}
                >
                  <MdiChevronDown className="size-5" />
                </button>
                <button
                  type="button"
                  className="text-button inline-flex items-center gap-1"
                  onClick={() => openGroupForm(group)}
                >
                  <MdiPencilOutline className="size-4" />
                  编辑
                </button>
              </span>
            ) : null}
          </header>
          {tags.length === 0 ? (
            <p className="member-meta mt-2">组内还没有标签。</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map((tag) => (
                <TagChip
                  key={tag.id}
                  tag={tag}
                  color={group.color}
                  onClick={() => openTagForm(tag)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </PopupLayout>
  )
}

function GroupBadge({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
      {children}
    </span>
  )
}
