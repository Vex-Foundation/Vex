/**
 * Newest-first ordering of the wizard model catalogue.
 *
 * Kept in its own file: `provider-model-catalog.test.ts` already covers
 * caching, cooldown and the keyless client, and is near the file-size ceiling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProviderModelCatalogForTests,
  loadProviderModelCatalog,
} from "../provider-model-catalog.js";

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "vendor/model",
    name: "Vendor Model",
    contextLength: 200_000,
    supportedParameters: ["tools"],
    pricing: { prompt: "0.000003", completion: "0.000015" },
    created: 1_700_000_000,
    ...overrides,
  };
}

function catalogPages(data: ReadonlyArray<unknown>) {
  const page = { result: { data } };
  return {
    ...page,
    next: () => null,
    [Symbol.asyncIterator]: async function* () {
      yield page;
    },
  };
}

function clientFactory(data: ReadonlyArray<unknown>) {
  const list = vi.fn().mockResolvedValue(catalogPages(data));
  return () => ({ models: { list } }) as never;
}

beforeEach(() => __resetProviderModelCatalogForTests());

describe("catalogue ordering", () => {
  it("captures `created` and puts the newest model first", async () => {
    const result = await loadProviderModelCatalog({
      clientFactory: clientFactory([
        model({ id: "vendor/old", name: "Aaa Old", created: 1_600_000_000 }),
        model({ id: "vendor/new", name: "Zzz New", created: 1_800_000_000 }),
      ]),
    });
    expect(result.models.map((m) => m.modelId)).toEqual([
      "vendor/new",
      "vendor/old",
    ]);
    expect(result.models[0]?.created).toBe(1_800_000_000);
  });

  it("sorts models with an unknown or malformed `created` LAST", async () => {
    const result = await loadProviderModelCatalog({
      clientFactory: clientFactory([
        model({ id: "vendor/missing", name: "Aaa", created: undefined }),
        model({ id: "vendor/malformed", name: "Bbb", created: "recent" }),
        model({ id: "vendor/dated", name: "Zzz", created: 1_500_000_000 }),
      ]),
    });
    expect(result.models.map((m) => m.modelId)).toEqual([
      "vendor/dated",
      "vendor/missing",
      "vendor/malformed",
    ]);
    expect(result.models[1]?.created).toBeUndefined();
  });

  it("breaks ties by display name then model id", async () => {
    const result = await loadProviderModelCatalog({
      clientFactory: clientFactory([
        model({ id: "b/same", name: "Same Name", created: 1_700_000_000 }),
        model({ id: "a/same", name: "Same Name", created: 1_700_000_000 }),
        model({ id: "c/other", name: "Another Name", created: 1_700_000_000 }),
      ]),
    });
    expect(result.models.map((m) => m.modelId)).toEqual([
      "c/other",
      "a/same",
      "b/same",
    ]);
  });

  it("applies the newest-first order BEFORE the catalogue cap", async () => {
    const oldest = Array.from({ length: 1_000 }, (_, index) =>
      model({
        id: `vendor/old-${index}`,
        name: `Old ${index}`,
        created: 1_000_000 + index,
      }),
    );
    const result = await loadProviderModelCatalog({
      clientFactory: clientFactory([
        ...oldest,
        model({ id: "vendor/newest", name: "Newest", created: 2_000_000_000 }),
      ]),
    });
    expect(result.models).toHaveLength(1_000);
    expect(result.models[0]?.modelId).toBe("vendor/newest");
  });
});
