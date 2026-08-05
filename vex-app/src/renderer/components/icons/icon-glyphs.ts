/**
 * icon-glyphs — the renderer's icon vocabulary, mapped onto `lucide-react`.
 *
 * NAMING RULE: an exported name is lucide's own `*Icon` name for the glyph that
 * is actually drawn — nothing else. The name describes the SHAPE, never the
 * feature that happens to use it, so a glyph can never overpromise (a generic
 * wallet outline is `WalletIcon`, not `BitcoinWalletIcon`). If two features
 * want the same shape they share the one export.
 *
 * Adding an icon: re-export its `*Icon` name from `lucide-react` here, keeping
 * the list alphabetical. Call sites import glyphs from
 * `../components/icons/index.js`, never from `lucide-react` directly — the
 * vendor stays behind this folder.
 */

export {
  ArchiveIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  BadgeCheckIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  BrainIcon,
  BugIcon,
  CableIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckBigIcon,
  CircleCheckIcon,
  CircleStopIcon,
  CopyIcon,
  CpuIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FlameIcon,
  GlobeIcon,
  GripVerticalIcon,
  InfoIcon,
  KeyRoundIcon,
  LockIcon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PercentIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  RocketIcon,
  SearchIcon,
  Settings2Icon,
  SparklesIcon,
  StarIcon,
  TargetIcon,
  TerminalIcon,
  Trash2Icon,
  UserPenIcon,
  WalletIcon,
  WaypointsIcon,
  WifiIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
