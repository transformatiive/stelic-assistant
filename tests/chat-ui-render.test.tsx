import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Chips } from '@/components/chat/chips'
import { ConfirmationCard } from '@/components/chat/confirmation-card'
import { ResultCard } from '@/components/chat/result-card'
import type { CardEntry } from '@/lib/chat/ui'
import {
  dateDetail,
  formatDate,
  formatHours,
  formatRange,
  weekdayName,
} from '@/lib/chat/format'

/**
 * Rendered to a string rather than into a DOM.
 *
 * These components have no behaviour of their own — the rules live in the reducer, which is
 * tested directly. What is worth asserting here is *output*: that every field is labelled,
 * that a blocked line is marked, and that no figure with a currency in front of it ever
 * reaches the screen.
 */
const render = (element: React.ReactElement) => renderToStaticMarkup(element)
const noop = () => {}

function entry(overrides: Partial<CardEntry> = {}): CardEntry {
  return {
    entryId: 'e1',
    state: 'ready',
    projectName: 'STE-100013 - Clayco: MS Data Center',
    taskName: 'Engineering',
    date: '2026-07-21',
    hours: 8,
    description: 'Structural review',
    billable: true,
    why: { project: 'matched the client name (Clayco)' },
    warnings: [],
    blocked: null,
    ...overrides,
  }
}

describe('the confirmation card', () => {
  it('labels every field, because this is the screen before an invoice line', () => {
    const html = render(
      <ConfirmationCard
        entries={[entry()]}
        totalHours={8}
        today="2026-07-22"
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    for (const label of [
      'Project',
      'Charge code',
      'Date',
      'Hours',
      'What you did',
      'Billable',
    ]) {
      expect(html).toContain(label)
    }
  })

  it('shows both the relative day and the date it will be billed as', () => {
    const html = render(
      <ConfirmationCard
        entries={[entry()]}
        totalHours={8}
        today="2026-07-22"
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).toContain('Yesterday')
    expect(html).toContain('Tue 21 Jul 2026')
  })

  it('shows no rate, currency or budget figure anywhere', () => {
    const html = render(
      <ConfirmationCard
        entries={[entry(), entry({ entryId: 'e2', billable: false })]}
        totalHours={16}
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).not.toMatch(/[$£€]/)
    expect(html).not.toMatch(/\brate\b(?!d)/i)
    expect(html).not.toMatch(/budget/i)
  })

  it('marks a blocked line and says it will not be logged', () => {
    const html = render(
      <ConfirmationCard
        entries={[
          entry(),
          entry({
            entryId: 'e2',
            state: 'blocked',
            blocked: '2026-07-30 is in the future, and Zoho does not accept future time.',
          }),
        ]}
        // Only the ready line counts, which is the server's own arithmetic.
        totalHours={8}
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).toContain('Blocked:')
    expect(html).toContain('won’t be logged')
    expect(html).toContain('8h')
  })

  it('distinguishes a warning from a block, in words and not only in colour', () => {
    const html = render(
      <ConfirmationCard
        entries={[
          entry({
            warnings: [{ kind: 'backdated', message: 'That’s 20 days ago.', days: 20 }],
          }),
          entry({ entryId: 'e2', state: 'blocked', blocked: 'In the future.' }),
        ]}
        totalHours={8}
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).toContain('Warning:')
    expect(html).toContain('Blocked:')
  })

  it('disables its actions while a commit is in flight', () => {
    const html = render(
      <ConfirmationCard
        entries={[entry()]}
        totalHours={8}
        busy
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).toContain('Logging…')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
  })

  it('cannot be confirmed when nothing on it is ready', () => {
    const html = render(
      <ConfirmationCard
        entries={[entry({ state: 'blocked', blocked: 'In the future.' })]}
        totalHours={0}
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).toContain('disabled=""')
  })

  it('says a missing field is missing rather than leaving a blank', () => {
    const html = render(
      <ConfirmationCard
        entries={[entry({ state: 'needs_answer', description: null })]}
        totalHours={8}
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    expect(html).toContain('not set yet')
    expect(html).toContain('Still needs an answer')
  })
})

describe('chips', () => {
  const chips = [
    { value: 'p1', label: 'Clayco: MS Data Center', hint: 'Clayco Construction' },
    { value: 'p2', label: 'Turner: Fit-out' },
  ]

  it('renders a button per option with its hint', () => {
    const html = render(<Chips chips={chips} onPick={noop} />)
    expect(html).toContain('Clayco: MS Data Center')
    expect(html).toContain('Clayco Construction')
    // The attribute, not the substring — the class list is full of `disabled:` variants.
    expect(html).not.toContain('disabled=""')
  })

  it('goes dead once answered, but stays on screen', () => {
    const html = render(<Chips chips={chips} answered onPick={noop} />)
    expect(html).toContain('Turner: Fit-out')
    expect(html).toContain('disabled=""')
    expect(html).toContain('already answered')
  })

  it('renders nothing when there is nothing to offer', () => {
    expect(render(<Chips chips={[]} onPick={noop} />)).toBe('')
  })
})

describe('the result card', () => {
  const labels = { e1: 'Clayco · 8h', e2: 'Turner · 2h', e3: 'Skanska · 1h' }

  it('reports each entry rather than a count', () => {
    const html = render(
      <ResultCard
        labels={labels}
        notCommitted={[]}
        outcomes={[
          { entryId: 'e1', status: 'created', commitLogId: 'c1', zohoLogId: '1' },
          {
            entryId: 'e2',
            status: 'failed',
            commitLogId: 'c2',
            reason: 'zoho_error',
            detail: 'Zoho rejected this entry (400).',
          },
          { entryId: 'e3', status: 'created', commitLogId: 'c3', zohoLogId: '3' },
        ]}
        onRetry={noop}
      />,
    )

    expect(html).toContain('Clayco · 8h')
    expect(html).toContain('Turner · 2h')
    expect(html).toContain('Zoho rejected this entry (400).')
    expect(html).toContain('2 logged, 1 not')
    expect(html).toContain('Retry failed')
  })

  it('offers no retry when everything went through', () => {
    const html = render(
      <ResultCard
        labels={labels}
        notCommitted={[]}
        outcomes={[
          { entryId: 'e1', status: 'created', commitLogId: 'c1', zohoLogId: '1' },
        ]}
        onRetry={noop}
      />,
    )
    expect(html).not.toContain('Retry failed')
  })

  it('says a duplicate was not written twice, rather than showing a bare tick', () => {
    const html = render(
      <ResultCard
        labels={labels}
        notCommitted={[]}
        outcomes={[
          { entryId: 'e1', status: 'duplicate', commitLogId: 'c1', zohoLogId: '1' },
        ]}
        onRetry={noop}
      />,
    )
    expect(html).toContain('nothing was duplicated')
  })

  it('explains an entry that was never attempted', () => {
    const html = render(
      <ResultCard
        labels={labels}
        notCommitted={[{ entryId: 'e2', state: 'blocked', reason: 'In the future.' }]}
        outcomes={[
          { entryId: 'e1', status: 'created', commitLogId: 'c1', zohoLogId: '1' },
        ]}
        onRetry={noop}
      />,
    )
    expect(html).toContain('Not logged')
    expect(html).toContain('In the future.')
  })
})

describe('how hours and dates read', () => {
  it('uses the units people think in', () => {
    expect(formatHours(8)).toBe('8h')
    expect(formatHours(7.5)).toBe('7h 30m')
    expect(formatHours(0.25)).toBe('15m')
    expect(formatHours(0)).toBe('0m')
  })

  it('prefers the relative day, because that is what they said', () => {
    expect(formatDate('2026-07-22', '2026-07-22')).toBe('Today')
    expect(formatDate('2026-07-21', '2026-07-22')).toBe('Yesterday')
    expect(formatDate('2026-07-20', '2026-07-22')).toBe('Mon 20 Jul 2026')
  })

  it('reads a date the same way whatever the reader’s clock says', () => {
    // No `Date`, no zone: `dateDetail` is pure arithmetic on the civil date.
    expect(dateDetail('2026-07-19')).toBe('Sun 19 Jul 2026')
    expect(dateDetail('2027-01-01')).toBe('Fri 1 Jan 2027')
    expect(weekdayName('2026-07-19')).toBe('Sunday')
  })

  it('collapses what two dates in a range share', () => {
    expect(formatRange('2026-07-19', '2026-07-25')).toBe('19–25 Jul 2026')
    expect(formatRange('2026-07-28', '2026-08-03')).toBe('28 Jul – 3 Aug 2026')
    expect(formatRange('2026-12-27', '2027-01-02')).toBe(
      'Sun 27 Dec 2026 – Sat 2 Jan 2027',
    )
  })
})
