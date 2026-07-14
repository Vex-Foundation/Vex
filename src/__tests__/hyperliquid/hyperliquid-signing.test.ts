import { describe, expect, it } from "vitest";
import { UsdSendTypes, Withdraw3Types } from "@nktkas/hyperliquid/api/exchange";
import { createL1ActionHash, signL1Action, signUserSignedAction, type Signature } from "@nktkas/hyperliquid/signing";
import { privateKeyToAccount } from "viem/accounts";

const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");

function normalizedHex(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

async function expectSignature(actual: Promise<Signature>, expected: Signature): Promise<void> {
  const signature = await actual;
  expect(normalizedHex(signature.r)).toBe(normalizedHex(expected.r));
  expect(normalizedHex(signature.s)).toBe(normalizedHex(expected.s));
  expect(signature.v).toBe(expected.v);
}

describe("Hyperliquid SDK signing vectors", () => {
  it("matches the official Python SDK vectors byte-for-byte", async () => {
    // 1. Phantom agent L1 action hash.
    expect(createL1ActionHash({
      action: { type: "order", orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" },
      nonce: 1677777606040,
    })).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");

    const dummy = { type: "dummy", num: 100000000000 };
    await expectSignature(signL1Action({ wallet, action: dummy, nonce: 0 }), {
      r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27,
    });
    await expectSignature(signL1Action({ wallet, action: dummy, nonce: 0, isTestnet: true }), {
      r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28,
    });

    const gtc = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    await expectSignature(signL1Action({ wallet, action: gtc, nonce: 0 }), {
      r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28,
    });
    await expectSignature(signL1Action({ wallet, action: gtc, nonce: 0, isTestnet: true }), {
      r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
      s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27,
    });

    const cloid = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } }, c: "0x00000000000000000000000000000001" }], grouping: "na" };
    await expectSignature(signL1Action({ wallet, action: cloid, nonce: 0 }), {
      r: "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
      s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", v: 27,
    });
    await expectSignature(signL1Action({ wallet, action: cloid, nonce: 0, isTestnet: true }), {
      r: "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d",
      s: "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988", v: 28,
    });

    const vaultAddress = "0x1719884eb866cb12b2287399b15f7db5e7d775ea" as const;
    await expectSignature(signL1Action({ wallet, action: dummy, nonce: 0, vaultAddress }), {
      r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
      s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", v: 28,
    });
    await expectSignature(signL1Action({ wallet, action: dummy, nonce: 0, vaultAddress, isTestnet: true }), {
      r: "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b",
      s: "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", v: 27,
    });

    const trigger = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { trigger: { isMarket: true, triggerPx: "103", tpsl: "sl" } } }], grouping: "na" };
    await expectSignature(signL1Action({ wallet, action: trigger, nonce: 0 }), {
      r: "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9",
      s: "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405", v: 27,
    });
    await expectSignature(signL1Action({ wallet, action: trigger, nonce: 0, isTestnet: true }), {
      r: "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4",
      s: "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac", v: 28,
    });

    const usdSend = { type: "usdSend", signatureChainId: "0x66eee" as const, hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 };
    await expectSignature(signUserSignedAction({ wallet, action: usdSend, types: UsdSendTypes }), {
      r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27,
    });

    const withdraw = { type: "withdraw3", signatureChainId: "0x66eee" as const, hyperliquidChain: "Testnet", destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "1", time: 1687816341423 };
    await expectSignature(signUserSignedAction({ wallet, action: withdraw, types: Withdraw3Types }), {
      r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881", v: 28,
    });
  });
});
