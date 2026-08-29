/**
 * hmac — verify a webhook's signature before anything else touches the request.
 *
 * Why this is its own module, and why it comes first. The receiver is a network-facing process
 * on the box that serves production, and the build pipeline it feeds is a real threat surface:
 * content is input to a build that executes on the VPS, so an unauthenticated caller
 * who can reach this port has a CPU- and disk-exhaustion path against production. The one thing
 * that must happen before parsing, before writing, before even trusting the delivery id, is
 * proving the request carries the shared secret — over the raw bytes that were sent, never a
 * re-encoded or re-serialized version of them.
 *
 * Constant-time comparison. `crypto.timingSafeEqual` throws on a length mismatch rather than
 * returning false, so a malformed header is rejected on length FIRST. That branch only leaks the
 * length of a value in a fixed public format (`sha256=` + 64 hex chars) — never which byte of a
 * correctly-shaped signature differed, which is the comparison that is actually secret-dependent
 * and the one `timingSafeEqual` protects.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';
const PREFIX = 'sha256=';

// `payload` must be the exact bytes that were signed — a Buffer, not a string a body was decoded
// into and not a parsed-then-reserialized object. Whitespace, key order and Unicode
// normalisation all change the byte sequence, and any of them would make a genuine signature
// fail to verify, which is precisely why verification happens before parsing rather than after.
export function computeSignature(secret, payload) {
  return PREFIX + createHmac('sha256', secret).update(payload).digest('hex');
}

// Returns a boolean and never throws — a malformed header is a "no", not an exception a caller
// might mishandle into an open door.
export function verifySignature(secret, payload, header) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof header !== 'string' || !header.startsWith(PREFIX)) return false;
  const expected = computeSignature(secret, payload);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false; // see file header: this is a length check, not a value check
  return timingSafeEqual(a, b);
}
