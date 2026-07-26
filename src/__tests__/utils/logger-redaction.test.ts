import { PassThrough } from "node:stream";
import winston from "winston";
import { afterEach, describe, expect, it } from "vitest";
import { logger } from "../../utils/logger.js";

const installed: winston.transport[] = [];

afterEach(() => {
  for (const transport of installed.splice(0)) logger.remove(transport);
});

function captureNextLog(run: () => void): Promise<string> {
  const stream = new PassThrough();
  const transport = new winston.transports.Stream({ stream });
  installed.push(transport);
  logger.add(transport);

  return new Promise((resolve) => {
    stream.once("data", (chunk) => resolve(String(chunk)));
    run();
  });
}

describe("engine logger transport redaction", () => {
  it("redacts message text and structured metadata before every transport", async () => {
    const apiKey = `sk-or-${"x".repeat(32)}`;
    const privateKey = `0x${"a".repeat(64)}`;

    const line = await captureNextLog(() => {
      logger.error(`provider failed with ${privateKey}`, {
        token: apiKey,
        nested: { authorization: `Bearer ${apiKey}` },
      });
    });

    expect(line).not.toContain(apiKey);
    expect(line).not.toContain(privateKey);
    expect(line).toContain("[REDACTED]");
  });

  it("redacts realistic base64 and labelled base58 secrets without hiding public ids", async () => {
    const base64Secret = Buffer.alloc(32, 0xff).toString("base64");
    const base58Secret = "3".repeat(88);
    const publicAddress = "3Nh6zJvJK6jY8t9LnGN9EmqCcTZbHVRRWkpBz1FEz1Zt";

    const line = await captureNextLog(() => {
      logger.warn(
        `base64=${base64Secret} secret key=${base58Secret} public=${publicAddress}`,
      );
    });

    expect(line).not.toContain(base64Secret);
    expect(line).not.toContain(base58Secret);
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("3Nh6");
    expect(line).toContain("1Zt");
  });
});
