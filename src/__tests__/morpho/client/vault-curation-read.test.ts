/**
 * `MorphoClient.getVaultCuration` - the read a deposit is gated on.
 *
 * Two properties separate it from every other vault read and neither is
 * cosmetic. It is UNCACHED, because a cached curation flag is a claim about an
 * earlier moment than the signature it authorizes, and the ordinary vault detail
 * read that also carries `listed` is served through a 15-second cache. And it
 * DETECTS the generation, V2 then V1, so a MetaMorpho vault is not reported as
 * nonexistent merely because it is not a VaultV2.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { MorphoClient } from "../../../tools/morpho/client.js";
import { MorphoBudget } from "../../../tools/morpho/budget.js";
import { ErrorCodes, VexError } from "../../../errors.js";

const ENDPOINT = "https://api.morpho.org/graphql";
const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Morpho's real not-found envelope: HTTP 200, `data: null`, `status: NOT_FOUND`. */
const NOT_FOUND = {
  data: null,
  errors: [{ message: "No results matching given parameters", status: "NOT_FOUND", extensions: {} }],
};

function curated(chainId: number, listed: boolean, field: "vaultV2ByAddress" | "vaultByAddress" = "vaultV2ByAddress") {
  return { data: { [field]: { address: VAULT, listed, chain: { id: chainId } } } };
}

/** Answer each outbound query by the document name it carries. */
function stubByDocument(bodies: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const sent = JSON.parse(String(init.body)) as { query: string };
    const key = Object.keys(bodies).find((k) => sent.query.includes(k));
    return jsonResponse(key === undefined ? NOT_FOUND : bodies[key]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function client(): MorphoClient {
  return new MorphoClient(ENDPOINT, new MorphoBudget({ requestsPerMinute: 600 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MorphoClient.getVaultCuration", () => {
  it("reads a V2 vault's flag bound to the address and chain it was asked about", async () => {
    stubByDocument({ VexMorphoVaultV2Curation: curated(8453, true) });

    const curation = await client().getVaultCuration({ vaultAddress: VAULT, chainId: 8453 });

    expect(curation).toEqual({ vaultAddress: VAULT, chainId: 8453, listed: true });
  });

  it("falls back to the V1 document rather than reporting a MetaMorpho vault as nonexistent", async () => {
    const fetchMock = stubByDocument({
      VexMorphoVaultV2Curation: NOT_FOUND,
      VexMorphoVaultV1Curation: curated(8453, true, "vaultByAddress"),
    });

    const curation = await client().getVaultCuration({ vaultAddress: VAULT, chainId: 8453 });

    expect(curation.listed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("IS UNCACHED: a second ask re-reads rather than replaying the first answer", async () => {
    // The whole point of the gate is that the flag is no older than the decision
    // it supports. The deposit lane asks twice - once before the approval and
    // once immediately before signing - and a cache would make the second ask a
    // replay of the first, which is the check it exists to avoid.
    const fetchMock = stubByDocument({ VexMorphoVaultV2Curation: curated(8453, true) });
    const morpho = client();

    await morpho.getVaultCuration({ vaultAddress: VAULT, chainId: 8453 });
    await morpho.getVaultCuration({ vaultAddress: VAULT, chainId: 8453 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("SEES A DELISTING that happened between the two asks", async () => {
    const morpho = client();
    stubByDocument({ VexMorphoVaultV2Curation: curated(8453, true) });
    expect((await morpho.getVaultCuration({ vaultAddress: VAULT, chainId: 8453 })).listed).toBe(true);

    stubByDocument({ VexMorphoVaultV2Curation: curated(8453, false) });
    expect((await morpho.getVaultCuration({ vaultAddress: VAULT, chainId: 8453 })).listed).toBe(false);
  });

  it("refuses an answer about the same address on ANOTHER CHAIN", async () => {
    stubByDocument({ VexMorphoVaultV2Curation: curated(1, true) });

    await expect(client().getVaultCuration({ vaultAddress: VAULT, chainId: 8453 }))
      .rejects.toMatchObject({ code: ErrorCodes.MORPHO_VAULT_POLICY_VIOLATION });
  });

  it("reports a vault neither generation knows as not found, from the SECOND failure", async () => {
    stubByDocument({});

    const error = await client().getVaultCuration({ vaultAddress: VAULT, chainId: 8453 }).catch((e) => e as VexError);

    expect(error).toBeInstanceOf(VexError);
    expect((error as VexError).code).toBe(ErrorCodes.MORPHO_VAULT_NOT_FOUND);
  });
});
