// The Claude brand palette: the only colours this pane draws with. Everything else (titles,
// dimmed text) takes the person's own text colour.
export const CLAUDE = {
  clay: '#D97757', // the signature orange
  kraft: '#D4A27F', // warm tan
  olive: '#788C5D',
  sky: '#6A9BCC',
  fig: '#C46686',
  heather: '#CBCADB',
  cactus: '#BCD1CA',
  oat: '#E3DACC',
  cloud: '#87867F', // neutral grey
} as const

// What each colour is for, so a change of palette is one edit here. Every role has a colour
// of its own, so nothing is told apart from another only by shade.
export const ROLE = {
  waiting: CLAUDE.fig, // Waiting for response
  running: CLAUDE.clay, // Working now: Claude's main brand orange, the colour of work in progress
  done: CLAUDE.sky, // Recent
  offline: CLAUDE.cloud, // Offline - Last 5 Hour
  project: CLAUDE.heather, // a project's folder name
  noProject: CLAUDE.cactus, // a session started without a project
  model: CLAUDE.kraft, // the model's name
  size: CLAUDE.oat, // the transcript's size
} as const

// The pane's dark background, which a card tint is a wash over.
const DARK_BASE = [28, 28, 28] as const

// A faint wash of a palette colour over the dark background: a few shades off it, so a card
// reads as belonging to its section without the fill competing with the text or the border.
export function wash(hex: string, amount = 0.12): string {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `#${channels
    .map((channel, i) => Math.round((DARK_BASE[i] ?? 0) + amount * (channel - (DARK_BASE[i] ?? 0))))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')}`
}
