// Template model: parse, serialize and layout math. Pure functions, shared by the renderer and test.js.
// Templates use the template.xml format of dslrBooth/LumaBooth: pixel geometry at Resolution DPI, colors as #AARRGGBB.
const Layout = (() => {
  const TYPES = ['Photo', 'Image', 'Text', 'Rectangle', 'Ellipse'] // ponytail: QRCode elements are skipped
  const num = (v, d = 0) => (v === undefined || v === '' || isNaN(+v) ? d : +v)
  const bool = v => String(v).toLowerCase() === 'true'

  // Normalize to #AARRGGBB; #RRGGBB gets full alpha.
  function argb(v, fallback = '#00000000') {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v || '')
    return m ? '#' + (m[1].length === 6 ? 'FF' : '') + m[1].toUpperCase() : fallback
  }

  function css(v) {
    const h = argb(v).slice(1)
    const [a, r, g, b] = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16))
    return `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`
  }

  // One flat shape for every element type; fields that don't apply to a type are ignored.
  const element = (type, a = {}) => ({
    type, name: a.Name || type,
    x: num(a.Left), y: num(a.Top), w: num(a.Width, 400), h: num(a.Height, 300),
    rotation: num(a.Rotation), opacity: num(a.Opacity, 100), z: num(a.ZIndex), keepAspect: bool(a.KeepAspect),
    strokeWidth: num(a.Thickness), strokeColor: argb(a.StrokeColor, '#FF000000'),
    shadow: bool(a.ShadowEnabled), shadowColor: argb(a.ShadowColor, '#80000000'),
    shadowDepth: num(a.ShadowDepth, 10), shadowBlur: num(a.ShadowRadius, 20), shadowAngle: num(a.ShadowDirection, -45),
    photo: num(a.PhotoNumber, 1), src: a.ImagePath || '', fill: argb(a.Fill),
    text: a.Text || '', font: a.FontName || 'Georgia', size: num(a.FontSize, 48),
    textColor: argb(a.FontColor, '#FF000000'), align: (a.TextAlignment || 'center').toLowerCase(),
  })

  const shots = t => Math.max(0, ...t.elements.filter(e => e.type === 'Photo').map(e => e.photo))

  // root: <Template> attributes; children: [{ tag, attrs }] from <Elements>.
  function fromNodes(root, children) {
    const t = {
      name: root.Name || 'Untitled', width: num(root.Width, 1800), height: num(root.Height, 1200),
      dpi: num(root.Resolution, 300), background: argb(root.BackgroundColor, '#FFFFFFFF'),
      elements: children.filter(c => TYPES.includes(c.tag)).map(c => element(c.tag, c.attrs)).sort((p, q) => p.z - q.z),
    }
    t.shots = shots(t)
    if (!t.shots) throw new Error('Template has no photo slots')
    return t
  }

  function parse(xml) {
    const root = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml').documentElement
    if (root.nodeName !== 'Template') throw new Error('Not a template.xml')
    const attrs = n => Object.fromEntries([...n.attributes].map(a => [a.name, a.value]))
    const els = root.getElementsByTagName('Elements')[0]
    return fromNodes(attrs(root), els ? [...els.children].map(n => ({ tag: n.nodeName, attrs: attrs(n) })) : [])
  }

  const esc = v => String(v).replace(/[&<>"'\n]/g, c => `&#${c.charCodeAt(0)};`)
  const attrs = o => Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')
  const cap = b => (b ? 'True' : 'False')

  // Array order is paint order, so ZIndex is written from the index.
  function toXml(t) {
    const els = t.elements.map((e, i) => {
      const a = {
        Name: e.name, Left: e.x, Top: e.y, Width: e.w, Height: e.h, Rotation: e.rotation, Opacity: e.opacity, ZIndex: i,
        Thickness: e.strokeWidth, StrokeColor: e.strokeColor, ShadowEnabled: cap(e.shadow), ShadowColor: e.shadowColor,
        ShadowDepth: e.shadowDepth, ShadowRadius: e.shadowBlur, ShadowDirection: e.shadowAngle,
      }
      if (e.type === 'Photo') Object.assign(a, { PhotoNumber: e.photo, KeepAspect: cap(e.keepAspect) })
      if (e.type === 'Image') Object.assign(a, { ImagePath: e.src, KeepAspect: cap(e.keepAspect) })
      if (e.type === 'Text') {
        Object.assign(a, { Text: e.text, FontName: e.font, FontSize: e.size, FontColor: e.textColor, TextAlignment: e.align[0].toUpperCase() + e.align.slice(1) })
      }
      if (e.type === 'Rectangle' || e.type === 'Ellipse') a.Fill = e.fill
      return `    <${e.type} ${attrs(a)} />`
    })
    const root = attrs({ Name: t.name, Width: t.width, Height: t.height, Resolution: t.dpi, BackgroundColor: t.background })
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Template ${root}>\n  <Elements>\n${els.join('\n')}\n  </Elements>\n</Template>\n`
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

  return { parse, fromNodes, toXml, element, shots, argb, css, cover, contain, fillText }
})()

if (typeof module !== 'undefined') module.exports = Layout
