/**
 * THE NODE TOKEN: how the renderer names a file without ever holding a path.
 *
 * ## What a token is
 *
 *     f1.<base64url(epoch NUL projectId NUL relativePath)>.<base64url(hmac)>
 *
 * The HMAC key is 32 random bytes minted once per PROCESS and never persisted,
 * so a token cannot outlive the run that issued it and cannot be replayed into
 * a different Vex instance. The payload is not encrypted, and that is
 * deliberate: it is not a secret, it is a NAME, and pretending a path the
 * renderer just asked for is confidential would be theatre. What the signature
 * buys is INTEGRITY - a renderer cannot edit `src/a.ts` into `../../.ssh/id_rsa`
 * and have main resolve it, because the edit fails verification before any
 * syscall is reached.
 *
 * The field separator is NUL, the one byte a POSIX filename cannot contain, so
 * a path with spaces, tabs or newlines in it still parses back into exactly
 * three fields. A separator that a filename CAN contain would make the payload
 * ambiguous, and an ambiguous payload under a valid signature is worse than no
 * signature at all.
 *
 * ## Why a token and not a path
 *
 * A path parameter makes every handler a path-resolution problem, and every one
 * of them has to get containment right. A token makes it ONE problem, solved
 * here, and a handler that forgets to call this module has no path at all to
 * misuse. It is the same reason `terminals.ts` mints terminal ids rather than
 * accepting a pid.
 *
 * ## Why an EPOCH, and what it actually stops
 *
 * A signature proves a token was issued. It cannot prove the project it names
 * still exists. Every project has a monotonic epoch, and a delete BUMPS it, so
 * every token that project ever handed out stops verifying at that instant.
 * Without it there is a real window - between the tombstone committing and the
 * renderer learning the project is gone - in which a tree still on screen names
 * files whose signatures are still perfectly valid, and a click reads a byte
 * out of a deleted project.
 *
 * The epoch is NOT the authority and is not treated as one. Authority is the
 * `projects` row (which serves ACTIVE projects only) plus the lifecycle gate,
 * re-established on every request. The epoch is what makes stale NAMES fail
 * fast and locally, which is the difference between a refusal and a race.
 *
 * ## Constant-time comparison
 *
 * `timingSafeEqual`, because signature verification that returns early on the
 * first differing byte leaks how much of a forgery was right. The threat is
 * modest here (an attacker who runs code in the renderer has better options),
 * but a verifier that is only sometimes constant-time is a habit that
 * eventually lands on something that matters.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The token format marker. Bumped if the payload layout ever changes. */
const TOKEN_VERSION = "f1";

/** Truncated to 128 bits: a digest, not content, and 128 bits is not guessable. */
const SIGNATURE_BYTES = 16;

/** NUL: the one byte a POSIX path cannot contain. */
const SEPARATOR = "\u0000";

/** Minted once per process, never written down. */
const signingKey = randomBytes(32);

/**
 * Per-project epochs.
 *
 * One integer per project the process has ever minted a token for. Bounded by
 * the number of projects, and dropped only by the test seam - never by a
 * delete, because forgetting a bumped epoch would let a token minted before the
 * delete verify again against a fresh zero.
 */
const epochs = new Map<string, number>();

/** The project's current epoch, created at 0 on first use. */
export function projectNodeEpoch(projectId: string): number {
  const current = epochs.get(projectId);
  if (current !== undefined) return current;
  epochs.set(projectId, 0);
  return 0;
}

/**
 * Spend every token this project has issued.
 *
 * Called by the lifecycle gate's close hook after a tombstone commits, and by
 * nothing else. Returns the new epoch so the caller can log the transition.
 */
export function invalidateProjectNodes(projectId: string): number {
  const next = projectNodeEpoch(projectId) + 1;
  epochs.set(projectId, next);
  return next;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey)
    .update(payload, "utf8")
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString("base64url");
}

/**
 * Mint a token for a project-relative POSIX path.
 *
 * The project ROOT is the empty relative path, and it gets a token like every
 * other node so a caller never needs a special case for "the top".
 */
export function mintFileNodeId(projectId: string, relativePath: string): string {
  const payload = [String(projectNodeEpoch(projectId)), projectId, relativePath]
    .join(SEPARATOR);
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${TOKEN_VERSION}.${encoded}.${sign(payload)}`;
}

/**
 * What a token turned out to be.
 *
 * ONE refusal for every way a token can be wrong - bad version, bad base64, bad
 * signature, spent epoch, wrong project - because telling a caller WHICH of
 * those it was is telling a forger how close they got, and no legitimate
 * consumer can act on the distinction: it re-lists in every case.
 */
export type FileNodeResolution =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false };

const REFUSED: FileNodeResolution = { ok: false };

/**
 * Verify a token and recover its relative path, for THIS project and THIS epoch.
 *
 * `projectId` is passed in rather than read out of the token, so a token minted
 * for project A can never be resolved while acting on project B even if both
 * are live. The token's own project field is compared against it.
 */
export function resolveFileNodeId(
  projectId: string,
  nodeId: string,
): FileNodeResolution {
  const parts = nodeId.split(".");
  if (parts.length !== 3) return REFUSED;
  const [version, encoded, signature] = parts;
  if (version !== TOKEN_VERSION || encoded === undefined || signature === undefined) {
    return REFUSED;
  }

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return REFUSED;
  }

  const expected = Buffer.from(sign(payload), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (expected.byteLength !== presented.byteLength) return REFUSED;
  if (!timingSafeEqual(expected, presented)) return REFUSED;

  // The payload is trustworthy from here: the signature covers all of it.
  const fields = payload.split(SEPARATOR);
  if (fields.length !== 3) return REFUSED;
  const [epochText, tokenProjectId, relativePath] = fields;
  if (
    epochText === undefined
    || tokenProjectId === undefined
    || relativePath === undefined
  ) {
    return REFUSED;
  }
  if (tokenProjectId !== projectId) return REFUSED;
  if (epochText !== String(projectNodeEpoch(projectId))) return REFUSED;
  return { ok: true, relativePath };
}

/** Test seam: forget every project's epoch. */
export function resetFileNodeEpochsForTests(): void {
  epochs.clear();
}
