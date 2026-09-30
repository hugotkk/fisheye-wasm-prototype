# fisheye-wasm-prototype

Client-side (WebGL) prototype for the dual-fisheye -> equirectangular
reprojection in [hugotkk/fisheye-image-converter](https://github.com/hugotkk/fisheye-image-converter).
Ports `build_panorama()` from that repo's `insp2pano.py` (numpy + opencv
`remap`) to a GLSL fragment shader, so the reprojection runs in the
browser instead of a Flask server.

No build step. Open `index.html` (served over `http://`, not `file://` —
canvas texture uploads need a proper origin) with a dual-fisheye `.insp`/
JPEG, tweak FOV/blend/roll/swap, hit Convert.

## Files

- `gl-pano.js` — the reprojection. WebGL2 primary path (fullscreen
  triangle, no vertex buffer, `gl_VertexID`), WebGL1 fallback (same GLSL
  math, classic vertex buffer, `texture2D`/`gl_FragColor`), and a
  Canvas2D/pure-JS fallback (per-pixel bilinear sampling, no GPU) for
  browsers with no WebGL at all. `renderPanorama()` tries them in that
  order.
- `xmp.js` — port of `gpano_xmp()`/`encode_jpeg()`: splices a GPano XMP
  APP1 segment after the JPEG SOI marker so output is recognized as a
  360 photo by Facebook/Google Photos/Street View.
- `index.html` — UI + wiring.

## Math port

`build_panorama()` walks: for every output equirect pixel, compute a world
direction vector, rotate it by the yaw/pitch/roll matrix, project it
through each lens's equidistant fisheye model (`lens_maps()`) to get pixel
coordinates in that lens's image circle, bilinear-sample both lenses, and
blend by angular distance from the seam with a smoothstep. That's a pure
function of per-pixel trig + one texture lookup per lens — no iterative
solve, no neighborhood ops — which maps directly onto a fragment shader
with no restructuring. The existing interactive viewer in `insp2pano.py`
(the `VIEWER` string) already runs the *inverse* of this projection
(equirect -> perspective view) as a GLSL shader in-browser, so this is the
same amount of shader code in the other direction.

One correctness subtlety worth noting for future readers: numpy applies
rotations as `dirs @ R` (row-vector convention), which is `R.transpose()`
relative to the usual GLSL `mat3 * vec3` (column-vector) convention. The
shader's `uR` uniform is uploaded as `R` flattened row-major with
`transpose: false` — which, because of how GLSL reads a flat array into a
column-major `mat3`, produces exactly the matrix needed to reproduce
`dirs @ R` when used as `uR * dir`. See the comment-free derivation in
`gl-pano.js`; get this backwards and yaw/pitch/roll all correctly return
0,0,0 (unrotated) but any nonzero rotation comes out transposed/wrong.

## Verification

Ran headless (Playwright driving the local system Chrome — the sandboxed
dev environment had no Chrome extension bridge available) against a
synthetic 3000x1500 dual-fisheye test image (concentric rings + radial
spokes + per-lens FRONT/BACK labels, generated since no real `.insp`
sample was available in this environment) and against the real
`insp2pano.py` CLI on the same input:

- **Visual parity**: side-by-side comparison shows identical ring
  geometry, spoke angles, seam blend position, and FRONT/BACK label
  placement between the WebGL output and the Python/opencv reference.
- **Pixel parity**: mean abs diff 5.2/255 across all channels, max diff
  239 (isolated to thin anti-aliased line edges — expected from
  GPU-side bilinear/AA vs. CPU `cv2.remap`, not a projection error). 8.7%
  of pixels differ by >20/255, all concentrated on 1-2px-wide line edges
  where a sub-pixel rasterization offset produces a large local diff even
  though the lines are visually in the same place.
- **Performance** (this device, Apple Silicon, WebGL2/WebKit backend):
  3000x1500 output, 3000x1500 input, reprojection 527ms, full pipeline
  (decode + reproject + JPEG encode + XMP embed) 626ms. `MAX_TEXTURE_SIZE`
  16384, comfortably above typical Insta360 dual-fisheye input dimensions
  (~6080x3040) and above the server app's `MAX_WIDTH` default (8000)
  output size.
  Peak JS heap during a run: ~5MB reported — the framebuffer/texture
  memory itself lives in GPU memory, not JS heap, which is the entire
  point: this avoids the ~2.75GB *server* memory spike the numpy pipeline
  hits at 6000px output.

Run the verification yourself: `python3 verify.py` (needs
`pip install playwright` and a local Chrome install; see the script for
how it drives the page and diffs output against a Python reference — the
Python reference generation itself needs `insp2pano.py`'s dependencies
from the main repo).

## Conclusions for the real migration

- WebGL2 fragment shader reprojection is correct and fast enough on this
  device to replace the server-side numpy path.
- Need a WebGL1/Canvas2D fallback for devices without WebGL2 — both are
  implemented here (untested on real WebGL1-only hardware; the dev
  environment only had a WebGL2-capable browser to verify against, so
  Phase 2 should get real-device testing on the fallback paths before
  they're trusted for production).
