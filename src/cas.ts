const BLOB_ID = /^sha256:([0-9a-f]{64})$/;
const ATTEMPTS = 3;

export function blobKey(blobId: string): string {
  const m = BLOB_ID.exec(blobId);
  if (!m) throw new Error(`unsupported blob id: ${blobId}`);
  const hex = m[1]!;
  return `blobs/sha256/${hex.slice(0, 2)}/${hex}`;
}

export function derivedIrKey(parserVersion: string, irSchemaVersion: string, blobId: string): string {
  return `derived/ir/${parserVersion}/${irSchemaVersion}/${blobId}/tree.json`;
}

// put() resolves to null when the precondition fails, i.e. the object already exists.
export async function putIfAbsent(bucket: R2Bucket, blobId: string, bytes: Uint8Array): Promise<void> {
  const key = blobKey(blobId);
  let lastError: unknown;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export async function getBlob(bucket: R2Bucket, blobId: string): Promise<Uint8Array | null> {
  const obj = await bucket.get(blobKey(blobId));
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}
