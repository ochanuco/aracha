let lastMs = 0;
let seq = 0;

// UUIDv7 (RFC 9562): 48-bit ms timestamp, 12-bit counter in rand_a to keep
// ids created within the same millisecond ordered.
export function uuidv7() {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    seq++;
    if (seq > 0xfff) { ms++; seq = 0; }
  } else {
    seq = 0;
  }
  lastMs = ms;
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const t = BigInt(ms);
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
