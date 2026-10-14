/* eslint-disable */
// @ts-nocheck
/* Liquid Glass 主题的按钮按压反馈。
 *
 * 移植自 m-ui 的 web/liquid-button.js（InteractiveHighlight.kt 的网页版，来自 liquid-glass-webgl，
 * https://github.com/martin65536/liquid-glass-webgl，Apache-2.0，见仓库根目录 NOTICE）：
 *   - 按压进度用欠阻尼弹簧（k = 300，ζ = 0.5），松开时轻微回弹；
 *   - 放大 1 + (4 / 48) * press；
 *   - 按住拖动时按 tanh 限幅跟随手指，并沿拖动方向拉伸；
 *   - 整体叠加白色 8% x press，手指处叠加白色 15% x press 的径向光晕（半径为短边 1.5 倍）。
 * 动画写在独立的 CSS scale / translate 属性上，不覆盖原有 transform；光晕由 CSS 根据
 * --lb-* 变量画。
 *
 * 和 m-ui 的不同：作用在 HeroUI 的按钮上，排除标签、开关、菜单项等自带交互的控件。
 */

const SELECTOR = 'button'
// 自带液态交互或不属于按钮外观的控件
const EXCLUDE =
  '[role="tab"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [data-slot="tabList"] *, [role="menu"] *, [role="listbox"] *, [data-slot="trigger"]'

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const OMEGA = Math.sqrt(300)
const ZETA = 0.5
const OMEGA_D = OMEGA * Math.sqrt(1 - ZETA * ZETA)
const THRESHOLD = 0.003
const PRESS_SCALE = 4 / 48

function spring(x, v, target, dt) {
  const x0 = x - target
  const decay = Math.exp(-ZETA * OMEGA * dt)
  const cos = Math.cos(OMEGA_D * dt),
    sin = Math.sin(OMEGA_D * dt)
  const b0 = (v + ZETA * OMEGA * x0) / OMEGA_D
  const offset = x0 * decay * cos + b0 * decay * sin
  return [
    target + offset,
    -ZETA * OMEGA * offset + decay * (-x0 * OMEGA_D * sin + b0 * OMEGA_D * cos)
  ]
}

const states = new Map()
let raf = 0,
  prevT = 0,
  active = null

function wake() {
  if (!raf) {
    prevT = 0
    raf = requestAnimationFrame(loop)
  }
}

function stateOf(el) {
  let st = states.get(el)
  if (!st) {
    st = {
      el,
      press: 0,
      pressV: 0,
      target: 0,
      dx: 0,
      dxV: 0,
      dy: 0,
      dyV: 0,
      tdx: 0,
      tdy: 0,
      w: 1,
      h: 1
    }
    states.set(el, st)
  }
  return st
}

function apply(st) {
  const el = st.el
  const p = st.press
  const glow = Math.max(0, Math.min(1, p))
  el.style.setProperty('--lb-p', glow.toFixed(4))
  if (reducedMotion.matches) return
  const minDim = Math.min(st.w, st.h),
    maxDim = Math.max(st.w, st.h)
  const tx = minDim * Math.tanh((0.05 * st.dx) / minDim)
  const ty = minDim * Math.tanh((0.05 * st.dy) / minDim)
  const angle = Math.atan2(st.dy, st.dx)
  const scale = 1 + PRESS_SCALE * p
  const sx =
    scale + PRESS_SCALE * Math.abs((Math.cos(angle) * st.dx) / maxDim) * Math.min(st.w / st.h, 1)
  const sy =
    scale + PRESS_SCALE * Math.abs((Math.sin(angle) * st.dy) / maxDim) * Math.min(st.h / st.w, 1)
  el.style.translate = `${tx.toFixed(2)}px ${ty.toFixed(2)}px`
  el.style.scale = `${sx.toFixed(4)} ${sy.toFixed(4)}`
}

function clear(st) {
  const el = st.el
  el.style.removeProperty('--lb-p')
  el.style.removeProperty('translate')
  el.style.removeProperty('scale')
  el.classList.remove('lb-pressed')
  states.delete(el)
}

function loop(now) {
  raf = 0
  const dt = Math.min((now - (prevT || now - 16)) / 1000, 0.032)
  prevT = now
  let any = false
  for (const st of states.values()) {
    let moving = false
    for (const [k, v, t] of [
      ['press', 'pressV', 'target'],
      ['dx', 'dxV', 'tdx'],
      ['dy', 'dyV', 'tdy']
    ]) {
      if (Math.abs(st[t] - st[k]) > THRESHOLD || Math.abs(st[v]) > THRESHOLD) {
        ;[st[k], st[v]] = spring(st[k], st[v], st[t], dt)
        moving = true
      } else {
        st[k] = st[t]
        st[v] = 0
      }
    }
    if (moving || st === active) {
      apply(st)
      any = true
    } else if (st.target === 0) {
      clear(st)
    }
  }
  if (any) raf = requestAnimationFrame(loop)
  else prevT = 0
}

function targetOf(e) {
  const el = e.target.closest && e.target.closest(SELECTOR)
  if (!el || el.closest(EXCLUDE) || el.disabled || el.getAttribute('aria-disabled') === 'true')
    return null
  return el
}

function onDown(e) {
  if (e.button !== 0 || !e.isPrimary) return
  const el = targetOf(e)
  if (!el) return
  const st = stateOf(el)
  const rect = el.getBoundingClientRect()
  // Measure in layout pixels, not the currently scaled box.
  st.w = el.offsetWidth || rect.width
  st.h = el.offsetHeight || rect.height
  st.startX = e.clientX
  st.startY = e.clientY
  st.tdx = st.tdy = 0
  st.target = 1
  st.pointerId = e.pointerId
  active = st
  el.classList.add('lb-pressed')
  el.style.setProperty('--lb-gx', `${e.clientX - rect.left}px`)
  el.style.setProperty('--lb-gy', `${e.clientY - rect.top}px`)
  el.style.setProperty('--lb-r', `${Math.min(st.w, st.h) * 1.5}px`)
  wake()
}

function onMove(e) {
  const st = active
  if (!st || e.pointerId !== st.pointerId) return
  st.tdx = e.clientX - st.startX
  st.tdy = e.clientY - st.startY
  const rect = st.el.getBoundingClientRect()
  st.el.style.setProperty('--lb-gx', `${e.clientX - rect.left}px`)
  st.el.style.setProperty('--lb-gy', `${e.clientY - rect.top}px`)
  wake()
}

function onUp(e) {
  const st = active
  if (!st || (e && e.pointerId !== st.pointerId)) return
  active = null
  st.target = 0
  st.tdx = st.tdy = 0
  st.el.classList.remove('lb-pressed')
  wake()
}

// Keyboard activation gets a short press pulse, like a tap.
function onKey(e) {
  if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return
  const el = targetOf(e)
  if (!el) return
  const st = stateOf(el)
  st.w = el.offsetWidth || 1
  st.h = el.offsetHeight || 1
  el.style.setProperty('--lb-gx', '50%')
  el.style.setProperty('--lb-gy', '50%')
  el.style.setProperty('--lb-r', `${Math.min(st.w, st.h) * 1.5}px`)
  st.target = 1
  wake()
  setTimeout(() => {
    if (active !== st) {
      st.target = 0
      wake()
    }
  }, 120)
}

let installed = false
export function installButtons() {
  if (installed) return
  installed = true
  document.addEventListener('pointerdown', onDown, { passive: true })
  window.addEventListener('pointermove', onMove, { passive: true })
  window.addEventListener('pointerup', onUp, { passive: true })
  window.addEventListener('pointercancel', onUp, { passive: true })
  window.addEventListener('blur', () => onUp(null))
  document.addEventListener('keydown', onKey)
}
