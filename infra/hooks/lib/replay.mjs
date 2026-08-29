/**
 * replay — delivery-id markers, so a redelivered webhook is a no-op instead of a second build.
 *
 * A webhook sender retries a delivery that did not answer 2xx, using the SAME delivery id every
 * time. Without a marker, a receiver that was briefly slow or down turns every retry into another
 * queued job — the same exhaustion path hmac.mjs names, just moved one step later than the
 * signature check. `claim()` is only ever meant to be called AFTER the signature has verified
 * (see `hmac.mjs`) — the id itself is attacker-supplied and must not be trusted, or trigger any
 * filesystem write, before authentication.
 *
 * A marker is an empty file named for the delivery id, created with the exclusive flag so two
 * requests racing on the same id cannot both "win": the filesystem, not application logic, is
 * what makes the check atomic.
 */
import { mkdirSync, closeSync, openSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

// GitHub delivery ids are UUIDs. Anything else is refused outright rather than sanitised —
// this value becomes a filename, and there is no legitimate reason for it to contain a path
// separator or a null byte.
const SAFE_ID = /^[A-Za-z0-9-]+$/;

function markerPath(dir, deliveryId) {
  if (typeof deliveryId !== 'string' || deliveryId === '' || !SAFE_ID.test(deliveryId)) {
    throw new Error(`refusing to use delivery id as a filename: ${JSON.stringify(deliveryId)}`);
  }
  return join(dir, deliveryId);
}

// Returns true the first time `deliveryId` is seen (and leaves a marker behind), false on every
// call after. One filesystem call decides it — never a separate exists-then-create, which would
// race two concurrent deliveries of the same id.
export function claim(dir, deliveryId) {
  mkdirSync(dir, { recursive: true });
  const path = markerPath(dir, deliveryId);
  try {
    closeSync(openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}
