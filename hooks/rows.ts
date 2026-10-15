import type { Folds, Row } from '../types'

export const WINDOW_MS = 60 * 60 * 1000
// A session waiting on the person stays listed this long, past WINDOW_MS, until they answer.
export const WAIT_MAX_MS = 24 * 60 * 60 * 1000
// Past WINDOW_MS a session is offline, and listed as such for this long.
export const OFFLINE_MS = 5 * 60 * 60 * 1000

export type Head = { title?: string; cwd?: string; entrypoint?: string }
// `prior` lists the earlier transcripts of the same session (left behind by a resume or a
// compaction): they carry the same title and would list the session twice.
export type Meta = {
  id: string
  title?: string
  cwd?: string
  model?: string
  effort?: string
  // the app's own id for the session, which a deep link opens it by
  appId?: string
  // when the app last saw the session run; unlike the transcript's modified time, opening a
  // session does not move it
  activeAt?: number
  archived: boolean
  prior: string[]
}
// What the last real message of a transcript says: `ask` is a question or plan approval
// nobody has answered, `instant` a call to a tool that finishes in milliseconds, `running`
// any other call or unanswered prompt, `done` an ended turn.
export type Kind = 'ask' | 'instant' | 'running' | 'done'
export type Status = 'waiting' | 'running' | 'done'
export type Entry = Head & {
  id: string
  // when the session last ran, which is not the file's modified time
  ranAt: number
  size: number
  dir: string
  model?: string
  effort?: string
  appId?: string
  archived?: boolean
  // the desktop app has a record of this session; otherwise it was found by its transcript alone
  hasRecord?: boolean
  status?: Status
  // when the turn now in flight began; unknown for a transcript too big to read
  startedAt?: number
}
export type State = 'waiting' | 'working' | 'recent' | 'idle'

const lastSegment = (path: string) => path.split(/[\\/]+/).filter(Boolean).pop() ?? path

// A session started without choosing a folder runs in a throwaway folder the app makes
// (scratch-workspaces/.../scratch-2026-10-12-64df8d): that is no project, and its folder
// name says nothing.
export function folderOf(cwd: string | undefined, dir: string): string {
  if ((cwd ?? dir).includes('scratch-workspaces')) return 'No Project'
  return cwd ? lastSegment(cwd) : dir.slice(-24)
}

// The transcript is JSON lines: the last custom-title line is the title, the first line
// carrying a cwd gives the folder and what started the session (entrypoint).
export function parseHead(text: string): Head {
  let title: string | undefined
  let cwd: string | undefined
  let entrypoint: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('{"type":"custom-title"')) title = JSON.parse(line).customTitle
    else if (cwd === undefined && line.includes('"cwd":"')) {
      const row = JSON.parse(line)
      cwd = row.cwd
      entrypoint = row.entrypoint
    }
  }
  return { title, cwd, entrypoint }
}

// The desktop app keeps one JSON record per session: its title, folder, model and the
// id of the transcript (cliSessionId) it belongs to.
export function parseRecord(text: string): Meta | undefined {
  const d = JSON.parse(text)
  if (typeof d.cliSessionId !== 'string') return undefined
  return {
    id: d.cliSessionId,
    title: d.title || undefined,
    cwd: d.cwd || undefined,
    model: d.model || undefined,
    effort: d.effort || undefined,
    appId: isAppSessionId(d.sessionId) ? d.sessionId : undefined,
    activeAt: typeof d.lastActivityAt === 'number' ? d.lastActivityAt : undefined,
    archived: d.isArchived === true,
    prior: Array.isArray(d.priorCliSessionIds) ? d.priorCliSessionIds.filter((x: unknown) => typeof x === 'string') : [],
  }
}

// The sections that can fold: Working now cannot, so a fold saved for it is dropped.
const SECTIONS = ['waiting', 'done', 'offline'] as const

// The folded sections as saved in the store: only a section that can fold, set to true,
// counts, so a hand-edited or older value cannot fold something else. `legacyOffline` is the
// value an earlier version saved when only the Offline section could fold.
export function parseFolds(saved: unknown, legacyOffline?: unknown): Folds {
  const from = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {}
  const folds: Folds = {}
  for (const section of SECTIONS) if (from[section] === true) folds[section] = true
  if (legacyOffline === true) folds.offline = true
  return folds
}

// The id the desktop app gives its own sessions, local_ and then letters, digits and dashes:
// what its deep links accept, checked the way it checks them (local_ plus 1 to 64 of those).
export function isAppSessionId(id: unknown): id is string {
  if (typeof id !== 'string' || !id.startsWith('local_') || id.length < 7 || id.length > 70) return false
  for (const ch of id.slice(6)) {
    const plain = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
    if (!plain && ch !== '-') return false
  }
  return true
}

// The link that opens a session in the desktop app: its continue route, which switches to
// the session it is given by id.
export const sessionUrl = (appId: string) => `claude://code/continue?session=${appId}`

// What a message from a card should open, if anything. The message is the card region's word
// and not a fact: only the exact click counts, the card is found by its key among the rows
// listed, and the id to open is read from that row and never from the message. The session the
// person is in opens nothing (its card is not clickable, and a stray message is ignored all
// the same), and neither does a card with no id the app would accept.
export function clickTarget(list: Row[], element: string, data: unknown): string | undefined {
  if (!element.startsWith('card-') || !data || typeof data !== 'object') return undefined
  if ((data as { open?: unknown }).open !== true) return undefined
  const row = list.find(r => r.id === element.slice('card-'.length))

  return row && !row.isCurrent && isAppSessionId(row.appId) ? row.appId : undefined
}

export const shortModel = (model: string) => model.replace(/^claude-/, '')

export function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000)
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

// Only a transcript written to within RUN_MS can be mid-turn: older, the turn was
// abandoned (a crash, a closed window) and the session shows as done.
export const RUN_MS = 10 * 60_000
// A transcript too big to read (over 4 MiB) has no tail to judge; written to in the last
// minute it is taken as running.
export const BLIND_RUN_MS = 60_000
// A call to a tool that finishes in milliseconds, still unanswered after this long, is held
// at an approval prompt.
export const PROMPT_MS = 15_000

const ASKS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const INSTANT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// The kind of the last real message: a prompt or tool result nobody has answered, or an
// assistant message that stopped to call a tool, is in flight; an assistant message that
// ended its turn, or an interrupted prompt, is done. Slash-command echoes, meta rows,
// subagent rows and a half-written last line are skipped.
// ponytail: a Bash or Agent approval prompt looks like a long run, so it reads as running;
// only a question, a plan approval and an Edit or Write prompt can read as waiting.
export function lastTurn(text: string): Kind {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue
    let d
    try {
      d = JSON.parse(line)
    } catch (e) {
      continue // the line being written as this was read
    }
    if (d.isMeta || d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue
    const message = d.message
    const content = message?.content
    if (d.type === 'assistant') {
      if (message?.stop_reason !== 'tool_use' && message?.stop_reason != null) return 'done'
      const call = Array.isArray(content) ? content.filter(block => block?.type === 'tool_use').pop() : undefined
      if (call && ASKS.has(call.name)) return 'ask'
      return call && INSTANT.has(call.name) ? 'instant' : 'running'
    }
    const first = Array.isArray(content) ? content[0] : content
    const said: unknown = typeof first === 'string' ? first : first?.text
    if (typeof said === 'string' && (said.startsWith('<local-command') || said.startsWith('<command-'))) continue
    return typeof said === 'string' && said.startsWith('[Request interrupted') ? 'done' : 'running'
  }
  return 'done'
}

// When the turn in flight began: the timestamp of the last real prompt, meaning a user
// message that is not a tool result, a slash-command echo, a meta row or a subagent row. A
// turn is a prompt followed by the assistant's calls and their results, so the first such
// message found walking back from the end is the one that started it.
export function turnStartedAt(text: string): number | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"type":"user"')) continue
    let d
    try {
      d = JSON.parse(line)
    } catch (e) {
      continue // the line being written as this was read
    }
    if (d.type !== 'user' || d.isMeta || d.isSidechain) continue
    const content = d.message?.content
    const first = Array.isArray(content) ? content[0] : content
    if (first?.type === 'tool_result') continue
    const said: unknown = typeof first === 'string' ? first : first?.text
    if (typeof said === 'string' && (said.startsWith('<local-command') || said.startsWith('<command-'))) continue
    const at = Date.parse(d.timestamp)
    return Number.isNaN(at) ? undefined : at
  }
  return undefined
}

// When the session last ran: the timestamp of its last real message, a prompt, a reply or a
// tool result. Opening a session writes other rows to its transcript (hooks, snapshots,
// titles) and so moves the file's modified time without anything having run; those rows are
// not messages and are skipped, as are slash-command echoes, meta rows and subagent rows.
export function lastRunAt(text: string): number | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue
    let d
    try {
      d = JSON.parse(line)
    } catch (e) {
      continue // the line being written as this was read
    }
    if (d.isMeta || d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue
    if (d.type === 'user') {
      const content = d.message?.content
      const first = Array.isArray(content) ? content[0] : content
      const said: unknown = typeof first === 'string' ? first : first?.text
      if (typeof said === 'string' && (said.startsWith('<local-command') || said.startsWith('<command-'))) continue
    }
    const at = Date.parse(d.timestamp)
    if (!Number.isNaN(at)) return at
  }
  return undefined
}

// How long a turn has run, as the card says it: 45s, 2m 14s, 1h 5m.
export function fmtElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

// Waiting needs no time limit: it lasts until the person answers. Running does, since an
// abandoned turn leaves the same tail as a live one.
export function statusOf(kind: Kind, idleMs: number): Status {
  if (kind === 'ask' || (kind === 'instant' && idleMs >= PROMPT_MS)) return 'waiting'
  return (kind === 'running' || kind === 'instant') && idleMs <= RUN_MS ? 'running' : 'done'
}

export const stateOf = (ageMs: number, status: Row['status']): State =>
  status === 'waiting' ? 'waiting' : status === 'running' ? 'working' : status === 'done' && ageMs < 600_000 ? 'recent' : 'idle'

export const fmtSize = (bytes: number) =>
  bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`

// Only a session with a real title is listed. One with no title is a headless run
// (claude -p, an SDK call) or a transcript too big to read (over 4 MiB); showing it as an
// id would be noise. A transcript the desktop app has no record of is listed only if it
// did not start in the desktop app: there it is an ancestor or a deleted session.
// ponytail: a long terminal session over 4 MiB with no record is not listed; read its head
// through $.process.run if that bites.
export function buildRows(entries: Entry[], now: number, currentId: string): Row[] {
  return entries
    .filter(e => {
      const age = now - e.ranAt
      const listed = age <= OFFLINE_MS || (e.status === 'waiting' && age <= WAIT_MAX_MS)
      const real = e.hasRecord || e.entrypoint !== 'claude-desktop'
      return listed && !e.archived && real && e.title !== undefined
    })
    // newest first; the session the person is in keeps its place by time
    .sort((a, b) => b.ranAt - a.ranAt)
    .map(e => ({
      id: e.id,
      title: e.title ?? '',
      folder: folderOf(e.cwd, e.dir),
      ranAt: e.ranAt,
      size: e.size,
      model: e.model && shortModel(e.model),
      effort: e.effort,
      appId: e.appId,
      // only a running session has a turn in flight to time
      startedAt: e.status === 'running' ? e.startedAt : undefined,
      // past the window and not waiting on the person: offline
      status: now - e.ranAt > WINDOW_MS && e.status !== 'waiting' ? 'offline' : (e.status ?? 'done'),
      isCurrent: e.id === currentId,
    }))
}
