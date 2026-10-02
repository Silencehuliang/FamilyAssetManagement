import type { Category } from './types'

interface Preset {
  id: string
  name: string
  children: string[]
}

const PRESETS: Preset[] = [
  { id: 'dining', name: '餐饮', children: ['早餐', '午餐', '晚餐', '外卖', '零食饮料'] },
  { id: 'transport', name: '交通', children: ['公共交通', '打车', '加油', '停车过路'] },
  { id: 'shopping', name: '购物', children: ['日用品', '衣物', '数码', '家居'] },
  { id: 'housing', name: '居住', children: ['房租', '水电燃气', '物业', '维修'] },
  { id: 'fun', name: '娱乐', children: ['游戏', '电影演出', '旅游'] },
  { id: 'medical', name: '医疗', children: ['药品', '门诊', '住院'] },
  { id: 'education', name: '教育', children: ['书籍', '培训', '学费'] },
  { id: 'social', name: '人情', children: ['红包送礼', '请客'] },
  { id: 'pet', name: '宠物', children: ['粮食用品', '宠物医疗'] },
  { id: 'other', name: '其他', children: ['杂项'] },
]

/** 开箱即得的中文二级分类;管理员可改造成自家体系 */
export const DEFAULT_CATEGORIES: Category[] = PRESETS.flatMap((parent, parentIdx) => [
  { id: `cat-${parent.id}`, name: parent.name, sortOrder: parentIdx },
  ...parent.children.map((child, childIdx) => ({
    id: `cat-${parent.id}-${childIdx + 1}`,
    name: child,
    parentId: `cat-${parent.id}`,
    sortOrder: childIdx,
  })),
])
