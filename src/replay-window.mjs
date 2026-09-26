export class ReplayWindow {
  constructor(limit = 10_000, ttlMs = 24 * 60 * 60_000) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.seen = new Map();
  }

  accept(sender, nonce, now = Date.now()) {
    if (
      typeof sender !== "string" ||
      typeof nonce !== "string" ||
      nonce.length > 32
    )
      return false;
    try {
      canonicalBase64(nonce, 12);
    } catch {
      return false;
    }
    const key = `${sender}:${nonce}`;
    if ((this.seen.get(key) || 0) > now) return false;
    this.seen.delete(key);
    this.seen.set(key, now + this.ttlMs);
    while (this.seen.size > this.limit)
      this.seen.delete(this.seen.keys().next().value);
    return true;
  }
}
import { canonicalBase64 } from "./common.mjs";
