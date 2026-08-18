/**
 * The one way a Morpho GraphQL read leaves this process.
 *
 * Extracted from `../client.ts` so that file states WHAT Vex reads and this one
 * states HOW every read is carried: budget and cache, the POST itself, the
 * non-ok mapping, the 200-with-`errors` mapping, and only then the validator.
 * The two have genuinely different reasons to change - a new query is a product
 * decision, a change here is a transport or provider-contract decision - and
 * `MorphoClient` keeps its whole public surface either way.
 *
 * TWO PROPERTIES ARE UNUSUAL ENOUGH TO STATE HERE.
 *
 * GRAPHQL FAILS AT HTTP 200. A bad field name comes back as a 200 whose body
 * carries `errors[]` and no `data`. Treating "the call returned" as "the call
 * worked" would turn a schema removal into a silently empty market list, which
 * on a lending screen reads as "no markets match your filter". The
 * 200-with-errors path is therefore checked explicitly and mapped to a named
 * refusal. Morpho also reports "no such vault" through that SAME envelope, which
 * is why a request may carry its own `notFound` mapping.
 *
 * THE BUDGET IS A BAN GUARD, not a politeness feature. See `../budget.ts`:
 * Morpho answers abuse with a seven-day block. Everything routed through here
 * passes {@link MorphoBudget}, whose breaker state travels into the error so a
 * refusal says who refused and until when.
 */

import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import logger from "../../../utils/logger.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import type { MorphoBudget } from "../budget.js";
import { mapMorphoGraphqlError, mapMorphoHttpError, mapMorphoTransportError } from "../errors.js";
import { describeGraphqlErrors } from "../validation/markets.js";
import { USER_AGENT, hasData, isNotFoundBody, parseRetryAfterSeconds, type GraphqlRequest } from "./envelope.js";

/**
 * Carry one request. Every read in the client goes through this, so none can
 * skip the budget, the cache key, or the error contract.
 */
export async function runMorphoGraphqlRequest<T>(
  endpoint: string,
  budget: MorphoBudget,
  req: GraphqlRequest,
  validator: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const key = `${req.operation}:${JSON.stringify(req.variables)}:${req.variant ?? ""}`;
  try {
    return await budget.run(key, req.ttlMs, async () => {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ query: req.query, variables: req.variables }),
        ...(signal ? { signal } : {}),
      });

      const body = await readJson(response);

      if (!response.ok) {
        const retryAfter = parseRetryAfterSeconds(response.headers?.get?.("retry-after"));
        if (response.status === 429) budget.recordRateLimit(retryAfter);
        logger.warn("morpho.http_error", {
          status: response.status,
          operation: req.operation,
          retryAfterSeconds: retryAfter ?? null,
        });
        // The BODY travels with the status. GraphQL's error text names the
        // exact field that failed; dropping it leaves a bare status.
        throw mapMorphoHttpError(response.status, body, retryAfter);
      }

      logMorphoExtensions(body, req.operation);

      // HTTP 200 with `errors` and no `data` is GraphQL's real failure mode.
      const graphqlErrors = describeGraphqlErrors(body);
      if (graphqlErrors !== null && !hasData(body)) {
        if (req.notFound !== undefined && isNotFoundBody(body)) throw req.notFound(graphqlErrors);
        throw mapMorphoGraphqlError(graphqlErrors);
      }

      return validator(body);
    });
  } catch (err) {
    mapMorphoTransportError(err);
  }
}

/**
 * Query cost against Morpho's ceiling, plus any `warnings` key should the schema
 * ever grow one. Structured logging only - never agent output.
 *
 * `extensions.warnings[]` is NOT what the plan expected. The 2026-08-14 probe
 * found `extensions` carrying only `complexity` and `maximumComplexity`;
 * deprecated fields are already hard errors rather than warnings. The block is
 * still logged because it is the only view of our query cost against Morpho's
 * 1,000,000 ceiling.
 */
function logMorphoExtensions(body: unknown, operation: string): void {
  if (!isRecord(body)) return;
  const extensions = body["extensions"];
  if (!isRecord(extensions)) return;
  const warnings = extensions["warnings"];
  logger.debug("morpho.graphql_extensions", {
    operation,
    complexity: typeof extensions["complexity"] === "number" ? extensions["complexity"] : null,
    maximumComplexity: typeof extensions["maximumComplexity"] === "number" ? extensions["maximumComplexity"] : null,
    warnings: Array.isArray(warnings) ? JSON.stringify(warnings) : null,
  });
}
