import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Unregister service workers in web browser (not Capacitor native)
// This prevents stale SW caching issues during development
const isNative = typeof window !== 'undefined' && 
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((window as any).Capacitor?.isNativePlatform?.() || (window as any).Capacitor?.isNative)

if (!isNative && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister()
    }
  }).catch(() => {
    // Silently ignore if unavailable
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
