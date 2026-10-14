/* eslint-disable */
// @ts-nocheck
/* Liquid Glass 主题的 WebGL 壁纸层。
 *
 * 移植自 m-ui 的 web/liquid-glass-gl.js，那份实现又移植自 liquid-glass-webgl
 * (https://github.com/martin65536/liquid-glass-webgl, Apache-2.0)。见仓库根目录 NOTICE。
 *
 * 一张铺满窗口的画布放在所有内容后面，它自己画壁纸，再在每个 .lg-surface 的位置画玻璃：
 * 折射（圆角矩形 SDF 梯度 + circleMap）、高斯模糊、色彩控制、斜面光和方向性边缘高光。
 * 文字和控件仍是上层的真实 DOM。只有直接放在壁纸上、下面没有页面内容滚过的元素才能注册
 * 成表面（侧栏、工具栏胶囊）；页面里的卡片、弹窗、菜单用 CSS 材质。
 *
 * 和 m-ui 的不同：
 *   - 没有内置壁纸：没设壁纸时背景就是主题底色；
 *   - 壁纸可以是用户自己的图片，模糊在上传纹理前用 2D 画布预先做好，遮罩（背景色按比例覆盖）
 *     在壁纸和玻璃两遍里都乘上，玻璃看到的就是屏幕上的壁纸；
 *   - 表面按 padding box 绘制（侧栏用透明边框留出四周的间距）；
 *   - 不做背光一侧的斜面压暗，它在边缘形成一道像阴影的黑线。
 */

// 直接放在壁纸上的表面：侧栏和页面顶部的工具栏胶囊
const SURFACE_SELECTOR = '.side, .page-toolbar-glass'

const PARAMS = {
  refractBand: 18,
  refractAmount: 26,
  blur: 7,
  brightness: 0.02,
  contrast: 1.0,
  saturation: 1.28,
  bevel: 0.9,
  lightAngleDeg: -68,
  rimStroke: 2.4,
  rimBlur: 1.1,
  rimFalloff: 2.2,
  rimAlpha: 0.9,
  tintLight: [0.96, 0.98, 1.0, 0.14],
  tintDark: [0.1, 0.14, 0.22, 0.3]
}

const OVERRIDES = [
  { sel: '.side', blur: 11, tintLightA: 0.18, refractBand: 26 },
  { sel: '.page-toolbar-glass', blur: 6, refractBand: 16 }
]

function blurTaps(n) {
  if (n <= 1) return [{ x: 0, y: 0, w: 1 }]
  const golden = Math.PI * (3 - Math.sqrt(5))
  const maxR = 3,
    taps = []
  let tot = 0
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n,
      r = maxR * Math.sqrt(t),
      a = i * golden
    const x = r * Math.cos(a),
      y = r * Math.sin(a),
      w = Math.exp(-0.5 * (x * x + y * y))
    taps.push({ x, y, w })
    tot += w
  }
  for (const tp of taps) tp.w /= tot
  return taps
}
const TAPS = blurTaps(16)
const BLUR_GLSL = TAPS.map(
  (t) =>
    `    sum += texture2D(uWall, uv + vec2(${t.x.toFixed(5)}, ${t.y.toFixed(5)}) * pxToUv) * ${t.w.toFixed(7)};`
).join('\n')

const VERT = `
  attribute vec2 aUnit;
  uniform vec4 uRectClip;
  void main() {
    vec2 p = mix(uRectClip.xy, uRectClip.zw, aUnit);
    gl_Position = vec4(p, 0.0, 1.0);
  }`

const COMMON = `
  precision highp float;
  uniform sampler2D uWall;
  uniform vec2 uCanvas;
  uniform vec2 uWallSize;
  uniform vec4 uVeil;          // 遮罩：rgb = 主题背景色，a = 覆盖比例
  float sdRoundedRect(vec2 c, vec2 h, float r) {
    vec2 q = abs(c) - (h - vec2(r));
    return length(max(q, 0.0)) - r + min(max(q.x, q.y), 0.0);
  }
  vec2 gradSdRoundedRect(vec2 c, vec2 h, float r) {
    vec2 q = abs(c) - (h - vec2(r));
    if (q.x >= 0.0 || q.y >= 0.0) {
      vec2 v = max(q, vec2(0.0)); float l = length(v);
      if (l < 1e-6) return vec2(0.0);
      return sign(c) * (v / l);
    }
    float gx = step(q.y, q.x);
    return sign(c) * vec2(gx, 1.0 - gx);
  }
  float circleMap(float x) { return 1.0 - sqrt(max(0.0, 1.0 - x * x)); }
  vec2 coverUv(vec2 px) {
    float ca = uCanvas.x / uCanvas.y, wa = uWallSize.x / uWallSize.y;
    vec2 uv = px / uCanvas;
    if (wa > ca) uv.x = (uv.x - 0.5) * (ca / wa) + 0.5;
    else uv.y = (uv.y - 0.5) * (wa / ca) + 0.5;
    return uv;
  }
  vec2 pxToUvScale() {
    float ca = uCanvas.x / uCanvas.y, wa = uWallSize.x / uWallSize.y;
    if (wa > ca) return vec2(ca / wa, 1.0) / uCanvas;
    return vec2(1.0, wa / ca) / uCanvas;
  }
  vec3 veil(vec3 c) { return mix(c, uVeil.rgb, uVeil.a); }`

const WALL_FRAG =
  COMMON +
  `
  uniform float uDim;
  void main() {
    vec2 px = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
    vec2 uv = coverUv(px);
    vec3 c = veil(texture2D(uWall, uv).rgb * uDim);
    gl_FragColor = vec4(c, 1.0);
  }`

const GLASS_FRAG =
  COMMON +
  `
  uniform vec2 uOffset;
  uniform vec2 uSize;
  uniform float uRadius;
  uniform float uBand;
  uniform float uAmount;
  uniform float uBlur;
  uniform float uBright, uContrast, uSat;
  uniform vec4 uTint;
  uniform float uBevel, uLightAngle;
  uniform float uGlassDim;
  vec3 colorControls(vec3 c) {
    float invS = 1.0 - uSat;
    float r = 0.213 * invS, g = 0.715 * invS, b = 0.072 * invS;
    float t = 0.5 - uContrast * 0.5 + uBright;
    float cs = uContrast * uSat, cr = uContrast * r, cg = uContrast * g, cb = uContrast * b;
    return vec3(
      (cr + cs) * c.r + cg * c.g + cb * c.b + t,
      cr * c.r + (cg + cs) * c.g + cb * c.b + t,
      cr * c.r + cg * c.g + (cb + cs) * c.b + t);
  }
  vec4 sampleBlurred(vec2 px, float radius) {
    vec2 uv = coverUv(px);
    if (radius < 0.5) return texture2D(uWall, uv);
    vec2 pxToUv = radius * pxToUvScale();
    vec4 sum = vec4(0.0);
${BLUR_GLSL}
    return sum;
  }
  void main() {
    vec2 screen = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
    vec2 center = uOffset + uSize * 0.5;
    vec2 centered = screen - center;
    vec2 halfSize = uSize * 0.5;
    float sd = sdRoundedRect(centered, halfSize, uRadius);
    if (sd > 1.0) discard;
    float edge = 1.0 - smoothstep(-1.0, 1.0, sd);
    float gradR = min(uRadius * 1.5, min(halfSize.x, halfSize.y));
    vec2 grad = gradSdRoundedRect(centered, halfSize, gradR);
    vec2 sampleCoord = screen;
    float intensity = 0.0;
    if (uBand > 0.5 && (-sd) < uBand) {
      float sdC = min(sd, 0.0);
      float k = 1.0 - (-sdC) / uBand;
      intensity = k;
      float d = circleMap(k) * uAmount;
      sampleCoord = screen + d * grad;
    }
    // 玻璃看到的必须是屏幕上画出来的壁纸：同样的压暗和遮罩
    vec4 bg = sampleBlurred(sampleCoord, uBlur);
    vec3 color = colorControls(veil(bg.rgb * uGlassDim));
    if (uBand > 0.5) {
      vec2 lightDir = vec2(cos(uLightAngle), sin(uLightAngle));
      float b1 = clamp(dot(grad, lightDir), 0.0, 1.0);
      color *= 1.0 + 0.5 * intensity * b1 * uBevel;
      // 偏离 m-ui：背光一侧的斜面压暗会在侧栏右边和工具栏底边形成一道黑线，去掉
    }
    color = mix(color, uTint.rgb, uTint.a);
    float coverage = edge;
    gl_FragColor = vec4(color * coverage, coverage);
  }`

const RIM_FRAG =
  COMMON +
  `
  uniform vec2 uOffset;
  uniform vec2 uSize;
  uniform float uRadius;
  uniform vec3 uRimColor;
  uniform float uRimAngle, uRimFalloff, uRimAlpha, uRimStroke, uRimBlur;
  void main() {
    vec2 screen = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
    vec2 center = uOffset + uSize * 0.5;
    vec2 centered = screen - center;
    vec2 halfSize = uSize * 0.5;
    float sd = sdRoundedRect(centered, halfSize, uRadius);
    if (sd > 0.0) discard;
    float strokeHalf = uRimStroke * 0.5;
    float sigma = max(uRimBlur, 0.1);
    float mask = 0.0, wSum = 0.0;
    for (int i = -1; i <= 1; i++) {
      float off = float(i) * sigma;
      float hard = (abs(sd - off) < strokeHalf) ? 1.0 : 0.0;
      float w = exp(-0.5 * (off * off) / (sigma * sigma));
      mask += hard * w; wSum += w;
    }
    mask = mask / wSum * 0.5;
    float gradR = min(uRadius * 1.5, min(halfSize.x, halfSize.y));
    vec2 grad = gradSdRoundedRect(centered, halfSize, gradR);
    vec2 normal = vec2(cos(uRimAngle), sin(uRimAngle));
    float d = dot(grad, normal);
    float ints = pow(abs(d), uRimFalloff);
    vec3 c = uRimColor * ints * mask * uRimAlpha;
    gl_FragColor = vec4(c, 1.0);
  }`

let gl, canvas, wallProg, glassProg, rimProg, quad, wallTex
let wallW = 1,
  wallH = 1
let active = false,
  rafId = 0,
  sig = '',
  idle = 0,
  pointerAngle = -0.9
const surfaces = new Map()
// 当前壁纸：url 为空时用主题底色；blur 预先做进纹理，veil 是遮罩比例
let wallpaper = { url: '', blur: 0, veil: 0 }
let wallKey = ''

function compile(type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[liquid-glass-gl] shader error:', gl.getShaderInfoLog(s))
    return null
  }
  return s
}
function program(frag) {
  const v = compile(gl.VERTEX_SHADER, VERT),
    f = compile(gl.FRAGMENT_SHADER, frag)
  if (!v || !f) return null
  const p = gl.createProgram()
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[liquid-glass-gl] link error:', gl.getProgramInfoLog(p))
    return null
  }
  p._u = {}
  p._a = { aUnit: gl.getAttribLocation(p, 'aUnit') }
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < n; i++) {
    const u = gl.getActiveUniform(p, i)
    p._u[u.name] = gl.getUniformLocation(p, u.name)
  }
  return p
}
const U = (p, name) => p._u[name]

const isDark = () => document.documentElement.classList.contains('dark')
// 壁纸明暗由遮罩控制
function themeDim() {
  return 1
}
function veilColor() {
  const c = getComputedStyle(document.documentElement).backgroundColor
  const m = /rgba?\(([^)]+)\)/.exec(c || '')
  if (!m) return isDark() ? [0, 0, 0] : [1, 1, 1]
  const p = m[1].split(/[\s,/]+/).map(Number)
  return [p[0] / 255, p[1] / 255, p[2] / 255]
}

function paramsFor(el) {
  const p = { ...PARAMS }
  for (const o of OVERRIDES) {
    if (!el.matches(o.sel)) continue
    if (o.blur != null) p.blur = o.blur
    if (o.refractBand != null) p.refractBand = o.refractBand
    if (o.refractAmount != null) p.refractAmount = o.refractAmount
    if (o.rimAlpha != null) p.rimAlpha = o.rimAlpha
    if (o.tintLightA != null) p._tintLightA = o.tintLightA
    if (o.tintDarkA != null) p._tintDarkA = o.tintDarkA
  }
  return p
}

function scan() {
  const found = new Set()
  document.querySelectorAll(SURFACE_SELECTOR).forEach((el) => {
    found.add(el)
    if (!surfaces.has(el)) surfaces.set(el, { el, p: paramsFor(el) })
  })
  for (const el of surfaces.keys()) if (!found.has(el) || !el.isConnected) surfaces.delete(el)
}

// 按 padding box 画：侧栏用透明边框留出和窗口边缘的间距
function rectOf(el) {
  const r = el.getBoundingClientRect()
  const w = el.clientWidth,
    h = el.clientHeight
  if (w < 2 || h < 2) return null
  const cs = getComputedStyle(el)
  if (cs.visibility !== 'visible' || cs.opacity === '0' || cs.display === 'none') return null
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null
  const x = r.left + el.clientLeft,
    y = r.top + el.clientTop
  const outer = parseFloat(cs.borderTopLeftRadius) || 16
  const radius = Math.min(Math.max(0, outer - el.clientLeft), w / 2, h / 2)
  return { x, y, w, h, radius }
}

function signature() {
  let s = `${innerWidth}x${innerHeight}:${themeDim()}:${isDark()}:${pointerAngle.toFixed(2)}:${wallKey}:${wallpaper.url ? '' : solidColor()}:`
  for (const st of surfaces.values()) {
    const r = st.el.getBoundingClientRect()
    s += `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)};`
  }
  return s
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.round(innerWidth * dpr),
    h = Math.round(innerHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
    canvas.style.width = innerWidth + 'px'
    canvas.style.height = innerHeight + 'px'
  }
  return dpr
}

function draw() {
  if (!wallpaper.url) ensureSolidWallpaper()
  if (!wallTex) return
  const dpr = resize()
  const CW = canvas.width,
    CH = canvas.height
  gl.viewport(0, 0, CW, CH)
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  const veil = veilColor()

  gl.disable(gl.BLEND)
  gl.useProgram(wallProg)
  gl.enableVertexAttribArray(wallProg._a.aUnit)
  gl.vertexAttribPointer(wallProg._a.aUnit, 2, gl.FLOAT, false, 0, 0)
  gl.uniform4f(U(wallProg, 'uRectClip'), -1, 1, 1, -1)
  gl.uniform2f(U(wallProg, 'uCanvas'), CW, CH)
  gl.uniform2f(U(wallProg, 'uWallSize'), wallW, wallH)
  gl.uniform4f(U(wallProg, 'uVeil'), veil[0], veil[1], veil[2], wallpaper.veil)
  gl.uniform1f(U(wallProg, 'uDim'), themeDim())
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, wallTex)
  gl.uniform1i(U(wallProg, 'uWall'), 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

  const dark = isDark()
  const rimColor = dark ? [0.86, 0.93, 1.0] : [1.0, 1.0, 1.0]

  gl.enable(gl.BLEND)
  for (const st of surfaces.values()) {
    const rc = rectOf(st.el)
    if (!rc) continue
    const p = st.p
    const ox = rc.x * dpr,
      oy = rc.y * dpr,
      sw = rc.w * dpr,
      sh = rc.h * dpr
    const pad = 2 * dpr
    const x0 = ((ox - pad) / CW) * 2 - 1,
      x1 = ((ox + sw + pad) / CW) * 2 - 1
    const y0 = 1 - ((oy - pad) / CH) * 2,
      y1 = 1 - ((oy + sh + pad) / CH) * 2
    const band = Math.min(p.refractBand * dpr, sw / 2, sh / 2)

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(glassProg)
    gl.enableVertexAttribArray(glassProg._a.aUnit)
    gl.vertexAttribPointer(glassProg._a.aUnit, 2, gl.FLOAT, false, 0, 0)
    gl.uniform4f(U(glassProg, 'uRectClip'), x0, y0, x1, y1)
    gl.uniform2f(U(glassProg, 'uCanvas'), CW, CH)
    gl.uniform2f(U(glassProg, 'uWallSize'), wallW, wallH)
    gl.uniform4f(U(glassProg, 'uVeil'), veil[0], veil[1], veil[2], wallpaper.veil)
    gl.uniform2f(U(glassProg, 'uOffset'), ox, oy)
    gl.uniform2f(U(glassProg, 'uSize'), sw, sh)
    gl.uniform1f(U(glassProg, 'uRadius'), Math.min(rc.radius * dpr, sw / 2, sh / 2))
    gl.uniform1f(U(glassProg, 'uBand'), band)
    gl.uniform1f(U(glassProg, 'uAmount'), p.refractAmount * dpr)
    gl.uniform1f(U(glassProg, 'uBlur'), p.blur * dpr)
    gl.uniform1f(U(glassProg, 'uBright'), p.brightness)
    gl.uniform1f(U(glassProg, 'uContrast'), p.contrast)
    gl.uniform1f(U(glassProg, 'uSat'), p.saturation)
    const tint = dark ? PARAMS.tintDark.slice() : PARAMS.tintLight.slice()
    if (dark && p._tintDarkA != null) tint[3] = p._tintDarkA
    if (!dark && p._tintLightA != null) tint[3] = p._tintLightA
    gl.uniform4f(U(glassProg, 'uTint'), tint[0], tint[1], tint[2], tint[3])
    gl.uniform1f(U(glassProg, 'uGlassDim'), themeDim())
    gl.uniform1f(U(glassProg, 'uBevel'), p.bevel)
    gl.uniform1f(U(glassProg, 'uLightAngle'), (p.lightAngleDeg * Math.PI) / 180)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, wallTex)
    gl.uniform1i(U(glassProg, 'uWall'), 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(rimProg)
    gl.enableVertexAttribArray(rimProg._a.aUnit)
    gl.vertexAttribPointer(rimProg._a.aUnit, 2, gl.FLOAT, false, 0, 0)
    gl.uniform4f(U(rimProg, 'uRectClip'), x0, y0, x1, y1)
    gl.uniform2f(U(rimProg, 'uCanvas'), CW, CH)
    gl.uniform2f(U(rimProg, 'uWallSize'), wallW, wallH)
    gl.uniform2f(U(rimProg, 'uOffset'), ox, oy)
    gl.uniform2f(U(rimProg, 'uSize'), sw, sh)
    gl.uniform1f(U(rimProg, 'uRadius'), Math.min(rc.radius * dpr, sw / 2, sh / 2))
    gl.uniform3f(U(rimProg, 'uRimColor'), rimColor[0], rimColor[1], rimColor[2])
    gl.uniform1f(U(rimProg, 'uRimAngle'), pointerAngle)
    gl.uniform1f(U(rimProg, 'uRimFalloff'), p.rimFalloff)
    gl.uniform1f(U(rimProg, 'uRimAlpha'), p.rimAlpha * (dark ? 0.7 : 1.0))
    gl.uniform1f(U(rimProg, 'uRimStroke'), p.rimStroke * dpr)
    gl.uniform1f(U(rimProg, 'uRimBlur'), Math.max(p.rimBlur * dpr, 0.3))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

function loop() {
  rafId = 0
  if (!active) return
  const cur = signature()
  if (cur !== sig) {
    sig = cur
    idle = 0
    draw()
  } else idle++
  if (idle < 8) rafId = requestAnimationFrame(loop)
}
function wake() {
  if (!active) return
  idle = 0
  sig = ''
  if (!rafId) rafId = requestAnimationFrame(loop)
}
export function refreshGlass() {
  if (!active) return
  scan()
  wake()
}

function putTexture(source, w, h) {
  if (!wallTex) wallTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, wallTex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
  } catch (e) {
    console.warn('[liquid-glass-gl] wallpaper upload failed:', e)
    return false
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  wallW = w
  wallH = h
  return true
}

// 没设壁纸时的底色：liquid-glass.css 里的 --lg-canvas（Apple 的分组背景灰），跟着明暗切换重新生成
function solidColor() {
  const root = document.documentElement
  return (
    getComputedStyle(root).getPropertyValue('--lg-canvas').trim() ||
    getComputedStyle(root).backgroundColor
  )
}

function ensureSolidWallpaper() {
  const color = solidColor()
  const key = `solid:${color}`
  if (key === wallKey && wallTex) return
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 2
  const ctx = c.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 2, 2)
  if (putTexture(c, 2, 2)) wallKey = key
}

// 模糊在上传前用 2D 画布做好：着色器里只有玻璃自己的模糊，壁纸本身是清晰的
function uploadWallpaper() {
  if (!wallpaper.url) return
  const key = `${wallpaper.url}:${wallpaper.blur}`
  if (key === wallKey && wallTex) return
  const img = new Image()
  img.onload = () => {
    // 加载期间又换了壁纸：丢弃这次的结果
    if (key !== `${wallpaper.url}:${wallpaper.blur}`) return
    const nw = img.naturalWidth || 1920,
      nh = img.naturalHeight || 1200
    const scale = Math.min(1, 2560 / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * scale)),
      h = Math.max(1, Math.round(nh * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    const blur = wallpaper.blur * scale
    if (blur > 0) {
      // 模糊会让边缘透明，先放大一圈再画
      const grow = blur * 3
      ctx.filter = `blur(${blur}px)`
      ctx.drawImage(img, -grow, -grow, w + grow * 2, h + grow * 2)
    } else ctx.drawImage(img, 0, 0, w, h)
    if (!putTexture(c, w, h)) return
    wallKey = key
    refreshGlass()
  }
  img.onerror = () => console.warn('[liquid-glass-gl] wallpaper load failed')
  img.src = wallpaper.url
}

export function setGlassWallpaper(next) {
  wallpaper = { ...wallpaper, ...next }
  if (!active) return
  uploadWallpaper()
  wake()
}

export function isGlassActive() {
  return active
}

export function startGlassGL() {
  if (active) return true
  if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return false
  canvas = document.createElement('canvas')
  canvas.id = 'liquid-glass-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;'
  const opts = {
    alpha: false,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power'
  }
  gl = canvas.getContext('webgl', opts)
  if (!gl) return false
  wallProg = program(WALL_FRAG)
  glassProg = program(GLASS_FRAG)
  rimProg = program(RIM_FRAG)
  if (!wallProg || !glassProg || !rimProg) return false
  quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

  document.body.insertBefore(canvas, document.body.firstChild)
  document.documentElement.setAttribute('data-glass-gl', 'on')
  active = true
  uploadWallpaper()
  scan()
  wake()

  addEventListener('resize', wake, { passive: true })
  addEventListener('scroll', wake, { passive: true, capture: true })
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return
      const host = e.target.closest?.(SURFACE_SELECTOR)
      if (host) {
        const r = host.getBoundingClientRect()
        pointerAngle = Math.atan2(
          e.clientY - (r.top + r.height / 2),
          e.clientX - (r.left + r.width / 2)
        )
      }
      wake()
    },
    { passive: true }
  )
  // 按钮、开关、标签栏每帧都写 inline style，它们不会移动玻璃表面，不能触发整层重绘
  const relevant = (r) =>
    r.attributeName !== 'style' ||
    (r.target.nodeType === 1 &&
      (r.target.matches(SURFACE_SELECTOR) || r.target.querySelector(SURFACE_SELECTOR)))
  const mo = new MutationObserver((records) => {
    if (records.some(relevant)) refreshGlass()
  })
  mo.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style']
  })
  // 明暗切换改的是 <html> 的 class
  new MutationObserver(wake).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshGlass()
  })
  if (document.fonts?.ready) document.fonts.ready.then(() => refreshGlass())
  setTimeout(refreshGlass, 300)
  return true
}
