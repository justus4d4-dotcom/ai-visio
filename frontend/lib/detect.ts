// Automatic screen-quad detection for the phone camera capture page.
//
// A monitor pointed at by a phone is almost always the brightest large region in the
// frame (an emissive display against a darker room/desk). We exploit that: downscale the
// current video frame, threshold the bright pixels, and take the four extreme corners of
// that bright blob as the screen quad. It is intentionally lightweight (no OpenCV) — a
// good first guess that the user can then fine-tune by dragging the corner handles.

import type { Point } from "@/lib/warp";

// Corner order everywhere: TL, TR, BR, BL (matches lib/warp + the camera page).
function quadAreaFrac(q: Point[]): number {
  // Shoelace area in fractional (0..1) coordinates.
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Estimate the screen quad from the current video frame. Returns corners as fractions of
 * the video frame (TL, TR, BR, BL), or null when no confident bright rectangle is found
 * (the caller should then keep the existing corners).
 */
export function detectScreenQuad(video: HTMLVideoElement): Point[] | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const W = 160;
  const H = Math.max(1, Math.round((W * vh) / vw));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, W, H);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return null; // tainted canvas etc.
  }

  const n = W * H;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    lum[p] = l;
    sum += l;
  }
  const mean = sum / n;
  let variance = 0;
  for (let p = 0; p < n; p++) {
    const d = lum[p] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / n);
  // "Bright" = clearly above the frame's average. The max() keeps it robust in both a dark
  // room (low mean) and an already-bright frame.
  const thresh = Math.max(mean + 0.5 * std, mean * 1.2, 55);

  let count = 0;
  // Extreme corners of the bright blob: TL=min(x+y), BR=max(x+y), TR=max(x-y), BL=min(x-y).
  let tlS = Infinity, brS = -Infinity, trS = -Infinity, blS = Infinity;
  let tl = { x: 0, y: 0 }, br = { x: 0, y: 0 }, tr = { x: 0, y: 0 }, bl = { x: 0, y: 0 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (lum[y * W + x] < thresh) continue;
      count++;
      const spd = x + y;
      const smd = x - y;
      if (spd < tlS) { tlS = spd; tl = { x, y }; }
      if (spd > brS) { brS = spd; br = { x, y }; }
      if (smd > trS) { trS = smd; tr = { x, y }; }
      if (smd < blS) { blS = smd; bl = { x, y }; }
    }
  }

  // Need a meaningful amount of bright area, but not the whole frame (that's just glare).
  const frac = count / n;
  if (frac < 0.03 || frac > 0.98) return null;

  const toFrac = (p: { x: number; y: number }): Point => ({ x: p.x / W, y: p.y / H });
  const quad = [toFrac(tl), toFrac(tr), toFrac(br), toFrac(bl)];
  if (quadAreaFrac(quad) < 0.05) return null; // too small / degenerate
  return quad;
}
