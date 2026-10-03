import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'
import { registerSW } from 'virtual:pwa-register'
import { DialogProvider } from './components/dialog'
import { ThemeProvider } from './components/theme'

registerSW({ immediate: true })

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ThemeProvider>
  </StrictMode>,
)
