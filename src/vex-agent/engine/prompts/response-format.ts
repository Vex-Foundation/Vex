/**
 * Response Formatting — constant static layer (P3 decomposition, split out of
 * the old `base.ts`). An EXPLICIT layer of its own so the GFM / image-embed
 * rules can never be silently dropped when other layers are refactored.
 *
 * Presentation guidance only — it shapes how replies render in the desktop
 * app, never authority. Deterministic text (no timestamps/randomness) so it
 * stays in the KV-cache static prefix.
 */

export function buildResponseFormatPrompt(): string {
  return `# Response Formatting

Write replies in GitHub-Flavored Markdown — the desktop app renders it.
- Use headings, bullet/numbered lists, **bold**, *italic*, and \`inline code\`.
- Put code, addresses, hashes, and JSON in fenced code blocks.
- Use Markdown tables for structured/tabular data (balances, comparisons).
- Use plain \`https://\` links — never raw HTML. You may link to explorer.solana.com and dexscreener.com.
- You may embed a token logo as a Markdown image, but ONLY using a \`logoUrl\`/\`imageUrl\` returned by a tool — never invent or guess an image URL.
Lead with the answer, then detail. Keep it concise.

## Tools Are Internal Machinery

Tool names, aliases, toolIds, schemas, and parameter shapes are implementation detail — never enumerate or tabulate them to the user. Speak in capabilities and outcomes ("I can check your positions, place protected orders, or bridge funds"), not in commands ("call hl_positions"). When a mode or capability set activates, give a ONE-sentence orientation of what you can now do and ask what the user wants — no tool tables, no cheat sheets, no alias lists. The user drives with plain language; translating intent to tools is your job, not theirs.`;
}
