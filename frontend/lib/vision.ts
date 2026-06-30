// Lightweight perceptual hashing for client-side change detection.
//
// We downscale the current video frame to 8x8 grayscale and build a 64-bit average
// hash (aHash). Comparing the Hamming distance of two hashes tells us how visually
// different two frames are — without sending anything to the server.

const SIZE = 8;

/** Compute a 64-bit average hash of a video frame, returned as a 16-char hex string. */
export function aHashFromVideo(video: HTMLVideoElement): string | null {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  const gray: number[] = [];
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray.push(g);
    sum += g;
  }
  const avg = sum / gray.length;

  let bits = "";
  for (const g of gray) bits += g >= avg ? "1" : "0";

  // Pack 64 bits into 16 hex chars.
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two 16-char hex hashes (0..64). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
