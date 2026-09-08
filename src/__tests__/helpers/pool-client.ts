import { Client, type PoolClient } from "pg";

/**
 * A REAL pg client object whose named methods are replaced by the test's own
 * doubles, so production keeps calling pg's declared signatures and a suite
 * reads what each replaced method was asked without casting a bare literal
 * into the `PoolClient` shape.
 *
 * `new Client()` opens nothing: the constructor only resolves configuration.
 * `release` is what separates a pooled client from a standalone one, so it is
 * supplied here and overridable by the caller like any other method.
 */
export function testPoolClient<Methods extends object>(methods: Methods): PoolClient & Methods {
  return Object.assign(new Client(), { release: () => {} }, methods);
}
