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
import type { LighterManagedTradingScope } from "@shared/schemas/onboarding.js";
import { IconKey, IconWaypoints } from "../../../../components/icons/index.js";
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
          The key is free - open the portal, then{" "}
          <span className="font-medium text-ink-primary">
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
      <p className="text-xs text-ink-tertiary">
        {configured
          ? "Leave blank to keep the saved key, or paste a new one to overwrite it."
          : "Leave blank to add later - Solana swaps stay unavailable until you set it."}
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
          <span className="font-medium text-ink-primary">
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
          <span className="font-medium text-ink-primary">
            secondary X account
          </span>{" "}
          - Vex keeps the key encrypted locally, but X may still flag
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
          className="font-medium text-ink-primary underline underline-offset-2 hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
        >
          Chrome: X Auth Helper ↗
        </a>
        <span aria-hidden className="text-ink-tertiary">
          ·
        </span>
        <a
          href="https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-ink-primary underline underline-offset-2 hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
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
        <IconWaypoints size={18} />
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
  readonly managedScopes: readonly LighterManagedTradingScope[];
  readonly accountIndexRef: RefObject<HTMLInputElement | null>;
  readonly apiKeyIndexRef: RefObject<HTMLInputElement | null>;
  readonly privateKeyRef: RefObject<HTMLInputElement | null>;
  readonly removeRef: RefObject<HTMLInputElement | null>;
}

export function LighterTradingCard({
  environment,
  status,
  configured,
  managedScopes,
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
  const managed = managedScopes.length > 0;
  const manualFields = (
    <LighterManualTradingFields
      title={title}
      prefix={prefix}
      configured={configured}
      managed={managed}
      accountIndexRef={accountIndexRef}
      apiKeyIndexRef={apiKeyIndexRef}
      privateKeyRef={privateKeyRef}
      removeRef={removeRef}
    />
  );
  return (
    <ProviderCard
      slug={environment === "rhc" ? "lighter-rhc-trading" : "lighter-core-trading"}
      iconSlot={<IconKey size={18} />}
      name={title}
      status={managed ? { tone: "set", label: "MANAGED" } : status}
      description="Vex creates, registers, and encrypts the trading key during wallet-funded onboarding."
      detail={
        managed ? (
          <>
            Your {environment === "rhc" ? "RHC" : "Core"} credential was
            generated locally by Vex, registered with Lighter after your
            approval, and is ready for approved trading. Nothing needs to be
            copied from the Lighter dashboard.
          </>
        ) : (
          <>
            For normal {environment === "rhc" ? "RHC" : "Core"} setup, enable
            Lighter and complete wallet-funded onboarding. Vex creates and
            registers the key locally after your approval; you do not paste a
            private key from Lighter.
          </>
        )
      }
    >
      {managed ? (
        <div
          role="status"
          data-vex-lighter-managed-credential={environment}
          className="space-y-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-elevated)] p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              Managed by Vex
            </span>
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--color-success)]">
              Active
            </span>
          </div>
          <div className="space-y-2">
            {managedScopes.map((scope) => (
              <dl
                key={`${scope.accountIndex}:${scope.apiKeyIndex}`}
                className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
              >
                <dt className="text-[var(--color-text-muted)]">Account index</dt>
                <dd className="text-right font-mono text-[var(--color-text-primary)]">
                  {scope.accountIndex}
                </dd>
                <dt className="text-[var(--color-text-muted)]">API-key index</dt>
                <dd className="text-right font-mono text-[var(--color-text-primary)]">
                  {scope.apiKeyIndex}
                </dd>
              </dl>
            ))}
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            The private key is encrypted in the local Vex vault. It is never
            displayed here, and every trade still requires your approval.
          </p>
        </div>
      ) : configured ? (
        <p
          data-vex-lighter-external-credential={environment}
          className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-elevated)] p-4 text-xs text-[var(--color-text-muted)]"
        >
          An externally managed {environment === "rhc" ? "RHC" : "Core"}
          trading key is saved in the encrypted local vault. No key value is
          displayed.
        </p>
      ) : null}

      <details
        data-vex-lighter-manual-credential={environment}
        className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-elevated)] px-4 py-3"
      >
        <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Advanced: manage an externally created {environment === "rhc" ? "RHC" : "Core"} key
        </summary>
        <div className="mt-4 space-y-3">{manualFields}</div>
      </details>
    </ProviderCard>
  );
}

interface LighterManualTradingFieldsProps {
  readonly title: string;
  readonly prefix: string;
  readonly configured: boolean;
  readonly managed: boolean;
  readonly accountIndexRef: RefObject<HTMLInputElement | null>;
  readonly apiKeyIndexRef: RefObject<HTMLInputElement | null>;
  readonly privateKeyRef: RefObject<HTMLInputElement | null>;
  readonly removeRef: RefObject<HTMLInputElement | null>;
}

function LighterManualTradingFields({
  title,
  prefix,
  configured,
  managed,
  accountIndexRef,
  apiKeyIndexRef,
  privateKeyRef,
  removeRef,
}: LighterManualTradingFieldsProps): JSX.Element {
  return (
    <>
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
        Remove the manually imported trading key for this account/API-key scope.
      </label>
      <p className="text-xs text-[var(--color-text-muted)]">
        {managed
          ? "Vex-managed registered keys cannot be replaced or removed here. These controls are only for a different externally managed scope."
          : configured
            ? "Leave blank to keep the saved external key, paste a replacement, or check remove."
            : "Use only for an existing account whose key was created outside Vex."}
      </p>
    </>
  );
}
