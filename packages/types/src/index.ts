// @corridor/types — shared domain types + the result type the whole engine speaks.
//
// Everything returns Outcome instead of throwing. This is the same discipline as
// Numio's SpendOutcome: failures are values you must handle, not exceptions that
// unwind the stack and lose the in-flight payment's state.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Outcome<T, E = CorridorError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(o: Outcome<T, E>): o is Ok<T> => o.ok;
export const isErr = <T, E>(o: Outcome<T, E>): o is Err<E> => !o.ok;

export type CorridorErrorCode =
  | "MANIFEST_INVALID"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "KYC_REQUIRED"
  | "KYC_REJECTED"
  | "ANCHOR_UNAVAILABLE"
  | "SETTLEMENT_FAILED"
  | "SETTLEMENT_TIMEOUT"
  | "RECONCILE_MISMATCH"
  | "IDEMPOTENCY_CONFLICT";

export interface CorridorError {
  readonly code: CorridorErrorCode;
  readonly message: string;
  /** Whether the recover step is allowed to retry this. */
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export const fail = (
  code: CorridorErrorCode,
  message: string,
  opts: { retryable?: boolean; cause?: unknown } = {},
): Err<CorridorError> =>
  err({ code, message, retryable: opts.retryable ?? false, cause: opts.cause });

// --- Money ---------------------------------------------------------------
// Amounts are strings on purpose. Never represent money as a JS number;
// FX math and stroop-level precision both lose data through float64.

export interface Money {
  /** Asset identifier: "USDC", or an off-chain SEP-38 asset like "iso4217:ARS". */
  readonly asset: string;
  readonly amount: string;
}

// --- Parties & intent ----------------------------------------------------

/** Opaque reference to a party. Real PII lives behind the anchor's SEP-12, never here. */
export interface PartyRef {
  readonly id: string;
  readonly jurisdiction?: string;
}

export interface PaymentIntent {
  /** Caller-supplied. Two requests with the same key must never settle twice. */
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly sender: PartyRef;
  readonly recipient: PartyRef;
  /** What the sender is putting in, in the corridor's source asset. */
  readonly sourceAmount: Money;
}
