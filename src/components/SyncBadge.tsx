import type { SyncStatus } from '../state/sync'

export const SYNC_LABELS: Record<SyncStatus, string> = {
  offline: '离线',
  syncing: '同步中…',
  synced: '已同步',
  error: '同步失败',
}

/** 顶栏同步状态徽标:离线 / 同步中 / 已同步 / 同步失败 */
export function SyncBadge({ status }: { status: SyncStatus }) {
  return (
    <span className="sync-badge" data-state={status}>
      {SYNC_LABELS[status]}
    </span>
  )
}
