/**
 * Legacy glyph names over the pixel sprite. Every `Icon*` export is a thin
 * wrapper around one px symbol (meaning table: the icon map of the redesign),
 * so the importing files keep their imports. WP18 removes these wrappers once
 * call sites render `PxIcon` directly.
 */

import type { JSX } from "react";
import { PxIcon, type PxSize } from "./px/PxIcon.js";
import type { PxName } from "./px/px-names.js";
import type { GlyphProps } from "./glyphs/props.js";

export type { GlyphProps } from "./glyphs/props.js";

/** Component form of one px symbol, for configs that carry an icon per key. */
export const pxGlyph =
  (name: PxName) =>
  ({ size = 16, className }: GlyphProps): JSX.Element => (
    // Legacy call sites pass any pixel size; the sprite stays crisp at any.
    <PxIcon name={name} size={size as PxSize} className={className} />
  );

export const IconArchive = pxGlyph("archive");
export const IconArrowUpRight = pxGlyph("external");
export const IconArrowsUpDown = pxGlyph("trades");
export const IconBadgeCheck = pxGlyph("check");
export const IconBars = pxGlyph("volume");
export const IconBookOpen = pxGlyph("knowledge");
export const IconBrain = pxGlyph("memory");
export const IconBrainCircuit = pxGlyph("models");
export const IconBranch = pxGlyph("branch");
export const IconBug = pxGlyph("report");
export const IconCable = pxGlyph("bridge");
export const IconCheck = pxGlyph("check");
export const IconChevronDown = pxGlyph("chevron-down");
export const IconChevronLeft = pxGlyph("chevron-left");
export const IconChevronRight = pxGlyph("chevron-right");
export const IconChevronUp = pxGlyph("chevron-up");
export const IconCircleAlert = pxGlyph("warning");
export const IconCircleCheck = pxGlyph("check");
export const IconCircleStop = pxGlyph("stop");
export const IconClock = pxGlyph("clock");
export const IconClose = pxGlyph("close");
export const IconCopy = pxGlyph("copy");
export const IconCpu = pxGlyph("tuning");
export const IconData = pxGlyph("list");
export const IconDislike = pxGlyph("report");
export const IconDownload = pxGlyph("download");
export const IconDroplet = pxGlyph("liquidity");
export const IconEdit = pxGlyph("edit");
export const IconEllipsis = pxGlyph("more");
export const IconFile = pxGlyph("file");
export const IconFolderClose = pxGlyph("folder");
export const IconFolderOpen = pxGlyph("folder-open");
export const IconFullscreen = pxGlyph("fullscreen");
export const IconGift = pxGlyph("gift");
export const IconGlobe = pxGlyph("globe");
export const IconGoal = pxGlyph("mission");
export const IconGripVertical = pxGlyph("grip");
export const IconHome = pxGlyph("home");
export const IconInfo = pxGlyph("info");
export const IconInspect = pxGlyph("history");
export const IconKey = pxGlyph("key");
export const IconKeyOutline16 = pxGlyph("key");
export const IconLink = pxGlyph("link");
export const IconLoading = pxGlyph("loading");
export const IconLock = pxGlyph("lock");
export const IconMegaphone = pxGlyph("megaphone");
export const IconMemoryOutline16 = pxGlyph("memory");
export const IconModelOutline16 = pxGlyph("models");
export const IconNewChat = pxGlyph("chat");
export const IconPanelLeft = pxGlyph("panel-left");
export const IconPanelRight = pxGlyph("panel-right");
export const IconPie = pxGlyph("portfolio");
export const IconPlus = pxGlyph("plus");
export const IconQuestion = pxGlyph("question");
export const IconQueue = pxGlyph("queue");
export const IconRefresh = pxGlyph("refresh");
export const IconSearch = pxGlyph("search");
export const IconSend = pxGlyph("send");
export const IconSettings = pxGlyph("settings");
export const IconShield = pxGlyph("shield");
export const IconShieldCheck = pxGlyph("approvals");
export const IconSparkle = pxGlyph("models");
export const IconSplitHorizontal = pxGlyph("split-cols");
export const IconSplitVertical = pxGlyph("split-rows");
export const IconStar = pxGlyph("watchlist-off");
export const IconStarFill = pxGlyph("watchlist");
export const IconStopFill = pxGlyph("stop");
export const IconTarget = pxGlyph("target");
export const IconTerminal = pxGlyph("terminal");
export const IconThemeDark = pxGlyph("theme-dark");
export const IconThemeLight = pxGlyph("theme-light");
export const IconThemeSystem = pxGlyph("theme-system");
export const IconThink = pxGlyph("memory");
export const IconTrash = pxGlyph("trash");
export const IconTuningOutline16 = pxGlyph("tuning");
export const IconUser = pxGlyph("user");
export const IconUsers = pxGlyph("users");
export const IconVaultOutline16 = pxGlyph("lock");
export const IconWallet = pxGlyph("wallet");
export const IconWalletOutline16 = pxGlyph("wallet");
export const IconWarning = pxGlyph("warning");
export const IconWaypoints = pxGlyph("chart");
export const IconWifi = pxGlyph("network");
export const IconWrench = pxGlyph("tools");
