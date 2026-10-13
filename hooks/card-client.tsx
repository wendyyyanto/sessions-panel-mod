import type { ClientModule, JsonValue } from 'claude-code'

import { CardView } from './card-view'
import type { Row } from '../types'

type CardProps = { row: Row; now: number; dark: boolean; clickable: boolean }
// the spinner's step, and the time it has counted on since the pane last handed it `now`
type Spin = { frame: number; base: number; ticks: number }

// A spinner step redraws only this card's region, never the pane around it, so the section
// arrows stay still however fast it turns.
export const SPIN_MS = 100

// The instances that have a button down inside them: a click is a press and a release both
// over the card, so a release after dragging off it does nothing.
const pressed = new Set<string>()
// each instance's latest props, for its timer, which was started with the first ones
const latest = new WeakMap<object, CardProps>()

// A session's card as a region of its own. It draws the same card the pane draws elsewhere,
// and while its session runs it turns its spinner and counts up its time by itself. Where it
// can be opened, a click is told to the plugin as a message, which decides what to open from
// the rows it holds. Nothing but the fact of the click leaves this module.
const SessionCard: ClientModule<JsonValue, Spin> = (raw, surface) => {
  const props = raw as unknown as CardProps
  const { row, now, dark, clickable } = props
  if (!latest.has(surface)) {
    surface.every(SPIN_MS, () => {
      const p = latest.get(surface)
      if (p?.row.status !== 'running') return
      const s = surface.state
      // a new `now` from the pane starts the count again from it
      surface.setState({ frame: (s?.frame ?? 0) + 1, base: p.now, ticks: s?.base === p.now ? s.ticks + 1 : 1 })
    })
  }
  latest.set(surface, props)
  surface.onPointer(event => {
    if (!clickable) return
    if (event.type === 'down' && event.button !== 'right') pressed.add(row.id)
    else if (event.type === 'leave') pressed.delete(row.id)
    else if (event.type === 'up') {
      // before its first layout a region reports no size, and the release is then taken as inside
      const inside =
        event.x >= 0 && event.y >= 0 && (surface.columns === 0 || event.x < surface.columns) && (surface.rows === 0 || event.y < surface.rows)
      if (pressed.delete(row.id) && inside) surface.post({ open: true })
    }
  })
  const s = surface.state
  const ticked = s?.base === now ? s.ticks * SPIN_MS : 0

  return CardView(surface.elements, row, now + ticked, s?.frame ?? 0, dark, true)
}

export default SessionCard
