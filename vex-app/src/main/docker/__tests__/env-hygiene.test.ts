import { describe, expect, it } from "vitest";

import { MANAGED_SECRET_ENV_KEYS } from "@vex-lib/secret-keys.js";
import { withoutManagedSecrets } from "../env-hygiene.js";

describe("withoutManagedSecrets", () => {
  it("strips every catalog key at its canonical casing", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const key of MANAGED_SECRET_ENV_KEYS) {
      env[key] = `value-for-${key}`;
    }

    const result = withoutManagedSecrets(env);

    expect(result).toEqual({ PATH: "/usr/bin" });
    for (const key of MANAGED_SECRET_ENV_KEYS) {
      expect(result[key]).toBeUndefined();
    }
  });

  it("strips catalog keys regardless of case (Windows case-insensitive env names)", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      openrouter_api_key: "leaked-lower",
      Openrouter_Api_Key: "leaked-mixed",
      TAVILY_API_KEY: "leaked-upper",
      lighter_core_read_only_auth_token: "retired-core-token",
      Lighter_Rhc_Read_Only_Auth_Token: "retired-rhc-token",
      vex_keystore_password: "leaked-password-lower",
    };

    const result = withoutManagedSecrets(env);

    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps operational vars untouched", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      HOME: "/home/vex",
      CUSTOM: "yes",
    };

    const result = withoutManagedSecrets(env);

    expect(result).toEqual(env);
  });

  it("never mutates the input, even when the input is process.env by identity", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: "secret",
    };
    const snapshot = { ...env };

    const result = withoutManagedSecrets(env);

    expect(env).toEqual(snapshot);
    expect(result).not.toBe(env);
  });
});
