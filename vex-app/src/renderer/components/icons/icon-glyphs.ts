/**
 * icon-glyphs — the renderer's icon vocabulary, mapped onto `lucide-react`.
 *
 * The exported names are the ones the shell already used when the icons came
 * from `@hugeicons/core-free-icons`. They are kept DELIBERATELY: the vendor
 * swap was a mechanical change, and renaming ~50 call sites in the same commit
 * would have buried the one thing worth reviewing (which lucide glyph replaced
 * which hugeicons glyph). Renaming these to lucide's own names is a separate,
 * independently reviewable step.
 *
 * Adding an icon: import it from `lucide-react` here and re-export it. Call
 * sites import glyphs from `../components/icons/index.js`, never from
 * `lucide-react` directly — the vendor stays behind this folder.
 */

import {
  Archive,
  ArrowUp,
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Brain,
  BrainCircuit,
  Bug,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleCheckBig,
  CircleStop,
  Copy,
  Cpu,
  Download,
  Eye,
  File,
  Flame,
  Globe,
  Info,
  KeyRound,
  Lock,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Percent,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Target,
  Terminal,
  Trash2,
  UserPen,
  Wallet,
  Wifi,
  Wrench,
  X,
} from "lucide-react";

export const Add01Icon = Plus;
export const AiBrain05Icon = BrainCircuit;
export const AiChat01Icon = MessageSquare;
export const AiWebBrowsingIcon = Globe;
export const AlertCircleIcon = CircleAlert;
export const Archive02Icon = Archive;
export const ArrowDown01Icon = ChevronDown;
export const ArrowLeft01Icon = ChevronLeft;
export const ArrowRight01Icon = ChevronRight;
export const ArrowUp01Icon = ArrowUp;
export const ArrowUpRight01Icon = ArrowUpRight;
/** No crypto-specific wallet glyph in lucide — the generic wallet stands in. */
export const BitcoinWalletIcon = Wallet;
export const BookOpen01Icon = BookOpen;
export const Brain01Icon = Brain;
export const Bug02Icon = Bug;
export const Cancel01Icon = X;
export const CheckmarkBadge02Icon = BadgeCheck;
export const CheckmarkCircle01Icon = CircleCheck;
export const CheckmarkCircle02Icon = CircleCheckBig;
export const ConnectIcon = Cable;
export const Copy01Icon = Copy;
export const CpuIcon = Cpu;
export const Delete02Icon = Trash2;
export const Download01Icon = Download;
export const File01Icon = File;
export const FireIcon = Flame;
export const InformationCircleIcon = Info;
export const Key02Icon = KeyRound;
export const PanelLeftCloseIcon = PanelLeftClose;
export const PanelLeftOpenIcon = PanelLeftOpen;
export const PanelRightCloseIcon = PanelRightClose;
export const PanelRightOpenIcon = PanelRightOpen;
export const PercentSquareIcon = Percent;
export const Radar01Icon = Radar;
export const RefreshIcon = RefreshCw;
export const Search01Icon = Search;
export const Settings02Icon = Settings2;
export const SparklesIcon = Sparkles;
export const SquareLock02Icon = Lock;
export const StarIcon = Star;
export const StopCircleIcon = CircleStop;
export const Target02Icon = Target;
export const TerminalIcon = Terminal;
export const UserEdit01Icon = UserPen;
export const ViewIcon = Eye;
export const Wallet01Icon = Wallet;
export const Wifi02Icon = Wifi;
export const Wrench01Icon = Wrench;
