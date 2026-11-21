import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckIn } from '../../src/types'

const { getCheckInHistory } = vi.hoisted(() => ({ getCheckInHistory: vi.fn() }))
vi.mock('../../src/api', () => ({ getCheckInHistory }))

// Imported after the mock so History picks up the mocked api module.
const { default: History } = await import('../../src/pages/History')

function makeCheckIns(dates: string[]): CheckIn[] {
  return dates.map((date, i) => ({ id: i + 1, date, note: null, createdAt: `${date}T08:00:00Z` }))
}

beforeEach(() => {
  getCheckInHistory.mockReset()
})

describe('Check-ins tab', () => {
  it('shows an empty state when there are no check-ins', async () => {
    getCheckInHistory.mockResolvedValue([])
    render(<History />)

    expect(await screen.findByText(/No check-ins yet/)).toBeInTheDocument()
  })

  it('groups check-ins by month, newest first, with a count per month', async () => {
    getCheckInHistory.mockResolvedValue(makeCheckIns(['2026-06-15', '2026-07-01', '2026-07-02']))
    render(<History />)

    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings.map((h) => h.textContent)).toEqual(['July 2026', 'June 2026'])
    expect(screen.getByText('2 check-ins')).toBeInTheDocument()
    expect(screen.getByText('1 check-in')).toBeInTheDocument()
  })

  it('shows 10 months at first and older ones on request', async () => {
    const dates = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}-10`)
    getCheckInHistory.mockResolvedValue(makeCheckIns(dates))
    const user = userEvent.setup()
    render(<History />)

    expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(10)
    expect(screen.queryByText('January 2025')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Show older months \(2 more\)/ }))

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(12)
    expect(screen.getByText('January 2025')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show older/ })).not.toBeInTheDocument()
  })
})
