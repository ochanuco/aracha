import { getBlob, putIfAbsent } from "./cas";
import { getCha } from "./cha/impl";

export async function storeBlob(env: { BLOBS: R2Bucket }, bytes: Uint8Array): Promise<string> {
  const blobId = getCha().blobId(bytes);
  await putIfAbsent(env.BLOBS, blobId, bytes);
  return blobId;
}

export function loadBlob(env: { BLOBS: R2Bucket }, blobId: string): Promise<Uint8Array | null> {
  return getBlob(env.BLOBS, blobId);
}
