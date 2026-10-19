/**
 * The drawing of every line icon, one entry per name. Each entry is the inner
 * SVG markup of docs/design/R3-MINIMAL.md appendix A (the 16 x 16 grid, the
 * paint lives on the root in `LineSvg`), keyed by the name the app uses.
 *
 * `spec` is the row id in appendix A, or null for a drawing the appendix does
 * not list yet (none today). The mirrored chevrons, warning, question, user,
 * archive, branch and thumbs-down (the transcript's message keys) were derived
 * in the same grid and stroke and have their own rows.
 * Several names may share one spec row (`send` is the `up` arrow).
 */

import type { JSX } from "react";

export interface LineGlyphDef {
  readonly spec: string | null;
  readonly draw: JSX.Element;
}

export const LINE_GLYPHS = {
  // Navigation and window chrome
  "new-chat": {
    spec: "new",
    draw: (
      <>
        <path d="M8.5 2.5h-6v11h11v-6" />
        <path d="M6.5 9.5l.5-2 6-6 1.5 1.5-6 6z" />
      </>
    ),
  },
  search: {
    spec: "search",
    draw: (
      <>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5l3.5 3.5" />
      </>
    ),
  },
  chat: {
    spec: "chat",
    draw: <path d="M2.5 3h11v8H7.5l-3 2.5V11h-2z" />,
  },
  missions: {
    spec: "missions",
    draw: <path d="M3.5 14.5V2.5h9l-2 3 2 3h-9" />,
  },
  portfolio: {
    spec: "portfolio",
    draw: (
      <>
        <path d="M13.5 9A5.5 5.5 0 1 1 7 2.5V9z" />
        <path d="M9.5 1.5a5 5 0 0 1 5 5h-5z" />
      </>
    ),
  },
  board: {
    spec: "board",
    draw: <path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />,
  },
  lighter: {
    spec: "lighter",
    draw: (
      <>
        <path d="M4.5 1.5v13M11.5 1.5v13" />
        <path d="M3 4.5h3v6H3zM10 6h3v4h-3z" />
      </>
    ),
  },
  studio: {
    spec: "studio",
    draw: (
      <>
        <path d="M1.5 2.5h13v11h-13z" />
        <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" />
      </>
    ),
  },
  settings: {
    spec: "settings",
    draw: (
      <>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
      </>
    ),
  },
  "panel-left": {
    spec: "panelL",
    draw: (
      <>
        <path d="M1.5 2.5h13v11h-13z" />
        <path d="M6 2.5v11" />
      </>
    ),
  },
  "panel-right": {
    spec: "panelR",
    draw: (
      <>
        <path d="M1.5 2.5h13v11h-13z" />
        <path d="M10 2.5v11" />
      </>
    ),
  },
  "chevron-up": {
    spec: "chevU",
    draw: <path d="M4 10l4-4 4 4" />,
  },
  "chevron-down": {
    spec: "chevD",
    draw: <path d="M4 6l4 4 4-4" />,
  },
  "chevron-left": {
    spec: "chevL",
    draw: <path d="M10 4l-4 4 4 4" />,
  },
  "chevron-right": {
    spec: "chevR",
    draw: <path d="M6 4l4 4-4 4" />,
  },
  "chevrons-up-down": {
    spec: "chevUD",
    draw: <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />,
  },
  close: {
    spec: "x",
    draw: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  },
  plus: {
    spec: "plus",
    draw: <path d="M8 2.5v11M2.5 8h11" />,
  },
  check: {
    spec: "check",
    draw: <path d="M3 8.5l3 3 7-7" />,
  },
  menu: {
    spec: "menu",
    draw: <path d="M2 4.5h12M2 8h12M2 11.5h12" />,
  },
  more: {
    spec: "dots",
    draw: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />,
  },
  back: {
    spec: "back",
    draw: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  },

  // Composer and actions
  send: {
    spec: "up",
    draw: <path d="M8 13.5v-11M3.5 7L8 2.5 12.5 7" />,
  },
  "arrow-up": {
    spec: "up",
    draw: <path d="M8 13.5v-11M3.5 7L8 2.5 12.5 7" />,
  },
  "arrow-down": {
    spec: "down",
    draw: <path d="M8 2.5v11M3.5 9L8 13.5 12.5 9" />,
  },
  stop: {
    spec: "stop",
    draw: <path d="M4 4h8v8H4z" />,
  },
  play: {
    spec: "play",
    draw: <path d="M4.5 2.5l9 5.5-9 5.5z" />,
  },
  pause: {
    spec: "pause",
    draw: <path d="M5 3v10M11 3v10" />,
  },
  attach: {
    spec: "clip",
    draw: <path d="M10.5 4.5l-5 5a1.4 1.4 0 0 0 2 2l5.5-5.5a2.8 2.8 0 0 0-4-4L3.5 7.5a4.2 4.2 0 0 0 6 6l4-4" />,
  },
  lock: {
    spec: "lock",
    draw: (
      <>
        <path d="M3.5 7.5h9v6h-9z" />
        <path d="M5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2" />
      </>
    ),
  },
  shield: {
    spec: "shield",
    draw: <path d="M8 1.5l5.5 2v4.5c0 3.2-2.4 5.5-5.5 6.5-3.1-1-5.5-3.3-5.5-6.5V3.5z" />,
  },
  copy: {
    spec: "copy",
    draw: (
      <>
        <path d="M5.5 5.5h8v8h-8z" />
        <path d="M10.5 5.5v-3h-8v8h3" />
      </>
    ),
  },
  external: {
    spec: "ext",
    draw: (
      <>
        <path d="M6.5 3.5h-4v10h10v-4" />
        <path d="M9 2.5h4.5V7M13.5 2.5L7 9" />
      </>
    ),
  },
  refresh: {
    spec: "refresh",
    draw: (
      <>
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M12.5 1.5v3h-3" />
      </>
    ),
  },
  undo: {
    spec: "undo",
    draw: (
      <>
        <path d="M5.5 3.5L2.5 6.5l3 3" />
        <path d="M2.5 6.5h7a4 4 0 0 1 0 8h-3" />
      </>
    ),
  },
  redo: {
    spec: "redo",
    draw: (
      <>
        <path d="M10.5 3.5l3 3-3 3" />
        <path d="M13.5 6.5h-7a4 4 0 0 0 0 8h3" />
      </>
    ),
  },
  edit: {
    spec: "edit",
    draw: <path d="M10.5 2.5l3 3-8 8h-3v-3z" />,
  },
  trash: {
    spec: "trash",
    draw: <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />,
  },
  pin: {
    spec: "pin",
    draw: (
      <>
        <path d="M6 2.5h4l-.5 4 2.5 2.5H4l2.5-2.5z" />
        <path d="M8 9v5" />
      </>
    ),
  },
  download: {
    spec: "download",
    draw: <path d="M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11" />,
  },
  update: {
    spec: "dl",
    draw: <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" />,
  },
  camera: {
    spec: "camera",
    draw: (
      <>
        <path d="M1.5 4.5h3l1.5-2h4l1.5 2h3v9h-13z" />
        <circle cx="8" cy="8.8" r="2.6" />
      </>
    ),
  },

  // Status and notices
  bell: {
    spec: "bell",
    draw: (
      <>
        <path d="M3.5 11.5h9l-1.2-1.8V6.5a3.3 3.3 0 0 0-6.6 0v3.2z" />
        <path d="M6.5 13.5h3" />
      </>
    ),
  },
  info: {
    spec: "info",
    draw: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7v4.5M8 4.6v.1" />
      </>
    ),
  },
  warning: {
    spec: "warning",
    draw: (
      <>
        <path d="M8 2l6.5 11.5h-13z" />
        <path d="M8 6.5v3.5M8 11.8v.1" />
      </>
    ),
  },
  question: {
    spec: "question",
    draw: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.1-1.8 1.4-1.8 2.6M8 11.4v.1" />
      </>
    ),
  },
  clock: {
    spec: "clock",
    draw: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5V8l2.5 1.5" />
      </>
    ),
  },
  inbox: {
    spec: "inbox",
    draw: (
      <>
        <path d="M1.5 9.5l2-6.5h9l2 6.5v4h-13z" />
        <path d="M1.5 9.5h4l1 1.5h3l1-1.5h4" />
      </>
    ),
  },
  activity: {
    spec: "activity",
    draw: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  },

  // Pages, markets and files
  strategies: {
    spec: "strategies",
    draw: (
      <>
        <path d="M1.5 13.5l4-5 3 2.5 6-7.5" />
        <path d="M10.5 3.5h4v4" />
      </>
    ),
  },
  markets: {
    spec: "markets",
    draw: (
      <>
        <path d="M4 1.5v13M12 1.5v13" />
        <path d="M2.5 4h3v7h-3zM10.5 5.5h3v5h-3z" />
        <path d="M8 3v10" />
      </>
    ),
  },
  candles: {
    spec: "candles",
    draw: (
      <>
        <path d="M4.5 1.5v13M11.5 1.5v13" />
        <path d="M3 4.5h3v6H3zM10 6h3v4h-3z" />
      </>
    ),
  },
  watchlist: {
    spec: "watchlist",
    draw: <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z" />,
  },
  wallet: {
    spec: "wallet",
    draw: (
      <>
        <path d="M1.5 4h13v9.5h-13z" />
        <path d="M1.5 4l9-2.5V4" />
        <path d="M11 8.5h1" />
      </>
    ),
  },
  swap: {
    spec: "swap",
    draw: <path d="M2.5 5h10l-2.5-2.5M13.5 11h-10l2.5 2.5" />,
  },
  flame: {
    spec: "flame",
    draw: <path d="M8 14.5c-2.8 0-4.5-1.8-4.5-4.3C3.5 6.7 8 5.5 7 1.5c3 1.6 5.5 4.5 5.5 8.2 0 2.9-1.9 4.8-4.5 4.8z" />,
  },
  percent: {
    spec: "percent",
    draw: (
      <>
        <path d="M3 13L13 3" />
        <circle cx="4.5" cy="4.5" r="1.8" />
        <circle cx="11.5" cy="11.5" r="1.8" />
      </>
    ),
  },
  rocket: {
    spec: "rocket",
    draw: (
      <>
        <path d="M9.5 2.5c2-1 4-1 4-1s0 2-1 4l-5 5-3-3z" />
        <path d="M4.5 7.5l-2 .5 1.5-3h3M8.5 11.5l-.5 2 3-1.5v-3" />
      </>
    ),
  },
  drop: {
    spec: "drop",
    draw: <path d="M8 1.8C10.5 5 12.5 7.3 12.5 9.8a4.5 4.5 0 0 1-9 0C3.5 7.3 5.5 5 8 1.8z" />,
  },
  bars: {
    spec: "bars",
    draw: <path d="M3 13.5V9M6.5 13.5V6M10 13.5V8M13.5 13.5V3.5" />,
  },
  arrows: {
    spec: "arrows",
    draw: <path d="M5 13.5v-11L2.5 5M11 2.5v11L13.5 11" />,
  },
  users: {
    spec: "users",
    draw: (
      <>
        <circle cx="6" cy="5.5" r="2.5" />
        <path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
        <path d="M11 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.8c1.3.6 2 1.9 2 3.7" />
      </>
    ),
  },
  user: {
    spec: "user",
    draw: (
      <>
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M3.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      </>
    ),
  },
  spark: {
    spec: "spark",
    draw: (
      <>
        <path d="M8 1.5l1.3 4.2 4.2 1.3-4.2 1.3L8 12.5 6.7 8.3 2.5 7l4.2-1.3z" />
        <path d="M13 11.5v3M11.5 13h3" />
      </>
    ),
  },
  zen: {
    spec: "zen",
    draw: <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />,
  },
  home: {
    spec: "home",
    draw: (
      <>
        <path d="M2.5 7.5L8 2.5l5.5 5v6h-11z" />
        <path d="M6.5 13.5V10h3v3.5" />
      </>
    ),
  },
  folder: {
    spec: "folder",
    draw: <path d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13z" />,
  },
  file: {
    spec: "file",
    draw: (
      <>
        <path d="M3.5 1.5h6l3 3v10h-9z" />
        <path d="M9.5 1.5v3h3" />
      </>
    ),
  },
  // Message actions. Drawn in the same grid and stroke for the transcript's
  // hover keys; their rows were added to appendix A with W4-6.
  branch: {
    spec: "branch",
    draw: (
      <>
        <path d="M4.5 2v8.9" />
        <circle cx="4.5" cy="12.5" r="1.6" />
        <circle cx="11.5" cy="4.5" r="1.6" />
        <path d="M11.5 6.1a5.4 5.4 0 0 1-5.4 6.4" />
      </>
    ),
  },
  "thumbs-down": {
    spec: "thumbsDown",
    draw: (
      <>
        <path d="M2.5 2.5h3v7h-3z" />
        <path d="M5.5 2.5h6.8l1.2 5.5v1.5H9.3l.5 3c.1 1-.6 1.8-1.5 1.5-.5-.2-.8-.6-1-1L5.5 9.5" />
      </>
    ),
  },
  archive: {
    spec: "archive",
    draw: (
      <>
        <path d="M1.5 3h13v3h-13z" />
        <path d="M2.5 6v7.5h11V6M6.5 9h3" />
      </>
    ),
  },
  terminal: {
    spec: "term",
    draw: (
      <>
        <path d="M1.5 2.5h13v11h-13z" />
        <path d="M4 6l2.5 2L4 10M8 10.5h4" />
      </>
    ),
  },
  "split-vertical": {
    spec: "splitV",
    draw: <path d="M1.5 2.5h13v11h-13zM8 2.5v11" />,
  },
  "split-horizontal": {
    spec: "splitH",
    draw: <path d="M1.5 2.5h13v11h-13zM1.5 8h13" />,
  },

  // Chart tools
  cursor: {
    spec: "cursor",
    draw: <path d="M3.5 2.5l9 5-4 1-2 4z" />,
  },
  "h-line": {
    spec: "hline",
    draw: (
      <>
        <path d="M1.5 8h13" />
        <circle cx="8" cy="8" r="1.4" />
      </>
    ),
  },
  "trend-line": {
    spec: "trend",
    draw: (
      <>
        <path d="M2.5 13.5l11-11" />
        <circle cx="2.8" cy="13.2" r="1.2" />
        <circle cx="13.2" cy="2.8" r="1.2" />
      </>
    ),
  },
  rectangle: {
    spec: "rect",
    draw: <path d="M2.5 3.5h11v9h-11z" />,
  },
  fib: {
    spec: "fib",
    draw: (
      <>
        <path d="M1.5 3.5h13M1.5 7h13M1.5 10.5h13M1.5 14h13" />
        <path d="M2 13.5L14 4" />
      </>
    ),
  },
  ruler: {
    spec: "ruler",
    draw: <path d="M1.5 10.5h13v3h-13zM4 10.5v1.5M7 10.5v1.5M10 10.5v1.5M13 10.5v1.5" />,
  },

  // Settings and system
  preferences: {
    spec: "prefs",
    draw: (
      <>
        <path d="M2 3.5h12v9H2z" />
        <path d="M2 6h12" />
        <path d="M4 4.7h.5M5.8 4.7h.5" />
      </>
    ),
  },
  vault: {
    spec: "vault",
    draw: (
      <>
        <path d="M2 2.5h12v11H2z" />
        <circle cx="8" cy="8" r="2.5" />
        <path d="M8 5.5V4M8 12v-1.5M3.5 13.5V15M12.5 13.5V15" />
      </>
    ),
  },
  key: {
    spec: "key",
    draw: (
      <>
        <circle cx="5" cy="8" r="3" />
        <path d="M8 8h6.5M12 8v2.5M14 8v2" />
      </>
    ),
  },
  model: {
    spec: "model",
    draw: (
      <>
        <path d="M4.5 4.5h7v7h-7z" />
        <path d="M6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3" />
      </>
    ),
  },
  memory: {
    spec: "memory",
    draw: (
      <>
        <path d="M4 2.5h8v11H4z" />
        <path d="M6.5 5.5h3M6.5 8h3M6.5 10.5h2" />
        <path d="M2.5 5h1.5M2.5 8h1.5M2.5 11h1.5M12 5h1.5M12 8h1.5M12 11h1.5" />
      </>
    ),
  },
  database: {
    spec: "db",
    draw: (
      <>
        <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
        <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
      </>
    ),
  },
  tuning: {
    spec: "tuning",
    draw: (
      <>
        <path d="M2 4.5h12M2 11.5h12" />
        <path d="M5 3v3M10.5 10v3" />
      </>
    ),
  },
  link: {
    spec: "link",
    draw: (
      <>
        <path d="M6.5 9.5l3-3" />
        <path d="M7.5 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L11 8M8.5 11.5L7 13a2.5 2.5 0 0 1-3.5-3.5L5 8" />
      </>
    ),
  },
  wifi: {
    spec: "wifi",
    draw: (
      <>
        <path d="M1.5 6a9 9 0 0 1 13 0M3.8 8.6a5.8 5.8 0 0 1 8.4 0M6 11.1a2.8 2.8 0 0 1 4 0" />
        <path d="M8 13.4h.01" />
      </>
    ),
  },
  "wifi-off": {
    spec: "offline",
    draw: (
      <>
        <path d="M1.5 6a9 9 0 0 1 13 0M6 11.1a2.8 2.8 0 0 1 4 0" />
        <path d="M2 2l12 12" />
      </>
    ),
  },
  desktop: {
    spec: "os",
    draw: (
      <>
        <path d="M1.5 2.5h13v9h-13z" />
        <path d="M5.5 14h5M8 11.5V14" />
      </>
    ),
  },
  gear: {
    spec: "gear",
    draw: (
      <>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
      </>
    ),
  },
  scan: {
    spec: "scan",
    draw: (
      <>
        <path d="M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11" />
        <path d="M4.5 8h7" />
      </>
    ),
  },
  book: {
    spec: "book",
    draw: <path d="M2 3h4.5A1.5 1.5 0 0 1 8 4.5v9A1.5 1.5 0 0 0 6.5 12H2zM14 3H9.5A1.5 1.5 0 0 0 8 4.5v9A1.5 1.5 0 0 1 9.5 12H14z" />,
  },
  sun: {
    spec: "sun",
    draw: (
      <>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" />
      </>
    ),
  },
  moon: {
    spec: "moon",
    draw: <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" />,
  },
} satisfies Record<string, LineGlyphDef>;

export type LineIconName = keyof typeof LINE_GLYPHS;

export const LINE_ICON_NAMES = Object.keys(LINE_GLYPHS) as readonly LineIconName[];
