# sessions-panel-mod

A side pane that lists your Claude Code sessions and what each one is doing: waiting for your reply, working now, finished recently, or gone quiet. Click a card to jump to that session in the desktop app. It is a mod for Claude Code and the Claude desktop app's Code tab.

## What it shows

The pane is titled **Sessions** and opens on the right when a session starts, but only if there is at least one session to list. At the top, **Sessions in the last hour** and a count. Below that, up to four sections, in this order:

| Section | Colour | What is in it |
| --- | --- | --- |
| **Waiting for response** | fig | A session stopped on a question, a plan approval, or a file-edit approval that nobody has answered. It stays listed for up to 24 hours, until you answer. |
| **Working now** | Claude orange | A session with a turn in flight. Its spinner turns and its time counts up: `running · 2m 14s`. |
| **Recent** | sky | A session whose last message was in the last hour. |
| **Offline - Last 5 Hour** | grey | A session last active between 1 and 5 hours ago. |

Each session is a card with:

- **A status mark:** `◆` waiting, a spinner while working, `●` the session you are in, `○` any other finished or offline session.
- **Title:** the session's name from the desktop app, or the name you gave it with a custom title.
- **Project folder,** or `No Project` for a session started without one.
- **Model and effort,** for example `opus-5-5 · high` (desktop app sessions only).
- **Status line:** `needs your reply · 5m`, `running · 45s`, `just now`, `12m ago` or `3h ago`.
- **Transcript size,** in KB or MB.

The session you are in keeps its place by time and has a heavier border. Inside each section the newest session comes first. On a dark theme each section's cards are also faintly tinted in its colour.

**Clicking a card** opens that session in the desktop app. A click is a press and a release on the same card. Dragging off the card or right-clicking does nothing.

**The `▾` / `▸` arrow** in front of a section header folds or unfolds it. Waiting, Recent and Offline can fold; Working now cannot. Your choices are remembered across sessions.

## Commands

There is one command:

| Command | What it does |
| --- | --- |
| `/sessions` | Toggles the Sessions pane. If the pane is on screen, it closes it. Otherwise it scans for sessions right away, opens the pane, and replies with how many sessions are listed. |

The pane opens by itself when a session starts and at least one session is listed (with none, it stays closed until you run `/sessions`), and refreshes itself every minute. Use `/sessions` to hide it, and again to bring it back with a fresh list.

## Install

The mod installs from this GitHub repository. In a terminal, run:

```bash
claude plugin marketplace add wendyyyanto/sessions-panel-mod
```

```bash
claude plugin install recent-sessions@sessions-panel-mod
```

From then on it loads in every session you start or resume, including the desktop app's Code tab. Sessions that are already open pick it up when they are restarted or resumed.

In a terminal session of Claude Code you can do the same from inside it, with `/plugin install recent-sessions --marketplace wendyyyanto/sessions-panel-mod` (answer `y` to add the marketplace, then pick the **user** scope). The `/plugin` command is not available in the desktop app's Code tab; install from a terminal once and the desktop app loads it too.

### From a local copy

To install from a folder on your machine instead (for example a clone you have changed), point the marketplace at the folder:

```bash
claude plugin marketplace add D:\Projects\sessions-panel-mod
```

```bash
claude plugin install recent-sessions@sessions-panel-mod
```

To try it in one session without installing anything, start Claude Code with the folder as a plugin directory. Edits to its files reload while that session runs:

```bash
claude --plugin-dir D:\Projects\sessions-panel-mod
```

## Update

Fetch the latest version of the marketplace, then update the mod:

```bash
claude plugin marketplace update sessions-panel-mod
```

```bash
claude plugin update recent-sessions@sessions-panel-mod
```

Restart or resume your sessions to load the new version. An update is only seen when the `version` in `.claude-plugin/plugin.json` has changed, so bump it with every release.

## Remove

```bash
claude plugin uninstall recent-sessions@sessions-panel-mod
```

To also forget the marketplace:

```bash
claude plugin marketplace remove sessions-panel-mod
```

Open sessions keep the pane until they are restarted or resumed.

## How it works

Once a minute, and whenever you run `/sessions`, the mod:

1. Lists the transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) written in the last 24 hours.
2. Reads the desktop app's own record of each session from `%APPDATA%\Claude\claude-code-sessions` on Windows, or `~/Library/Application Support/Claude/claude-code-sessions` on macOS. That record supplies the title, model, effort, archived flag and the id a click opens.
3. Reads the end of each transcript that changed since the last scan, to tell whether a turn is in flight, waiting on you, or over. A transcript that has not changed is not read again.
4. Redraws the pane, so the `ago` times move on every minute.

Between scans, a running card turns its own spinner and counts its own seconds without redrawing the rest of the pane.

**What it costs you:**

- **No model tokens.** The mod never calls a model and adds nothing to your prompt or conversation.
- **No network.** Everything it reads is a local file. A click hands a `claude://` link to your operating system; nothing else leaves your machine.
- **A little disk reading.** One directory listing a minute, and one read of each transcript that changed in that minute.

## Limitations

**Where it works**

- **Terminal and desktop app only for clicks and the live spinner.** Clickable cards and the turning spinner need a surface that draws a mod's own regions, which only those two do. Elsewhere the cards are drawn still and cannot be clicked.
- **Clicking opens desktop app sessions only.** A card opens a session through the desktop app's `claude://code/continue` link, so a session started in a plain terminal (with no desktop app record) cannot be opened. Neither can the session you are already in.
- **Windows and macOS only for clicking.** It launches the link with `rundll32` on Windows and `open` on macOS. On Linux the click fails with **Could not open that session**.
- **No desktop app records on Linux.** It looks for the app's records only where Windows and macOS keep them, so on Linux cards have no model or effort and archived sessions are not hidden.
- **Installed per machine.** It lists sessions from this computer only, not your other machines or the cloud.

**Which sessions are listed**

- **Only sessions with a title.** A session with no title is left out: a headless run (`claude -p`, an SDK call) or a terminal session you never named.
- **Archived sessions are hidden.** A session you archived in the desktop app is not listed.
- **Time windows are fixed.** Recent is the last hour, Offline is 1 to 5 hours, and Waiting is kept up to 24 hours. A finished session older than 5 hours is not listed. The windows are constants in `hooks/rows.ts`.
- **Resumed or compacted sessions are listed once,** under their newest transcript. This needs the desktop app's record. Without one, an earlier transcript with the same title may appear as well.
- **Opening a session does not make it recent.** Time is taken from the last real message in the transcript, not from when the file last changed.

**How accurate the status is**

- **Updates are up to a minute late.** A session that starts, finishes or begins waiting can take up to a minute to move to its new section. The `ago` times also move once a minute. Only a running card's own elapsed time counts each second.
- **Only some prompts count as waiting.** A question (`AskUserQuestion`), a plan approval (`ExitPlanMode`), and an Edit, Write, MultiEdit or NotebookEdit approval left unanswered for 15 seconds show as Waiting. Any other approval prompt, such as one for a Bash command, looks like a long-running tool and shows as Working now.
- **An abandoned turn reads as running for a while.** If Claude Code crashes or a window is closed mid-turn, the transcript ends the same way a live turn does. The session shows as Working now until 10 minutes after its last message, then as finished.
- **Transcripts over 4 MiB cannot be read.** For those the mod cannot see the last message. Such a session counts as running only while its file was written in the last minute and the desktop app saw it active recently, never as waiting, and its card says plain `running` with no time. Without a desktop app record (its title comes from the transcript), it is not listed at all.
- **It relies on undocumented formats.** The transcript layout and the desktop app's session records are internal to Claude Code and can change in any release. If they change, sessions may be missing or show the wrong status until the mod is updated.

**Display**

- **No GIF or Lottie.** The plugin API has no element for animated images, so the working spinner is a text spinner (`⠋ ⠙ ⠹ …`) at ten steps a second.
- **Tints only on a dark theme.** The card fills are dark washes of each section's colour, so a light theme gets coloured borders only.
- **Colours are fixed** to the Claude palette, in `hooks/palette.ts`.
- **Very narrow panes** cut long titles and folder names off with `…`.

## Develop

The hooks module is `hooks/register.tsx`. The pane's drawing is in `hooks/cards.tsx` and `hooks/card-view.tsx`, each clickable, self-animating card is `hooks/card-client.tsx`, and the parsing and status rules are pure functions in `hooks/rows.ts`.

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

To work on it live, start a session with `claude --plugin-dir <this folder>`; each edit reloads the mod when Claude's turn ends.

## License

[MIT](LICENSE)
