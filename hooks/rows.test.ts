import { test, expect } from 'claude-code/testing'

import {
  WAIT_MAX_MS,
  ago,
  buildRows,
  clickTarget,
  fmtElapsed,
  fmtSize,
  folderOf,
  isAppSessionId,
  lastRunAt,
  lastTurn,
  parseFolds,
  parseHead,
  parseRecord,
  sessionUrl,
  stateOf,
  statusOf,
  turnStartedAt,
} from './rows'

const NOW = 10_000_000_000
const min = (n: number) => n * 60_000

test('parseHead: last title wins, cwd unescaped', () => {
  const text = [
    '{"type":"custom-title","customTitle":"old","sessionId":"s"}',
    '{"type":"user","cwd":"D:\\\\Projects\\\\om-library-be"}',
    '{"type":"custom-title","customTitle":"new \\"q\\"","sessionId":"s"}',
  ].join('\n')
  expect(parseHead(text)).toEqual({ title: 'new "q"', cwd: 'D:\\Projects\\om-library-be' })
  expect(parseHead('{"type":"user"}')).toEqual({ title: undefined, cwd: undefined })
  // the line that carries the cwd also says what started the session
  expect(parseHead('{"type":"user","cwd":"D:\\\\x","entrypoint":"claude-desktop"}').entrypoint).toBe('claude-desktop')
})

test('parseRecord: desktop record to meta, none without a transcript id', () => {
  const record = '{"cliSessionId":"abc","title":"Niche research","cwd":"D:\\\\x","model":"claude-opus-5-5","isArchived":true}'
  expect(parseRecord(record)).toEqual({ id: 'abc', title: 'Niche research', cwd: 'D:\\x', model: 'claude-opus-5-5', archived: true, prior: [] })
  // the effort the session is set to rides along with the model
  expect(parseRecord('{"cliSessionId":"e","title":"T","effort":"high"}')?.effort).toBe('high')
  // the earlier transcripts of a resumed session are listed under priorCliSessionIds
  const resumed = '{"cliSessionId":"new","title":"T","priorCliSessionIds":["old1","old2",7]}'
  expect(parseRecord(resumed)?.prior).toEqual(['old1', 'old2'])
  expect(parseRecord('{"title":"no id"}')).toBeUndefined()
})

test('ago: now, minutes, hours', () => {
  expect([ago(5_000), ago(min(3)), ago(min(59)), ago(min(61))]).toEqual(['now', '3m', '59m', '1h'])
})

test('stateOf: waiting and running win; otherwise recent under ten minutes, else idle', () => {
  expect([
    stateOf(min(45), 'waiting'),
    stateOf(min(45), 'running'),
    stateOf(30_000, 'done'),
    stateOf(min(5), 'done'),
    stateOf(min(10), 'done'),
    stateOf(min(90), 'offline'),
  ]).toEqual(['waiting', 'working', 'recent', 'recent', 'idle', 'idle'])
})

const lines = (...entries: object[]) => entries.map(e => JSON.stringify(e)).join('\n')
const assistant = (stop_reason: string | null) => ({ type: 'assistant', message: { role: 'assistant', stop_reason } })
const user = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra })
const noise = { type: 'last-prompt' }

const call = (name: string) => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name }] },
})

test('lastTurn: a tool call or an unanswered prompt is running', () => {
  expect(lastTurn(lines(user('hi'), call('Bash'), noise))).toBe('running')
  expect(lastTurn(lines(assistant('tool_use'), user([{ type: 'tool_result', content: 'ok' }])))).toBe('running')
  expect(lastTurn(lines(assistant('end_turn'), user('next question'), noise))).toBe('running')
  expect(lastTurn(lines(user('hi'), assistant(null)))).toBe('running')
})

test('lastTurn: an unanswered question or plan approval is an ask; an edit is instant', () => {
  expect(lastTurn(lines(user('hi'), call('AskUserQuestion'), noise))).toBe('ask')
  expect(lastTurn(lines(user('hi'), call('ExitPlanMode')))).toBe('ask')
  expect(lastTurn(lines(user('hi'), call('Edit')))).toBe('instant')
  expect(lastTurn(lines(user('hi'), call('Write'), noise))).toBe('instant')
})

test('lastTurn: answering the question ends the ask', () => {
  const answered = lines(call('AskUserQuestion'), user([{ type: 'tool_result', content: 'The user answered: "A"' }]))
  expect(lastTurn(answered)).toBe('running')
  expect(lastTurn(`${answered}
${JSON.stringify(assistant('end_turn'))}`)).toBe('done')
})

test('lastTurn: an ended turn, an interrupt, or nothing is done', () => {
  expect(lastTurn(lines(user('hi'), assistant('end_turn'), noise))).toBe('done')
  expect(lastTurn(lines(call('AskUserQuestion'), user([{ type: 'text', text: '[Request interrupted by user]' }])))).toBe('done')
  expect(lastTurn(lines(noise))).toBe('done')
  expect(lastTurn('')).toBe('done')
})

test('lastTurn: skips slash-command echoes, meta rows and a half-written last line', () => {
  const echoed = lines(user('hi'), assistant('end_turn'), user('<local-command-stdout>ok</local-command-stdout>'))
  expect(lastTurn(echoed)).toBe('done')
  expect(lastTurn(lines(assistant('end_turn'), user('caveat', { isMeta: true })))).toBe('done')
  expect(lastTurn(`${lines(user('hi'), assistant('end_turn'))}
{"type":"assistant","mess`)).toBe('done')
  // a question stays an ask through the echo of a slash command run while it is open
  expect(lastTurn(lines(call('AskUserQuestion'), user('<local-command-stdout>ok</local-command-stdout>')))).toBe('ask')
})

test('statusOf: asks wait without a time limit; instant tools wait after 15s; runs expire', () => {
  expect(statusOf('ask', min(300))).toBe('waiting')
  expect(statusOf('instant', 5_000)).toBe('running')
  expect(statusOf('instant', 20_000)).toBe('waiting')
  expect(statusOf('instant', min(300))).toBe('waiting')
  expect(statusOf('running', min(5))).toBe('running')
  expect(statusOf('running', min(11))).toBe('done')
  expect(statusOf('done', 1_000)).toBe('done')
})

test('folderOf: the project folder, or No Project for a throwaway scratch folder', () => {
  // the same paths a Windows session records, with the backslashes built from a char code
  const win = (...parts: string[]) => parts.join(String.fromCharCode(92))
  expect(folderOf(win('D:', 'Projects', 'om-library-be'), 'D--x')).toBe('om-library-be')
  expect(folderOf(win('C:', 'Users', 'u', 'AppData', 'Roaming', 'Claude', 'scratch-workspaces', 'a', 'b', 'scratch-2026-10-12-64df8d'), 'd')).toBe('No Project')
  expect(folderOf('/home/u/Library/Claude/scratch-workspaces/a/b/scratch-2026-10-12-64df8d', 'd')).toBe('No Project')
  // no cwd: the encoded folder name decides, trimmed to its tail
  expect(folderOf(undefined, 'C--Users-USER-AppData-Roaming-Claude-scratch-workspaces-7dd6-scratch-2026-10-12-64df8d')).toBe('No Project')
  expect(folderOf(undefined, 'D--Projects-om-library-be')).toBe('--Projects-om-library-be')
  expect(folderOf(undefined, 'D--short')).toBe('D--short')
})

test('buildRows: carries effort and shows No Project for scratch sessions', () => {
  const [row] = buildRows(
    [{ id: 'x', ranAt: NOW - min(5), size: 1, dir: 'd', title: 'T', hasRecord: true, model: 'claude-opus-5-5', effort: 'medium', cwd: 'C:/Users/u/scratch-workspaces/a/scratch-2026-10-12-aaaaaa' }],
    NOW,
    'y',
  )
  expect(row).toMatchObject({ folder: 'No Project', model: 'opus-5-5', effort: 'medium' })
})

test('parseFolds: only known sections set to true are folded; the older Offline-only value still counts', () => {
  expect(parseFolds({ waiting: true, running: false, done: true, offline: true })).toEqual({ waiting: true, done: true, offline: true })
  // Working now cannot fold, so a fold saved for it is dropped
  expect(parseFolds({ running: true, waiting: true })).toEqual({ waiting: true })
  // unknown keys, non-booleans and non-objects are ignored
  expect(parseFolds({ bogus: true, running: 'yes', waiting: 1 })).toEqual({})
  expect(parseFolds(undefined)).toEqual({})
  expect(parseFolds('waiting')).toEqual({})
  expect(parseFolds(null)).toEqual({})
  // what the first version saved, when only Offline could fold
  expect(parseFolds(undefined, true)).toEqual({ offline: true })
  expect(parseFolds({ waiting: true }, true)).toEqual({ waiting: true, offline: true })
  expect(parseFolds(undefined, false)).toEqual({})
})

// What opening a session writes to its transcript: rows that carry timestamps and are not messages
const opened = [
  { type: 'attachment', timestamp: new Date(NOW - 1000).toISOString(), attachment: { type: 'hook_success' } },
  { type: 'system', timestamp: new Date(NOW - 900).toISOString() },
  { type: 'last-prompt', timestamp: new Date(NOW - 800).toISOString() },
  { type: 'custom-title', customTitle: 'T' },
]

test('lastRunAt: the last real message, not the rows opening a session writes after it', () => {
  const ran = lines(prompt(min(200)), call('Bash'), result(min(180)), assistant('end_turn'))
  // the assistant helper has no timestamp, so the tool result is the last message that has one
  expect(lastRunAt(ran)).toBe(NOW - min(180))
  // opening the session afterwards appends attachments, snapshots and titles, all timestamped
  expect(lastRunAt(lines(prompt(min(200)), result(min(180)), ...opened))).toBe(NOW - min(180))
  // a tool result is part of a run; a prompt is one too
  expect(lastRunAt(lines(prompt(min(3))))).toBe(NOW - min(3))
})

test('lastRunAt: skips slash-command echoes, meta rows, subagent rows, a bad timestamp and a half-written line', () => {
  const base = lines(prompt(min(120)), result(min(100)))
  expect(lastRunAt(lines(prompt(min(120)), result(min(100)), prompt(1000, '<local-command-stdout>ok</local-command-stdout>')))).toBe(NOW - min(100))
  expect(lastRunAt(lines(prompt(min(120)), result(min(100)), prompt(1000, 'caveat', { isMeta: true })))).toBe(NOW - min(100))
  expect(lastRunAt(lines(prompt(min(120)), result(min(100)), prompt(1000, 'agent work', { isSidechain: true })))).toBe(NOW - min(100))
  // a message whose timestamp does not parse is passed over for the one before it
  expect(lastRunAt(lines(prompt(min(120)), { type: 'user', timestamp: 'later', message: { role: 'user', content: 'hi' } }))).toBe(NOW - min(120))
  expect(lastRunAt(base + String.fromCharCode(10) + '{"type":"user","timest')).toBe(NOW - min(100))
  // nothing that ran: unknown
  expect(lastRunAt(lines(...opened))).toBeUndefined()
  expect(lastRunAt('')).toBeUndefined()
})

test('isAppSessionId: only the ids the app gives its own sessions', () => {
  expect(isAppSessionId('local_5320008d-7994-4a81-828a-9e30639f0024')).toBe(true)
  expect(isAppSessionId('local_a')).toBe(true)
  // too short, too long, the wrong prefix, or any character the app would refuse
  expect(isAppSessionId('local_')).toBe(false)
  expect(isAppSessionId('local_' + 'a'.repeat(65))).toBe(false)
  expect(isAppSessionId('local_' + 'a'.repeat(64))).toBe(true)
  expect(isAppSessionId('session_abc')).toBe(false)
  expect(isAppSessionId('local_../etc')).toBe(false)
  expect(isAppSessionId('local_a b')).toBe(false)
  expect(isAppSessionId('local_a&b=c')).toBe(false)
  expect(isAppSessionId('local_a_b')).toBe(false)
  expect(isAppSessionId(undefined)).toBe(false)
  expect(isAppSessionId(42)).toBe(false)
})

const rowOf = (id: string, extra: object = {}) => ({
  id,
  title: id,
  folder: 'f',
  ranAt: NOW,
  size: 1,
  status: 'done' as const,
  isCurrent: false,
  appId: 'local_' + id,
  ...extra,
})

test('clickTarget: a click on a card opens that card\'s own session', () => {
  const list = [rowOf('a1'), rowOf('b2')]
  expect(clickTarget(list, 'card-a1', { open: true })).toBe('local_a1')
  expect(clickTarget(list, 'card-b2', { open: true })).toBe('local_b2')
  // the id comes from the row, not from anything the message carries
  expect(clickTarget(list, 'card-a1', { open: true, session: 'local_other', url: 'claude://x' })).toBe('local_a1')
})

test('clickTarget: the session the person is in, a card with nothing to open and a stray message open nothing', () => {
  const list = [rowOf('cur', { isCurrent: true }), rowOf('bad', { appId: '../evil' }), rowOf('none', { appId: undefined }), rowOf('ok')]
  // the current session is not opened, however the message is addressed
  expect(clickTarget(list, 'card-cur', { open: true })).toBeUndefined()
  // an id the app would not accept, or none at all
  expect(clickTarget(list, 'card-bad', { open: true })).toBeUndefined()
  expect(clickTarget(list, 'card-none', { open: true })).toBeUndefined()
  // no such card, or not a card's key
  expect(clickTarget(list, 'card-ghost', { open: true })).toBeUndefined()
  expect(clickTarget(list, 'ok', { open: true })).toBeUndefined()
  expect(clickTarget(list, 'open-ok', { open: true })).toBeUndefined()
  // anything but the exact click
  for (const data of [{ open: 'yes' }, { open: 1 }, { open: false }, { opened: true }, {}, 'open', 5, null, undefined, [true]]) {
    expect(clickTarget(list, 'card-ok', data)).toBeUndefined()
  }
})

test('sessionUrl: the deep link that opens a session in the app', () => {
  expect(sessionUrl('local_abc-123')).toBe('claude://code/continue?session=local_abc-123')
})

test('parseRecord: carries the app id, only when it is one the app would accept', () => {
  expect(parseRecord('{"cliSessionId":"a","title":"T","sessionId":"local_abc-1"}')?.appId).toBe('local_abc-1')
  expect(parseRecord('{"cliSessionId":"a","title":"T","sessionId":"../evil"}')?.appId).toBeUndefined()
  expect(parseRecord('{"cliSessionId":"a","title":"T"}')?.appId).toBeUndefined()
})

test('buildRows: carries the app id through to the row', () => {
  const [row] = buildRows([{ id: 'x', ranAt: NOW - 5_000, size: 1, dir: 'd', title: 'T', appId: 'local_x' }], NOW, 'y')
  expect(row?.appId).toBe('local_x')
})

test('parseRecord: carries when the app last saw the session run', () => {
  expect(parseRecord('{"cliSessionId":"a","title":"T","lastActivityAt":1234}')?.activeAt).toBe(1234)
  expect(parseRecord('{"cliSessionId":"a","title":"T","lastActivityAt":"soon"}')?.activeAt).toBeUndefined()
  expect(parseRecord('{"cliSessionId":"a","title":"T"}')?.activeAt).toBeUndefined()
})

test('fmtElapsed: seconds, minutes and seconds, hours and minutes', () => {
  const sec = (n: number) => n * 1000
  expect([fmtElapsed(sec(0)), fmtElapsed(sec(45)), fmtElapsed(sec(59.9))]).toEqual(['0s', '45s', '59s'])
  expect([fmtElapsed(sec(60)), fmtElapsed(sec(134)), fmtElapsed(min(10))]).toEqual(['1m', '2m 14s', '10m'])
  expect([fmtElapsed(min(65)), fmtElapsed(min(60)), fmtElapsed(min(125))]).toEqual(['1h 5m', '1h', '2h 5m'])
  // a clock a little behind the file's does not show a negative time
  expect(fmtElapsed(-5000)).toBe('0s')
})

const at = (n: number) => new Date(NOW - n).toISOString()
const prompt = (n: number, content: unknown = 'do it', extra: object = {}) => ({
  type: 'user',
  timestamp: at(n),
  message: { role: 'user', content },
  ...extra,
})
const result = (n: number) => prompt(n, [{ type: 'tool_result', content: 'ok' }])

test('turnStartedAt: the prompt that began the turn, not the tool results after it', () => {
  // an earlier turn, then this one's prompt, its calls and the results that came back
  const text = lines(prompt(min(30)), assistant('end_turn'), prompt(min(2)), call('Bash'), result(min(1)), call('Read'), result(10_000))
  expect(turnStartedAt(text)).toBe(NOW - min(2))
  // a prompt written as text blocks counts the same
  expect(turnStartedAt(lines(prompt(5000, [{ type: 'text', text: 'hi' }]), call('Bash')))).toBe(NOW - 5000)
})

test('turnStartedAt: skips slash-command echoes, meta rows, a half-written line and a bad timestamp', () => {
  // the echo of a slash command run during the turn is not its start
  const echoed = lines(prompt(60_000), call('Bash'), prompt(1000, '<local-command-stdout>ok</local-command-stdout>'))
  expect(turnStartedAt(echoed)).toBe(NOW - 60_000)
  expect(turnStartedAt(lines(prompt(60_000), prompt(1000, 'caveat', { isMeta: true }), call('Bash')))).toBe(NOW - 60_000)
  const half = lines(prompt(60_000), call('Bash')) + String.fromCharCode(10) + '{"type":"user","timest'
  expect(turnStartedAt(half)).toBe(NOW - 60_000)
  // no prompt at all, or one whose timestamp does not parse: unknown
  expect(turnStartedAt(lines(call('Bash')))).toBeUndefined()
  expect(turnStartedAt('')).toBeUndefined()
  expect(turnStartedAt(lines({ type: 'user', timestamp: 'later', message: { role: 'user', content: 'hi' } }))).toBeUndefined()
})

test('fmtSize: KB under a megabyte, MB above', () => {
  expect([fmtSize(100), fmtSize(512 * 1024), fmtSize(7_700_000)]).toEqual(['1 KB', '512 KB', '7.3 MB'])
})

test('buildRows: carries the turn start for a running session only', () => {
  const entry = (id: string, status: 'running' | 'done' | 'waiting') => ({
    id,
    ranAt: NOW - 5_000,
    size: 1,
    dir: 'd',
    title: id,
    status,
    startedAt: NOW - 60_000,
  })
  const out = buildRows([entry('r', 'running'), entry('d', 'done'), entry('w', 'waiting')], NOW, 'x')
  expect(out.map(r => [r.id, r.startedAt])).toEqual([
    ['r', NOW - 60_000],
    ['d', undefined],
    ['w', undefined],
  ])
})

test('buildRows: carries the status through, defaulting to done', () => {
  const [run] = buildRows([{ id: 'r', ranAt: NOW - 5_000, size: 1, dir: 'd', title: 'T', status: 'running' }], NOW, 'x')
  expect(run?.status).toBe('running')
  const [idle] = buildRows([{ id: 'i', ranAt: NOW - 5_000, size: 1, dir: 'd', title: 'T' }], NOW, 'x')
  expect(idle?.status).toBe('done')
})

test('buildRows: a waiting session outlives the one-hour window, up to a day', () => {
  const wait = (id: string, age: number) => ({ id, ranAt: NOW - age, size: 1, dir: 'd', title: id, status: 'waiting' as const })
  const out = buildRows(
    [
      wait('three-hours', min(180)),
      wait('too-old', WAIT_MAX_MS + min(1)),
      { id: 'stale-done', ranAt: NOW - min(180), size: 1, dir: 'd', title: 'stale-done', status: 'done' as const },
    ],
    NOW,
    'x',
  )
  // the waiting one stays as waiting; the finished one of the same age is merely offline
  expect(out.map(r => [r.id, r.status])).toEqual([
    ['three-hours', 'waiting'],
    ['stale-done', 'offline'],
  ])
})

test('buildRows: past the hour a session is offline, listed until five hours', () => {
  const entry = (id: string, age: number) => ({ id, ranAt: NOW - age, size: 1, dir: 'd', title: id, status: 'done' as const })
  const out = buildRows(
    [entry('fresh', min(59)), entry('just-past', min(61)), entry('four-59', min(299)), entry('five-01', min(301))],
    NOW,
    'x',
  )
  expect(out.map(r => [r.id, r.status])).toEqual([
    ['fresh', 'done'],
    ['just-past', 'offline'],
    ['four-59', 'offline'],
  ])
})

test('buildRows: a running session never reads as offline, and an offline one stays offline', () => {
  const [run] = buildRows([{ id: 'r', ranAt: NOW - min(2), size: 1, dir: 'd', title: 'r', status: 'running' }], NOW, 'x')
  expect(run?.status).toBe('running')
  const [off] = buildRows([{ id: 'o', ranAt: NOW - min(120), size: 1, dir: 'd', title: 'o', status: 'running' }], NOW, 'x')
  expect(off?.status).toBe('offline')
})

test('buildRows: pins the current session first even when it is the oldest', () => {
  const entries = [
    { id: 'new', ranAt: NOW - min(1), size: 1, dir: 'd', title: 'Newest' },
    { id: 'mid', ranAt: NOW - min(10), size: 1, dir: 'd', title: 'Middle' },
    { id: 'cur', ranAt: NOW - min(50), size: 1, dir: 'd', title: 'Current' },
  ]
  expect(buildRows(entries, NOW, 'cur').map(r => r.id)).toEqual(['cur', 'new', 'mid'])
  expect(buildRows(entries, NOW, 'none').map(r => r.id)).toEqual(['new', 'mid', 'cur'])
})

test('buildRows: drops archived, untitled, orphaned and over-five-hour sessions; marks current', () => {
  const out = buildRows(
    [
      { id: 'aaaaaaaa-1', ranAt: NOW - min(30), size: 10, dir: 'D--x', title: 'Old one', cwd: 'D:\\Projects\\a', model: 'claude-opus-5-5', hasRecord: true },
      { id: 'bbbbbbbb-2', ranAt: NOW - min(2), size: 20, dir: 'D--w', title: 'Current one', cwd: 'D:\\Projects\\b', hasRecord: true },
      { id: 'cccccccc-3', ranAt: NOW - min(61), size: 30, dir: 'D--y', title: 'Offline one', hasRecord: true },
      { id: 'ffffffff-6', ranAt: NOW - min(400), size: 30, dir: 'D--y', title: 'Too old', hasRecord: true },
      { id: 'dddddddd-4', ranAt: NOW - min(1), size: 40, dir: 'D--z', title: 'Archived', archived: true, hasRecord: true },
      // no title: a headless run, or a transcript too big to read; never shown as an id
      { id: 'eeeeeeee-5', ranAt: NOW - min(1), size: 50, dir: 'C--Temp', entrypoint: 'cli' },
      { id: 'gggggggg-7', ranAt: NOW - min(1), size: 50, dir: 'C--Temp', hasRecord: true },
      // titled, but started in the desktop app and unknown to it: an ancestor or a deleted session
      { id: 'hhhhhhhh-8', ranAt: NOW - min(3), size: 60, dir: 'D--v', title: 'Orphan', cwd: 'D:\\Projects\\v', entrypoint: 'claude-desktop' },
      // titled and from a terminal: kept without a desktop record
      { id: 'iiiiiiii-9', ranAt: NOW - min(20), size: 70, dir: 'D--u', title: 'Terminal one', cwd: 'D:\\Projects\\u', entrypoint: 'cli' },
    ],
    NOW,
    'bbbbbbbb-2',
  )
  expect(out.map(r => r.id)).toEqual(['bbbbbbbb-2', 'iiiiiiii-9', 'aaaaaaaa-1', 'cccccccc-3'])
  expect(out[0]).toMatchObject({ title: 'Current one', folder: 'b', isCurrent: true })
  expect(out[2]).toMatchObject({ title: 'Old one', folder: 'a', model: 'opus-5-5', isCurrent: false })
  expect(out[3]).toMatchObject({ title: 'Offline one', status: 'offline' })
  // no row is ever titled with an id
  expect(out.every(r => r.title.length > 0 && !/-\d$/.test(r.title))).toBe(true)
})
