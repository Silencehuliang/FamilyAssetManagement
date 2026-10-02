import type { Category, CategoryId, LedgerData, Member, MemberId } from './types'
import { DomainError } from './types'

export function findMember(ledger: LedgerData, id: MemberId): Member {
  const member = ledger.meta.members.find((m) => m.id === id)
  if (!member) throw new DomainError('unknown_member', `成员不存在:${id}`)
  return member
}

export function findCategory(ledger: LedgerData, id: CategoryId): Category {
  const category = ledger.meta.categories.find((c) => c.id === id)
  if (!category) throw new DomainError('unknown_category', `分类不存在:${id}`)
  return category
}
