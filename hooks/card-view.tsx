import { ROLE, wash } from './palette'
import { ago, fmtElapsed, fmtSize, stateOf } from './rows'
import type { State } from './rows'
import type { Row } from '../types'

// One colour per kind of information, all from the Claude palette (see palette.ts) and kept
// to a few so the pane stays calm: the title is plain text, the project heather (cactus for
// No Project), the model kraft, the size oat, and the status line takes the colour of its
// section. Work in progress is Claude's orange.
const TONE: Record<State, string> = {
  waiting: ROLE.waiting,
  working: ROLE.running,
  recent: ROLE.done,
  idle: ROLE.offline,
}
// The card border of each section.
export const SECTION: Record<Row['status'], string> = {
  waiting: ROLE.waiting,
  running: ROLE.running,
  done: ROLE.done,
  offline: ROLE.offline,
}
// A faint wash for each section's cards, a few shades off the pane's own dark background:
// enough to tell the sections apart, not enough to compete with the text or the borders.
// These are raw dark tints, so they are only used on a dark theme; on a light one the
// cards keep their coloured borders and nothing else.
const TINT: Record<Row['status'], string> = {
  waiting: wash(ROLE.waiting),
  running: wash(ROLE.running),
  done: wash(ROLE.done),
  offline: wash(ROLE.offline),
}
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// One session's card. `ui` is an element table (the hooks module's `$.ui.resolve(e)`, or a
// surface module's `surface.elements`), so the same drawing serves a card the pane draws
// itself and one a Client region draws to be clicked. `fill` stretches it across a region
// that is not already as wide as its parent.
export function CardView(
  { Box, Text }: { Box: any; Text: any },
  r: Row,
  now: number,
  frame: number,
  dark: boolean,
  fill = false,
) {
  const age = now - r.ranAt
  const state = stateOf(age, r.status)
  const tone = TONE[state]
  const glyph = state === 'waiting' ? '◆' : state === 'working' ? SPINNER[frame % SPINNER.length] : state === 'idle' ? '○' : '●'
  const label =
    state === 'waiting'
      ? `needs your reply · ${ago(age)}`
      : state === 'working'
        ? r.startedAt === undefined
          ? 'running'
          : `running · ${fmtElapsed(now - r.startedAt)}`
        : age < 60_000
          ? 'just now'
          : `${ago(age)} ago`

  // a card's border is its section's colour, the session the person is in included: that one
  // is told apart by its heavier line and by leading its section, not by a colour of its own.
  // Under the pointer a card keeps that same colour, so hovering never recolours it
  const border = SECTION[r.status]

  return (
    <Box
      key={r.id}
      flexDirection="column"
      borderStyle={r.isCurrent ? 'bold' : 'round'}
      borderColor={border}
      hover={{ borderColor: border }}
      paddingX={1}
      {...(fill ? { width: '100%' } : {})}
      {...(dark ? { backgroundColor: TINT[r.status] } : {})}
    >
      <Box gap={1}>
        <Text color={tone}>{glyph}</Text>
        <Text bold dimColor={r.status === 'offline'} wrap="truncate-end">
          {r.title}
        </Text>
      </Box>
      <Box justifyContent="space-between" gap={1}>
        <Text color={r.folder === 'No Project' ? ROLE.noProject : ROLE.project} wrap="truncate-end">
          {r.folder}
        </Text>
        {r.model && (
          <Text>
            <Text color={ROLE.model}>{r.model}</Text>
            {r.effort && <Text dimColor>{` · ${r.effort}`}</Text>}
          </Text>
        )}
      </Box>
      <Box justifyContent="space-between">
        <Text color={tone}>{label}</Text>
        <Text color={ROLE.size}>{fmtSize(r.size)}</Text>
      </Box>
    </Box>
  )
}
