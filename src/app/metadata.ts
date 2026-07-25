import type { Metadata, Viewport } from 'next'

/**
 * The document's head, as data (tasks 8.1, 8.2).
 *
 * Separate from `layout.tsx` only because that file imports the global stylesheet, and a test
 * asserting "iOS will launch this standalone" should not need a CSS pipeline to find out.
 * `layout.tsx` re-exports both, which is what Next reads.
 */

export const metadata: Metadata = {
  title: 'Stelic Assistant',
  description: 'Log your time by chatting.',
  applicationName: 'Stelic Assistant',
  /**
   * iOS ignores the manifest almost entirely (PWA-1).
   *
   * *Add to Home Screen* on Safari reads these meta tags instead: without `capable` the app
   * launches into a Safari tab complete with address bar, which is precisely what installing
   * was meant to avoid. `title` is the name under the icon, short enough not to be truncated.
   */
  appleWebApp: {
    capable: true,
    title: 'Stelic',
    // Translucent, so the app's own navy runs up behind the clock rather than leaving a white
    // strip above it. Depends on `viewportFit: cover` and the safe-area padding in the CSS.
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    // iOS applies its own rounded mask and ignores transparency, so this one is a square.
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  // A timesheet is nobody's search result.
  robots: { index: false, follow: false },
  // Safari turns bare numbers into phone links, which on a screen full of hours and dates is
  // both wrong and tappable by accident.
  formatDetection: { telephone: false, date: false, address: false, email: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Stelic navy — tints the browser chrome on Android and the status bar of the installed
  // app, so the frame around the app matches the mark inside it.
  themeColor: '#0b204b',
  // No maximum-scale / user-scalable=no: pinch-zoom must stay available (PWA-10).
  viewportFit: 'cover',
}
