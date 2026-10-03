import { useCallback } from 'react'
import type { AppController } from '../../state/app-controller'
import { useDialog } from '../dialog'
import { TagManagerDialog } from './TagManagerDialog'

export { TagChip } from './TagChip'
export { TagFormDialog } from './TagFormDialog'
export { TagGroupFormDialog } from './TagGroupFormDialog'
export { TagManagerDialog } from './TagManagerDialog'

/**
 * 打开标签管理对话框(promise 式):「我的」页与记账编辑器共用;
 * 内容订阅 controller,标签/组的增改会即时反映在对话框里。
 */
export function useTagManager(controller: AppController): () => void {
  const { showDialog } = useDialog()
  return useCallback(() => {
    void showDialog<void>(() => <TagManagerDialog controller={controller} />, {
      label: '标签管理',
    })
  }, [controller, showDialog])
}
