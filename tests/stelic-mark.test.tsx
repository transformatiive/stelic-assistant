import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StelicMark } from '@/components/stelic-mark'

/**
 * Rendered to a string rather than into a DOM: the mark has no behaviour, only output, and a
 * string assertion needs no jsdom in CI.
 */
const render = (element: React.ReactElement) => renderToStaticMarkup(element)

describe('StelicMark', () => {
  it('carries Stelic’s own colours, not an approximation of them', () => {
    const svg = render(<StelicMark />)
    expect(svg).toContain('#0b204b') // navy field
    expect(svg).toContain('#009be3') // accent band
  })

  it('is decorative by default, so the name is not announced twice', () => {
    // It always sits beside the words "Stelic Assistant".
    const svg = render(<StelicMark />)
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).not.toContain('<title>')
    expect(svg).not.toContain('role="img"')
  })

  it('becomes a labelled image when it stands alone', () => {
    const svg = render(<StelicMark title="Stelic" />)
    expect(svg).toContain('role="img"')
    expect(svg).toContain('<title>Stelic</title>')
    expect(svg).not.toContain('aria-hidden')
  })

  it('scales without distorting — one size drives both dimensions', () => {
    const svg = render(<StelicMark size={36} />)
    expect(svg).toContain('width="36"')
    expect(svg).toContain('height="36"')
    expect(svg).toContain('viewBox="0 0 100 100"')
  })

  it('needs no network request, so it renders offline and on first paint', () => {
    const svg = render(<StelicMark />)
    expect(svg).not.toMatch(/https?:\/\//)
    expect(svg).not.toContain('<image')
  })

  it('clips the accent band to the same corner curve as the field behind it', () => {
    const svg = render(<StelicMark />)
    expect(svg).toContain('clip-path="url(#stelic-mark-clip)"')
    expect(svg).toContain('rx="22.5"')
  })
})
