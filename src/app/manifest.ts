import type { MetadataRoute } from 'next'

/**
 * The web app manifest (task 8.1, PWA-1).
 *
 * `display: standalone` is the point of the whole exercise: launched from a home screen there
 * is no address bar, so the fifteen-second target is not spent on browser chrome.
 *
 * Three icons, and the third is not a duplicate. Android crops a launcher icon to whatever
 * shape the device uses — circle, squircle, teardrop — and a normal icon cropped that way
 * loses its corners. The `maskable` variant is the same mark with the artwork pulled into the
 * safe zone and the accent band dropped, because a band running to the edge survives a
 * circular crop only as a thin chord.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Stelic Assistant',
    short_name: 'Stelic',
    description: 'Log your time by chatting.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b204b',
    theme_color: '#0b204b',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
