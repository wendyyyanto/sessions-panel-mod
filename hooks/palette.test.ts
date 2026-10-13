import { test, expect } from 'claude-code/testing'

import { CLAUDE, ROLE, wash } from './palette'

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

test('the palette is made of valid colours, and each role has a colour of its own', () => {
  for (const hex of Object.values(CLAUDE)) {
    expect(hex.length).toBe(7)
    expect(hex[0]).toBe('#')
    expect(channels(hex).every(channel => channel >= 0 && channel <= 255)).toBe(true)
  }
  // every role is a colour of the Claude palette
  const palette = new Set<string>(Object.values(CLAUDE))
  expect(Object.values(ROLE).every(hex => palette.has(hex))).toBe(true)
  // and no two roles share one, so nothing is told apart only by shade
  expect(new Set(Object.values(ROLE)).size).toBe(Object.values(ROLE).length)
})

test('there is no colour for the session the person is in: it takes its section\'s', () => {
  expect('current' in ROLE).toBe(false)
})

test('work in progress is Claude\'s main brand orange, and nothing else is', () => {
  expect(ROLE.running).toBe('#D97757')
  expect(ROLE.running).toBe(CLAUDE.clay)
  const others = Object.entries(ROLE).filter(([role]) => role !== 'running')
  expect(others.some(([, hex]) => hex === CLAUDE.clay)).toBe(false)
})

test('wash: a faint, repeatable tint of a palette colour over the dark background', () => {
  expect(wash(ROLE.running)).toBe('#332723')
  expect(wash(ROLE.waiting)).toBe('#302529')
  expect(wash(ROLE.done)).toBe('#252b31')
  expect(wash(ROLE.offline)).toBe('#292928')
  // dark, and with little spread between its channels, so it never competes with the text
  for (const role of [ROLE.waiting, ROLE.running, ROLE.done, ROLE.offline]) {
    const [r = 0, g = 0, b = 0] = channels(wash(role))
    expect(Math.max(r, g, b)).toBeLessThan(0x38)
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0x18)
  }
  // a stronger amount moves toward the colour, no amount leaves the background
  expect(wash(CLAUDE.clay, 0)).toBe('#1c1c1c')
  expect(wash(CLAUDE.clay, 1)).toBe(CLAUDE.clay.toLowerCase())
  // the four sections' tints are four different fills
  expect(new Set([ROLE.waiting, ROLE.running, ROLE.done, ROLE.offline].map(c => wash(c))).size).toBe(4)
})
