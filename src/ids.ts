const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const ms = Date.now();
  // 48-bit big-endian millisecond timestamp; avoid 32-bit bitwise ops on ms.
  const hi = Math.floor(ms / 2 ** 16);
  b[0] = Math.floor(hi / 2 ** 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUIDV7.test(value);
}
