// One-tap photo enhance. Pure function on ImageData-like { data, width, height }, shared by review.js and test.js.
// Gray-world white balance, then a luminance levels stretch, then an exposure curve, all folded into one lookup table per channel.
const Enhance = (() => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

  function luts({ data }) {
    // Sample about 250k pixels; enough for stable percentiles on any camera.
    const step = Math.max(1, Math.floor(data.length / 4 / 250000)) * 4
    const sum = [0, 0, 0], hist = new Uint32Array(256)
    let n = 0
    for (let i = 0; i < data.length; i += step, n++) {
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]
      hist[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++
    }
    // Mild white balance: a gain of at most ±15% per channel, so a room with colored lights keeps its mood.
    const mean = sum.map(s => s / n), gray = (mean[0] + mean[1] + mean[2]) / 3
    const gain = mean.map(m => clamp(gray / (m || 1), 0.85, 1.15))
    const pct = p => { let c = 0; for (let v = 0; v < 256; v++) if ((c += hist[v]) >= n * p) return v; return 255 }
    // Stretch the 0.5–99.5% luminance range, but never by more than 1.6x, so a dim or misty scene doesn't turn harsh.
    let lo = Math.min(pct(0.005), 60), hi = Math.max(pct(0.995), 190)
    if (hi - lo < 160) { const mid = (lo + hi) / 2; lo = mid - 80; hi = mid + 80 }
    // Exposure: only a median outside 0.38–0.55 is pulled back to that band, so a well-exposed photo keeps its look.
    const median = clamp((pct(0.5) - lo) / (hi - lo), 0.05, 0.95)
    const gamma = clamp(Math.log(clamp(median, 0.38, 0.55)) / Math.log(median), 0.75, 1.3)
    return gain.map(g => Uint8ClampedArray.from({ length: 256 }, (_, v) => 255 * clamp((v * g - lo) / (hi - lo), 0, 1) ** gamma))
  }

  // Enhances in place.
  function apply(img) {
    const [r, g, b] = luts(img), d = img.data
    for (let i = 0; i < d.length; i += 4) { d[i] = r[d[i]]; d[i + 1] = g[d[i + 1]]; d[i + 2] = b[d[i + 2]] }
    return img
  }

  // How many stops a photo is from a good exposure; above zero, it should be brighter. Measured where guests stand (the
  // middle of the frame), in linear light, against mid grey (18%), like a camera's centre-weighted meter. A frame with
  // blown highlights (a flash too strong) is never called too dark.
  function exposure({ data, width, height }) {
    let sum = 0, n = 0, blown = 0
    const stepX = Math.max(1, Math.floor(width / 160)), stepY = Math.max(1, Math.floor(height / 160))
    for (let y = Math.floor(height * 0.15); y < height * 0.85; y += stepY) {
      for (let x = Math.floor(width * 0.2); x < width * 0.8; x += stepX, n++) {
        const i = (y * width + x) * 4, v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        sum += (v / 255) ** 2.2
        if (v >= 250) blown++
      }
    }
    const stops = clamp(Math.log2(0.18 / Math.max(sum / n, 1e-4)), -3, 3)
    return blown > n * 0.05 ? Math.min(stops, -0.5) : stops
  }

  // The camera value nearest to `stops` away from the current one, as an index into its options. Exposure
  // compensation is in stops already ("+0.3"); ISO doubles per stop ("400"). Values that aren't numbers (Auto) are skipped.
  function nearest(options, current, stops, iso) {
    const val = o => (iso ? Math.log2(parseFloat(o)) : parseFloat(o))
    const want = val(options[current]) + stops
    if (isNaN(want)) return current
    let best = current
    options.forEach((o, i) => { if (Math.abs(val(o) - want) < Math.abs(val(options[best]) - want)) best = i })
    return best
  }

  return { apply, exposure, nearest }
})()

if (typeof module !== 'undefined') module.exports = Enhance
