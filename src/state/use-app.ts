import { useSyncExternalStore } from 'react'
import type { AppController, AppState } from './app-controller'

/** 订阅 AppController 状态(控制器在 React 之外维护,便于逻辑测试) */
export function useAppState(controller: AppController): AppState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
}
