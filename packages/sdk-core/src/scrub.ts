// PII scrub, copied (not imported) from apps/server/src/errors/scrub.ts, the
// one /track applies to `$exception`. The SDK runs it where nothing on the
// server will: session replay chunks are stored as sent, so `$console` lines
// (and later network headers and bodies, VEL-2145) are scrubbed here.
// scrub.test.ts repeats the server's cases: keep the two copies identical.
//
// Pattern-based and narrow on purpose: e-mail addresses, bearer / JWT /
// `token=`-style secrets and card numbers that pass Luhn. A safety net for
// text that interpolates user input, not a guarantee.

/** Depth past which `scrubDeep` replaces an object or array with {@link SCRUB_TRUNCATED}. */
export const MAX_SCRUB_DEPTH = 8;
export const SCRUB_TRUNCATED = "[truncated]";
export const SCRUB_TOKEN = "[token]";

// Starts only where a run of local-part characters starts: an unanchored start
// rescans every suffix of a long run with no "@" (quadratic). Same matches.
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g;
const KEY_VALUE =
  /\b(token|access_token|refresh_token|id_token|auth_token|api_key|apikey|api-key|secret|client_secret|password|passwd|pwd)=([^\s&"',;]+)/gi;
// 13-19 digits, optionally grouped by spaces or dashes.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replaces e-mails, bearer / JWT / `key=value` secrets and Luhn-valid card numbers. */
export function scrubText(text: string): string {
  return text
    .replace(JWT, "[token]")
    .replace(BEARER, "$1 [token]")
    .replace(KEY_VALUE, "$1=[token]")
    .replace(EMAIL, "[email]")
    .replace(CARD_CANDIDATE, (m) => {
      const digits = m.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[card]" : m;
    });
}

// In structured data a secret sits under its key with no `token=` around it,
// so the key itself decides. Matched with separators and case removed
// (`apiKey`, `api_key`, `X-Api-Key`).
const SECRET_KEY =
  /^(?:x)?(?:token|accesstoken|refreshtoken|idtoken|authtoken|authorization|auth|apikey|secret|clientsecret|password|passwd|pwd|cookie|setcookie|sessionid)$/;

/** Whether a property or header name holds a secret (`password`, `apiKey`, `Authorization`, ...). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[-_\s]/g, ""));
}

/**
 * A scrubbed copy of a JSON-like value: strings through {@link scrubText},
 * the value under a secret key (not null) replaced by `"[token]"`, objects and
 * arrays deeper than `maxDepth` replaced by `"[truncated]"`. Walks own
 * enumerable keys only; the input is not mutated. Not cycle-safe on its own:
 * the depth bound is what stops a cycle.
 */
export function scrubDeep(value: unknown, maxDepth = MAX_SCRUB_DEPTH, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (depth >= maxDepth) {
    return Array.isArray(value) || (typeof value === "object" && value !== null)
      ? SCRUB_TRUNCATED
      : value;
  }
  if (Array.isArray(value)) return value.map((x) => scrubDeep(x, maxDepth, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      out[k] = isSecretKey(k) && x != null ? SCRUB_TOKEN : scrubDeep(x, maxDepth, depth + 1);
    }
    return out;
  }
  return value;
}
