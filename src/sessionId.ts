/**
 * Shared safe-segment guard for values that become a single path segment under the run
 * store (e.g. `session/<id>.real.jsonl`). Both the transcript resolver (runners.ts) and
 * failed-run preservation (preserve.ts) consume untrusted, provider-emitted ids/phases;
 * defining the allow-list ONCE here keeps the two call sites from drifting apart.
 */

/** A value is a safe path segment iff it is non-empty and only `[A-Za-z0-9._-]`. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** True when `value` is a single safe path segment (no slashes, no traversal). */
export function isSafeSessionSegment(value: string): boolean {
  return SAFE_SESSION_ID.test(value);
}
