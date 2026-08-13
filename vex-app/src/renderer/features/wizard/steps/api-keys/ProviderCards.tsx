/**
 * ApiKeysStep provider-card bodies — the three `ProviderCard` instances
 * rendered inside the step form (Jupiter / Tavily / Rettiwt / Relay).
 *
 * Each component owns the per-provider chrome (icon, copy, external
 * links, status badge) and forwards the parent-owned uncontrolled secret
 * ref into the `PasswordField`. Markup, copy, hrefs, `data-vex-apikeys-card`
 * selectors, and accessibility (sr-only labels, aria-hidden icons) are
 * preserved verbatim from the inlined cards.
 *
 * Presentational: no state, no IPC of their own. Status badges come from
 * the parent (which derives them via `status-helpers`); secret values
 * stay in the parent's refs and never enter these modules' scope.
 */

import type { JSX, RefObject } from "react";
import { Tavily, X } from "@thesvg/react";
import {
  KeyRoundIcon,
  VexIcon,
  WaypointsIcon,
} from "../../../../components/icons/index.js";
import { Label } from "../../../../components/ui/label.js";
import { PasswordField } from "../../../../components/common/PasswordField.js";
import { ProviderCard, type ProviderCardStatus } from "./ProviderCard.js";

export interface JupiterCardProps {
  readonly status: ProviderCardStatus;
  readonly configured: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

export function JupiterCard({
  status,
  configured,
  inputRef,
}: JupiterCardProps): JSX.Element {
  return (
    <ProviderCard
      slug="jupiter"
      iconSlot={
        <img
          src="/logo/jupiter.png"
          alt=""
          aria-hidden
          draggable={false}
          className="h-6 w-6 object-contain"
        />
      }
      name="Jupiter"
      status={status}
      description="Prices and swaps tokens on Solana."
      detail={
        <>
          The key is free — open the portal, then{" "}
          <span className="font-medium text-[var(--color-text-primary)]">
            API Keys → Create new API key
          </span>
          . Without it, Solana swaps stay unavailable; everything else
          still works.
        </>
      }
      getKey={{
        url: "https://portal.jup.ag/",
        label: "Open Jupiter Portal",
      }}
    >
      <Label htmlFor="vex-apikey-jupiter" className="sr-only">
        Jupiter API key
      </Label>
      <PasswordField
        id="vex-apikey-jupiter"
        autoFocus
        autoComplete="new-password"
        ref={inputRef}
      />
      <p className="text-xs text-[var(--color-text-muted)]">
        {configured
          ? "Leave blank to keep the saved key, or paste a new one to overwrite it."
          : "Leave blank to add later — Solana swaps stay unavailable until you set it."}
      </p>
    </ProviderCard>
  );
}

export interface TavilyCardProps {
  readonly status: ProviderCardStatus;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

export function TavilyCard({
  status,
  inputRef,
}: TavilyCardProps): JSX.Element {
  return (
    <ProviderCard
      slug="tavily"
      iconSlot={<Tavily width={20} height={20} aria-hidden />}
      name="Tavily"
      status={status}
      description="Lets the agent search and read the web."
      detail={
        <>
          Free tier:{" "}
          <span className="font-medium text-[var(--color-text-primary)]">
            1,000 queries a month
          </span>
          . Open the dashboard, then click the + next to API Keys.
        </>
      }
      getKey={{
        url: "https://app.tavily.com/home",
        label: "Open Tavily dashboard",
      }}
    >
      <Label htmlFor="vex-apikey-tavily" className="sr-only">
        Tavily API key
      </Label>
      <PasswordField
        id="vex-apikey-tavily"
        autoComplete="new-password"
        ref={inputRef}
      />
    </ProviderCard>
  );
}

export interface RettiwtCardProps {
  readonly status: ProviderCardStatus;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

export function RettiwtCard({
  status,
  inputRef,
}: RettiwtCardProps): JSX.Element {
  return (
    <ProviderCard
      slug="rettiwt"
      iconSlot={<X width={18} height={18} aria-hidden />}
      name="Rettiwt (X / Twitter)"
      status={status}
      description="Posts and reads from an X (Twitter) account."
      detail={
        <>
          The key is your X session cookie, so use a{" "}
          <span className="font-medium text-[var(--color-text-primary)]">
            secondary X account
          </span>{" "}
          — Vex keeps the key encrypted locally, but X may still flag
          automation activity (~1 in 100k risk). Sign in in an incognito
          window, then click the extension to generate the key. It stays
          valid for 5 years from login.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <a
          href="https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          Chrome: X Auth Helper ↗
        </a>
        <span aria-hidden className="text-[var(--color-text-muted)]">
          ·
        </span>
        <a
          href="https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[var(--color-text-primary)] underline underline-offset-2 hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          Firefox: Rettiwt Auth Helper ↗
        </a>
      </div>
      <Label htmlFor="vex-apikey-rettiwt" className="sr-only">
        Rettiwt API key
      </Label>
      <PasswordField
        id="vex-apikey-rettiwt"
        autoComplete="new-password"
        ref={inputRef}
      />
    </ProviderCard>
  );
}

export interface RelayCardProps {
  readonly status: ProviderCardStatus;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * Relay is the ONLY optional-by-design card here: bridging works fully without
 * a key, so the copy must not imply anything is unavailable without one.
 */
export function RelayCard({
  status,
  inputRef,
}: RelayCardProps): JSX.Element {
  return (
    <ProviderCard
      slug="relay"
      iconSlot={
        // strokeWidth 2 (lucide's own default), not the shell's 1.75: this card
        // imported the glyph directly until now, so 2 is what it has always
        // drawn. Routing it through the facade must not restyle it.
        <VexIcon icon={WaypointsIcon} size={18} strokeWidth={2} aria-hidden />
      }
      name="Relay"
      status={status}
      description="Cross-chain bridging."
      detail={
        <>
          Optional. Bridging works without it; a key raises Relay&apos;s rate
          limits and enables faster live bridge status.
        </>
      }
      getKey={{
        url: "https://dashboard.relay.link",
        label: "Open Relay dashboard",
      }}
    >
      <Label htmlFor="vex-apikey-relay" className="sr-only">
        Relay API key
      </Label>
      <PasswordField
        id="vex-apikey-relay"
        autoComplete="new-password"
        ref={inputRef}
      />
    </ProviderCard>
  );
}

export interface LighterTradingCardProps {
  readonly environment: "core" | "rhc";
  readonly status: ProviderCardStatus;
  readonly configured: boolean;
  readonly accountIndexRef: RefObject<HTMLInputElement | null>;
  readonly apiKeyIndexRef: RefObject<HTMLInputElement | null>;
  readonly privateKeyRef: RefObject<HTMLInputElement | null>;
  readonly removeRef: RefObject<HTMLInputElement | null>;
}

export function LighterTradingCard({
  environment,
  status,
  configured,
  accountIndexRef,
  apiKeyIndexRef,
  privateKeyRef,
  removeRef,
}: LighterTradingCardProps): JSX.Element {
  const title =
    environment === "rhc"
      ? "Lighter RHC trading"
      : "Lighter Core trading";
  const prefix = `vex-apikey-lighter-${environment}-trading`;
  return (
    <ProviderCard
      slug={environment === "rhc" ? "lighter-rhc-trading" : "lighter-core-trading"}
      iconSlot={<VexIcon icon={KeyRoundIcon} size={18} aria-hidden />}
      name={title}
      status={status}
      description="One key for Lighter previews, approval preparation, and trading actions."
      detail={
        <>
          Add the trading API private key from Lighter. Vex uses it only from
          the encrypted local vault, keeps preview paths read-only, and still
          requires your explicit approval before any order can be submitted.
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label
            htmlFor={`${prefix}-account-index`}
            className="text-xs text-[var(--color-text-muted)]"
          >
            Account index
          </Label>
          <input
            id={`${prefix}-account-index`}
            ref={accountIndexRef}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            autoComplete="off"
            className="h-10 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-elevated)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor={`${prefix}-api-key-index`}
            className="text-xs text-[var(--color-text-muted)]"
          >
            API-key index
          </Label>
          <input
            id={`${prefix}-api-key-index`}
            ref={apiKeyIndexRef}
            type="number"
            min={4}
            max={254}
            step={1}
            inputMode="numeric"
            autoComplete="off"
            className="h-10 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-elevated)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
      <Label htmlFor={`${prefix}-private-key`} className="sr-only">
        {title} API private key
      </Label>
      <PasswordField
        id={`${prefix}-private-key`}
        autoComplete="new-password"
        ref={privateKeyRef}
      />
      <label
        htmlFor={`${prefix}-remove`}
        className="flex items-start gap-2 text-xs text-[var(--color-text-muted)]"
      >
        <input
          id={`${prefix}-remove`}
          ref={removeRef}
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-subtle)] bg-transparent"
        />
        Remove the saved trading key for this account/API-key scope.
      </label>
      <p className="text-xs text-[var(--color-text-muted)]">
        {configured
          ? "Leave blank to keep the saved trading key, paste a replacement, or check remove."
          : "Needed once to enable Lighter account-aware previews and approval preparation."}
      </p>
    </ProviderCard>
  );
}
