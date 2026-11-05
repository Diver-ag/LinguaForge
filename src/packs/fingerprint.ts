/**
 * Calculates a fast, deterministic content fingerprint for dataset files:
 * SHA-256 of (first 1MB + last 1MB + 8-byte big-endian file size).
 * Works across both Main Thread and Web Workers using standard crypto.subtle.
 */
export async function computeFingerprint(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const size = bytes.byteLength;
  const ONE_MB = 1024 * 1024;

  let sample: Uint8Array;
  if (size <= 2 * ONE_MB) {
    sample = bytes;
  } else {
    sample = new Uint8Array(2 * ONE_MB);
    sample.set(bytes.subarray(0, ONE_MB), 0);
    sample.set(bytes.subarray(size - ONE_MB, size), ONE_MB);
  }

  // Append 8-byte size to guarantee different file sizes with similar chunks don't collide
  const payload = new Uint8Array(sample.length + 8);
  payload.set(sample, 0);
  const view = new DataView(payload.buffer, payload.byteOffset + sample.length, 8);
  view.setBigUint64(0, BigInt(size));

  const hashBuffer = await crypto.subtle.digest('SHA-256', payload);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
