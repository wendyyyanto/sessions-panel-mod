import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { Cards } from './cards'
import { BLIND_RUN_MS, OFFLINE_MS, RUN_MS, WAIT_MAX_MS, buildRows, clickTarget, isAppSessionId, lastRunAt, lastTurn, parseFolds, parseHead, parseRecord, sessionUrl, statusOf, turnStartedAt } from './rows'
import type { Entry, Head, Kind, Meta, Status } from './rows'
import type { Row } from '../types'

const PANE = 'recent-sessions'
// The cards tell time in minutes ("1m ago", "1h ago"), so a scan a minute keeps them true. A
// session that starts or finishes moves section within a minute; a running card counts its
// own seconds.
const REFRESH_MS = 60_000
const rows = atom({ plugin: 'recent-sessions', key: 'rows' } as const, [])
// which sections are folded away; kept in $.store as well, so the choices outlive the session
const collapsed = atom({ plugin: 'recent-sessions', key: 'collapsed' } as const, {})
const FOLDS_KEY = 'collapsedSections'
// what an earlier version saved, when only the Offline section could fold
const LEGACY_OFFLINE_KEY = 'offlineCollapsed'
// whether the person's theme is a dark one, which the card tints need; read with each scan,
// and false (no tints) until it is known or where the setting cannot be read
let dark = false
// transcript heads by session id, re-read when the file grows; desktop records by path,
// re-read when the file changes
const heads = new Map<string, { size: number; head: Head }>()
const records = new Map<string, { mtimeMs: number; meta?: Meta }>()
// what each transcript's last message says, re-read only when the file changes; the status
// is worked out from it on every scan, since an approval prompt turns on with idle time
const kinds = new Map<string, { mtimeMs: number; size: number; kind?: Kind; startedAt?: number; ranAt?: number }>()

// The desktop app's own session records, indexed by transcript id, and the ids of the
// earlier transcripts those sessions have left behind (listed through their newest one).
// Absent (a terminal-only setup, another OS layout) both are empty and the transcripts
// stand alone.
async function desktopIndex($: EngineInterface, home: string) {
  const appData = await $.env.get('APPDATA')
  const root = `${appData ?? `${home}/Library/Application Support`}/Claude/claude-code-sessions`
  const index = new Map<string, Meta>()
  const superseded = new Set<string>()
  for (const account of await $.fs.list(root).catch(() => [])) {
    for (const org of await $.fs.list(`${root}/${account.name}`).catch(() => [])) {
      for (const file of await $.fs.list(`${root}/${account.name}/${org.name}`).catch(() => [])) {
        if (!file.name.startsWith('local_') || !file.name.endsWith('.json')) continue
        const path = `${root}/${account.name}/${org.name}/${file.name}`
        let hit = records.get(path)
        if (hit?.mtimeMs !== file.mtimeMs) {
          const meta = await $.fs.read(path).then(parseRecord).catch(() => undefined)
          hit = { mtimeMs: file.mtimeMs, meta }
          records.set(path, hit)
        }
        if (hit.meta) {
          index.set(hit.meta.id, hit.meta)
          for (const old of hit.meta.prior) superseded.add(old)
        }
      }
    }
  }
  return { index, superseded }
}

async function refresh($: EngineInterface) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const base = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const root = `${base}/projects`
  const now = await $.clock.now()
  const { index, superseded } = await desktopIndex($, home)
  const entries: Entry[] = []
  for (const dir of await $.fs.list(root)) {
    if (dir.kind !== 'dir') continue
    for (const file of await $.fs.list(`${root}/${dir.name}`)) {
      const age = now - file.mtimeMs
      if (!file.name.endsWith('.jsonl') || age > WAIT_MAX_MS) continue
      const id = file.name.slice(0, -'.jsonl'.length)
      // an earlier transcript of a session already listed through its newest one
      if (superseded.has(id)) continue
      const path = `${root}/${dir.name}/${file.name}`
      let seen = kinds.get(id)
      if (seen?.mtimeMs !== file.mtimeMs || seen.size !== file.size) {
        // read rejects over 4 MiB: such a transcript has no tail to judge
        const text = await $.fs.read(path).catch(() => undefined)
        const kind = typeof text === 'string' ? lastTurn(text) : undefined
        // when the turn in flight began, for the card to count up from; only a turn that can
        // be running needs it, and it holds until the file changes again
        const inFlight = kind === 'running' || kind === 'instant'
        const ranAt = typeof text === 'string' ? lastRunAt(text) : undefined
        seen = { mtimeMs: file.mtimeMs, size: file.size, kind, startedAt: inFlight ? turnStartedAt(text as string) : undefined, ranAt }
        kinds.set(id, seen)
      }
      const meta = index.get(id)
      // When it last ran is its last real message, not the file's modified time: opening a
      // session writes to the transcript without anything running. A transcript too big to
      // read falls back on the app's record of the session's last activity, and only then
      // on the file.
      const ranAt = Math.min(seen.ranAt ?? meta?.activeAt ?? file.mtimeMs, file.mtimeMs)
      const idle = now - ranAt
      // Unreadable, it cannot be told from its tail whether a turn is in flight; it counts as
      // running while the file is fresh and the app has seen it run lately (its record lags a
      // minute or two behind a live turn, but is hours behind a session that was only opened),
      // and is never waiting.
      const lately = meta?.activeAt === undefined || now - meta.activeAt < RUN_MS
      const status: Status = seen.kind ? statusOf(seen.kind, idle) : age < BLIND_RUN_MS && lately ? 'running' : 'done'
      // past the offline window a session is listed only while it waits for the person
      if (idle > OFFLINE_MS && status !== 'waiting') continue
      let head: Head = meta ?? {}
      if (!meta) {
        let hit = heads.get(id)
        if (hit?.size !== file.size) {
          // read rejects over 4 MiB, and a line caught mid-write fails to parse: no head, no title
          const parsed = await $.fs
            .read(path)
            .then(parseHead)
            .catch((): Head => ({}))
          hit = { size: file.size, head: parsed }
          heads.set(id, hit)
        }
        head = hit.head
      }
      entries.push({
        id,
        ranAt,
        size: file.size,
        dir: dir.name,
        ...head,
        model: meta?.model,
        effort: meta?.effort,
        appId: meta?.appId,
        archived: meta?.archived,
        hasRecord: meta !== undefined,
        status,
        startedAt: seen.startedAt,
      })
    }
  }
  const current = await $.session.id()
  const built = buildRows(entries, now, current)
  const theme = (await $.config.list().catch(() => [])).find(row => row.key === 'theme')?.value
  dark = typeof theme === 'string' && theme.startsWith('dark')
  // the rows are written only when they changed; otherwise the pane is still drawn again, once
  // a scan, so its "ago" times move on
  if (JSON.stringify(await read($, rows)) !== JSON.stringify(built)) await update($, rows, () => built)
  else $.ui.invalidate('ui.render')
}

// Folds or unfolds one section, and keeps every section's choice for the next session.
async function toggleSection($: EngineInterface, section: Row['status']) {
  await update($, collapsed, folds => ({ ...folds, [section]: !folds?.[section] }))
  await $.store.set(FOLDS_KEY, await read($, collapsed))
}

// Opens a session in the desktop app by handing its deep link to the operating system, which
// gives it to the app (the app's continue route switches to the session it names). The id is
// checked again here, so only a link of the app's own form is ever launched, and nothing but
// the fixed command below is run.
async function openSession($: EngineInterface, appId: string) {
  if (!isAppSessionId(appId)) return
  const url = sessionUrl(appId)
  const windows = (await $.env.get('APPDATA')) !== undefined
  const argv = windows ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['open', url]
  const done = await $.process.run(argv, { timeoutMs: 10_000 })
  if (done.exitCode !== 0) $.ui.toast('Could not open that session')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Show or hide the side pane of sessions active in the last hour',
    })
    // the choices made in earlier sessions; unreadable, every section stays unfolded
    const saved = parseFolds(await $.store.get(FOLDS_KEY).catch(() => undefined), await $.store.get(LEGACY_OFFLINE_KEY).catch(() => undefined))
    if (Object.keys(saved).length > 0) await update($, collapsed, () => saved)
    // a stale list beats a toast every 30 seconds, so a failed scan is dropped
    const tick = () => void refresh($).catch(() => {})
    tick()
    $.clock.every(REFRESH_MS, tick)
    void $.ui.open({ id: PANE, title: 'Sessions' })

    return next(e)
  })

  // A toggle: a pane on screen closes; one closed, or waiting undrawn on a narrow terminal, opens.
  on('command.run', { command: 'sessions' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)) {
      await $.ui.close({ id: PANE })

      return { text: 'Sessions pane closed.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Sessions' })

    const found = (await read($, rows)).length

    return { text: `Sessions pane opened: ${found} listed.` }
  })

  // A click on a card: its region tells us so, as a message; clickTarget decides what, if
  // anything, it opens.
  on('ui.message', async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId === PANE) {
      const target = clickTarget(await read($, rows), e.element, e.data)
      if (target) await openSession($, target).catch(() => $.ui.toast('Could not open that session'))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, rows)
    const folds = await read($, collapsed)

    return Cards($.ui.resolve(e), list, await $.clock.now(), dark, folds, section => void toggleSection($, section).catch(() => {}),
    )
  })
}
