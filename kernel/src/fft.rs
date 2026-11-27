//! 2-D discrete Fourier transform of any size, exact (no padding, no resampling):
//! power-of-two lengths use iterative radix-2 Cooley–Tukey; every other length uses Bluestein's chirp-z algorithm
//! (which re-expresses an N-point DFT as a convolution evaluated with radix-2 FFTs of length ≥ 2N−1). f64 throughout.
use crate::*;
use core::f64::consts::PI;

struct Pow2 {
    n: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
    rev: Vec<u32>,
}
impl Pow2 {
    fn new(n: usize) -> Self {
        let bits = n.trailing_zeros();
        let cos = (0..n / 2).map(|k| (2.0 * PI * k as f64 / n as f64).cos()).collect();
        let sin = (0..n / 2).map(|k| -(2.0 * PI * k as f64 / n as f64).sin()).collect();
        let rev = (0..n as u32).map(|i| if bits == 0 { 0 } else { i.reverse_bits() >> (32 - bits) }).collect();
        Pow2 { n, cos, sin, rev }
    }
    /// forward transform in place
    fn run(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.n;
        for i in 0..n {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            let mut i = 0;
            while i < n {
                for k in 0..half {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (i + k, i + k + half);
                    let tr = re[b] * c - im[b] * s;
                    let ti = re[b] * s + im[b] * c;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
                i += len;
            }
            len <<= 1;
        }
    }
}

struct Plan {
    n: usize,
    p2: Pow2,
    // Bluestein state (empty when n is a power of two)
    wr: Vec<f64>,
    wi: Vec<f64>,
    br: Vec<f64>,
    bi: Vec<f64>,
    ar: Vec<f64>,
    ai: Vec<f64>,
}
impl Plan {
    fn new(n: usize) -> Self {
        if n.is_power_of_two() {
            return Plan { n, p2: Pow2::new(n), wr: vec![], wi: vec![], br: vec![], bi: vec![], ar: vec![], ai: vec![] };
        }
        let m = (2 * n - 1).next_power_of_two();
        let p2 = Pow2::new(m);
        // chirp w_k = exp(−iπk²/n); k² is reduced mod 2n to keep the angle exact for large k
        let (mut wr, mut wi) = (vec![0f64; n], vec![0f64; n]);
        for k in 0..n {
            let q = ((k as u64 * k as u64) % (2 * n as u64)) as f64;
            let a = PI * q / n as f64;
            wr[k] = a.cos();
            wi[k] = -a.sin();
        }
        let (mut br, mut bi) = (vec![0f64; m], vec![0f64; m]);
        br[0] = wr[0];
        bi[0] = -wi[0];
        for k in 1..n {
            br[k] = wr[k];
            bi[k] = -wi[k];
            br[m - k] = wr[k];
            bi[m - k] = -wi[k];
        }
        p2.run(&mut br, &mut bi);
        Plan { n, p2, wr, wi, br, bi, ar: vec![0f64; m], ai: vec![0f64; m] }
    }
    fn run(&mut self, re: &mut [f64], im: &mut [f64]) {
        let n = self.n;
        if self.wr.is_empty() {
            return self.p2.run(re, im);
        }
        let m = self.p2.n;
        self.ar.fill(0.0);
        self.ai.fill(0.0);
        for k in 0..n {
            self.ar[k] = re[k] * self.wr[k] - im[k] * self.wi[k];
            self.ai[k] = re[k] * self.wi[k] + im[k] * self.wr[k];
        }
        self.p2.run(&mut self.ar, &mut self.ai);
        for k in 0..m {
            let (xr, xi) = (self.ar[k], self.ai[k]);
            // multiply by B and conjugate, so the next forward FFT acts as an inverse
            let pr = xr * self.br[k] - xi * self.bi[k];
            let pi = xr * self.bi[k] + xi * self.br[k];
            self.ar[k] = pr;
            self.ai[k] = -pi;
        }
        self.p2.run(&mut self.ar, &mut self.ai);
        let inv = 1.0 / m as f64;
        for k in 0..n {
            let (cr, ci) = (self.ar[k] * inv, -self.ai[k] * inv);
            re[k] = cr * self.wr[k] - ci * self.wi[k];
            im[k] = cr * self.wi[k] + ci * self.wr[k];
        }
    }
}

/// 2-D FFT of Rec.709 luma. Writes the centred (DC at (w/2, h/2)) log-magnitude spectrum log(1+|F|), scaled so the maximum is 255,
/// as gray RGBA into d. window != 0 applies a separable Hann window first (suppresses the edge-discontinuity cross).
/// peaks: f32[max_peaks·4] = fx, fy (cycles/pixel, in the upper half-plane or fx>0 on the axis), |F|/|F(0)|, prominence
/// (|F| divided by the mean magnitude of its radial frequency band). Local maxima only; those with prominence ≥ 8 come
/// first ordered by magnitude, the rest follow by prominence.
/// info: f64[4] = |F(0)| / (w·h) (mean luma after windowing), fraction of non-DC spectral energy above 0.25 cycles/pixel,
/// fraction above 0.125 cycles/pixel, max log-magnitude. Returns the number of peaks written.
#[no_mangle]
pub unsafe extern "C" fn fft2(s: *const u8, w: u32, h: u32, d: *mut u8, window: u32, peaks: *mut f32, max_peaks: u32, info: *mut f64) -> u32 {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let n = w * h;
    let mut re = vec![0f64; n];
    let mut im = vec![0f64; n];
    for (i, p) in s.chunks_exact(4).enumerate() {
        re[i] = luma(p) as f64;
    }
    if window != 0 {
        let wx: Vec<f64> = (0..w).map(|x| if w > 1 { 0.5 - 0.5 * (2.0 * PI * x as f64 / (w - 1) as f64).cos() } else { 1.0 }).collect();
        for y in 0..h {
            let wy = if h > 1 { 0.5 - 0.5 * (2.0 * PI * y as f64 / (h - 1) as f64).cos() } else { 1.0 };
            for x in 0..w {
                re[y * w + x] *= wx[x] * wy;
            }
        }
    }
    let mut plan = Plan::new(w);
    for y in 0..h {
        plan.run(&mut re[y * w..(y + 1) * w], &mut im[y * w..(y + 1) * w]);
    }
    let mut plan = Plan::new(h);
    let (mut cr, mut ci) = (vec![0f64; h], vec![0f64; h]);
    for x in 0..w {
        for y in 0..h {
            cr[y] = re[y * w + x];
            ci[y] = im[y * w + x];
        }
        plan.run(&mut cr, &mut ci);
        for y in 0..h {
            re[y * w + x] = cr[y];
            im[y * w + x] = ci[y];
        }
    }
    drop(cr);
    drop(ci);
    // magnitude (reuse `re`), release `im`
    for i in 0..n {
        re[i] = (re[i] * re[i] + im[i] * im[i]).sqrt();
    }
    drop(im);
    let mag = re;
    let dc = mag[0];
    // signed frequency of bin index
    let fq = |i: usize, n: usize| -> f64 { (if i <= n / 2 { i as f64 } else { i as f64 - n as f64 }) / n as f64 };
    // radial profile (mean magnitude per band) and energy fractions
    const BANDS: usize = 64;
    let mut bsum = [0f64; BANDS];
    let mut bcnt = [0u32; BANDS];
    let (mut e_all, mut e_hi, mut e_mid) = (0f64, 0f64, 0f64);
    let mut maxlog = 0f64;
    let band = |r: f64| -> usize { ((r / 0.7072 * BANDS as f64) as usize).min(BANDS - 1) };
    for y in 0..h {
        let fy = fq(y, h);
        for x in 0..w {
            let m = mag[y * w + x];
            maxlog = maxlog.max((1.0 + m).ln());
            if x == 0 && y == 0 {
                continue;
            }
            let r = (fq(x, w).powi(2) + fy * fy).sqrt();
            let e = m * m;
            e_all += e;
            if r > 0.25 {
                e_hi += e;
            }
            if r > 0.125 {
                e_mid += e;
            }
            let b = band(r);
            bsum[b] += m;
            bcnt[b] += 1;
        }
    }
    let info = core::slice::from_raw_parts_mut(info, 4);
    info[0] = dc / n as f64;
    info[1] = if e_all > 0.0 { e_hi / e_all } else { 0.0 };
    info[2] = if e_all > 0.0 { e_mid / e_all } else { 0.0 };
    info[3] = maxlog;
    // spectrum image, fftshifted
    let k = if maxlog > 0.0 { 255.0 / maxlog } else { 0.0 };
    for y in 0..h {
        let sy = (y + h - h / 2) % h;
        for x in 0..w {
            let sx = (x + w - w / 2) % w;
            let v = clamp8(((1.0 + mag[sy * w + sx]).ln() * k) as f32);
            let o = (y * w + x) * 4;
            d[o] = v;
            d[o + 1] = v;
            d[o + 2] = v;
            d[o + 3] = 255;
        }
    }
    // peaks: local maxima (3×3, wrapping) in one half-plane, ranked by prominence over the radial mean
    let mp = max_peaks as usize;
    if mp == 0 || peaks.is_null() {
        return 0;
    }
    let peaks = core::slice::from_raw_parts_mut(peaks, mp * 4);
    let mut best: Vec<(f32, f32, f32, f32)> = Vec::new(); // prominence, fx, fy, rel
    for y in 0..h {
        let fy = fq(y, h);
        if fy < 0.0 {
            continue;
        }
        for x in 0..w {
            let fx = fq(x, w);
            if (fy == 0.0 && fx <= 0.0) || (fx * fx + fy * fy).sqrt() < 2.5 / (w.min(h) as f64) {
                continue; // skip the mirrored half and the DC neighbourhood (which the window smears over ±2 bins)
            }
            let m = mag[y * w + x];
            let mut is_max = true;
            'p: for dy in [h - 1, 0, 1] {
                for dx in [w - 1, 0, 1] {
                    if (dx != 0 || dy != 0) && mag[((y + dy) % h) * w + (x + dx) % w] > m {
                        is_max = false;
                        break 'p;
                    }
                }
            }
            if !is_max {
                continue;
            }
            let b = band((fx * fx + fy * fy).sqrt());
            let mean = if bcnt[b] > 0 { bsum[b] / bcnt[b] as f64 } else { 0.0 };
            let prom = if mean > 0.0 { m / mean } else { 0.0 };
            best.push((prom as f32, fx as f32, fy as f32, if dc > 0.0 { (m / dc) as f32 } else { 0.0 }));
            if best.len() > 8192 {
                best.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
                best.truncate(mp.max(1024));
            }
        }
    }
    // final order: peaks that clearly stand out of their band (prominence ≥ 8) first, strongest magnitude first;
    // then the remaining local maxima by prominence
    best.sort_by(|a, b| {
        let (sa, sb) = (a.0 >= 8.0, b.0 >= 8.0);
        sb.cmp(&sa).then(if sa && sb { b.3.partial_cmp(&a.3) } else { b.0.partial_cmp(&a.0) }.unwrap_or(core::cmp::Ordering::Equal))
    });
    best.truncate(mp);
    for (i, p) in best.iter().enumerate() {
        peaks[i * 4] = p.1;
        peaks[i * 4 + 1] = p.2;
        peaks[i * 4 + 2] = p.3;
        peaks[i * 4 + 3] = p.0;
    }
    best.len() as u32
}

/// Self-test hook: forward DFT of an interleaved complex f64 signal of any length, in place (used by the test-suite to
/// compare the radix-2 and Bluestein paths against a direct O(N²) DFT).
#[no_mangle]
pub unsafe extern "C" fn fft1d(data: *mut f64, n: u32) {
    let n = n as usize;
    let data = core::slice::from_raw_parts_mut(data, n * 2);
    let mut re: Vec<f64> = (0..n).map(|i| data[i * 2]).collect();
    let mut im: Vec<f64> = (0..n).map(|i| data[i * 2 + 1]).collect();
    Plan::new(n).run(&mut re, &mut im);
    for i in 0..n {
        data[i * 2] = re[i];
        data[i * 2 + 1] = im[i];
    }
}
