// Client-side port of insp2pano.py's build_panorama(): dual-fisheye ->
// equirectangular reprojection, done as a WebGL fragment shader instead of
// a numpy remap. Falls back to WebGL1, then a slow Canvas2D/JS path.

function rotationMatrix(yawDeg, pitchDeg, rollDeg) {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180, r = rollDeg * Math.PI / 180;
  const Ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const Rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]];
  const Rz = [[Math.cos(r), -Math.sin(r), 0], [Math.sin(r), Math.cos(r), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row, i) => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  return mul(mul(Ry, Rx), Rz);
}

const FRAG_BODY = `
uniform vec2 uImgSize;
uniform vec2 uOutSize;
uniform vec2 uLensSize;
uniform vec2 uFrontCenter;
uniform vec2 uBackCenter;
uniform float uRadiusScale;
uniform float uFovHalfRad;
uniform float uBlendHalfRad;
uniform mat3 uR;
uniform float uFrontIsLeft;
uniform float uSwap;

vec4 sampleLens(sampler2D tex, vec3 d, vec2 center, float radius, float originU, out float theta) {
  theta = acos(clamp(d.z, -1.0, 1.0));
  float phi = atan(d.y, d.x);
  float r = theta / uFovHalfRad * radius;
  float mx = center.x + r * cos(phi);
  float my = center.y + r * sin(phi);
  if (mx < 0.0 || mx >= uLensSize.x || my < 0.0 || my >= uLensSize.y) return vec4(0.0);
  vec2 uv = vec2(originU + mx / uImgSize.x, my / uImgSize.y);
  return SAMPLE(tex, uv);
}

vec4 panoColor(sampler2D tex, vec2 fragXY) {
  float PI = 3.14159265358979;
  float lon = (fragXY.x + 0.5) / uOutSize.x * 2.0 * PI - PI;
  float lat = PI * 0.5 - (fragXY.y + 0.5) / uOutSize.y * PI;
  vec3 dLocal = vec3(cos(lat) * sin(lon), -sin(lat), cos(lat) * cos(lon));
  vec3 dW = uR * dLocal;
  vec3 dBack = vec3(-dW.x, dW.y, -dW.z);

  vec2 fCenter = vec2(uLensSize.x * 0.5 + uFrontCenter.x, uLensSize.y * 0.5 + uFrontCenter.y);
  vec2 bCenter = vec2(uLensSize.x * 0.5 + uBackCenter.x, uLensSize.y * 0.5 + uBackCenter.y);
  float rad = min(uLensSize.x, uLensSize.y) * 0.5 * uRadiusScale;

  bool frontIsLeft = uFrontIsLeft > 0.5;
  float frontOriginU = frontIsLeft ? 0.0 : 0.5;
  float backOriginU = frontIsLeft ? 0.5 : 0.0;

  float ft, bt;
  vec4 fCol = sampleLens(tex, dW, fCenter, rad, frontOriginU, ft);
  vec4 bCol = sampleLens(tex, dBack, bCenter, rad, backOriginU, bt);

  float t = clamp((ft - (1.5707963267948966 - uBlendHalfRad)) / (2.0 * uBlendHalfRad), 0.0, 1.0);
  float wBack = t * t * (3.0 - 2.0 * t);
  float edge = uFovHalfRad;
  float wFront = ft < edge ? (1.0 - wBack) : 0.0;
  wBack = bt < edge ? wBack : 0.0;
  float norm = max(wFront + wBack, 1e-6);
  return vec4((fCol.rgb * wFront + bCol.rgb * wBack) / norm, 1.0);
}
`;

const VS_GL2 = `#version 300 es
const vec2 verts[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() { gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0); }`;

const FS_GL2 = `#version 300 es
precision highp float;
uniform sampler2D uTex;
out vec4 fragColor;
#define SAMPLE texture
${FRAG_BODY}
void main() { fragColor = panoColor(uTex, gl_FragCoord.xy); }`;

const VS_GL1 = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_GL1 = `
precision highp float;
uniform sampler2D uTex;
#define SAMPLE texture2D
${FRAG_BODY}
void main() { fragColor_stub(); }
`; // patched below (GLSL ES 1.00 has no gl_FragCoord write target issue, but needs gl_FragColor)

const FS_GL1_FINAL = FS_GL1.replace('void main() { fragColor_stub(); }',
  'void main() { gl_FragColor = panoColor(uTex, gl_FragCoord.xy); }');

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('shader compile failed: ' + log);
  }
  return s;
}

function link(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

function setUniforms(gl, prog, opts, R) {
  const u = name => gl.getUniformLocation(prog, name);
  gl.uniform2f(u('uImgSize'), opts.imgW, opts.imgH);
  gl.uniform2f(u('uOutSize'), opts.outW, opts.outH);
  gl.uniform2f(u('uLensSize'), opts.imgW / 2, opts.imgH);
  gl.uniform2f(u('uFrontCenter'), opts.frontCenter[0], opts.frontCenter[1]);
  gl.uniform2f(u('uBackCenter'), opts.backCenter[0], opts.backCenter[1]);
  gl.uniform1f(u('uRadiusScale'), opts.radiusScale);
  gl.uniform1f(u('uFovHalfRad'), opts.fov / 2 * Math.PI / 180);
  gl.uniform1f(u('uBlendHalfRad'), opts.blend * Math.PI / 180);
  gl.uniform1f(u('uFrontIsLeft'), opts.swap ? 0.0 : 1.0);
  gl.uniformMatrix3fv(u('uR'), false, new Float32Array([].concat(...R)));
  gl.uniform1i(u('uTex'), 0);
}

function makeTexture(gl, image) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// opts: { imgW, imgH, outW, outH, fov, blend, radiusScale, frontCenter:[x,y],
//         backCenter:[x,y], swap, yaw, pitch, roll }
function renderPanoramaWebGL2(image, opts) {
  const canvas = document.createElement('canvas');
  canvas.width = opts.outW; canvas.height = opts.outH;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (opts.imgW > maxTex || opts.imgH > maxTex) {
    gl.getExtension('WEBGL_lose_context'); // release before falling through
    return { unsupported: true, reason: `image ${opts.imgW}x${opts.imgH} exceeds MAX_TEXTURE_SIZE ${maxTex}` };
  }
  const prog = link(gl, VS_GL2, FS_GL2);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  makeTexture(gl, image);
  const R = rotationMatrix(opts.yaw, opts.pitch, opts.roll);
  setUniforms(gl, prog, opts, R);
  gl.viewport(0, 0, opts.outW, opts.outH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return { canvas, backend: 'webgl2', maxTextureSize: maxTex };
}

function renderPanoramaWebGL1(image, opts) {
  const canvas = document.createElement('canvas');
  canvas.width = opts.outW; canvas.height = opts.outH;
  const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true }) ||
             canvas.getContext('experimental-webgl', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (opts.imgW > maxTex || opts.imgH > maxTex) {
    return { unsupported: true, reason: `image ${opts.imgW}x${opts.imgH} exceeds MAX_TEXTURE_SIZE ${maxTex}` };
  }
  const prog = link(gl, VS_GL1, FS_GL1_FINAL);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  makeTexture(gl, image);
  const R = rotationMatrix(opts.yaw, opts.pitch, opts.roll);
  setUniforms(gl, prog, opts, R);
  gl.viewport(0, 0, opts.outW, opts.outH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return { canvas, backend: 'webgl1', maxTextureSize: maxTex };
}

// Slow last-resort path: plain JS/Canvas2D, same math as the shader, no GPU.
// O(outW*outH) per-pixel bilinear sampling; only meant for devices with no WebGL.
function renderPanoramaCanvas2D(image, opts, onProgress) {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = opts.imgW; srcCanvas.height = opts.imgH;
  const sctx = srcCanvas.getContext('2d');
  sctx.drawImage(image, 0, 0, opts.imgW, opts.imgH);
  const src = sctx.getImageData(0, 0, opts.imgW, opts.imgH).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = opts.outW; outCanvas.height = opts.outH;
  const octx = outCanvas.getContext('2d');
  const out = octx.createImageData(opts.outW, opts.outH);

  const R = rotationMatrix(opts.yaw, opts.pitch, opts.roll);
  const lensW = opts.imgW / 2, lensH = opts.imgH;
  const fCenter = [lensW / 2 + opts.frontCenter[0], lensH / 2 + opts.frontCenter[1]];
  const bCenter = [lensW / 2 + opts.backCenter[0], lensH / 2 + opts.backCenter[1]];
  const rad = Math.min(lensW, lensH) / 2 * opts.radiusScale;
  const fovHalf = opts.fov / 2 * Math.PI / 180;
  const blendHalf = opts.blend * Math.PI / 180;
  const frontOriginX = opts.swap ? lensW : 0;
  const backOriginX = opts.swap ? 0 : lensW;

  function bilinear(ox, oy) {
    if (ox < 0 || ox >= opts.imgW || oy < 0 || oy >= opts.imgH) return [0, 0, 0];
    const x0 = Math.floor(ox), y0 = Math.floor(oy);
    const x1 = Math.min(x0 + 1, opts.imgW - 1), y1 = Math.min(y0 + 1, opts.imgH - 1);
    const fx = ox - x0, fy = oy - y0;
    const idx = (x, y) => (y * opts.imgW + x) * 4;
    const c = [0, 1, 2].map(k => {
      const a = src[idx(x0, y0) + k], b = src[idx(x1, y0) + k];
      const c_ = src[idx(x0, y1) + k], d = src[idx(x1, y1) + k];
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c_ * (1 - fx) * fy + d * fx * fy;
    });
    return c;
  }

  function sampleLens(d, center, originX) {
    const theta = Math.acos(Math.max(-1, Math.min(1, d[2])));
    const phi = Math.atan2(d[1], d[0]);
    const r = theta / fovHalf * rad;
    const mx = center[0] + r * Math.cos(phi);
    const my = center[1] + r * Math.sin(phi);
    if (mx < 0 || mx >= lensW || my < 0 || my >= lensH) return { col: [0, 0, 0], theta };
    return { col: bilinear(originX + mx, my), theta };
  }

  const PI = Math.PI;
  for (let y = 0; y < opts.outH; y++) {
    const lat = PI / 2 - (y + 0.5) / opts.outH * PI;
    const coslat = Math.cos(lat), sinlat = Math.sin(lat);
    for (let x = 0; x < opts.outW; x++) {
      const lon = (x + 0.5) / opts.outW * 2 * PI - PI;
      const dl = [coslat * Math.sin(lon), -sinlat, coslat * Math.cos(lon)];
      const dW = [
        dl[0] * R[0][0] + dl[1] * R[1][0] + dl[2] * R[2][0],
        dl[0] * R[0][1] + dl[1] * R[1][1] + dl[2] * R[2][1],
        dl[0] * R[0][2] + dl[1] * R[1][2] + dl[2] * R[2][2],
      ];
      const dBack = [-dW[0], dW[1], -dW[2]];
      const f = sampleLens(dW, fCenter, frontOriginX);
      const b = sampleLens(dBack, bCenter, backOriginX);
      const t = Math.max(0, Math.min(1, (f.theta - (PI / 2 - blendHalf)) / (2 * blendHalf)));
      let wBack = t * t * (3 - 2 * t);
      const edge = fovHalf;
      const wFront = f.theta < edge ? 1 - wBack : 0;
      wBack = b.theta < edge ? wBack : 0;
      const norm = Math.max(wFront + wBack, 1e-6);
      const o = (y * opts.outW + x) * 4;
      out.data[o] = (f.col[0] * wFront + b.col[0] * wBack) / norm;
      out.data[o + 1] = (f.col[1] * wFront + b.col[1] * wBack) / norm;
      out.data[o + 2] = (f.col[2] * wFront + b.col[2] * wBack) / norm;
      out.data[o + 3] = 255;
    }
    if (onProgress && (y % 64 === 0)) onProgress(y / opts.outH);
  }
  octx.putImageData(out, 0, 0);
  return { canvas: outCanvas, backend: 'canvas2d' };
}

function renderPanorama(image, opts, onProgress) {
  let r = null;
  try { r = renderPanoramaWebGL2(image, opts); } catch (e) { console.warn('webgl2 failed', e); }
  if (r && !r.unsupported) return r;
  const webgl2Reason = r && r.unsupported ? r.reason : 'no WebGL2 context';
  try { r = renderPanoramaWebGL1(image, opts); } catch (e) { console.warn('webgl1 failed', e); }
  if (r && !r.unsupported) { r.fallbackFrom = webgl2Reason; return r; }
  const webgl1Reason = r && r.unsupported ? r.reason : 'no WebGL1 context';
  const r2 = renderPanoramaCanvas2D(image, opts, onProgress);
  r2.fallbackFrom = `${webgl2Reason}; ${webgl1Reason}`;
  return r2;
}
