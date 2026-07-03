// Perspective ("keystone") correction for the iPhone-camera capture source.
//
// A phone pointing at a monitor never sees a clean rectangle: the screen appears as a
// tilted quadrilateral, smaller than the frame, surrounded by desk/bezel. Before we ship
// a frame to Gemini we warp the user-selected quad back to a flat rectangle so the vision
// model reads a screenshot-like image instead of an angled photo. This both crops away
// everything but the screen and undoes the perspective, which is the "scaling adjustment"
// a hand-held camera needs.

export type Point = { x: number; y: number };

/**
 * Solve the 3x3 homography H (with h22 = 1) mapping each `dst` point to its `src` point,
 * i.e. src ≈ H · dst in homogeneous coordinates. Returns the 9 row-major coefficients.
 * `dst`/`src` are four corresponding corners in the order TL, TR, BR, BL.
 */
export function solveHomography(dst: Point[], src: Point[]): number[] {
  // Build the 8x8 linear system A·h = b for the 8 unknowns (h00..h21).
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: X, y: Y } = dst[i];
    const { x, y } = src[i];
    A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]);
    b.push(x);
    A.push([0, 0, 0, X, Y, 1, -X * y, -Y * y]);
    b.push(y);
  }
  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting for a small dense system. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / pv;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  // After full elimination M is diagonal; each unknown is the RHS over its pivot.
  return M.map((row, i) => row[n] / (row[i] || 1e-9));
}

/** Apply a homography to a point (returns the de-homogenised result). */
function applyH(h: number[], x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Warp the quadrilateral `srcQuad` (in the pixel space of `source`) to a flat
 * `outW`×`outH` rectangle, drawing the result into `out`. The perspective warp is
 * approximated by a triangle mesh: fine enough at this size to look continuous, cheap
 * enough to run every frame on a phone. `srcQuad` order is TL, TR, BR, BL.
 */
export function warpQuadToCanvas(
  source: CanvasImageSource,
  srcQuad: Point[],
  out: HTMLCanvasElement,
  outW: number,
  outH: number,
): void {
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) return;

  // Homography maps the output rectangle back onto the source quad.
  const dstRect: Point[] = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = solveHomography(dstRect, srcQuad);

  const GRID = 24;
  // Precompute the source position of every grid vertex.
  const pts: Point[][] = [];
  for (let gy = 0; gy <= GRID; gy++) {
    const row: Point[] = [];
    for (let gx = 0; gx <= GRID; gx++) {
      row.push(applyH(H, (gx / GRID) * outW, (gy / GRID) * outH));
    }
    pts.push(row);
  }

  ctx.clearRect(0, 0, outW, outH);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const dx0 = (gx / GRID) * outW;
      const dx1 = ((gx + 1) / GRID) * outW;
      const dy0 = (gy / GRID) * outH;
      const dy1 = ((gy + 1) / GRID) * outH;
      const s00 = pts[gy][gx];
      const s10 = pts[gy][gx + 1];
      const s11 = pts[gy + 1][gx + 1];
      const s01 = pts[gy + 1][gx];
      drawTriangle(ctx, source, s00, s10, s01, { x: dx0, y: dy0 }, { x: dx1, y: dy0 }, { x: dx0, y: dy1 });
      drawTriangle(ctx, source, s10, s11, s01, { x: dx1, y: dy0 }, { x: dx1, y: dy1 }, { x: dx0, y: dy1 });
    }
  }
}

/** Draw the source triangle (s0,s1,s2) into the destination triangle (d0,d1,d2). */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  s0: Point,
  s1: Point,
  s2: Point,
  d0: Point,
  d1: Point,
  d2: Point,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();

  // Affine [a c e; b d f] mapping each source corner to its destination corner. The two
  // coordinate rows share the same 3x3 matrix, so we solve x- and y-components separately.
  const M = [
    [s0.x, s0.y, 1],
    [s1.x, s1.y, 1],
    [s2.x, s2.y, 1],
  ];
  const [a, c, e] = solveLinear(M.map((r) => [...r]), [d0.x, d1.x, d2.x]);
  const [b, d, f] = solveLinear(M.map((r) => [...r]), [d0.y, d1.y, d2.y]);
  if (![a, b, c, d, e, f].every(Number.isFinite)) {
    ctx.restore();
    return;
  }

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}
