import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent, ChatTurn } from '../../src/types'

const { getChatQuota, streamChat, updateGoal } = vi.hoisted(() => ({
  getChatQuota: vi.fn(),
  streamChat: vi.fn(),
  updateGoal: vi.fn(),
}))
vi.mock('../../src/api', () => ({ getChatQuota, streamChat, updateGoal }))

import ChatWidget from '../../src/components/ChatWidget'

// Makes streamChat replay the given events, like the server's SSE stream
function streams(...events: ChatStreamEvent[]) {
  streamChat.mockImplementationOnce(
    async (_h: ChatTurn[], _m: string, _mode: string | null, onEvent: (e: ChatStreamEvent) => void) => {
      events.forEach(onEvent)
    },
  )
}

async function openWidget() {
  const user = userEvent.setup()
  render(<MemoryRouter><ChatWidget /></MemoryRouter>)
  await user.click(screen.getByRole('button', { name: 'Open AI assistant' }))
  return user
}

const messageBox = () => screen.getByRole('textbox', { name: 'Message' })

describe('ChatWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getChatQuota.mockResolvedValue({ used: 2, limit: 30, remaining: 28 })
  })

  it('opens with topic pills and the remaining quota', async () => {
    await openWidget()

    expect(screen.getByRole('dialog', { name: 'HealthTrack assistant' })).toBeInTheDocument()
    // Only the two topics the pages can't answer: setting a plan, and advice
    expect(screen.getAllByRole('button').filter((b) => b.closest('[aria-label="Topics"]')).map((b) => b.textContent))
      .toEqual(['🎯 Set my plan', '💡 Workout advice'])
    expect(await screen.findByText('28 / 30 messages left today')).toBeInTheDocument()
  })

  it('sends a typed message, renders the streamed Markdown answer and updates the quota', async () => {
    streams(
      { type: 'tool', name: 'get_workout_summary' },
      { type: 'text', text: 'You did **4 workouts** ' },
      { type: 'text', text: 'this week.' },
      { type: 'done', remaining: 27 },
    )
    const user = await openWidget()
    await screen.findByText('28 / 30 messages left today')

    await user.type(messageBox(), 'How did I do this week?{Enter}')

    expect(streamChat).toHaveBeenCalledWith([], 'How did I do this week?', null, expect.any(Function), expect.any(AbortSignal))
    expect((await screen.findByText('4 workouts')).tagName).toBe('STRONG')
    expect(screen.getByText('27 / 30 messages left today')).toBeInTheDocument()
  })

  it('one click on a pill sends its prompt with the mode; the next typed message has no mode', async () => {
    streams({ type: 'text', text: 'Try adding a rest day.' }, { type: 'done', remaining: 27 })
    streams({ type: 'text', text: 'Yoga works.' }, { type: 'done', remaining: 26 })
    const user = await openWidget()

    await user.click(screen.getByRole('button', { name: /Workout advice/ }))

    const prompt = 'Based on my recent workouts, what should I do next?'
    expect(streamChat).toHaveBeenLastCalledWith([], prompt, 'advice', expect.any(Function), expect.any(AbortSignal))
    expect(await screen.findByText('Try adding a rest day.')).toBeInTheDocument()
    // The user bubble carries the topic badge (the pill itself has the same label)
    expect(screen.getAllByText('💡 Workout advice').length).toBe(2)

    await user.type(messageBox(), 'What kind?{Enter}')

    expect(streamChat).toHaveBeenLastCalledWith(
      [
        { role: 'user', text: prompt },
        { role: 'assistant', text: 'Try adding a rest day.' },
      ],
      'What kind?',
      null,
      expect.any(Function),
      expect.any(AbortSignal),
    )
  })

  it('shows an error with Retry, and retrying resends with the same mode and no failed history', async () => {
    streams({ type: 'error', message: 'The AI assistant is unavailable right now. Please try again.' })
    streams({ type: 'text', text: 'All good now.' }, { type: 'done', remaining: 27 })
    const user = await openWidget()

    await user.click(screen.getByRole('button', { name: /Set my plan/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable right now')

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('All good now.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(streamChat).toHaveBeenLastCalledWith([], 'Help me set my daily intake and weekly burn goals.', 'plan', expect.any(Function), expect.any(AbortSignal))
  })

  it('shows a proposed plan as a card and saves it only when Apply is pressed', async () => {
    streams(
      { type: 'text', text: 'A moderate deficit would be 1,900 a day.' },
      { type: 'proposal', proposal: { intakePerDay: 1900, burnPerWeek: 2100, currentIntakePerDay: null, currentBurnPerWeek: 2000 } },
      { type: 'done', remaining: 27 },
    )
    updateGoal.mockResolvedValue({ intake: { perDay: 1900, perWeek: 13300 }, burn: { perDay: 300, perWeek: 2100 } })
    const user = await openWidget()

    await user.click(screen.getByRole('button', { name: /Set my plan/ }))

    expect(await screen.findByText('Proposed plan')).toBeInTheDocument()
    expect(screen.getByText('not set →')).toBeInTheDocument()
    expect(screen.getByText('1,900 kcal')).toBeInTheDocument()
    expect(screen.getByText('2,100 kcal')).toBeInTheDocument()
    expect(updateGoal).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText(/Applied/)).toBeInTheDocument()
    expect(updateGoal).toHaveBeenCalledWith('intake', { perDay: 1900 })
    expect(updateGoal).toHaveBeenCalledWith('burn', { perWeek: 2100 })
  })

  it('keeps Set my plan on for typed replies until Done', async () => {
    streams({ type: 'text', text: 'Lose, keep or gain?' }, { type: 'done', remaining: 27 })
    streams({ type: 'text', text: 'Here you go.' }, { type: 'done', remaining: 26 })
    streams({ type: 'text', text: 'Hi.' }, { type: 'done', remaining: 25 })
    const user = await openWidget()

    await user.click(screen.getByRole('button', { name: /Set my plan/ }))
    await screen.findByText('Lose, keep or gain?')
    await user.type(messageBox(), 'Lose slowly{Enter}')
    expect(streamChat).toHaveBeenLastCalledWith(expect.any(Array), 'Lose slowly', 'plan', expect.any(Function), expect.any(AbortSignal))

    await screen.findByText('Here you go.')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.type(messageBox(), 'hello{Enter}')
    expect(streamChat).toHaveBeenLastCalledWith(expect.any(Array), 'hello', null, expect.any(Function), expect.any(AbortSignal))
  })

  it('surfaces request errors thrown before the stream starts (e.g. quota 429)', async () => {
    streamChat.mockRejectedValueOnce(new Error("You've used all 30 AI messages for today. Try again tomorrow."))
    const user = await openWidget()

    await user.type(messageBox(), 'hello{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent('used all 30 AI messages')
  })

  it('disables input when the daily quota is used up', async () => {
    getChatQuota.mockResolvedValue({ used: 30, limit: 30, remaining: 0 })
    await openWidget()

    expect(await screen.findByText(/used all 30 messages for today/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Topics' })).not.toBeInTheDocument()
  })

  it('closes with Escape', async () => {
    const user = await openWidget()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Open AI assistant' })).toBeInTheDocument()
  })
})
