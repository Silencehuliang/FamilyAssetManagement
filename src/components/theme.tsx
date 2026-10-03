import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 读取用户主题偏好;非法/不可用时回退 system(与 index.html 防闪烁脚本同一约定) */
export function readStoredTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    return 'system'
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === 'dark' || (choice === 'system' && systemPrefersDark()) ? 'dark' : 'light'
}

interface ThemeContextValue {
  theme: ThemeChoice
  resolved: ResolvedTheme
  setTheme: (choice: ThemeChoice) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/** 在 <html> 上维护 .dark;localStorage "theme" 持久化,system 时跟随系统并监听变化 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readStoredTheme)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredTheme()))

  useEffect(() => {
    const next = resolveTheme(theme)
    setResolved(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    if (theme !== 'system') return
    const media = window.matchMedia(DARK_QUERY)
    const onChange = (): void => {
      const value = resolveTheme('system')
      setResolved(value)
      document.documentElement.classList.toggle('dark', value === 'dark')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((choice: ThemeChoice) => {
    try {
      localStorage.setItem(STORAGE_KEY, choice)
    } catch {
      // 隐私模式下仅当前会话生效
    }
    setThemeState(choice)
  }, [])

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return context
}
