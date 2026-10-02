/**
 * 生产装配:单例 ApiClient(同源 /api)+ IndexedDB 本地存储 + AppController。
 * 测试不引入本模块,直接 new AppController 注入替身。
 */
import { ApiClient } from '../api'
import { DexieLocalStore } from '../storage'
import { AppController } from './app-controller'

export const appController = new AppController({
  api: new ApiClient(),
  store: new DexieLocalStore(),
})
