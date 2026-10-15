import { test, expect, mock } from 'claude-code/testing'

import { CLAUDE, ROLE, wash } from './palette'

const SURFACES = ['terminal', 'desktop'] as const
const SPIN_FIRST = '⠋'

type Child = {
  type?: string
  props?: { key?: string; borderStyle?: string; borderColor?: string; backgroundColor?: string; color?: string; bold?: boolean }
  children?: unknown[]
}

// Every Text in the drawing with the colour it wears, for checking what is coloured how.
const texts = (node: unknown): { text: string; color?: string; bold?: boolean }[] => {
  if (!node || typeof node !== 'object') return []
  const { type, props, children } = node as Child
  const own = type === 'Text' && typeof children?.[0] === 'string' ? [{ text: children[0].trim(), color: props?.color, bold: props?.bold }] : []

  return [...own, ...(children ?? []).flatMap(texts)]
}

// Every colour the drawing names, wherever it sits: text, borders, fills and the hover border.
const paints = (node: unknown): string[] => {
  if (!node || typeof node !== 'object') return []
  const { props, children } = node as Child
  const hover = (node as { hover?: { borderColor?: string } }).hover?.borderColor
  const own = [props?.color, props?.borderColor, props?.backgroundColor, hover].filter((v): v is string => typeof v === 'string')

  return [...own, ...(children ?? []).flatMap(paints)]
}

// A card the person can click is a Client region: the pane's own tree names it but its drawing
// is the card module's. These put each such drawing back where its region sits, so a card reads
// as it does when the pane draws it itself, and look inside the regions when searching.
const expand = async (ui: any, node: unknown): Promise<unknown> => {
  if (!node || typeof node !== 'object') return node
  const n = node as Child
  if (n.type === 'Client') return ui.drawn({ in: n.props?.key })

  return { ...n, children: await Promise.all((n.children ?? []).map(child => expand(ui, child))) }
}
const full = async (ui: any) => expand(ui, await ui.drawn())
const clientKeys = async (ui: any): Promise<string[]> =>
  (((await ui.drawn()) as { children?: Child[] }).children ?? []).filter(c => c?.type === 'Client').map(c => String(c.props?.key))
const find = async (ui: any, query: object) => {
  const own = await ui.find(query)
  if (own) return own
  for (const key of await clientKeys(ui)) {
    const hit = await ui.find({ ...query, in: key })
    if (hit) return hit
  }

  return undefined
}
const findAll = async (ui: any, query: object) => [
  ...(await ui.findAll(query)),
  ...(await Promise.all((await clientKeys(ui)).map(key => ui.findAll({ ...query, in: key })))).flat(),
]
// A click: the button goes down and comes up over the same card.
const click = async (ui: any, key: string, at = { x: 2, y: 1 }) => {
  await ui.pointer({ type: 'down', ...at, button: 'left', in: key })
  await ui.pointer({ type: 'up', ...at, button: 'left', in: key })
}

// What the pane draws, top to bottom: card keys and the text of section headers.
const layout = (tree: unknown) =>
  ((tree as { children: Child[] }).children ?? [])
    .filter(child => child && typeof child === 'object')
    .map(child => child.props?.key ?? (typeof child.children?.[0] === 'string' ? child.children[0].trim() : 'header'))

// Each test scans a faked ~/.claude/projects and desktop-app session index, runs /sessions,
// then draws the pane on every surface. The hooks beneath the plugin run isolated, so
// their fixtures are literals and each test carries its own. The fake clock reads
// 1_000_000_000, so a file's mtime of 1_000_000_000 - n is n milliseconds old.

test('waiting, running and finished sessions each get their section', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  // b2 is the current session and the oldest of the Recent pair: pinned first, but only
  // within its own section
  on('session.id', async () => ({ value: 'b2' }))
  on('config.list', async () => ({ value: [{ key: 'theme', value: 'dark' }] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
  const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
  on('fs.list', async (_$, e) => {
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) {
      return { value: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => file(`local_${n}.json`, 100, 5)) }
    }

    return {
      value: [
        file('a1.jsonl', 2_000_000, 999_990_000), // 10s old, mid-turn
        file('d4.jsonl', 400_000, 999_980_000), // 20s old, mid-turn
        file('w5.jsonl', 300_000, 999_700_000), // 5m old, question open
        file('w6.jsonl', 200_000, 989_200_000), // 3h old, edit approval open
        file('c3.jsonl', 300_000, 999_600_000), // 6m old, turn ended
        file('b2.jsonl', 900_000, 997_600_000), // 40m old, current
        file('arch.jsonl', 5_000, 999_500_000), // archived
        file('stale.jsonl', 5_000, 989_000_000), // 3h old and finished: offline
        file('ancient.jsonl', 5_000, 978_400_000), // 6h old and finished: past the offline window
        file('old.jsonl', 5, 1), // days old
      ],
    }
  })
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string, isArchived: boolean) =>
      JSON.stringify({
        cliSessionId: id,
        // the app's own id; w6's is not a valid one and stale has none
        sessionId: id === 'w6' ? '../evil' : id === 'stale' ? undefined : `local_${id}`,
        title,
        // a1 was started without a project: the app ran it in a throwaway scratch folder
        cwd: id === 'a1' ? 'C:/Users/u/AppData/Roaming/Claude/scratch-workspaces/x/y/scratch-2026-10-12-aaaaaa' : `D:/Projects/${id}-dir`,
        model: 'claude-opus-5-5',
        effort: id === 'b2' ? 'medium' : 'high',
        isArchived,
      })
    const call = (name: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name }] } })
    if (e.path.endsWith('local_1.json')) return { value: record('a1', 'Working one', false) }
    if (e.path.endsWith('local_2.json')) return { value: record('b2', 'Idle one', false) }
    if (e.path.endsWith('local_3.json')) return { value: record('arch', 'Archived one', true) }
    if (e.path.endsWith('local_4.json')) return { value: record('c3', 'Done one', false) }
    if (e.path.endsWith('local_5.json')) return { value: record('d4', 'Second runner', false) }
    if (e.path.endsWith('local_6.json')) return { value: record('w5', 'Question one', false) }
    if (e.path.endsWith('local_7.json')) return { value: record('w6', 'Edit one', false) }
    if (e.path.endsWith('local_8.json')) return { value: record('stale', 'Offline one', false) }
    if (e.path.endsWith('local_9.json')) return { value: record('ancient', 'Too old one', false) }
    if (e.path.endsWith('a1.jsonl') || e.path.endsWith('d4.jsonl')) {
      // the prompt that began the turn, then its tool call: a1's prompt was 2m 14s ago, d4's 45s
      const began = new Date(1_000_000_000 - (e.path.endsWith('a1.jsonl') ? 134_000 : 45_000)).toISOString()
      const prompt = JSON.stringify({ type: 'user', timestamp: began, message: { role: 'user', content: 'do the thing' } })

      // and the call itself, a1's 10s ago and d4's 20s ago, which is when each last ran
      const called = new Date(1_000_000_000 - (e.path.endsWith('a1.jsonl') ? 10_000 : 20_000)).toISOString()
      const tool = JSON.stringify({
        type: 'assistant',
        timestamp: called,
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] },
      })

      return { value: [prompt, tool].join(String.fromCharCode(10)) }
    }
    if (e.path.endsWith('w5.jsonl')) return { value: call('AskUserQuestion') }
    if (e.path.endsWith('w6.jsonl')) return { value: call('Edit') }
    if (e.path.endsWith('c3.jsonl')) {
      return { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) }
    }

    return { value: '{"type":"last-prompt"}' }
  })

  const ran = await eng.command.run({ command: 'sessions', args: '' } as never)
  expect(JSON.stringify(ran)).toContain('7 listed')

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    for (const text of [
      'Waiting for response · 2 sessions',
      'Working now · 2 sessions',
      'Recent · 2 sessions',
      'Sessions in the last hour',
      '5 sessions',
      'Offline - Last 5 Hour · 1 session',
      'Offline one',
      '3h ago',
      'Question one',
      'Edit one',
      'Working one',
      'Second runner',
      'Idle one',
      'Done one',
      'needs your reply · 5m',
      'needs your reply · 3h',
      '6m ago',
      '40m ago',
    ]) {
      expect(await find(ui, { text })).toBeDefined()
    }
    // attention first; newest first inside a section; the current session leads Recent
    // despite being the older one; a 3h-old waiting session is kept past the window while
    // a 3h-old finished one is offline, listed last; the header counts the last hour only
    expect(layout(await full(ui))).toEqual([
      'header',
      'waiting-header',
      'w5',
      'w6',
      'running-header',
      'a1',
      'd4',
      'done-header',
      'b2',
      'c3',
      'offline-header',
      'stale',
    ])
    // a scratch-folder session reads "No Project", never its throwaway folder name; the
    // effort sits next to the model, whatever it is set to
    expect(await find(ui, { text: 'No Project' })).toBeDefined()
    expect(await find(ui, { text: 'scratch-2026-10-12-aaaaaa' })).toBeUndefined()
    expect(await find(ui, { text: 'w5-dir' })).toBeDefined()
    expect(await find(ui, { text: 'opus-5-5 · high' })).toBeDefined()
    expect(await find(ui, { text: 'opus-5-5 · medium' })).toBeDefined()
    // spinners and "running" only on the running cards; a diamond and no spinner on waiting ones
    expect(await findAll(ui, { type: 'Text', text: SPIN_FIRST })).toHaveLength(2)
    expect(await findAll(ui, { type: 'Text', text: 'running' })).toHaveLength(2)
    // each one says how long its turn has been going, not just that it is running
    expect(await find(ui, { type: 'Text', text: 'running · 2m 14s' })).toBeDefined()
    expect(await find(ui, { type: 'Text', text: 'running · 45s' })).toBeDefined()
    expect(await findAll(ui, { type: 'Text', text: '◆' })).toHaveLength(2)
    // the filled dot is only the open session's (b2); the other finished and offline cards get a hollow one
    expect(await findAll(ui, { type: 'Text', text: '●' })).toHaveLength(1)
    expect(await findAll(ui, { type: 'Text', text: '○' })).toHaveLength(2)
    // the heavy border marks the current session; there is no header text on any card
    const cards = ((await full(ui)) as unknown as { children: Child[] }).children.filter(c => c?.props?.borderStyle)
    // each section has its own border colour; the current session (b2) has its section's, in a
    // heavier line, and no colour of its own
    expect(cards.map(c => [c.props?.key, c.props?.borderStyle, c.props?.borderColor])).toEqual([
      ['w5', 'round', ROLE.waiting],
      ['w6', 'round', ROLE.waiting],
      ['a1', 'round', ROLE.running],
      ['d4', 'round', ROLE.running],
      ['b2', 'bold', ROLE.done],
      ['c3', 'round', ROLE.done],
      ['stale', 'round', ROLE.offline],
    ])
    // under the pointer a card keeps its own border colour: the hover colour of every card
    // is its border colour, whichever section it is in and whether or not it is the current one
    const hoverOf = (card: Child) => (card as unknown as { hover?: { borderColor?: string } }).hover?.borderColor
    expect(cards.map(hoverOf)).toEqual(cards.map(c => c.props?.borderColor))
    expect(new Set(cards.map(hoverOf)).size).toBe(4)
    // on a dark theme every section also tints its cards, a different fill each
    expect(cards.map(c => [c.props?.key, c.props?.backgroundColor])).toEqual([
      ['w5', wash(ROLE.waiting)],
      ['w6', wash(ROLE.waiting)],
      ['a1', wash(ROLE.running)],
      ['d4', wash(ROLE.running)],
      ['b2', wash(ROLE.done)],
      ['c3', wash(ROLE.done)],
      ['stale', wash(ROLE.offline)],
    ])
    // ...and the tints stay faint: dark, and with little spread between their channels, so
    // they tell the sections apart without becoming a fill that competes with the text
    for (const card of cards) {
      const hex = String(card.props?.backgroundColor)
      const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
      expect(Math.max(...channels)).toBeLessThan(0x38)
      expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(0x18)
    }
    // the four sections' tints are four different colours
    expect(new Set(cards.map(c => c.props?.backgroundColor)).size).toBe(4)
    // every card is a region of its own, so a running one turns its spinner without repainting
    // the pane (which ones open anything is tested with the clicks)
    expect(await clientKeys(ui)).toEqual(['card-w5', 'card-w6', 'card-a1', 'card-d4', 'card-b2', 'card-c3', 'card-stale'])
    // every colour on screen is a Claude palette colour, or a faint wash of one for a card fill
    const allowed = new Set<string>([...Object.values(CLAUDE), ...[ROLE.waiting, ROLE.running, ROLE.done, ROLE.offline].map(c => wash(c))])
    expect(paints(await full(ui)).filter(c => !allowed.has(c))).toEqual([])
    // in particular no white border on the session the person is in
    expect(paints(await full(ui)).some(c => c.toLowerCase() === '#faf9f5' || c.toLowerCase() === '#ffffff')).toBe(false)
    // the project name is always coloured (teal for No Project, lavender otherwise), and the
    // size has a colour of its own, none shared with the model, project or status
    const coloured = texts(await full(ui))
    expect(coloured.find(t => t.text === 'No Project')?.color).toBe(ROLE.noProject)
    expect(coloured.find(t => t.text === 'w5-dir')?.color).toBe(ROLE.project)
    expect(coloured.find(t => t.text === 'opus-5-5')?.color).toBe(ROLE.model)
    const sizes = coloured.filter(t => t.text.endsWith(' KB') || t.text.endsWith(' MB'))
    expect(sizes).toHaveLength(7)
    expect(sizes.every(t => t.color === ROLE.size)).toBe(true)
    // every section header is bold and wears the colour of its cards, Offline included
    const headers = coloured.filter(t => t.text.includes(' · ') && t.text.includes('session'))
    expect(headers.map(t => [t.text, t.color, t.bold])).toEqual([
      ['Waiting for response · 2 sessions', ROLE.waiting, true],
      ['Working now · 2 sessions', ROLE.running, true],
      ['Recent · 2 sessions', ROLE.done, true],
      ['Offline - Last 5 Hour · 1 session', ROLE.offline, true],
    ])
    // Waiting, Recent and Offline each have an arrow button, pointing down while open; Working
    // now has none and cannot fold
    expect(await findAll(ui, { type: 'Button', text: '▾' })).toHaveLength(3)
    expect(await find(ui, { key: 'running-toggle' })).toBeUndefined()
    expect(await find(ui, { text: 'YOU ARE HERE' })).toBeUndefined()
    for (const text of ['Archived one', 'Too old one']) {
      expect(await find(ui, { text })).toBeUndefined()
    }
  }
})

test('a session whose turn ended drops out of Working now into the default list', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    // written 10 seconds ago, so it is warm: its last message decides
    return { value: [file('a1.jsonl', 2_000_000, 999_990_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', title: 'Finished one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    // no section headers, no spinner: just the card, as done
    expect(layout(await full(ui))).toEqual(['header', 'a1'])
    expect(await find(ui, { text: 'Finished one' })).toBeDefined()
    expect(await find(ui, { text: '1 session' })).toBeDefined()
    expect(await find(ui, { text: '1 sessions' })).toBeUndefined()
    expect(await find(ui, { text: 'just now' })).toBeDefined()
    expect(await find(ui, { text: 'Working now' })).toBeUndefined()
    expect(await find(ui, { text: SPIN_FIRST })).toBeUndefined()
    expect(await find(ui, { text: 'running' })).toBeUndefined()
  }
})

test('a session leaves Waiting for response once the person answers', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    // written 5 minutes ago and 3 hours ago would both be waiting if the question were open
    return { value: [file('a1.jsonl', 2_000_000, 999_700_000)] }
  })
  // the question was asked, answered, and the turn then ended
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', title: 'Answered one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : {
          value: [
            { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } },
            { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'The user answered: "A"' }] } },
            { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
          ]
            .map(line => JSON.stringify(line))
            .join('\n'),
        },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    expect(layout(await full(ui))).toEqual(['header', 'a1'])
    expect(await find(ui, { text: 'Waiting for response' })).toBeUndefined()
    expect(await find(ui, { text: '◆' })).toBeUndefined()
    expect(await find(ui, { text: '5m ago' })).toBeDefined()
    expect(await find(ui, { text: '1 session' })).toBeDefined()
  }
})

test('the spinner advances while a session is running', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => e)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('a1.jsonl', 2_000_000, 999_999_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', title: 'Runner', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : {
          // the turn began 5 seconds before the mocked clock's start
          value: [
            { type: 'user', timestamp: new Date(1_000_000_000 - 5_000).toISOString(), message: { role: 'user', content: 'go' } },
            { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
          ]
            .map(line => JSON.stringify(line))
            .join(String.fromCharCode(10)),
        },
  )

  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)
  const ui = await eng.ui.mount({ plugin: 'recent-sessions', surface: 'terminal', component: 'Pane', requestId: 'recent-sessions', props: {} as never })
  expect(await find(ui, { text: 'Working now · 1 session' })).toBeDefined()
  expect(await find(ui, { type: 'Text', text: SPIN_FIRST })).toBeDefined()
  const pane = JSON.stringify(await ui.drawn())

  // one spinner step later (100ms), on the card's own frame clock
  await ui.advance(110)
  expect(await find(ui, { type: 'Text', text: '⠙' })).toBeDefined()
  expect(await find(ui, { type: 'Text', text: SPIN_FIRST })).toBeUndefined()

  // the time counts up with the clock: five seconds in, then two more seconds on
  expect(await find(ui, { type: 'Text', text: 'running · 5s' })).toBeDefined()
  await ui.advance(2_000)
  expect(await find(ui, { type: 'Text', text: 'running · 7s' })).toBeDefined()
  expect(await find(ui, { type: 'Text', text: 'running · 5s' })).toBeUndefined()
  // all of that turned inside the card: the pane around it, fold arrows and all, is unchanged
  expect(JSON.stringify(await ui.drawn())).toBe(pane)
})

test('with nothing in the last hour, only the Offline section lists sessions', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5), file('local_2.json', 100, 5)] }

    // an hour and a half and two hours old: past the hour, inside the five
    return { value: [file('a1.jsonl', 2_000_000, 994_600_000), file('a2.jsonl', 1_000_000, 992_800_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', title: 'Gone quiet', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : e.path.endsWith('local_2.json')
        ? { value: JSON.stringify({ cliSessionId: 'a2', title: 'Gone quiet too', cwd: 'D:/Projects/y', model: 'claude-opus-5-5', isArchived: false }) }
        : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    expect(await find(ui, { text: 'Sessions in the last hour' })).toBeDefined()
    expect(await find(ui, { text: '0 sessions' })).toBeDefined()
    expect(await find(ui, { text: 'Nothing active in the last hour.' })).toBeDefined()
    // the count carries the word, plural for two
    expect(await find(ui, { text: 'Offline - Last 5 Hour · 2 sessions' })).toBeDefined()
    expect(await find(ui, { text: 'Gone quiet' })).toBeDefined()
    expect(await find(ui, { text: 'Gone quiet too' })).toBeDefined()
    expect(await find(ui, { text: '1h ago' })).toBeDefined()
    expect(await find(ui, { text: '2h ago' })).toBeDefined()
    // the Recent subheading only appears beside another section's cards
    expect(await find(ui, { text: 'Recent' })).toBeUndefined()
  }
})

test('a resumed session is listed once, and sessions without a real title are not listed', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return {
      value: [
        file('a1.jsonl', 800_000, 999_700_000), // the session's newest transcript: 5m old
        file('p0.jsonl', 1_100_000, 998_800_000), // an earlier transcript of the same session
        file('orphan.jsonl', 300_000, 998_500_000), // started in the desktop app, no record
        file('term.jsonl', 300_000, 998_400_000), // a terminal session, no record
        file('blank.jsonl', 300_000, 999_000_000), // a headless run: no title
        file('big.jsonl', 7_000_000, 999_100_000), // too big to read: no title
      ],
    }
  })
  on('fs.read', async (_$, e) => {
    const lines = (title: string, entrypoint: string) =>
      [
        { type: 'custom-title', customTitle: title },
        { type: 'user', cwd: 'D:/Projects/x', entrypoint, message: { role: 'user', content: 'hi' } },
        { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
      ]
        .map(line => JSON.stringify(line))
        .join('\n')
    if (e.path.endsWith('local_1.json')) {
      // the session's record: its current transcript, and the earlier one it was resumed from
      return {
        value: JSON.stringify({ cliSessionId: 'a1', title: 'Main session', cwd: 'D:/Projects/main', model: 'claude-opus-5-5', isArchived: false, priorCliSessionIds: ['p0'] }),
      }
    }
    if (e.path.endsWith('p0.jsonl')) return { value: lines('Main session', 'claude-desktop') }
    if (e.path.endsWith('orphan.jsonl')) return { value: lines('Orphan session', 'claude-desktop') }
    if (e.path.endsWith('term.jsonl')) return { value: lines('Terminal session', 'cli') }
    if (e.path.endsWith('big.jsonl')) return { deny: 'too large' }
    if (e.path.endsWith('a1.jsonl')) return { value: lines('Main session', 'claude-desktop') }

    return { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) }
  })

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    // the resumed session once, not twice; a terminal session without a record stays
    expect(layout(await full(ui))).toEqual(['header', 'a1', 'term'])
    expect(await findAll(ui, { type: 'Text', text: 'Main session' })).toHaveLength(1)
    expect(await find(ui, { text: 'Terminal session' })).toBeDefined()
    expect(await find(ui, { text: '2 sessions' })).toBeDefined()
    // no orphaned desktop transcript, and nothing titled with an id: neither the headless
    // run nor the unreadable one is drawn
    expect(await find(ui, { text: 'Orphan session' })).toBeUndefined()
    expect(await find(ui, { text: 'blank' })).toBeUndefined()
    expect(await find(ui, { text: 'big' })).toBeUndefined()
    expect(await find(ui, { text: 'p0' })).toBeUndefined()
  }
})

test('a single session in a section reads as 1 session', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5), file('local_2.json', 100, 5)] }

    // a1 has an open question; b2 finished its turn: one waiting, one recent
    return { value: [file('a1.jsonl', 2_000_000, 999_700_000), file('b2.jsonl', 900_000, 999_600_000)] }
  })
  // the question is still open: the transcript ends on the unanswered call
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string) =>
      JSON.stringify({ cliSessionId: id, title, cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false })
    if (e.path.endsWith('local_1.json')) return { value: record('a1', 'Asked one') }
    if (e.path.endsWith('local_2.json')) return { value: record('b2', 'Finished one') }
    if (e.path.endsWith('b2.jsonl')) {
      return { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) }
    }

    return {
      value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } }),
    }
  })

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    expect(await find(ui, { text: 'Waiting for response · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Recent · 1 session' })).toBeDefined()
    expect(await find(ui, { text: '1 sessions' })).toBeUndefined()
  }
})

test('on a light theme the cards keep their coloured borders but get no tint', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('config.list', async () => ({ value: [{ key: 'theme', value: 'light' }] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('a1.jsonl', 2_000_000, 999_990_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', title: 'Light one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } }) },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    const cards = ((await full(ui)) as unknown as { children: Child[] }).children.filter(c => c?.props?.borderStyle)
    expect(cards.map(c => [c.props?.key, c.props?.borderColor, c.props?.backgroundColor])).toEqual([['a1', ROLE.running, undefined]])
  }
})

// The four-section fixture of the fold tests: w5 waits on a question, a1 is mid-turn, c3 has
// finished its turn, and o2 and o3 are an hour and a half and two hours old.
test('each section folds on its own arrow, and every choice is remembered', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  // the plugin's store, answered from memory the test can see: the hooks run isolated, so
  // they share it through globalThis, and every write is noted
  const g = globalThis as unknown as { __store?: Record<string, unknown>; __writes?: unknown[] }
  g.__store = {}
  g.__writes = []
  on('store.get', async (_$, e) => ({ value: (globalThis as unknown as { __store: Record<string, unknown> }).__store[e.key] }) as never)
  on('store.set', async (_$, e) => {
    const shared = globalThis as unknown as { __store: Record<string, unknown>; __writes: unknown[] }
    shared.__store[e.key] = e.value
    shared.__writes.push([e.key, e.value])

    return { value: undefined } as never
  })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [1, 2, 3, 4, 5].map(n => file(`local_${n}.json`, 100, 5)) }

    return {
      value: [
        file('w5.jsonl', 300_000, 999_700_000),
        file('a1.jsonl', 2_000_000, 999_990_000),
        file('c3.jsonl', 300_000, 999_600_000),
        file('o2.jsonl', 900_000, 994_600_000),
        file('o3.jsonl', 900_000, 992_800_000),
      ],
    }
  })
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string) =>
      JSON.stringify({ cliSessionId: id, title, cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false })
    const call = (name: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name }] } })
    if (e.path.endsWith('local_1.json')) return { value: record('w5', 'Asked one') }
    if (e.path.endsWith('local_2.json')) return { value: record('a1', 'Running one') }
    if (e.path.endsWith('local_3.json')) return { value: record('c3', 'Finished one') }
    if (e.path.endsWith('local_4.json')) return { value: record('o2', 'Offline one') }
    if (e.path.endsWith('local_5.json')) return { value: record('o3', 'Offline two') }
    if (e.path.endsWith('w5.jsonl')) return { value: call('AskUserQuestion') }
    if (e.path.endsWith('a1.jsonl')) return { value: call('Bash') }

    return { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) }
  })

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    const cardKeys = async () =>
      ((await full(ui)) as unknown as { children: Child[] }).children.filter(c => c?.props?.borderStyle).map(c => c.props?.key)
    const arrows = async (arrow: string) => (await findAll(ui, { type: 'Button', text: arrow })).length
    // the key and the folded sections of the latest write: a section already unfolded by an
    // earlier surface is saved as false, which means the same as absent
    const lastWrite = () => {
      const [key, value] = (g.__writes as [string, Record<string, boolean>][]).at(-1) ?? []

      return [key, Object.fromEntries(Object.entries(value ?? {}).filter(([, folded]) => folded))]
    }
    g.__writes = [] // each surface counts its own writes
    g.__store = {}

    // everything open to begin with: four headers, three arrows, all five cards
    expect(await cardKeys()).toEqual(['w5', 'a1', 'c3', 'o2', 'o3'])
    expect(await arrows('▾')).toBe(3)

    // a press on a section's arrow folds just that section: its cards go, its header (bold,
    // with its count) stays, its arrow turns, the others are untouched, and the choices so far
    // are saved after each press
    await ui.press({ key: 'waiting-toggle' })
    expect(await cardKeys()).toEqual(['a1', 'c3', 'o2', 'o3'])
    expect(await find(ui, { text: 'Waiting for response · 1 session' })).toBeDefined()
    expect(await arrows('▸')).toBe(1)
    expect(lastWrite()).toEqual(['collapsedSections', { waiting: true }])

    await ui.press({ key: 'done-toggle' })
    expect(await cardKeys()).toEqual(['a1', 'o2', 'o3'])
    expect(lastWrite()).toEqual(['collapsedSections', { waiting: true, done: true }])

    await ui.press({ key: 'offline-toggle' })
    // everything that can fold is folded: only the running session's card is left, because
    // Working now has no arrow and stays open
    expect(await cardKeys()).toEqual(['a1'])
    expect(lastWrite()).toEqual(['collapsedSections', { waiting: true, done: true, offline: true }])
    expect(layout(await full(ui))).toEqual(['header', 'waiting-header', 'running-header', 'a1', 'done-header', 'offline-header'])
    expect(await arrows('▸')).toBe(3)
    expect(await arrows('▾')).toBe(0)
    expect(await find(ui, { text: 'Offline - Last 5 Hour · 2 sessions' })).toBeDefined()

    // pressing them again opens each, and the saved choices follow
    for (const section of ['waiting', 'done', 'offline']) await ui.press({ key: `${section}-toggle` })
    expect(await cardKeys()).toEqual(['w5', 'a1', 'c3', 'o2', 'o3'])
    expect(await arrows('▾')).toBe(3)
    expect(lastWrite()).toEqual(['collapsedSections', {}])
    expect(g.__writes).toHaveLength(6)
  }
})

test('saved choices are restored in the next session, including the older Offline-only one', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  // Waiting was folded in an earlier session; an unknown section is ignored, and so is a
  // fold saved for Working now, which cannot fold and so could never be reopened;
  // offlineCollapsed is what the first version saved, before every section could fold
  mock.store(on, { collapsedSections: { waiting: true, bogus: true, running: true }, offlineCollapsed: true })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => e)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [1, 2, 3, 4].map(n => file(`local_${n}.json`, 100, 5)) }

    return {
      value: [
        file('w5.jsonl', 300_000, 999_700_000),
        file('a1.jsonl', 2_000_000, 999_990_000),
        file('c3.jsonl', 300_000, 999_600_000),
        file('o2.jsonl', 900_000, 994_600_000),
      ],
    }
  })
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string) =>
      JSON.stringify({ cliSessionId: id, title, cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false })
    const call = (name: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name }] } })
    if (e.path.endsWith('local_1.json')) return { value: record('w5', 'Asked one') }
    if (e.path.endsWith('local_2.json')) return { value: record('a1', 'Running one') }
    if (e.path.endsWith('local_3.json')) return { value: record('c3', 'Finished one') }
    if (e.path.endsWith('local_4.json')) return { value: record('o2', 'Offline one') }
    if (e.path.endsWith('w5.jsonl')) return { value: call('AskUserQuestion') }
    if (e.path.endsWith('a1.jsonl')) return { value: call('Bash') }

    return { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) }
  })

  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    const cardKeys = ((await full(ui)) as unknown as { children: Child[] }).children.filter(c => c?.props?.borderStyle).map(c => c.props?.key)
    // Waiting (saved) and Offline (the older value) start folded; Working now stays open
    // whatever was saved, and Recent is open
    expect(cardKeys).toEqual(['a1', 'c3'])
    expect((await findAll(ui, { type: 'Button', text: '▸' })).length).toBe(2)
    expect((await findAll(ui, { type: 'Button', text: '▾' })).length).toBe(1)
    expect(await find(ui, { key: 'running-toggle' })).toBeUndefined()
    expect(await find(ui, { text: 'Working now · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Waiting for response · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Offline - Last 5 Hour · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Asked one' })).toBeUndefined()
    expect(await find(ui, { text: 'Offline one' })).toBeUndefined()
  }
})

test('a folded Recent section keeps its header even when it is the only section', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  mock.store(on, { collapsedSections: { done: true } })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => e)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('c3.jsonl', 300_000, 999_600_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'c3', title: 'Finished one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)

  const views = []
  for (const surface of SURFACES) {
    views.push(
      await eng.ui.mount({
        plugin: 'recent-sessions',
        surface,
        component: 'Pane',
        requestId: 'recent-sessions',
        props: {} as never,
      }),
    )
  }
  for (const ui of views) {
    // alone, Recent has no header, but folded it must keep one or its card could not be reopened
    expect(layout(await full(ui))).toEqual(['header', 'done-header'])
    expect(await find(ui, { text: 'Recent · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Finished one' })).toBeUndefined()
  }

  // one press unfolds it, for every view of the pane; alone and open again, the header goes away
  await views[0]?.press({ key: 'done-toggle' })
  for (const ui of views) {
    expect(await find(ui, { text: 'Finished one' })).toBeDefined()
    expect(layout(await full(ui))).toEqual(['header', 'c3'])
  }
})

test('a running session too big to read has no start time, so it says plain "running"', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    // written 10 seconds ago, and over the 4 MiB a mod can read
    return { value: [file('big.jsonl', 7_000_000, 999_990_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'big', title: 'Big one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { deny: 'too large' },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    // fresh and unreadable: it counts as running, but nothing says when its turn began
    expect(await find(ui, { text: 'Working now · 1 session' })).toBeDefined()
    expect(await find(ui, { type: 'Text', text: 'running' })).toBeDefined()
    expect(await find(ui, { text: 'running · ' })).toBeUndefined()
  }
})

// Opening a session in the app writes to its transcript (hooks, snapshots, titles), which moves
// the file's modified time without anything having run. What counts is when it last ran.
test('a session that was only opened is not recent, or running, just because its file changed', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [1, 2, 3, 4, 5].map(n => file(`local_${n}.json`, 100, 5)) }

    // every transcript was written to 10 seconds ago: the app had just opened each one
    return {
      value: [
        file('o1.jsonl', 800_000, 999_990_000), // last ran 3h ago, turn ended
        file('o2.jsonl', 800_000, 999_990_000), // last ran 3h10m ago, turn left unfinished
        file('b3.jsonl', 7_000_000, 999_990_000), // too big to read; the app says 3h ago
        file('r4.jsonl', 800_000, 999_990_000), // really ran 2 minutes ago
        file('l5.jsonl', 7_000_000, 999_990_000), // too big to read; the app says 90 seconds ago
      ],
    }
  })
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string, lastActivityAt?: number) =>
      JSON.stringify({ cliSessionId: id, title, cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false, lastActivityAt })
    const nl = String.fromCharCode(10)
    const stamp = (ms: number) => new Date(ms).toISOString()
    // what opening a session appends: rows with a timestamp that are not messages
    const openedRows = [
      { type: 'attachment', timestamp: stamp(999_990_000), attachment: { type: 'hook_success' } },
      { type: 'last-prompt', timestamp: stamp(999_990_000) },
    ]
    const msg = (type: string, ms: number, stop_reason: string | null, content: unknown) =>
      ({ type, timestamp: stamp(ms), message: { role: type, stop_reason, content } })
    const turn = (ranMs: number, ended: boolean) =>
      [
        msg('user', ranMs - 5_000, null, 'do it'),
        ended ? msg('assistant', ranMs, 'end_turn', [{ type: 'text', text: 'done' }]) : msg('assistant', ranMs, 'tool_use', [{ type: 'tool_use', name: 'Bash' }]),
        ...openedRows,
      ]
        .map(row => JSON.stringify(row))
        .join(nl)
    if (e.path.endsWith('local_1.json')) return { value: record('o1', 'Opened only') }
    if (e.path.endsWith('local_2.json')) return { value: record('o2', 'Opened mid-turn') }
    if (e.path.endsWith('local_3.json')) return { value: record('b3', 'Opened big', 989_000_000) }
    if (e.path.endsWith('local_4.json')) return { value: record('r4', 'Really recent') }
    if (e.path.endsWith('local_5.json')) return { value: record('l5', 'Big live one', 999_910_000) }
    if (e.path.endsWith('o1.jsonl')) return { value: turn(989_200_000, true) }
    if (e.path.endsWith('o2.jsonl')) return { value: turn(988_600_000, false) }
    if (e.path.endsWith('r4.jsonl')) return { value: turn(999_880_000, true) }

    return { deny: 'too large' }
  })

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    // Working now: only the big session the app saw run 90 seconds ago, and it says plain "running";
    // Recent: only the one that really ran 2 minutes ago; Offline: the three that were just opened,
    // newest run first, each with the time it last RAN, not the minute it was opened
    expect(layout(await full(ui))).toEqual(['header', 'running-header', 'l5', 'done-header', 'r4', 'offline-header', 'o1', 'b3', 'o2'])
    expect(await find(ui, { text: 'Working now · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Recent · 1 session' })).toBeDefined()
    expect(await find(ui, { text: 'Offline - Last 5 Hour · 3 sessions' })).toBeDefined()
    expect(await findAll(ui, { type: 'Text', text: '3h ago' })).toHaveLength(3)
    expect(await find(ui, { type: 'Text', text: '2m ago' })).toBeDefined()
    // the header counts the last hour only: the two that ran in it
    expect(await find(ui, { text: '2 sessions' })).toBeDefined()
    // none of them reads as "just now", though every file was written to 10 seconds ago
    expect(await find(ui, { text: 'just now' })).toBeUndefined()
    // the opened session whose turn was left unfinished is not running
    expect(await findAll(ui, { type: 'Text', text: 'running' })).toHaveLength(1)
  }
})

test('running sessions wear Claude\'s main brand orange, the one you are in included', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  // a1 is the session the person is in, and both sessions are mid-turn
  on('session.id', async () => ({ value: 'a1' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('config.list', async () => ({ value: [{ key: 'theme', value: 'dark' }] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5), file('local_2.json', 100, 5)] }

    return { value: [file('a1.jsonl', 800_000, 999_990_000), file('d4.jsonl', 800_000, 999_980_000)] }
  })
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string) =>
      JSON.stringify({ cliSessionId: id, title, cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false })
    if (e.path.endsWith('local_1.json')) return { value: record('a1', 'Current runner') }
    if (e.path.endsWith('local_2.json')) return { value: record('d4', 'Other runner') }
    const ran = e.path.endsWith('a1.jsonl') ? 999_990_000 : 999_980_000
    const rows = [
      { type: 'user', timestamp: new Date(ran - 30_000).toISOString(), message: { role: 'user', content: 'go' } },
      { type: 'assistant', timestamp: new Date(ran).toISOString(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
    ]

    return { value: rows.map(row => JSON.stringify(row)).join(String.fromCharCode(10)) }
  })

  await eng.command.run({ command: 'sessions', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    // Claude's orange itself, not a theme's idea of one
    expect(ROLE.running).toBe('#D97757')
    expect(ROLE.running).toBe(CLAUDE.clay)

    const tree = await full(ui)
    const coloured = texts(tree)
    // the spinner, the elapsed time and the section header are all that orange
    const spinners = coloured.filter(t => t.text === SPIN_FIRST)
    expect(spinners).toHaveLength(2)
    expect(spinners.every(t => t.color === ROLE.running)).toBe(true)
    const times = coloured.filter(t => t.text.startsWith('running · '))
    expect(times.map(t => t.text)).toEqual(['running · 40s', 'running · 50s'])
    expect(times.every(t => t.color === ROLE.running)).toBe(true)
    expect(coloured.find(t => t.text === 'Working now · 2 sessions')).toMatchObject({ color: ROLE.running, bold: true })

    // the cards: both borders are the orange; the current session's is the heavier line, and
    // leads the section, but is not a different colour
    const cards = ((await full(ui)) as unknown as { children: Child[] }).children.filter(c => c?.props?.borderStyle)
    expect(cards.map(c => [c.props?.key, c.props?.borderStyle, c.props?.borderColor, c.props?.backgroundColor])).toEqual([
      ['a1', 'bold', ROLE.running, wash(ROLE.running)],
      ['d4', 'round', ROLE.running, wash(ROLE.running)],
    ])
    // and hovering either keeps its own colour
    const hovers = cards.map(c => (c as unknown as { hover?: { borderColor?: string } }).hover?.borderColor)
    expect(hovers).toEqual([ROLE.running, ROLE.running])
  }
})

// Each write to the listed rows repaints the whole pane, buttons included, so the same rows
// must not be written again: the scan runs every few seconds and usually finds nothing new.
test('a scan that finds nothing new does not repaint the pane', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  const g = globalThis as unknown as { __rowWrites?: number }
  g.__rowWrites = 0
  on('state.set', async (_$, e, next) => {
    if (e.key === 'rows') (globalThis as unknown as { __rowWrites: number }).__rowWrites += 1

    return next(e)
  })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('c3.jsonl', 300_000, 999_600_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'c3', title: 'Finished one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  // the first scan lists the session: one write
  await eng.command.run({ command: 'sessions', args: '' } as never)
  expect(g.__rowWrites).toBe(1)
  // scanning again, with nothing changed, writes nothing and so repaints nothing
  await eng.command.run({ command: 'sessions', args: '' } as never)
  await eng.command.run({ command: 'sessions', args: '' } as never)
  expect(g.__rowWrites).toBe(1)
})


// A click on a card hands the session's deep link to the operating system. What the hooks beneath
// the plugin see is noted through globalThis, since they run isolated.
const FIXTURE_ID = 'local_5320008d-7994-4a81-828a-9e30639f0024'

test('clicking anywhere on a card opens that session, but not the one you are in', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  const g = globalThis as unknown as { __runs?: unknown[] }
  g.__runs = []
  on('process.run', async (_$, e) => {
    ;(globalThis as unknown as { __runs: unknown[] }).__runs.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  // c9 is the session the person is in
  on('session.id', async () => ({ value: 'c9' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [1, 2, 3, 4].map(n => file(`local_${n}.json`, 100, 5)) }

    return {
      value: [
        file('c9.jsonl', 300_000, 999_900_000),
        file('a1.jsonl', 300_000, 999_600_000),
        file('d4.jsonl', 300_000, 999_500_000),
        file('b2.jsonl', 300_000, 999_400_000),
      ],
    }
  })
  on('fs.read', async (_$, e) => {
    const record = (id: string, title: string, sessionId?: string) =>
      JSON.stringify({ cliSessionId: id, sessionId, title, cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false })
    if (e.path.endsWith('local_1.json')) return { value: record('a1', 'Openable one', 'local_5320008d-7994-4a81-828a-9e30639f0024') }
    if (e.path.endsWith('local_2.json')) return { value: record('b2', 'Invalid id', '../evil') }
    if (e.path.endsWith('local_3.json')) return { value: record('c9', 'The one open', 'local_current-1') }
    if (e.path.endsWith('local_4.json')) return { value: record('d4', 'Second openable', 'local_second-2') }

    return { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) }
  })

  await eng.command.run({ command: 'sessions', args: '' } as never)

  // the last surface in the loop is the desktop, whose pane is used again after it
  let desktop: any
  for (const surface of SURFACES) {
    const ui = await eng.ui.mount({
      plugin: 'recent-sessions',
      surface,
      component: 'Pane',
      requestId: 'recent-sessions',
      props: {} as never,
    })
    desktop = ui
    g.__runs = []
    // every card is a region, but the session you are in, and the one whose id the app would
    // not accept, open nothing when clicked
    expect(await clientKeys(ui)).toEqual(['card-c9', 'card-a1', 'card-d4', 'card-b2'])
    await click(ui, 'card-c9')
    await click(ui, 'card-b2')
    expect(g.__runs).toEqual([])
    // the region draws the same card: its title, folder, status and border are all there
    expect(await find(ui, { text: 'Openable one' })).toBeDefined()
    const drawn = (await ui.drawn({ in: 'card-a1' })) as Child
    expect(drawn.props?.key).toBe('a1')
    expect(drawn.props?.borderStyle).toBe('round')

    // nothing is launched until a click lands
    expect(g.__runs).toEqual([])
    await click(ui, 'card-a1')
    expect(g.__runs).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=' + FIXTURE_ID]])
    // any spot on the card counts, the corners included
    await click(ui, 'card-d4', { x: 0, y: 0 })
    expect(g.__runs).toHaveLength(2)
    expect(g.__runs?.[1]).toEqual(['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=local_second-2'])

    // not every pointer event is a click: a press with no release, a release that follows a press
    // dragged off the card, the right button, and a pointer merely moving over it
    g.__runs = []
    await ui.pointer({ type: 'down', x: 2, y: 1, button: 'left', in: 'card-a1' })
    await ui.pointer({ type: 'move', x: 40, y: 1, button: 'left', in: 'card-a1' })
    await ui.pointer({ type: 'up', x: -5, y: 1, button: 'left', in: 'card-a1' })
    await ui.pointer({ type: 'down', x: 2, y: 1, button: 'right', in: 'card-a1' })
    await ui.pointer({ type: 'up', x: 2, y: 1, button: 'right', in: 'card-a1' })
    await ui.pointer({ type: 'move', x: 3, y: 1, in: 'card-a1' })
    await ui.pointer({ type: 'up', x: 2, y: 1, button: 'left', in: 'card-a1' })
    expect(g.__runs).toEqual([])
  }

  // A message from a card is the region's word, not a fact: only the exact click opens anything,
  // and what opens is the card's own session, however the message is dressed. (Which cards can
  // open anything at all is clickTarget's rule, tested on its own.)
  const ui = desktop
  g.__runs = []
  await ui.post({ open: 'yes' }, { in: 'card-a1' }) // not the exact click
  await ui.post({ opened: true }, { in: 'card-a1' })
  await ui.post('open', { in: 'card-a1' })
  expect(g.__runs).toEqual([])
  await ui.post({ open: true, url: 'claude://elsewhere', session: 'local_other' }, { in: 'card-a1' })
  // that one opened a1's own link, never the one the message tried to name
  expect(g.__runs).toEqual([['rundll32', 'url.dll,FileProtocolHandler', 'claude://code/continue?session=' + FIXTURE_ID]])
})

test('on a Mac a click uses the open command', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  // no APPDATA: not Windows
  mock.env(on, { HOME: '/Users/u' })
  const g = globalThis as unknown as { __runs?: unknown[] }
  g.__runs = []
  on('process.run', async (_$, e) => {
    ;(globalThis as unknown as { __runs: unknown[] }).__runs.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('a1.jsonl', 300_000, 999_600_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', sessionId: 'local_abc-1', title: 'Mac one', cwd: '/Users/u/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)
  const ui = await eng.ui.mount({ plugin: 'recent-sessions', surface: 'terminal', component: 'Pane', requestId: 'recent-sessions', props: {} as never })
  await click(ui, 'card-a1')
  expect(g.__runs).toEqual([['open', 'claude://code/continue?session=local_abc-1']])
})

test('a click that fails to open tells the person, whether the command ran badly or could not run', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  const g = globalThis as unknown as { __calls?: number; __toasts?: string[] }
  g.__calls = 0
  g.__toasts = []
  on('process.run', async (_$, e) => {
    const shared = globalThis as unknown as { __calls: number }
    shared.__calls += 1
    // the first launch exits badly; the second cannot start at all
    if (shared.__calls === 1) return { value: { exitCode: 1, stdout: '', stderr: 'no handler' } } as never

    return { deny: 'could not start ' + e.argv[0] } as never
  })
  on('ui.toast', async (_$, e) => {
    ;(globalThis as unknown as { __toasts: string[] }).__toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('a1.jsonl', 300_000, 999_600_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', sessionId: 'local_abc-1', title: 'Failing one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  await eng.command.run({ command: 'sessions', args: '' } as never)
  const ui = await eng.ui.mount({ plugin: 'recent-sessions', surface: 'terminal', component: 'Pane', requestId: 'recent-sessions', props: {} as never })

  await click(ui, 'card-a1')
  expect(g.__toasts).toEqual(['Could not open that session'])
  await click(ui, 'card-a1')
  expect(g.__toasts).toEqual(['Could not open that session', 'Could not open that session'])
})

// The scan runs once a minute, and every scan redraws the pane, so "5m ago" reads "6m ago" a
// minute on even though nothing in the list changed.
test('the time labels move on with each one-minute scan', async (eng, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => e)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    return { value: [file('a1.jsonl', 300_000, 999_700_000)] }
  })
  on('fs.read', async (_$, e) =>
    e.path.endsWith('local_1.json')
      ? { value: JSON.stringify({ cliSessionId: 'a1', title: 'Quiet one', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
      : { value: JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }) },
  )

  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)
  const ui = await eng.ui.mount({ plugin: 'recent-sessions', surface: 'terminal', component: 'Pane', requestId: 'recent-sessions', props: {} as never })
  expect(await find(ui, { text: '5m ago' })).toBeDefined()
  // under a minute on, no scan has run yet
  await clock.advance(50_000)
  expect(await find(ui, { text: '5m ago' })).toBeDefined()
  await clock.advance(10_000)
  expect(await find(ui, { text: '6m ago' })).toBeDefined()
  expect(await find(ui, { text: '5m ago' })).toBeUndefined()
})

// /sessions toggles: a pane on screen closes without a scan; a closed pane, or one waiting
// undrawn on a narrow terminal, opens. What the engine is asked is noted through globalThis.
test('/sessions closes the pane when it is on screen and opens it otherwise', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  const g = globalThis as unknown as { __panes?: unknown[]; __asked?: string[] }
  g.__panes = []
  g.__asked = []
  const shared = () => globalThis as unknown as { __panes: unknown[]; __asked: string[] }
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.panes', async () => ({ value: shared().__panes }) as never)
  on('ui.open', async (_$, e) => {
    shared().__asked.push('open ' + e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', async (_$, e) => {
    shared().__asked.push('close ' + e.id)

    return { value: undefined } as never
  })
  on('fs.list', async () => ({ value: [] }))

  // closed: it opens
  expect(JSON.stringify(await eng.command.run({ command: 'sessions', args: '' } as never))).toContain('Sessions pane opened')
  expect(g.__asked).toEqual(['open recent-sessions'])

  // on screen: it closes, and nothing opens
  g.__panes = [{ id: 'recent-sessions', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }]
  expect(JSON.stringify(await eng.command.run({ command: 'sessions', args: '' } as never))).toContain('Sessions pane closed')
  expect(g.__asked).toEqual(['open recent-sessions', 'close recent-sessions'])

  // waiting undrawn: it opens, since the person cannot see it
  g.__panes = [{ id: 'recent-sessions', title: 'Sessions', isShown: true, isFocused: false, isPlaced: false }]
  expect(JSON.stringify(await eng.command.run({ command: 'sessions', args: '' } as never))).toContain('Sessions pane opened')
  expect(g.__asked).toEqual(['open recent-sessions', 'close recent-sessions', 'open recent-sessions'])
})

test('the pane opens at session start only when a session is listed', async (eng, on) => {
  mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  const g = globalThis as unknown as { __opened?: number; __files?: unknown[] }
  const shared = () => globalThis as unknown as { __opened: number; __files: unknown[] }
  g.__opened = 0
  g.__files = []
  on('session.id', async () => ({ value: 'nobody' }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => e)
  on('ui.open', async () => {
    shared().__opened++

    return { value: { isPlaced: true } }
  })
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }

    return { value: shared().__files } as never
  })
  on('fs.read', async () => ({
    value: [
      { type: 'custom-title', customTitle: 'Finished one' },
      { type: 'user', cwd: 'D:/Projects/x', entrypoint: 'cli', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
    ]
      .map(line => JSON.stringify(line))
      .join(String.fromCharCode(10)),
  }))

  // nothing to list: the pane stays closed
  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)
  expect(g.__opened).toBe(0)

  // a session in the last hour: it opens
  g.__files = [{ name: 'c3.jsonl', kind: 'file', size: 300_000, mtimeMs: 999_600_000, isLink: false }]
  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)
  expect(g.__opened).toBe(1)
})

// A running card counts up by itself, so a turn that ended must be noticed soon: while
// something runs the list is scanned every few seconds, not once a minute.
test('a session that finishes while the pane is open stops reading as running within seconds', async (eng, on) => {
  const clock = mock.clock(on, { now: 1_000_000_000 })
  mock.env(on, { USERPROFILE: 'C:/h', APPDATA: 'C:/a' })
  const g = globalThis as unknown as { __ended?: boolean }
  g.__ended = false
  on('session.id', async () => ({ value: 'a1' }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => e)
  on('fs.list', async (_$, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path.endsWith('projects')) return { value: [dir('proj')] }
    if (e.path.endsWith('claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('acct')) return { value: [dir('org')] }
    if (e.path.endsWith('org')) return { value: [file('local_1.json', 100, 5)] }

    // the transcript grows when the turn ends
    const ended = (globalThis as unknown as { __ended: boolean }).__ended

    return { value: [file('a1.jsonl', ended ? 2_000_100 : 2_000_000, 999_999_000)] }
  })
  on('fs.read', async (_$, e) => {
    if (e.path.endsWith('local_1.json')) {
      return { value: JSON.stringify({ cliSessionId: 'a1', title: 'Just finished', cwd: 'D:/Projects/x', model: 'claude-opus-5-5', isArchived: false }) }
    }
    const ended = (globalThis as unknown as { __ended: boolean }).__ended
    const stop_reason = ended ? 'end_turn' : 'tool_use'
    const content = ended ? [{ type: 'text', text: 'done' }] : [{ type: 'tool_use', name: 'Bash' }]

    return {
      value: [
        { type: 'user', timestamp: new Date(1_000_000_000 - 5_000).toISOString(), message: { role: 'user', content: 'go' } },
        { type: 'assistant', message: { role: 'assistant', stop_reason, content } },
      ]
        .map(line => JSON.stringify(line))
        .join(String.fromCharCode(10)),
    }
  })

  await eng.session.start({ source: 'startup', cwd: 'D:/Projects/x' } as never)
  const ui = await eng.ui.mount({ plugin: 'recent-sessions', surface: 'terminal', component: 'Pane', requestId: 'recent-sessions', props: {} as never })
  expect(await find(ui, { text: 'Working now · 1 session' })).toBeDefined()

  g.__ended = true
  await clock.advance(5_000)
  expect(await find(ui, { text: 'Working now · 1 session' })).toBeUndefined()
  expect(await find(ui, { text: 'Recent · 1 session' })).toBeUndefined()
  expect(await findAll(ui, { type: 'Text', text: 'running' })).toHaveLength(0)
  expect(await find(ui, { text: 'just now' })).toBeDefined()
})
