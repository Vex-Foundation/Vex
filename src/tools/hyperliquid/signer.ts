import { privateKeyToAccount } from "viem/accounts";
import {
  signL1Action,
  signUserSignedAction,
  type AbstractWallet,
  type Signature,
} from "@nktkas/hyperliquid/signing";

import {
  endpointsForNetwork,
  HYPERLIQUID_REQUEST_TIMEOUT_MS,
  type HyperliquidNetwork,
} from "./constants.js";
import { HyperliquidClientError } from "./errors.js";
import { HyperliquidNonceAllocator, hyperliquidRuntimeNonceAllocator } from "./nonce.js";
import type {
  HyperliquidL1Request,
  HyperliquidUserSignedRequest,
  HyperliquidWallet,
} from "./types.js";

export interface HyperliquidSignerOptions {
  /** Resolves a selected wallet only for the duration of a signing operation. */
  readonly resolveWallet: () => HyperliquidWallet;
  readonly network: HyperliquidNetwork;
  readonly nonceAllocator?: HyperliquidNonceAllocator;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface SignedExchangeRequest {
  readonly action: Record<string, unknown>;
  readonly signature: Signature;
  readonly nonce: number;
  readonly vaultAddress?: `0x${string}`;
  readonly expiresAfter?: number;
}

/**
 * Privileged signer. It creates a viem LocalAccount only for a single signing
 * operation; private-key material is never stored outside the wallet source or
 * serialized into request results/logs.
 */
export class HyperliquidSigner {
  private readonly resolveWallet: () => HyperliquidWallet;
  private readonly network: HyperliquidNetwork;
  private readonly nonceAllocator: HyperliquidNonceAllocator;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HyperliquidSignerOptions) {
    this.resolveWallet = options.resolveWallet;
    this.network = options.network;
    this.nonceAllocator = options.nonceAllocator ?? hyperliquidRuntimeNonceAllocator;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? HYPERLIQUID_REQUEST_TIMEOUT_MS;
  }

  get address(): `0x${string}` {
    return this.resolveWallet().address;
  }

  /** Allocate a unique millisecond nonce for either L1 or user-signed actions. */
  nextNonce(): number {
    return this.nonceAllocator.next(this.resolveWallet().address);
  }

  private account(wallet: HyperliquidWallet): AbstractWallet {
    return privateKeyToAccount(wallet.privateKey);
  }

  async signL1(request: HyperliquidL1Request): Promise<SignedExchangeRequest> {
    const wallet = this.resolveWallet();
    const nonce = this.nonceAllocator.next(wallet.address);
    try {
      const signature = await signL1Action({
        wallet: this.account(wallet),
        action: request.action,
        nonce,
        isTestnet: this.network === "testnet",
        ...(request.vaultAddress ? { vaultAddress: request.vaultAddress } : {}),
        ...(request.expiresAfter !== undefined ? { expiresAfter: request.expiresAfter } : {}),
      });
      return {
        action: request.action,
        signature,
        nonce,
        ...(request.vaultAddress ? { vaultAddress: request.vaultAddress } : {}),
        ...(request.expiresAfter !== undefined ? { expiresAfter: request.expiresAfter } : {}),
      };
    } catch (cause) {
      throw new HyperliquidClientError("transport", "Unable to sign Hyperliquid L1 action.", { cause });
    }
  }

  async signUserAction(request: HyperliquidUserSignedRequest): Promise<SignedExchangeRequest> {
    const nonce = userActionNonce(request.action);
    const wallet = this.resolveWallet();
    try {
      const signature = await signUserSignedAction({
        wallet: this.account(wallet),
        action: request.action,
        types: request.types,
      });
      return { action: request.action, signature, nonce };
    } catch (cause) {
      throw new HyperliquidClientError("transport", "Unable to sign Hyperliquid user action.", { cause });
    }
  }

  async post(signed: SignedExchangeRequest, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchFn(endpointsForNetwork(this.network).exchange, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: signed.action,
          signature: signed.signature,
          nonce: signed.nonce,
          ...(signed.vaultAddress ? { vaultAddress: signed.vaultAddress } : {}),
          ...(signed.expiresAfter !== undefined ? { expiresAfter: signed.expiresAfter } : {}),
        }),
        signal: controller.signal,
      });
      const raw = await response.json().catch(() => null);
      if (!response.ok) {
        throw new HyperliquidClientError("api", `Hyperliquid exchange returned HTTP ${response.status}.`);
      }
      return raw;
    } catch (cause) {
      if (cause instanceof HyperliquidClientError) throw cause;
      if (controller.signal.aborted) {
        throw new HyperliquidClientError("timeout", "Hyperliquid exchange request timed out or was aborted.", { cause });
      }
      throw new HyperliquidClientError("transport", "Hyperliquid exchange request failed.", { cause });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function userActionNonce(action: Record<string, unknown>): number {
  const candidate = action.time ?? action.nonce;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new HyperliquidClientError("validation", "User-signed action requires a safe integer time or nonce.");
  }
  return candidate;
}
