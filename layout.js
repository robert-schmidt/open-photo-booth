// Template parsing and layout math. Pure functions, shared by the renderer (app.js) and test.js.
// Templates use the template.xml format of dslrBooth/LumaBooth: pixel geometry at Resolution DPI, colors as #AARRGGBB.
const Layout = (() => {
  const TYPES = ['Photo', 'Image', 'Text', 'Rectangle', 'Ellipse'] // ponytail: QRCode elements are skipped
  const num = (v, d = 0) => (v === undefined || v === '' || isNaN(+v) ? d : +v)
  const bool = v => String(v).toLowerCase() === 'true'

  function color(v, fallback = 'transparent') {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v || '')
    if (!m) return fallback
    const h = m[1].length === 6 ? 'FF' + m[1] : m[1]
    const [a, r, g, b] = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16))
    return `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`
  }

  const element = (type, a) => ({
    type, name: a.Name || type,
    x: num(a.Left), y: num(a.Top), w: num(a.Width), h: num(a.Height),
    rotation: num(a.Rotation), opacity: num(a.Opacity, 100) / 100, z: num(a.ZIndex),
    keepAspect: bool(a.KeepAspect),
    stroke: num(a.Thickness) > 0 ? { width: num(a.Thickness), color: color(a.StrokeColor, '#000') } : null,
    shadow: bool(a.ShadowEnabled)
      ? { color: color(a.ShadowColor, '#000'), depth: num(a.ShadowDepth, 10), blur: num(a.ShadowRadius, 20), angle: num(a.ShadowDirection, -45) }
      : null,
    photo: num(a.PhotoNumber, 1),
    src: a.ImagePath || '',
    fill: color(a.Fill),
    text: a.Text || '', font: a.FontName || 'sans-serif', size: num(a.FontSize, 48),
    textColor: color(a.FontColor, '#000'), align: (a.TextAlignment || 'center').toLowerCase(),
  })

  // root: <Template> attributes; children: [{ tag, attrs }] from <Elements>.
  function fromNodes(root, children) {
    const elements = children.filter(c => TYPES.includes(c.tag)).map(c => element(c.tag, c.attrs)).sort((p, q) => p.z - q.z)
    const shots = Math.max(0, ...elements.filter(e => e.type === 'Photo').map(e => e.photo))
    if (!shots) throw new Error('Template has no photo slots')
    return {
      name: root.Name || 'Untitled', width: num(root.Width, 1800), height: num(root.Height, 1200),
      dpi: num(root.Resolution, 300), background: color(root.BackgroundColor, '#fff'), elements, shots,
    }
  }

  function parse(xml) {
    const root = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml').documentElement
    if (root.nodeName !== 'Template') throw new Error('Not a template.xml')
    const attrs = n => Object.fromEntries([...n.attributes].map(a => [a.name, a.value]))
    const els = root.getElementsByTagName('Elements')[0]
    return fromNodes(attrs(root), els ? [...els.children].map(n => ({ tag: n.nodeName, attrs: attrs(n) })) : [])
  }

  // Source crop that fills a dw x dh box, centered (object-fit: cover).
  function cover(sw, sh, dw, dh) {
    const s = Math.max(dw / sw, dh / sh)
    return { sx: (sw - dw / s) / 2, sy: (sh - dh / s) / 2, sw: dw / s, sh: dh / s }
  }

  // Destination rect inside a dw x dh box, centered (object-fit: contain).
  function contain(sw, sh, dw, dh) {
    const s = Math.min(dw / sw, dh / sh)
    return { dx: (dw - sw * s) / 2, dy: (dh - sh * s) / 2, dw: sw * s, dh: sh * s }
  }

  const fillText = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)

  return { parse, fromNodes, color, cover, contain, fillText }
})()

if (typeof module !== 'undefined') module.exports = Layout
