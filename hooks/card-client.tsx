import type { ClientModule, JsonValue } from 'claude-code'

import { CardView } from './card-view'
import type { Row } from '../types'

type CardProps = { row: Row; now: number; frame: number; dark: boolean }

// The instances that have a button down inside them: a click is a press and a release both
// over the card, so a release after dragging off it does nothing.
const pressed = new Set<string>()

// A session's card as a region that can be clicked anywhere on it. It draws the same card the
// pane draws elsewhere; the click is told to the plugin as a message, which decides what to
// open from the rows it holds. Nothing but the fact of the click leaves this module.
const SessionCard: ClientModule<JsonValue> = (raw, surface) => {
  const { row, now, frame, dark } = raw as unknown as CardProps
  surface.onPointer(event => {
    if (event.type === 'down' && event.button !== 'right') pressed.add(row.id)
    else if (event.type === 'leave') pressed.delete(row.id)
    else if (event.type === 'up') {
      // before its first layout a region reports no size, and the release is then taken as inside
      const inside =
        event.x >= 0 && event.y >= 0 && (surface.columns === 0 || event.x < surface.columns) && (surface.rows === 0 || event.y < surface.rows)
      if (pressed.delete(row.id) && inside) surface.post({ open: true })
    }
  })

  return CardView(surface.elements, row, now, frame, dark, true)
}

export default SessionCard
