import MdiCloudAlertOutline from '~icons/mdi/cloud-alert-outline'
import MdiCloudCheckOutline from '~icons/mdi/cloud-check-outline'
import MdiCloudOffOutline from '~icons/mdi/cloud-off-outline'
import MdiCloudSyncOutline from '~icons/mdi/cloud-sync-outline'
import type { SyncStatus } from '../state/sync'

export const SYNC_LABELS: Record<SyncStatus, string> = {
  offline: '离线',
  syncing: '同步中…',
  synced: '已同步',
  error: '同步失败',
}

function StatusIcon({ status }: { status: SyncStatus }) {
  const className = 'size-3.5'
  switch (status) {
    case 'synced':
      return <MdiCloudCheckOutline className={className} />
    case 'syncing':
      return <MdiCloudSyncOutline className={`${className} animate-spin`} />
    case 'error':
      return <MdiCloudAlertOutline className={className} />
    default:
      return <MdiCloudOffOutline className={className} />
  }
}

/** 顶栏同步状态徽标:离线 / 同步中 / 已同步 / 同步失败 */
export function SyncBadge({ status }: { status: SyncStatus }) {
  return (
    <span className="sync-badge inline-flex items-center gap-1" data-state={status}>
      <StatusIcon status={status} />
      {SYNC_LABELS[status]}
    </span>
  )
}
