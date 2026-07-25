/**
 * Native-value authorization — public gate.
 *
 * PURPOSE. Before Vex signs an EVM transaction, every wei of its `tx.value`
 * must be attributed to a PROVEN cost component. An unattributed remainder is
 * an authorization failure and the transaction is refused. This is not an
 * economics policy and needs no agreed threshold: "we cannot say what this
 * money is for" is never a state in which a self-custodial agent should sign.
 *
 * THE PROBLEM IT CLOSES. A provider hands Vex a transaction request and Vex
 * signs its `value` verbatim. Measured live (Khalani → deBridge, Base,
 * 2026-07-25): a deposit carried 1e15 wei (~$1.86) absent from `amountIn`,
 * `amountOut` and `estimatedGas` alike. On a $2 bridge the all-in cost was 128%
 * of principal, and the charge reached the signer without ever having been
 * disclosed, let alone authorized.
 *
 * PUBLIC API
 *   `proveEvmNativeValue`                 classify one call (async; consults provers)
 *   `classifyNativeValue`                 the pure attribution arithmetic
 *   `evaluateNativeValueAuthorization`    the pass/fail rule
 *   `checkNativeValueAuthorizedForCall`   the pre-sign re-validation
 *   `describeNativeValueAuthorization`    the record/agent-facing projection
 *
 * KEY FILES
 *   `components.ts`             the closed component union + the sum invariant
 *   `classify.ts`               attribution order and the surcharge remainder
 *   `debridge-protocol-fee.ts`  the only venue prover that exists today
 *   `prove-evm-leg.ts`          composition: which provers, and reconciliation
 *
 * DO NOT
 *   - add a "gas" component: gas is charged against the gas limit, never out of
 *     `tx.value`, and a gas member would make the sum invariant unfalsifiable;
 *   - hardcode a protocol fee: deBridge's docs require querying it, and the
 *     value differs per chain and is governance-mutable;
 *   - add a tolerance to the sum check: there is no mechanism that makes a real
 *     native charge miss its components by a little;
 *   - attribute an amount you cannot prove in order to clear the gate — the
 *     type system forbids it (`ProvenComponent` excludes `unproven` evidence)
 *     and `evaluateNativeValueAuthorization` re-checks it at runtime.
 */

export {
  buildNativeValueAuthorization,
  checkNativeValueAuthorizedForCall,
  describeNativeValueAuthorization,
  evaluateNativeValueAuthorization,
  nativeValueCallFingerprint,
  sumNativeValueComponents,
  unclassifiedNativeValue,
  type NativeValueAuthorization,
  type NativeValueCall,
  type NativeValueComponent,
  type NativeValueComponentKind,
  type NativeValueDisclosure,
  type NativeValueEvidence,
  type NativeValueRefundSemantics,
  type NativeValueVerdict,
} from "./components.js";

export {
  classifyNativeValue,
  type NativeValueClassificationRequest,
  type ProvenComponent,
} from "./classify.js";

export {
  DEBRIDGE_DLN_SOURCE_CHAIN_IDS,
  DEBRIDGE_DLN_SOURCE_PROXY,
  DEBRIDGE_FIXED_FEE_ABI,
  decodeDebridgeOrderCall,
  proveDebridgeOrderNativeCharge,
  type DebridgeFixedFeeReader,
  type DebridgeOrderNativeCharge,
} from "./debridge-protocol-fee.js";

export {
  proveEvmNativeValue,
  type EvmNativeValueProofRequest,
  type VexDerivedNativeValue,
} from "./prove-evm-leg.js";
