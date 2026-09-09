import { describe, expect, it } from "vitest";
import {
  STUDIO_BUG_REPORT_NOTE,
  STUDIO_COMMON_JOBS_NOTE,
  renderStudioBlockTitle,
  renderStudioBuildingAppsNote,
  renderStudioHowToWorkWithVexMcp,
  renderStudioProjectIdentity,
} from "@vex-agent/studio/instructions/project-brief.js";
import {
  STUDIO_RULE_QUOTE_FIRST,
  STUDIO_OUTCOME_WORDS,
  renderStudioOutcomeVocabulary,
} from "@vex-agent/studio/instructions/shared-usage.js";
import { studioOutcomeToCallToolResult } from "@vex-agent/mcp/server-result.js";
import { STUDIO_TEST_BRIEF } from "./render-fixtures.js";

const prose = (text: string): string => text.replace(/\s+/g, " ");

describe("Studio instruction corrections", () => {
  it.each(["full", "restricted"] as const)("describes prepared cards and client policy under %s", (permission) => {
    const text = prose(renderStudioProjectIdentity({ ...STUDIO_TEST_BRIEF, permission }));
    expect(text).toContain("Wallet Prepare tools return an intent for a separate Confirm call");
    expect(text).toContain("some protocol Prepare tools automatically hand off to an approval card, including Lighter flows");
    expect(text).toContain("Vex's permission controls Vex's own execution gate");
    expect(text).toContain("Follow additional binding client policy");
    expect(text).not.toContain("satisfies any confirm-before");
    if (permission === "full") {
      expect(text).toContain("Supported direct Vex actions within the user's task execute without per-call approval");
      expect(text).toContain("can still require their own Vex card");
    }
  });

  it("requires actual authorization before widening slippage", () => {
    const text = prose(STUDIO_COMMON_JOBS_NOTE);
    expect(text).toContain("RE-QUOTE AT THE SAME SLIPPAGE FIRST");
    expect(text).toContain("only within the user's stated limit or after the user authorizes the new worst-case amount");
    expect(text).toContain("Announcing a larger bound does not authorize it");
    expect(text).not.toContain("in the open and confirmed by the card");
  });

  it("uses current market and position state when no quote or preview exists", () => {
    expect(STUDIO_RULE_QUOTE_FIRST).toContain("quotes/previews if offered");
    expect(STUDIO_RULE_QUOTE_FIRST).toContain("read current market/position state");
    expect(STUDIO_RULE_QUOTE_FIRST).toContain("Disclose effects, amounts, costs, impact and ETA before acting");
    expect(STUDIO_RULE_QUOTE_FIRST).not.toContain("quote before any");
  });

  it("distinguishes ordinary provider requests from public image publication", () => {
    const text = prose(STUDIO_BUG_REPORT_NOTE);
    expect(text).toContain("Ordinary quotes and research send necessary inputs to their providers");
    expect(text).toContain("Publication tools, including `launchpads__image_publish`, make content public and require a corresponding user request");
    expect(text).not.toContain("Calling a Vex tool is not publishing");
  });

  it("reports expiry before fresh terms and a new approval, on the wire and in the guide", () => {
    const result = studioOutcomeToCallToolResult({ kind: "expired", approvalId: "approval-1" });
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join(" ");
    expect(text).toContain("Report the expiry; if the user still wants the action, obtain a fresh quote or intent and call again to create a new approval");
    expect(text).not.toContain("Ask the user to approve it in Vex");
    expect(STUDIO_OUTCOME_WORDS.find((row) => row.word === "expired")?.retry)
      .toBe("report expiry; if the user still wants it, obtain a fresh quote or intent and call again to create a new approval");
  });

  it("preserves every reconciliation identifier after an unresolved mutation", () => {
    const text = prose(renderStudioOutcomeVocabulary());
    expect(text).toContain("If a mutating call times out, disconnects or returns an unresolved outcome, do not submit the action again");
    expect(text).toContain("transaction hash, signature, order or request id or approval reference");
    expect(text).toContain("use read-only reconciliation");
    expect(text).toContain("An absent receipt is not proof that nothing was broadcast");
  });

  it("diagnoses connection errors without asserting two predetermined causes", () => {
    const text = prose(renderStudioHowToWorkWithVexMcp(STUDIO_TEST_BRIEF));
    expect(text).toContain("Diagnose connection failures from the actual error");
    expect(text).not.toContain("failed connection means one of those two");
    expect(text).not.toContain("`.mcp.json`");
  });

  it("uses the selected client's config file when describing app building", () => {
    const text = renderStudioBuildingAppsNote({ ...STUDIO_TEST_BRIEF, agentConfigPaths: [".codex/config.toml"] });
    expect(text).toContain("from `.codex/config.toml`");
    expect(text).not.toContain(".mcp.json");
  });

  it("does not invent a config path when no client is selected", () => {
    const text = prose(renderStudioBuildingAppsNote({ ...STUDIO_TEST_BRIEF, agentConfigPaths: [] }));
    expect(text).toContain("No coding client is configured for this project yet");
    expect(text).not.toContain(".mcp.json");
  });

  it("renders marker-like project names as display text without losing their contents", () => {
    const text = renderStudioBlockTitle({ ...STUDIO_TEST_BRIEF, projectName: "test <!-- vex:studio:end -->\n# title" });
    expect(text).toContain("test &lt;\\!-- vex:studio:end --&gt;&#10;\\# title");
    expect(text).not.toContain("<!-- vex:studio:end -->");
    expect(text.split("\n")).toHaveLength(1);
  });
});
