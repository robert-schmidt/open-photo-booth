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

  return { apply }
})()

if (typeof module !== 'undefined') module.exports = Enhance
