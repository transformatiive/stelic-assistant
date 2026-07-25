'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker (task 8.3).
 *
 * After load rather than during it: registration competes with the first render for the same
 * network and main thread, and the shell is more useful on screen than cached.
 *
 * Failure is silent by design. A browser with service workers disabled, a private window, or
 * an insecure origin in local development all reject here — and none of them is a problem the
 * user can act on. The app works without a worker; it is offline resilience, not a dependency.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
    }

    if (document.readyState === 'complete') {
      register()
      return
    }
    window.addEventListener('load', register, { once: true })
    return () => window.removeEventListener('load', register)
  }, [])

  return null
}
