import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stelic Assistant',
  description: 'Log your time by chatting.',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
