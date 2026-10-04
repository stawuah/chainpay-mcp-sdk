/*
 * Card-data hygiene for anything that leaves a ChainPay process toward a
 * model, a log or a screen (contracts.md §5 "never stored anywhere", §10
 * forbidden list). Two layers:
 *   1. Forbidden keys are dropped wherever they appear.
 *   2. Any free-standing run of 13 to 19 digits (spaces or dashes allowed
 *      between digits) is replaced, Luhn-valid or not. ChainPay never needs
 *      to show such a number: amounts are cents (≤ 7 digits under the sandbox
 *      cap) and times are ISO strings.
 * Digits glued to letters, `_` or `-` (base58 addresses, hex digests, UUIDs,
 * base64url tokens) are not a match. A bare 13-digit epoch-ms value IS
 * redacted, which is why card outputs use ISO times.
 */

export const CARD_DATA_REDACTION = "[redacted]";

const FORBIDDEN_KEY = /^(?:pan|card_?number|cardnum|primary_?account_?number|cvv2?|cvc2?|csc|security_?code|exp(?:iry|iration)?(?:_?(?:date|month|year))?|exp_?(?:month|year)|pin|embed_?url|embed_?session|track_?data|tee_?token|auth_?token|access_?token)$/i;

// `_` and `-` count as part of an identifier, so UUIDs, base64url capabilities
// and dashed ids are never touched; a dashed PAN still matches when it stands alone.
const CARD_NUMBER_RUN = /(?<![0-9A-Za-z_-])\d(?:[ -]?\d){12,18}(?![0-9A-Za-z_-])/g;

// Inputs (tool arguments, keys included) are scanned more loosely: dots and
// slashes between digits too, so `4111.1111.1111.1111` or `4111/1111/...`
// never reaches Axum (review F7). Outputs keep the strict pattern above.
const CARD_NUMBER_RUN_INPUT = /(?<![0-9A-Za-z_-])\d(?:[ ./-]?\d){12,18}(?![0-9A-Za-z_-])/g;

export function isForbiddenCardKey(key: string): boolean {
  return FORBIDDEN_KEY.test(key);
}

/** Every 13 to 19 digit run that could be a card number. */
export function findCardNumberLike(text: string): string[] {
  return text.match(CARD_NUMBER_RUN) ?? [];
}

/** Input-side scan: also catches digits separated by dots or slashes. */
export function findCardNumberLikeInInput(text: string): string[] {
  return text.match(CARD_NUMBER_RUN_INPUT) ?? [];
}

/** Input-side redaction, for anything that echoes caller text (errors). */
export function redactCardNumbersInInput(text: string): string {
  return text.replace(CARD_NUMBER_RUN_INPUT, CARD_DATA_REDACTION);
}

export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/[ -]/g, "");
  if (!/^\d+$/.test(clean)) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = clean.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactCardNumbers(text: string): string {
  return text.replace(CARD_NUMBER_RUN, CARD_DATA_REDACTION);
}

export type RedactionResult<T> = { value: T; redactions: number };

/** Deep copy with forbidden keys removed and card-number-like runs replaced in every string. */
export function redactCardData<T>(input: T): RedactionResult<T> {
  let redactions = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error("Value is nested too deeply to check for card data");
    if (typeof value === "string") {
      const next = redactCardNumbers(value);
      if (next !== value) redactions += 1;
      return next;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      const text = value.toString();
      if (findCardNumberLike(text).length) {
        redactions += 1;
        return CARD_DATA_REDACTION;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (value instanceof Uint8Array) return value;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (isForbiddenCardKey(key)) {
          redactions += 1;
          continue;
        }
        out[key] = walk(item, depth + 1);
      }
      return out;
    }
    return value;
  };
  return { value: walk(input, 0) as T, redactions };
}

/** Throw instead of redacting. Use at trust boundaries where a match means a bug upstream. */
export function assertNoCardData(value: unknown, where = "value"): void {
  const { redactions } = redactCardData(value);
  if (redactions > 0) throw new Error(`Card data is never allowed in ${where}`);
}
