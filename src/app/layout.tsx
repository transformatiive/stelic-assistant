import './globals.css'
import { ServiceWorkerRegistration } from './service-worker'

export { metadata, viewport } from './metadata'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  )
}
