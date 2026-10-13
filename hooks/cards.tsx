import { CardView, SECTION } from './card-view'
import { WINDOW_MS } from './rows'
import type { Folds, Row } from '../types'

const TITLE: Record<Row['status'], string> = {
  waiting: 'Waiting for response',
  running: 'Working now',
  done: 'Recent',
  offline: 'Offline - Last 5 Hour',
}

const sessions = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`

// `ui` is the surface's element table from $.ui.resolve(e); drawing lives apart from
// the scan so the tree can be mounted in a test without any files. `dark` says the theme can
// carry the card tints;
// `folds` names the sections whose cards are hidden, and pressing a section's arrow calls
// `onToggle` with it.
export function Cards(
  { Box, Text, Button, Client }: { Box: any; Text: any; Button: any; Client?: any },
  list: Row[],
  now: number,
  dark: boolean,
  folds: Folds,
  onToggle: (section: Row['status']) => void,
) {
  const waiting = list.filter(r => r.status === 'waiting')
  const working = list.filter(r => r.status === 'running')
  const rest = list.filter(r => r.status === 'done')
  const offline = list.filter(r => r.status === 'offline')
  // the header counts the last hour only; a waiting session older than that has its own section
  const inHour = list.filter(r => now - r.ranAt <= WINDOW_MS).length

  // A card is a region of its own where the surface can draw one (the terminal and the
  // desktop; the others have no such element): it turns its own spinner, so a running session
  // never repaints the pane and its fold arrows. It can be clicked anywhere to open its session
  // in the app when the session has an app id to open, except the one the person is already in:
  // clicking it would open what is open. The card's drawing is the same either way; without
  // regions it is drawn still.
  const card = (r: Row) =>
    Client ? (
      <Client key={`card-${r.id}`} module="./card-client.tsx" width="100%" props={{ row: r, now, dark, clickable: Boolean(r.appId) && !r.isCurrent }} />
    ) : (
      CardView({ Box, Text }, r, now, 0, dark)
    )

  // A section: its header, and under it its cards unless it is folded. The header is bold and
  // in the section's colour, like every other. A Button cannot hold styled text in this
  // build (a label, one string, no more), so the control that folds is an arrow in front of
  // the header and not the header text itself.
  // Working now never folds: it is the section to watch, so it has no arrow, and any fold
  // saved for it is ignored (it could not be undone). Its header sits where the others' text
  // does: the one-column padding, the arrow's column, and the gap.
  const section = (status: Row['status'], items: Row[]) => {
    const foldable = status !== 'running'
    const folded = foldable && folds[status] === true

    return [
      <Box key={`${status}-header`} gap={1} paddingLeft={foldable ? 1 : 3}>
        {foldable && <Button key={`${status}-toggle`} plain label={folded ? '▸' : '▾'} onPress={() => onToggle(status)} />}
        <Text bold color={SECTION[status]}>
          {`${TITLE[status]} · ${sessions(items.length)}`}
        </Text>
      </Box>,
      ...(folded ? [] : items.map(card)),
    ]
  }
  // Recent has no header of its own while it is the only section; but a folded one keeps it,
  // or its cards would vanish with nothing to open them again
  const recentHeader = rest.length > 0 && (waiting.length > 0 || working.length > 0 || offline.length > 0 || folds.done === true)

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between" gap={1} paddingX={1}>
        <Text bold wrap="truncate-end">
          Sessions in the last hour
        </Text>
        <Text dimColor>{sessions(inHour)}</Text>
      </Box>
      {rest.length + working.length + waiting.length === 0 && (
        <Box paddingX={1}>
          <Text dimColor>Nothing active in the last hour.</Text>
        </Box>
      )}
      {waiting.length > 0 && section('waiting', waiting)}
      {working.length > 0 && section('running', working)}
      {recentHeader ? section('done', rest) : rest.map(card)}
      {offline.length > 0 && section('offline', offline)}
    </Box>
  )
}
