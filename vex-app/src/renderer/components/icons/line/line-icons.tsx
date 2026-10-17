/**
 * One component per line icon, a registry keyed by icon name, and `LineIcon`
 * for config-driven call sites (a nav list that carries a name per row).
 *
 * Every component takes the same two props, `size` (14, 16 or 20; default 16)
 * and `className`; the colour is the text colour of the place it sits in.
 */

import type { JSX } from "react";
import { LineSvg, type LineIconProps } from "./LineSvg.js";
import { LINE_GLYPHS, type LineIconName } from "./line-glyphs.js";

export interface LineIconComponent {
  (props: LineIconProps): JSX.Element;
  displayName: string;
}

const pascal = (name: string): string =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

function make(name: LineIconName): LineIconComponent {
  const { draw } = LINE_GLYPHS[name];
  const Glyph = ({ size, className }: LineIconProps): JSX.Element => (
    <LineSvg size={size} className={className}>
      {draw}
    </LineSvg>
  );
  return Object.assign(Glyph, { displayName: `Line${pascal(name)}` });
}

export const LineNewChat = make("new-chat");
export const LineSearch = make("search");
export const LineChat = make("chat");
export const LineMissions = make("missions");
export const LinePortfolio = make("portfolio");
export const LineBoard = make("board");
export const LineLighter = make("lighter");
export const LineStudio = make("studio");
export const LineSettings = make("settings");
export const LinePanelLeft = make("panel-left");
export const LinePanelRight = make("panel-right");
export const LineChevronUp = make("chevron-up");
export const LineChevronDown = make("chevron-down");
export const LineChevronLeft = make("chevron-left");
export const LineChevronRight = make("chevron-right");
export const LineChevronsUpDown = make("chevrons-up-down");
export const LineClose = make("close");
export const LinePlus = make("plus");
export const LineCheck = make("check");
export const LineMenu = make("menu");
export const LineMore = make("more");
export const LineBack = make("back");
export const LineSend = make("send");
export const LineArrowUp = make("arrow-up");
export const LineArrowDown = make("arrow-down");
export const LineStop = make("stop");
export const LinePlay = make("play");
export const LinePause = make("pause");
export const LineAttach = make("attach");
export const LineLock = make("lock");
export const LineShield = make("shield");
export const LineCopy = make("copy");
export const LineExternal = make("external");
export const LineRefresh = make("refresh");
export const LineUndo = make("undo");
export const LineRedo = make("redo");
export const LineEdit = make("edit");
export const LineTrash = make("trash");
export const LinePin = make("pin");
export const LineDownload = make("download");
export const LineUpdate = make("update");
export const LineCamera = make("camera");
export const LineBell = make("bell");
export const LineInfo = make("info");
export const LineWarning = make("warning");
export const LineQuestion = make("question");
export const LineClock = make("clock");
export const LineInbox = make("inbox");
export const LineActivity = make("activity");
export const LineStrategies = make("strategies");
export const LineMarkets = make("markets");
export const LineCandles = make("candles");
export const LineWatchlist = make("watchlist");
export const LineWallet = make("wallet");
export const LineSwap = make("swap");
export const LineFlame = make("flame");
export const LinePercent = make("percent");
export const LineRocket = make("rocket");
export const LineDrop = make("drop");
export const LineBars = make("bars");
export const LineArrows = make("arrows");
export const LineUsers = make("users");
export const LineUser = make("user");
export const LineSpark = make("spark");
export const LineZen = make("zen");
export const LineHome = make("home");
export const LineFolder = make("folder");
export const LineFile = make("file");
export const LineArchive = make("archive");
export const LineTerminal = make("terminal");
export const LineSplitVertical = make("split-vertical");
export const LineSplitHorizontal = make("split-horizontal");
export const LineCursor = make("cursor");
export const LineHLine = make("h-line");
export const LineTrendLine = make("trend-line");
export const LineRectangle = make("rectangle");
export const LineFib = make("fib");
export const LineRuler = make("ruler");
export const LinePreferences = make("preferences");
export const LineVault = make("vault");
export const LineKey = make("key");
export const LineModel = make("model");
export const LineMemory = make("memory");
export const LineDatabase = make("database");
export const LineTuning = make("tuning");
export const LineLink = make("link");
export const LineDocker = make("docker");
export const LineWifi = make("wifi");
export const LineWifiOff = make("wifi-off");
export const LineDesktop = make("desktop");
export const LineGear = make("gear");
export const LineScan = make("scan");
export const LineBook = make("book");
export const LineSun = make("sun");
export const LineMoon = make("moon");

/** Every icon by name; the type makes a missing entry a compile error. */
export const LINE_ICONS: { readonly [K in LineIconName]: LineIconComponent } = {
  "new-chat": LineNewChat,
  search: LineSearch,
  chat: LineChat,
  missions: LineMissions,
  portfolio: LinePortfolio,
  board: LineBoard,
  lighter: LineLighter,
  studio: LineStudio,
  settings: LineSettings,
  "panel-left": LinePanelLeft,
  "panel-right": LinePanelRight,
  "chevron-up": LineChevronUp,
  "chevron-down": LineChevronDown,
  "chevron-left": LineChevronLeft,
  "chevron-right": LineChevronRight,
  "chevrons-up-down": LineChevronsUpDown,
  close: LineClose,
  plus: LinePlus,
  check: LineCheck,
  menu: LineMenu,
  more: LineMore,
  back: LineBack,
  send: LineSend,
  "arrow-up": LineArrowUp,
  "arrow-down": LineArrowDown,
  stop: LineStop,
  play: LinePlay,
  pause: LinePause,
  attach: LineAttach,
  lock: LineLock,
  shield: LineShield,
  copy: LineCopy,
  external: LineExternal,
  refresh: LineRefresh,
  undo: LineUndo,
  redo: LineRedo,
  edit: LineEdit,
  trash: LineTrash,
  pin: LinePin,
  download: LineDownload,
  update: LineUpdate,
  camera: LineCamera,
  bell: LineBell,
  info: LineInfo,
  warning: LineWarning,
  question: LineQuestion,
  clock: LineClock,
  inbox: LineInbox,
  activity: LineActivity,
  strategies: LineStrategies,
  markets: LineMarkets,
  candles: LineCandles,
  watchlist: LineWatchlist,
  wallet: LineWallet,
  swap: LineSwap,
  flame: LineFlame,
  percent: LinePercent,
  rocket: LineRocket,
  drop: LineDrop,
  bars: LineBars,
  arrows: LineArrows,
  users: LineUsers,
  user: LineUser,
  spark: LineSpark,
  zen: LineZen,
  home: LineHome,
  folder: LineFolder,
  file: LineFile,
  archive: LineArchive,
  terminal: LineTerminal,
  "split-vertical": LineSplitVertical,
  "split-horizontal": LineSplitHorizontal,
  cursor: LineCursor,
  "h-line": LineHLine,
  "trend-line": LineTrendLine,
  rectangle: LineRectangle,
  fib: LineFib,
  ruler: LineRuler,
  preferences: LinePreferences,
  vault: LineVault,
  key: LineKey,
  model: LineModel,
  memory: LineMemory,
  database: LineDatabase,
  tuning: LineTuning,
  link: LineLink,
  docker: LineDocker,
  wifi: LineWifi,
  "wifi-off": LineWifiOff,
  desktop: LineDesktop,
  gear: LineGear,
  scan: LineScan,
  book: LineBook,
  sun: LineSun,
  moon: LineMoon,
};

export interface LineIconByNameProps extends LineIconProps {
  readonly name: LineIconName;
}

export function LineIcon({ name, size, className }: LineIconByNameProps): JSX.Element {
  return (
    <LineSvg size={size} className={className}>
      {LINE_GLYPHS[name].draw}
    </LineSvg>
  );
}
