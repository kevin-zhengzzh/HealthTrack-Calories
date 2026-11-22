import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import { getChatQuota, streamChat } from '../api'
import type { ChatQuota, ChatTurn, GoalProposal } from '../types'
import { useGoals } from '../goals'

// AI chat assistant (specs/06-ai-features-spec.md §5.1, §5.3). A floating button in
// the same right-hand column as RecordButton (bottom-6) and BackToTopButton
// (bottom-24), one step above them so it never overlaps either (CA-1).

const MAX_MESSAGE_LENGTH = 1000 // matches ChatAssistantService.MaxMessageLength
const MAX_HISTORY_TURNS = 20 // CA-7; the server caps it too

// Topic pills above the input (spec §5.3). One click sends the pill's prompt
// straight away, tagged with its id as `mode` — the backend then gives the
// model topic-specific instructions and only the tools that topic needs.
// The mode applies to that one message only. Ids must match ChatModes.
// Facts the pages already show (week, rank, points, goal progress) have no
// pill; you can still just ask. "Set my plan" is the one topic that can
// change data: the model proposes goals and the user applies them from a
// card (AGENTS.md D-34).
interface ChatModeOption {
  id: string
  label: string
  prompt: string
  // Stays on for the messages typed after it (until Done): planning is a
  // short conversation — the assistant asks what you want, then proposes
  sticky?: boolean
}

const MODES: ChatModeOption[] = [
  { id: 'plan', label: '🎯 Set my plan', prompt: 'Help me set my daily intake and weekly burn goals.', sticky: true },
  { id: 'advice', label: '💡 Workout advice', prompt: 'Based on my recent workouts, what should I do next?' },
]

const TOOL_LABELS: Record<string, string> = {
  get_workout_summary: 'Checking your workouts…',
  get_checkin_status: 'Checking your check-in streak…',
  get_weekly_goal_progress: 'Checking your weekly goal…',
  get_rank: 'Checking the leaderboards…',
  get_points_summary: 'Checking your points…',
  get_plan_context: 'Looking at your goals and history…',
  propose_goals: 'Preparing a plan…',
}

interface Message {
  role: 'user' | 'assistant'
  text: string
  // The topic pill a user message was sent with, shown as a badge
  mode?: ChatModeOption
  // Failed exchanges stay visible but are left out of the history sent back
  failed?: boolean
  // Goals the assistant proposed in this answer, shown as an Apply card
  proposal?: GoalProposal
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
      <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
    </svg>
  )
}

// After a failure: keep the user's message (marked failed so it's not sent as
// history) and drop the assistant bubble unless some text had already streamed.
function markLastExchangeFailed(messages: Message[]): Message[] {
  const next = messages.slice()
  const last = next[next.length - 1]
  if (last?.role === 'assistant') {
    if (last.text) next[next.length - 1] = { ...last, failed: true }
    else next.pop()
  }
  const userIndex = next.map((m) => m.role).lastIndexOf('user')
  if (userIndex !== -1) next[userIndex] = { ...next[userIndex], failed: true }
  return next
}

// The assistant's proposed goals, old → new. Applying goes through the same
// endpoints as the Plan page, as the signed-in user; the model can't save.
function ProposalCard({ proposal }: { proposal: GoalProposal }) {
  const { save } = useGoals()
  const [state, setState] = useState<'idle' | 'saving' | 'applied' | 'dismissed' | 'error'>('idle')
  const rows = [
    proposal.intakePerDay !== null && { label: 'Daily intake', from: proposal.currentIntakePerDay, to: proposal.intakePerDay },
    proposal.burnPerWeek !== null && { label: 'Weekly burn', from: proposal.currentBurnPerWeek, to: proposal.burnPerWeek },
  ].filter((r): r is { label: string; from: number | null; to: number } => !!r)

  async function apply() {
    setState('saving')
    try {
      if (proposal.intakePerDay !== null) await save('intake', { perDay: proposal.intakePerDay })
      if (proposal.burnPerWeek !== null) await save('burn', { perWeek: proposal.burnPerWeek })
      setState('applied')
    } catch {
      setState('error')
    }
  }

  return (
    <div className="w-[85%] rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-3 text-sm shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-2">Proposed plan</p>
      <ul className="flex flex-col gap-1 mb-3">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline justify-between gap-2">
            <span className="text-[var(--text-secondary)]">{r.label}</span>
            <span className="tabular-nums">
              <span className="text-[var(--text-muted)]">{r.from === null ? 'not set' : r.from.toLocaleString()} → </span>
              <span className="font-semibold text-[var(--text-primary)]">{r.to.toLocaleString()} kcal</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-[var(--text-muted)] mb-2 leading-snug">
        A suggestion, not medical advice. Check with a professional first if you're pregnant, under 18 or have a
        health condition. <Link to="/disclaimer" className="underline">Disclaimer</Link>
      </p>
      {state === 'applied' ? (
        <p className="text-xs font-medium" style={{ color: 'var(--primary-text)' }}>✓ Applied — see the Plan page.</p>
      ) : state === 'dismissed' ? (
        <p className="text-xs text-[var(--text-muted)]">Not applied.</p>
      ) : (
        <div className="flex gap-2">
          <button type="button" onClick={() => setState('dismissed')} disabled={state === 'saving'}
            className="flex-1 border border-[var(--border)] rounded-lg py-1.5 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-inset)] cursor-pointer disabled:opacity-50">
            Dismiss
          </button>
          <button type="button" onClick={apply} disabled={state === 'saving'}
            className="flex-1 rounded-lg py-1.5 text-xs font-semibold text-white cursor-pointer disabled:opacity-60"
            style={{ backgroundColor: 'var(--primary)' }}>
            {state === 'saving' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      )}
      {state === 'error' && <p className="text-xs text-red-600 mt-2">Couldn't save — try again, or set it on the Plan page.</p>}
    </div>
  )
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [quota, setQuota] = useState<ChatQuota | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A sticky topic in progress: typed messages are sent with it
  const [stickyMode, setStickyMode] = useState<ChatModeOption | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    getChatQuota().then(setQuota).catch(() => {})
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Stop an in-flight stream if the widget unmounts (e.g. on sign-out)
  useEffect(() => () => abortRef.current?.abort(), [])

  // Keep the newest text in view as it streams in
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, toolStatus, error])

  const outOfQuota = quota?.remaining === 0

  async function send(text: string, base: Message[], withMode: ChatModeOption | null) {
    const message = text.trim() || withMode?.prompt || ''
    if (!message || busy || outOfQuota) return

    const history: ChatTurn[] = base
      .filter((m) => !m.failed && m.text)
      .slice(-MAX_HISTORY_TURNS)
      .map(({ role, text }) => ({ role, text }))

    setStickyMode(withMode?.sticky ? withMode : null)
    setMessages([...base, { role: 'user', text: message, mode: withMode ?? undefined }, { role: 'assistant', text: '' }])
    setInput('')
    setError(null)
    setBusy(true)
    setToolStatus(null)

    const controller = new AbortController()
    abortRef.current = controller
    const appendToAnswer = (chunk: string) =>
      setMessages((prev) => {
        const next = prev.slice()
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, text: last.text + chunk }
        return next
      })

    try {
      const outcome: { error: string | null } = { error: null }
      await streamChat(history, message, withMode?.id ?? null, (event) => {
        switch (event.type) {
          case 'text':
            setToolStatus(null)
            appendToAnswer(event.text)
            break
          case 'tool':
            setToolStatus(TOOL_LABELS[event.name] ?? 'Looking up your data…')
            break
          case 'proposal':
            setMessages((prev) => {
              const next = prev.slice()
              next[next.length - 1] = { ...next[next.length - 1], proposal: event.proposal }
              return next
            })
            break
          case 'done':
            setQuota((q) => (q ? { ...q, used: q.limit - event.remaining, remaining: event.remaining } : q))
            break
          case 'error':
            outcome.error = event.message
            break
        }
      }, controller.signal)
      if (outcome.error) throw new Error(outcome.error)
    } catch (err) {
      if (controller.signal.aborted) return
      setMessages(markLastExchangeFailed)
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      if (abortRef.current === controller) {
        setBusy(false)
        setToolStatus(null)
      }
    }
  }

  // Re-send the last user message, discarding the failed exchange (CA-9)
  function retry() {
    const index = messages.map((m) => m.role).lastIndexOf('user')
    if (index !== -1) send(messages[index].text, messages.slice(0, index), messages[index].mode ?? null)
  }

  // Typed messages carry no mode (all read-only tools), unless a sticky
  // topic like Set my plan is in progress
  const submit = () => send(input, messages, stickyMode)

  const last = messages[messages.length - 1]
  const waitingForFirstText = busy && last?.role === 'assistant' && !last.text

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open AI assistant"
        title="Ask the AI assistant"
        className="fixed bottom-42 right-4 w-12 h-12 flex items-center justify-center text-white rounded-full shadow-lg transition-transform active:scale-95 cursor-pointer z-30"
        style={{ backgroundColor: 'var(--primary)' }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--primary-hover)')}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--primary)')}
      >
        <ChatIcon className="w-6 h-6" />
      </button>
    )
  }

  return (
    <section
      role="dialog"
      aria-label="HealthTrack assistant"
      className="fixed z-40 inset-x-3 bottom-3 top-17 sm:top-auto sm:inset-x-auto sm:right-16 sm:bottom-6 sm:w-96 sm:h-[34rem] flex flex-col rounded-2xl shadow-xl border border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)]">
        <div className="min-w-0">
          <h2 className="font-semibold text-[var(--text-primary)] text-sm">HealthTrack Assistant</h2>
          {quota && (
            <p className="text-xs text-[var(--text-secondary)]">
              {quota.remaining} / {quota.limit} messages left today
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close AI assistant"
          className="p-1.5 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-inset)] cursor-pointer"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-sm text-[var(--text-secondary)]">
            Ask me anything about your workouts, streak, goals, rank or points — or let me help you set your plan.
          </p>
        )}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div
                className={`max-w-[85%] px-3 py-2 rounded-2xl rounded-br-sm text-sm ${m.failed ? 'opacity-60' : ''}`}
                style={{ backgroundColor: 'var(--primary)', color: 'white' }}
              >
                {m.mode && <p className="text-[11px] font-medium opacity-80 mb-0.5">{m.mode.label}</p>}
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
              </div>
            </div>
          ) : m.text || m.proposal ? (
            <div key={i} className="flex flex-col items-start gap-2">
              {/* react-markdown never renders raw HTML, so model output can't inject markup */}
              <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm text-sm bg-[var(--bg-inset)] text-[var(--text-primary)] break-words">
                <ReactMarkdown
                  components={{
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-0.5">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-0.5">{children}</ol>,
                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                  }}
                >
                  {m.text}
                </ReactMarkdown>
              </div>
              {m.proposal && <ProposalCard proposal={m.proposal} />}
            </div>
          ) : null,
        )}

        {waitingForFirstText && (
          <p className="text-xs text-[var(--text-secondary)] italic">{toolStatus ?? 'Thinking…'}</p>
        )}

        {error && (
          <div role="alert" className="text-sm text-red-600 flex items-center gap-2 flex-wrap">
            <span>{error}</span>
            <button type="button" onClick={retry} className="underline font-medium cursor-pointer">
              Retry
            </button>
          </div>
        )}
      </div>

      <form
        className="border-t border-[var(--border)] p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {outOfQuota ? (
          <p className="text-sm text-[var(--text-secondary)] text-center py-2">
            You've used all {quota?.limit} messages for today. Come back tomorrow!
          </p>
        ) : (
          <>
          {/* Topic pills — horizontally scrollable so they fit on narrow screens */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1" role="group" aria-label="Topics">
            {MODES.map((m) => {
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => send(m.prompt, messages, m)}
                  disabled={busy}
                  className="flex-shrink-0 text-xs px-2.5 py-1 rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-inset)] transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          {stickyMode && (
            <div className="flex items-center justify-between gap-2 mb-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-inset)] text-xs text-[var(--text-secondary)]">
              <span>{stickyMode.label} — your replies continue this</span>
              <button type="button" onClick={() => setStickyMode(null)} disabled={busy}
                className="font-semibold hover:underline cursor-pointer disabled:opacity-50" style={{ color: 'var(--primary-text)' }}>
                Done
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter adds a newline
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="Ask about your progress…"
              aria-label="Message"
              className="flex-1 resize-none max-h-28 px-3 py-2 text-sm rounded-xl border border-[var(--border)] bg-[var(--bg-page)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-light)]"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="px-3 py-2 text-sm font-medium text-white rounded-xl disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--primary)' }}
            >
              Send
            </button>
          </div>
          </>
        )}
        <p className="mt-2 text-[11px] text-[var(--text-secondary)] text-center">
          AI answers can be wrong. Not medical advice.
        </p>
      </form>
    </section>
  )
}
