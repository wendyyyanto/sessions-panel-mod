export type Row = {
  id: string
  title: string
  folder: string
  // when the session last ran (ms since the epoch): its last real prompt or reply, never
  // the transcript's modified time, which merely opening a session also moves
  ranAt: number
  size: number
  // the app's own id for the session (local_...), when it has one: what a deep link opens it by
  appId?: string
  model?: string
  // how much thinking the session is set to use: low, medium, high, ...
  effort?: string
  // when the turn in flight began (ms since the epoch), for a running session whose
  // transcript could be read; the card counts up from it
  startedAt?: number
  // waiting: a question or approval is open for the person; running: a turn is in flight;
  // offline: past the one-hour window and not waiting
  status: 'waiting' | 'running' | 'done' | 'offline'
  isCurrent: boolean
}

// The sections folded away (by their status); also kept in $.store so it outlives the session
export type Folds = Partial<Record<Row['status'], boolean>>

declare module 'claude-code' {
  interface PluginState {
    'recent-sessions': { rows: Row[]; frame: number; collapsed: Folds }
  }
}
