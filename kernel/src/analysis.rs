//! Measurements: histograms, statistics, k-means palette, sharpness, noise, image comparison, perceptual hashes,
//! connected components, corners, Hough lines, bit planes and LSB steganography.
use crate::filters::{blur_plane, canny_mask, gauss_kernel, gradient};
use crate::*;

/// out: 5×256 u32 — R, G, B, A, rounded Rec.709 luma
#[no_mangle]
pub unsafe extern "C" fn histogram(s: *const u8, w: u32, h: u32, out: *mut u32) {
    let s = rs(s, w, h);
    let out = core::slice::from_raw_parts_mut(out, 5 * 256);
    out.fill(0);
    for p in s.chunks_exact(4) {
        out[p[0] as usize] += 1;
        out[256 + p[1] as usize] += 1;
        out[512 + p[2] as usize] += 1;
        out[768 + p[3] as usize] += 1;
        out[1024 + clamp8(luma(p)) as usize] += 1;
    }
}

/// out: f64[32]. For each of R,G,B,A,luma (5 values each): mean, std (population), min, max, entropy (bits, 8-bit histogram).
/// out[25] = Hasler–Süsstrunk colourfulness, out[26] = mean saturation (HSV, 0..1), out[27] = fraction of pixels with luma<16,
/// out[28] = fraction with luma>239.
#[no_mangle]
pub unsafe extern "C" fn stats(s: *const u8, w: u32, h: u32, out: *mut f64) {
    let s = rs(s, w, h);
    let out = core::slice::from_raw_parts_mut(out, 32);
    out.fill(0.0);
    let n = (w as usize * h as usize) as f64;
    let mut hist = vec![0u32; 5 * 256];
    let (mut srg, mut syb, mut srg2, mut syb2, mut ssat) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for p in s.chunks_exact(4) {
        hist[p[0] as usize] += 1;
        hist[256 + p[1] as usize] += 1;
        hist[512 + p[2] as usize] += 1;
        hist[768 + p[3] as usize] += 1;
        hist[1024 + clamp8(luma(p)) as usize] += 1;
        let (r, g, b) = (p[0] as f64, p[1] as f64, p[2] as f64);
        let rg = r - g;
        let yb = 0.5 * (r + g) - b;
        srg += rg;
        syb += yb;
        srg2 += rg * rg;
        syb2 += yb * yb;
        let mx = p[0].max(p[1]).max(p[2]) as f64;
        let mn = p[0].min(p[1]).min(p[2]) as f64;
        if mx > 0.0 {
            ssat += (mx - mn) / mx;
        }
    }
    for c in 0..5 {
        let hgram = &hist[c * 256..(c + 1) * 256];
        let (mut sum, mut sum2, mut mn, mut mx, mut ent) = (0f64, 0f64, 255usize, 0usize, 0f64);
        for (v, &cnt) in hgram.iter().enumerate() {
            if cnt == 0 {
                continue;
            }
            let c64 = cnt as f64;
            sum += v as f64 * c64;
            sum2 += (v * v) as f64 * c64;
            mn = mn.min(v);
            mx = mx.max(v);
            let p = c64 / n;
            ent -= p * p.log2();
        }
        let mean = sum / n;
        out[c * 5] = mean;
        out[c * 5 + 1] = (sum2 / n - mean * mean).max(0.0).sqrt();
        out[c * 5 + 2] = mn as f64;
        out[c * 5 + 3] = mx as f64;
        out[c * 5 + 4] = ent;
    }
    let (mrg, myb) = (srg / n, syb / n);
    let (vrg, vyb) = ((srg2 / n - mrg * mrg).max(0.0), (syb2 / n - myb * myb).max(0.0));
    out[25] = (vrg + vyb).sqrt() + 0.3 * (mrg * mrg + myb * myb).sqrt();
    out[26] = ssat / n;
    out[27] = hist[1024..1024 + 16].iter().map(|&v| v as f64).sum::<f64>() / n;
    out[28] = hist[1024 + 240..1024 + 256].iter().map(|&v| v as f64).sum::<f64>() / n;
}

fn srgb_to_lab(p: [f32; 3]) -> [f32; 3] {
    let lin = |c: f32| {
        let c = c / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(p[0]), lin(p[1]), lin(p[2]));
    let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}
fn lab_to_srgb(p: [f32; 3]) -> [f32; 3] {
    let fy = (p[0] + 16.0) / 116.0;
    let fx = fy + p[1] / 500.0;
    let fz = fy - p[2] / 200.0;
    let f = |t: f32| if t * t * t > 0.008856 { t * t * t } else { (t - 16.0 / 116.0) / 7.787 };
    let (x, y, z) = (f(fx) * 0.95047, f(fy), f(fz) * 1.08883);
    let r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    let b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    let gam = |c: f32| {
        let c = c.clamp(0.0, 1.0);
        255.0 * if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
    };
    [gam(r), gam(g), gam(b)]
}

/// k-means (k-means++ seeding, Lloyd iterations) on an evenly strided sample of at most `max_samples` non-transparent pixels.
/// space 0 = RGB, 1 = CIE L*a*b* (centroids are returned converted back to sRGB).
/// cent: f32[k·3] sRGB 0..255, counts: u32[k] (members among the samples). Returns the number of samples used.
#[no_mangle]
pub unsafe extern "C" fn kmeans(s: *const u8, w: u32, h: u32, k: u32, max_iter: u32, seed: u32, space: u32, max_samples: u32, cent: *mut f32, counts: *mut u32) -> u32 {
    let s = rs(s, w, h);
    let k = k as usize;
    let cent = core::slice::from_raw_parts_mut(cent, k * 3);
    let counts = core::slice::from_raw_parts_mut(counts, k);
    let n = w as usize * h as usize;
    let step = (n / (max_samples.max(1) as usize)).max(1);
    let mut pts: Vec<[f32; 3]> = Vec::with_capacity(n / step + 1);
    let mut i = 0;
    while i < n {
        let p = &s[i * 4..i * 4 + 4];
        if p[3] != 0 {
            let v = [p[0] as f32, p[1] as f32, p[2] as f32];
            pts.push(if space == 1 { srgb_to_lab(v) } else { v });
        }
        i += step;
    }
    cent.fill(0.0);
    counts.fill(0);
    if pts.is_empty() {
        return 0;
    }
    let d2 = |a: &[f32; 3], b: &[f32; 3]| (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]);
    let mut rng = Rng::new(seed);
    let mut c: Vec<[f32; 3]> = Vec::with_capacity(k);
    c.push(pts[(rng.next() as usize) % pts.len()]);
    let mut dist: Vec<f32> = pts.iter().map(|p| d2(p, &c[0])).collect();
    while c.len() < k {
        let total: f64 = dist.iter().map(|&v| v as f64).sum();
        let pick = if total <= 0.0 {
            (rng.next() as usize) % pts.len()
        } else {
            let mut target = rng.f() as f64 * total;
            let mut idx = pts.len() - 1;
            for (j, &dv) in dist.iter().enumerate() {
                target -= dv as f64;
                if target <= 0.0 {
                    idx = j;
                    break;
                }
            }
            idx
        };
        let nc = pts[pick];
        for (dv, p) in dist.iter_mut().zip(&pts) {
            *dv = dv.min(d2(p, &nc));
        }
        c.push(nc);
    }
    let mut assign = vec![0u32; pts.len()];
    for it in 0..max_iter.max(1) {
        let mut changed = 0usize;
        let mut sums = vec![[0f64; 3]; k];
        let mut cnt = vec![0u32; k];
        for (j, p) in pts.iter().enumerate() {
            let (mut best, mut bd) = (0usize, f32::MAX);
            for (ci, cc) in c.iter().enumerate() {
                let dv = d2(p, cc);
                if dv < bd {
                    bd = dv;
                    best = ci;
                }
            }
            if assign[j] != best as u32 || it == 0 {
                changed += (assign[j] != best as u32) as usize;
                assign[j] = best as u32;
            }
            sums[best][0] += p[0] as f64;
            sums[best][1] += p[1] as f64;
            sums[best][2] += p[2] as f64;
            cnt[best] += 1;
        }
        for ci in 0..k {
            if cnt[ci] > 0 {
                let inv = 1.0 / cnt[ci] as f64;
                c[ci] = [(sums[ci][0] * inv) as f32, (sums[ci][1] * inv) as f32, (sums[ci][2] * inv) as f32];
            }
        }
        counts.copy_from_slice(&cnt);
        if it > 0 && changed == 0 {
            break;
        }
    }
    for ci in 0..k {
        let v = if space == 1 { lab_to_srgb(c[ci]) } else { c[ci] };
        cent[ci * 3..ci * 3 + 3].copy_from_slice(&v);
    }
    pts.len() as u32
}

/// out f64[4]: variance of the 4-neighbour Laplacian of luma, Tenengrad (mean sobel gx²+gy²), mean gradient magnitude, mean luma.
#[no_mangle]
pub unsafe extern "C" fn sharpness(s: *const u8, w: u32, h: u32, out: *mut f64) {
    let s = rs(s, w, h);
    let out = core::slice::from_raw_parts_mut(out, 4);
    let (w, h) = (w as usize, h as usize);
    let l = luma_plane(s);
    let n = (w * h) as f64;
    let (mut sl, mut sl2, mut st, mut sm, mut sy) = (0f64, 0f64, 0f64, 0f64, 0f64);
    let (gx, gy) = gradient(&l, w, h, 0);
    for y in 0..h {
        let (r0, r1, r2) = (cl(y as isize - 1, h) * w, y * w, cl(y as isize + 1, h) * w);
        for x in 0..w {
            let (x0, x2) = (cl(x as isize - 1, w), cl(x as isize + 1, w));
            let lap = (l[r0 + x] + l[r2 + x] + l[r1 + x0] + l[r1 + x2] - 4.0 * l[r1 + x]) as f64;
            sl += lap;
            sl2 += lap * lap;
            let g2 = (gx[r1 + x] * gx[r1 + x] + gy[r1 + x] * gy[r1 + x]) as f64;
            st += g2;
            sm += g2.sqrt();
            sy += l[r1 + x] as f64;
        }
    }
    let ml = sl / n;
    out[0] = sl2 / n - ml * ml;
    out[1] = st / n;
    out[2] = sm / n;
    out[3] = sy / n;
}

/// Noise standard deviation of luma, two estimators. out f64[2]:
/// [0] Immerkær (1996): sqrt(π/2)/(6(W−2)(H−2)) · Σ|L ∗ [1 −2 1; −2 4 −2; 1 −2 1]|
/// [1] Donoho MAD: median(|HH|)/0.6745 with HH the Haar diagonal detail (a−b−c+d)/2 of 2×2 blocks.
#[no_mangle]
pub unsafe extern "C" fn noise(s: *const u8, w: u32, h: u32, out: *mut f64) {
    let s = rs(s, w, h);
    let out = core::slice::from_raw_parts_mut(out, 2);
    let (w, h) = (w as usize, h as usize);
    out[0] = 0.0;
    out[1] = 0.0;
    if w < 3 || h < 3 {
        return;
    }
    let l = luma_plane(s);
    let mut sum = 0f64;
    for y in 1..h - 1 {
        let (a, b, c) = (&l[(y - 1) * w..y * w], &l[y * w..(y + 1) * w], &l[(y + 1) * w..(y + 2) * w]);
        let mut row = 0f32;
        for x in 1..w - 1 {
            row += (a[x - 1] - 2.0 * a[x] + a[x + 1] - 2.0 * b[x - 1] + 4.0 * b[x] - 2.0 * b[x + 1] + c[x - 1] - 2.0 * c[x] + c[x + 1]).abs();
        }
        sum += row as f64;
    }
    out[0] = (core::f64::consts::PI / 2.0).sqrt() / (6.0 * (w - 2) as f64 * (h - 2) as f64) * sum;
    let mut hh: Vec<f32> = Vec::with_capacity((w / 2) * (h / 2));
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            let i = y * 2 * w + x * 2;
            hh.push(((l[i] - l[i + 1] - l[i + w] + l[i + w + 1]) * 0.5).abs());
        }
    }
    if !hh.is_empty() {
        let mid = hh.len() / 2;
        hh.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        out[1] = hh[mid] as f64 / 0.6745;
    }
}

/// out f64[8]: MSE of R,G,B,A; max abs channel difference; number of differing pixels; MSE of luma; mean abs error over RGB.
#[no_mangle]
pub unsafe extern "C" fn mse(a: *const u8, b: *const u8, w: u32, h: u32, out: *mut f64) {
    let (a, b) = (rs(a, w, h), rs(b, w, h));
    let out = core::slice::from_raw_parts_mut(out, 8);
    let n = (w as usize * h as usize) as f64;
    let mut se = [0u64; 4];
    let (mut mx, mut diff, mut sl, mut sad) = (0i32, 0u64, 0f64, 0u64);
    for (p, q) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let mut any = false;
        for c in 0..4 {
            let dv = p[c] as i32 - q[c] as i32;
            se[c] += (dv * dv) as u64;
            mx = mx.max(dv.abs());
            any |= dv != 0;
            if c < 3 {
                sad += dv.unsigned_abs() as u64;
            }
        }
        diff += any as u64;
        let dl = (luma(p) - luma(q)) as f64;
        sl += dl * dl;
    }
    for c in 0..4 {
        out[c] = se[c] as f64 / n;
    }
    out[4] = mx as f64;
    out[5] = diff as f64;
    out[6] = sl / n;
    out[7] = sad as f64 / (n * 3.0);
}

/// Mean SSIM of Rec.709 luma (Wang et al. 2004: 11×11 gaussian window σ=1.5, K1=0.01, K2=0.03, L=255).
/// The mean is taken over pixels whose window lies fully inside the image (all pixels if the image is smaller than 11 px).
/// If `map` is non-null it receives an RGBA gray image of the local SSIM (white = identical, black = SSIM ≤ 0).
#[no_mangle]
pub unsafe extern "C" fn ssim(a: *const u8, b: *const u8, w: u32, h: u32, map: *mut u8) -> f64 {
    let (a, b) = (rs(a, w, h), rs(b, w, h));
    let (w, h) = (w as usize, h as usize);
    let k = gauss_kernel(1.5);
    let k = &k[..]; // radius ceil(4.5) = 5 → 11 taps
    let len = k.len();
    let r = len / 2;
    let rw = w * 5;
    let mut ring = vec![0f32; len * rw];
    let mut pa = vec![0f32; w + 2 * r];
    let mut pb = vec![0f32; w + 2 * r];
    let mut acc = vec![0f32; rw];
    let (c1, c2) = ((0.01f32 * 255.0).powi(2), (0.03f32 * 255.0).powi(2));
    let inner = w >= len && h >= len;
    let (mut total, mut count) = (0f64, 0u64);
    let mut done: isize = -1;
    for y in 0..h {
        let need = (y + r).min(h - 1) as isize;
        while done < need {
            done += 1;
            let yy = done as usize;
            for x in 0..w + 2 * r {
                let sx = (yy * w + cl(x as isize - r as isize, w)) * 4;
                pa[x] = luma(&a[sx..sx + 4]);
                pb[x] = luma(&b[sx..sx + 4]);
            }
            let out = &mut ring[(yy % len) * rw..(yy % len + 1) * rw];
            for x in 0..w {
                let (mut ma, mut mb, mut aa, mut bb, mut ab) = (0f32, 0f32, 0f32, 0f32, 0f32);
                for t in 0..len {
                    let (va, vb, kv) = (pa[x + t], pb[x + t], k[t]);
                    ma += kv * va;
                    mb += kv * vb;
                    aa += kv * va * va;
                    bb += kv * vb * vb;
                    ab += kv * va * vb;
                }
                out[x * 5..x * 5 + 5].copy_from_slice(&[ma, mb, aa, bb, ab]);
            }
        }
        acc.fill(0.0);
        for t in 0..len {
            let yy = cl(y as isize + t as isize - r as isize, h) % len;
            let row = &ring[yy * rw..(yy + 1) * rw];
            let kv = k[t];
            for (o, &v) in acc.iter_mut().zip(row) {
                *o += v * kv;
            }
        }
        let row_in = !inner || (y >= r && y < h - r);
        let mut row_sum = 0f64;
        for x in 0..w {
            let v = &acc[x * 5..x * 5 + 5];
            let (ma, mb) = (v[0], v[1]);
            let (va, vb, cov) = (v[2] - ma * ma, v[3] - mb * mb, v[4] - ma * mb);
            let sv = ((2.0 * ma * mb + c1) * (2.0 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            if row_in && (!inner || (x >= r && x < w - r)) {
                row_sum += sv as f64;
                count += 1;
            }
            if !map.is_null() {
                let g = clamp8(sv * 255.0);
                let o = map.add((y * w + x) * 4);
                *o = g;
                *o.add(1) = g;
                *o.add(2) = g;
                *o.add(3) = 255;
            }
        }
        total += row_sum;
    }
    if count == 0 {
        1.0
    } else {
        total / count as f64
    }
}

/// Difference heat-map: v = max over R,G,B,A of |a−b| × gain, clamped, sent through a 256×RGB LUT (null → gray). Alpha 255.
#[no_mangle]
pub unsafe extern "C" fn diffmap(a: *const u8, b: *const u8, w: u32, h: u32, d: *mut u8, gain: f32, lut: *const u8) {
    let (a, b, d) = (rs(a, w, h), rs(b, w, h), ws(d, w, h));
    for ((p, q), o) in a.chunks_exact(4).zip(b.chunks_exact(4)).zip(d.chunks_exact_mut(4)) {
        let mut m = 0i32;
        for c in 0..4 {
            m = m.max((p[c] as i32 - q[c] as i32).abs());
        }
        let v = clamp8(m as f32 * gain) as usize;
        if lut.is_null() {
            o[0] = v as u8;
            o[1] = v as u8;
            o[2] = v as u8;
        } else {
            o[0] = *lut.add(v * 3);
            o[1] = *lut.add(v * 3 + 1);
            o[2] = *lut.add(v * 3 + 2);
        }
        o[3] = 255;
    }
}

/// Error-level image: |a−b|·scale per RGB channel, alpha 255. out f64[2] = mean abs diff, max abs diff.
/// grid: f32[gx·gy] mean abs diff per cell of a gx×gy grid (to locate hot regions).
#[no_mangle]
pub unsafe extern "C" fn ela_diff(a: *const u8, b: *const u8, w: u32, h: u32, d: *mut u8, scale: f32, out: *mut f64, grid: *mut f32, gx: u32, gy: u32) {
    let (a, b, d) = (rs(a, w, h), rs(b, w, h), ws(d, w, h));
    let (w, h, gx, gy) = (w as usize, h as usize, gx.max(1) as usize, gy.max(1) as usize);
    let grid = core::slice::from_raw_parts_mut(grid, gx * gy);
    let mut gsum = vec![0u64; gx * gy];
    let mut gcnt = vec![0u64; gx * gy];
    let (mut sum, mut mx) = (0u64, 0u32);
    for y in 0..h {
        let cy = y * gy / h;
        for x in 0..w {
            let i = (y * w + x) * 4;
            let mut px = 0u32;
            for c in 0..3 {
                let dv = (a[i + c] as i32 - b[i + c] as i32).unsigned_abs();
                px += dv;
                mx = mx.max(dv);
                d[i + c] = clamp8(dv as f32 * scale);
            }
            d[i + 3] = 255;
            sum += px as u64;
            let g = cy * gx + x * gx / w;
            gsum[g] += px as u64;
            gcnt[g] += 3;
        }
    }
    *out = sum as f64 / (w * h * 3) as f64;
    *out.add(1) = mx as f64;
    for i in 0..gx * gy {
        grid[i] = if gcnt[i] > 0 { gsum[i] as f32 / gcnt[i] as f32 } else { 0.0 };
    }
}

/// Perceptual hashes, 8 bytes each, bits row-major MSB-first. out[0..8] aHash (8×8 mean), out[8..16] dHash (9×8 horizontal
/// gradient: left > right), out[16..24] pHash (32×32 DCT-II, low 8×8 block incl. DC, bit = coefficient > median).
/// Reduction is an exact area average of the image, then Rec.709 luma.
#[no_mangle]
pub unsafe extern "C" fn hashes(s: *const u8, w: u32, h: u32, out: *mut u8) {
    let s = rs(s, w, h);
    let out = core::slice::from_raw_parts_mut(out, 24);
    out.fill(0);
    let small = |dw: usize, dh: usize| -> Vec<f32> {
        let mut t = vec![0u8; dw * dh * 4];
        crate::geom::resize_sep(s, w as usize, h as usize, &mut t, dw, dh, 2);
        luma_plane(&t)
    };
    let a = small(8, 8);
    let mean = a.iter().sum::<f32>() / 64.0;
    for i in 0..64 {
        if a[i] > mean {
            out[i / 8] |= 0x80 >> (i % 8);
        }
    }
    let dd = small(9, 8);
    for y in 0..8 {
        for x in 0..8 {
            if dd[y * 9 + x] > dd[y * 9 + x + 1] {
                out[8 + y] |= 0x80 >> x;
            }
        }
    }
    const N: usize = 32;
    let p = small(N, N);
    let mut cosv = [[0f32; N]; N];
    for (u, row) in cosv.iter_mut().enumerate() {
        for (x, v) in row.iter_mut().enumerate() {
            *v = ((2 * x + 1) as f32 * u as f32 * core::f32::consts::PI / (2 * N) as f32).cos();
        }
    }
    // separable DCT-II, only the 8 lowest frequencies in each direction
    let mut tmp = [[0f32; N]; 8];
    for u in 0..8 {
        for x in 0..N {
            let mut acc = 0f32;
            for y in 0..N {
                acc += p[y * N + x] * cosv[u][y];
            }
            tmp[u][x] = acc;
        }
    }
    let mut low = [0f32; 64];
    for u in 0..8 {
        for v in 0..8 {
            let mut acc = 0f32;
            for x in 0..N {
                acc += tmp[u][x] * cosv[v][x];
            }
            low[u * 8 + v] = acc;
        }
    }
    let mut sorted = low;
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let med = (sorted[31] + sorted[32]) * 0.5;
    for i in 0..64 {
        if low[i] > med {
            out[16 + i / 8] |= 0x80 >> (i % 8);
        }
    }
}

// ───────────────────────────────────────────────── connected components ──

fn find(parent: &mut [u32], mut x: u32) -> u32 {
    while parent[x as usize] != x {
        let p = parent[x as usize];
        parent[x as usize] = parent[p as usize];
        x = parent[x as usize];
    }
    x
}

/// Two-pass union-find labelling. Foreground = (luma ≥ t) XOR invert. conn = 4 or 8.
/// labels: u32[w·h], 0 = background, 1..=count = components in raster order of first pixel. Returns count.
#[no_mangle]
pub unsafe extern "C" fn cc_label(s: *const u8, w: u32, h: u32, labels: *mut u32, t: f32, invert: u32, conn: u32) -> u32 {
    let s = rs(s, w, h);
    let (w, h) = (w as usize, h as usize);
    let lab = core::slice::from_raw_parts_mut(labels, w * h);
    let mut parent: Vec<u32> = vec![0];
    let inv = invert != 0;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if (luma(&s[i * 4..i * 4 + 4]) >= t) == inv {
                lab[i] = 0;
                continue;
            }
            let mut best = 0u32;
            let mut join = |n: u32, parent: &mut Vec<u32>| {
                if n == 0 {
                    return;
                }
                let rn = find(parent, n);
                if best == 0 {
                    best = rn;
                } else if rn != best {
                    let (lo, hi) = if rn < best { (rn, best) } else { (best, rn) };
                    parent[hi as usize] = lo;
                    best = lo;
                }
            };
            if x > 0 {
                join(lab[i - 1], &mut parent);
            }
            if y > 0 {
                join(lab[i - w], &mut parent);
                if conn == 8 {
                    if x > 0 {
                        join(lab[i - w - 1], &mut parent);
                    }
                    if x + 1 < w {
                        join(lab[i - w + 1], &mut parent);
                    }
                }
            }
            if best == 0 {
                best = parent.len() as u32;
                parent.push(best);
            }
            lab[i] = best;
        }
    }
    let mut remap = vec![0u32; parent.len()];
    let mut count = 0u32;
    for v in lab.iter_mut() {
        if *v != 0 {
            let r = find(&mut parent, *v) as usize;
            if remap[r] == 0 {
                count += 1;
                remap[r] = count;
            }
            *v = remap[r];
        }
    }
    count
}

/// out: f64[count·7] per label (index label−1): area, minX, minY, maxX, maxY, sumX, sumY.
#[no_mangle]
pub unsafe extern "C" fn cc_stats(labels: *const u32, w: u32, h: u32, count: u32, out: *mut f64) {
    let (w, h) = (w as usize, h as usize);
    let lab = core::slice::from_raw_parts(labels, w * h);
    let out = core::slice::from_raw_parts_mut(out, count as usize * 7);
    for c in out.chunks_exact_mut(7) {
        c.copy_from_slice(&[0.0, f64::MAX, f64::MAX, -1.0, -1.0, 0.0, 0.0]);
    }
    for y in 0..h {
        for x in 0..w {
            let l = lab[y * w + x];
            if l == 0 {
                continue;
            }
            let o = &mut out[(l as usize - 1) * 7..(l as usize) * 7];
            let (xf, yf) = (x as f64, y as f64);
            o[0] += 1.0;
            o[1] = o[1].min(xf);
            o[2] = o[2].min(yf);
            o[3] = o[3].max(xf);
            o[4] = o[4].max(yf);
            o[5] += xf;
            o[6] += yf;
        }
    }
}

/// Paint the label map: each kept label gets a distinct saturated colour (golden-ratio hue walk); background black;
/// labels with keep[label]==0 are dark gray. keep: u8[count+1].
#[no_mangle]
pub unsafe extern "C" fn cc_render(labels: *const u32, w: u32, h: u32, d: *mut u8, keep: *const u8) {
    let n = w as usize * h as usize;
    let lab = core::slice::from_raw_parts(labels, n);
    let d = ws(d, w, h);
    for (o, &l) in d.chunks_exact_mut(4).zip(lab) {
        let c = if l == 0 {
            [0u8, 0, 0]
        } else if *keep.add(l as usize) == 0 {
            [48, 48, 48]
        } else {
            let hue = (l as f32 * 0.618_034).fract() * 6.0;
            let val = 1.0 - 0.3 * ((l as f32 * 0.37).fract());
            let f = |n: f32| {
                let k = (n + hue) % 6.0;
                val * (1.0 - 0.8 * k.min(4.0 - k).clamp(0.0, 1.0))
            };
            [clamp8(f(5.0) * 255.0), clamp8(f(3.0) * 255.0), clamp8(f(1.0) * 255.0)]
        };
        o[0] = c[0];
        o[1] = c[1];
        o[2] = c[2];
        o[3] = 255;
    }
}

// ───────────────────────────────────────────────────── corners & lines ──

/// Harris (method 0: det − k·trace²) or Shi-Tomasi (method 1: smaller eigenvalue) corners of luma.
/// Sobel gradients (÷8), structure tensor smoothed with a gaussian of `sigma`, response ≥ rel·max, local maximum within
/// `min_dist` px, strongest first. out: f32[max·3] = x, y, response. Returns the number written.
#[no_mangle]
pub unsafe extern "C" fn corners(s: *const u8, w: u32, h: u32, method: u32, sigma: f32, kk: f32, rel: f32, min_dist: u32, max: u32, out: *mut f32) -> u32 {
    let s = rs(s, w, h);
    let (w, h) = (w as usize, h as usize);
    let out = core::slice::from_raw_parts_mut(out, max as usize * 3);
    let l = luma_plane(s);
    let (mut a, mut c) = gradient(&l, w, h, 0);
    drop(l);
    let mut b = vec![0f32; w * h];
    for i in 0..w * h {
        let (gx, gy) = (a[i] * 0.125, c[i] * 0.125);
        a[i] = gx * gx;
        b[i] = gx * gy;
        c[i] = gy * gy;
    }
    let k = gauss_kernel(sigma.max(0.3));
    blur_plane(&mut a, w, h, &k);
    blur_plane(&mut b, w, h, &k);
    blur_plane(&mut c, w, h, &k);
    let mut mx = 0f32;
    for i in 0..w * h {
        let (xx, xy, yy) = (a[i], b[i], c[i]);
        let r = if method == 1 {
            let tr = xx + yy;
            (tr - ((xx - yy) * (xx - yy) + 4.0 * xy * xy).sqrt()) * 0.5
        } else {
            xx * yy - xy * xy - kk * (xx + yy) * (xx + yy)
        };
        a[i] = r;
        mx = mx.max(r);
    }
    if mx <= 0.0 {
        return 0;
    }
    let thr = rel * mx;
    let md = min_dist.max(1) as isize;
    let mut cand: Vec<(f32, u32, u32)> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let r = a[y * w + x];
            if r < thr {
                continue;
            }
            // 3×3 local maximum first (cheap), exact min-distance suppression afterwards
            let mut is_max = true;
            'o: for dy in -1isize..=1 {
                for dx in -1isize..=1 {
                    let (nx, ny) = (x as isize + dx, y as isize + dy);
                    if (dx != 0 || dy != 0) && nx >= 0 && ny >= 0 && nx < w as isize && ny < h as isize && a[ny as usize * w + nx as usize] > r {
                        is_max = false;
                        break 'o;
                    }
                }
            }
            if is_max {
                cand.push((r, x as u32, y as u32));
            }
        }
    }
    cand.sort_by(|p, q| q.0.partial_cmp(&p.0).unwrap_or(core::cmp::Ordering::Equal));
    // greedy suppression on a coarse occupancy grid
    let cell = md as usize;
    let (gw, gh) = (w / cell + 1, h / cell + 1);
    let mut grid: Vec<Vec<(u32, u32)>> = vec![Vec::new(); gw * gh];
    let mut n = 0usize;
    for &(r, x, y) in &cand {
        if n >= max as usize {
            break;
        }
        let (gx, gy) = (x as usize / cell, y as usize / cell);
        let mut ok = true;
        'g: for yy in gy.saturating_sub(1)..(gy + 2).min(gh) {
            for xx in gx.saturating_sub(1)..(gx + 2).min(gw) {
                for &(px, py) in &grid[yy * gw + xx] {
                    let (dx, dy) = (px as isize - x as isize, py as isize - y as isize);
                    if dx * dx + dy * dy < md * md {
                        ok = false;
                        break 'g;
                    }
                }
            }
        }
        if ok {
            grid[gy * gw + gx].push((x, y));
            out[n * 3] = x as f32;
            out[n * 3 + 1] = y as f32;
            out[n * 3 + 2] = r;
            n += 1;
        }
    }
    n as u32
}

/// Standard Hough transform for straight lines on a Canny edge map of the image.
/// Line model: rho = x·cos(theta) + y·sin(theta), theta in [0, π) with `theta_steps` bins, rho resolution 1 px.
/// A peak must have ≥ `min_votes` votes (≤ 0 → half of the strongest peak) and be the maximum in a ±nms_rho × ±nms_theta window
/// (theta wraps with rho negated). out: f32[max·7] = rho, theta(rad), votes, x1, y1, x2, y2 where (x1,y1)-(x2,y2) is the longest
/// run of edge pixels supporting the line (gaps ≤ max_gap px). edges_out (nullable): RGBA edge map. info: f32[4] = canny low,
/// canny high, edge pixel count, strongest vote count. Returns the number of lines.
#[no_mangle]
pub unsafe extern "C" fn hough(s: *const u8, w: u32, h: u32, sigma: f32, low: f32, high: f32, theta_steps: u32, min_votes: f32, nms_rho: u32, nms_theta: u32, max_gap: u32, max: u32, out: *mut f32, edges_out: *mut u8, info: *mut f32) -> u32 {
    let s = rs(s, w, h);
    let (w, h) = (w as usize, h as usize);
    let out = core::slice::from_raw_parts_mut(out, max as usize * 7);
    let mut l = luma_plane(s);
    let (mask, lo, hi) = canny_mask(&mut l, w, h, sigma, low, high);
    drop(l);
    if !edges_out.is_null() {
        let e = core::slice::from_raw_parts_mut(edges_out, w * h * 4);
        for (o, &m) in e.chunks_exact_mut(4).zip(&mask) {
            let v = m * 255;
            o[0] = v;
            o[1] = v;
            o[2] = v;
            o[3] = 255;
        }
    }
    let nt = theta_steps.max(4) as usize;
    let diag = ((w * w + h * h) as f32).sqrt().ceil() as usize + 1;
    let nr = 2 * diag + 1;
    let trig: Vec<(f32, f32)> = (0..nt).map(|t| { let a = t as f32 * core::f32::consts::PI / nt as f32; (a.cos(), a.sin()) }).collect();
    let mut acc = vec![0u32; nt * nr];
    let mut n_edges = 0u32;
    for y in 0..h {
        for x in 0..w {
            if mask[y * w + x] == 0 {
                continue;
            }
            n_edges += 1;
            for (t, &(c, sn)) in trig.iter().enumerate() {
                let rho = (x as f32 * c + y as f32 * sn + 0.5).floor() as isize + diag as isize;
                acc[t * nr + rho as usize] += 1;
            }
        }
    }
    let peak = acc.iter().copied().max().unwrap_or(0);
    *info = lo;
    *info.add(1) = hi;
    *info.add(2) = n_edges as f32;
    *info.add(3) = peak as f32;
    if peak == 0 {
        return 0;
    }
    let thr = if min_votes <= 0.0 { (peak as f32 * 0.5).max(2.0) } else { min_votes } as u32;
    let (wr, wt) = (nms_rho as isize, nms_theta as isize);
    let at = |t: isize, r: isize| -> u32 {
        // theta wraps by π, which mirrors rho
        let (mut t, mut r) = (t, r);
        if t < 0 {
            t += nt as isize;
            r = 2 * diag as isize - r;
        } else if t >= nt as isize {
            t -= nt as isize;
            r = 2 * diag as isize - r;
        }
        if r < 0 || r >= nr as isize {
            0
        } else {
            acc[t as usize * nr + r as usize]
        }
    };
    let mut peaks: Vec<(u32, u32, u32)> = Vec::new();
    for t in 0..nt {
        for r in 0..nr {
            let v = acc[t * nr + r];
            if v < thr {
                continue;
            }
            let mut ok = true;
            'n: for dt in -wt..=wt {
                for dr in -wr..=wr {
                    if dt == 0 && dr == 0 {
                        continue;
                    }
                    let o = at(t as isize + dt, r as isize + dr);
                    // ties: keep the first in scan order
                    if o > v || (o == v && (dt < 0 || (dt == 0 && dr < 0))) {
                        ok = false;
                        break 'n;
                    }
                }
            }
            if ok {
                peaks.push((v, t as u32, r as u32));
            }
        }
    }
    peaks.sort_by(|p, q| q.0.cmp(&p.0));
    peaks.truncate(max as usize);
    for (n, &(v, t, r)) in peaks.iter().enumerate() {
        let (c, sn) = trig[t as usize];
        let rho = r as f32 - diag as f32;
        // walk the line across the image and find the longest supported run
        let (px, py) = (rho * c, rho * sn); // closest point to the origin
        let (dx, dy) = (-sn, c);
        let reach = diag as isize;
        let (mut best, mut bs, mut be) = (0isize, 0isize, 0isize);
        let (mut start, mut last, mut open) = (0isize, 0isize, false);
        for k in -reach..=reach {
            let (fx, fy) = (px + dx * k as f32, py + dy * k as f32);
            let (ix, iy) = ((fx + 0.5).floor() as isize, (fy + 0.5).floor() as isize);
            let mut on = false;
            if ix >= 0 && iy >= 0 && ix < w as isize && iy < h as isize {
                'e: for oy in -1isize..=1 {
                    for ox in -1isize..=1 {
                        let (qx, qy) = (ix + ox, iy + oy);
                        if qx >= 0 && qy >= 0 && qx < w as isize && qy < h as isize && mask[qy as usize * w + qx as usize] != 0 {
                            on = true;
                            break 'e;
                        }
                    }
                }
            }
            if on {
                if !open || k - last > max_gap as isize + 1 {
                    start = k;
                    open = true;
                }
                last = k;
                if last - start > best {
                    best = last - start;
                    bs = start;
                    be = last;
                }
            }
        }
        let o = &mut out[n * 7..n * 7 + 7];
        o[0] = rho;
        o[1] = t as f32 * core::f32::consts::PI / nt as f32;
        o[2] = v as f32;
        o[3] = px + dx * bs as f32;
        o[4] = py + dy * bs as f32;
        o[5] = px + dx * be as f32;
        o[6] = py + dy * be as f32;
    }
    peaks.len() as u32
}

// ───────────────────────────────────────────────────────── bits & LSB ──

/// Bit-plane view. chan 0..3 = that channel's bit → black/white; 4 = bit of R, G and B kept in their own channels. Alpha 255.
#[no_mangle]
pub unsafe extern "C" fn bitplane(s: *const u8, w: u32, h: u32, d: *mut u8, bit: u32, chan: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let b = bit.min(7);
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        if chan < 4 {
            let v = ((i[chan as usize] >> b) & 1) * 255;
            o[0] = v;
            o[1] = v;
            o[2] = v;
        } else {
            o[0] = ((i[0] >> b) & 1) * 255;
            o[1] = ((i[1] >> b) & 1) * 255;
            o[2] = ((i[2] >> b) & 1) * 255;
        }
        o[3] = 255;
    }
}

/// Write `len` bytes into the low `bits` bits of the channels selected by chmask (bit0=R … bit3=A), pixels in raster order,
/// channels in RGBA order, message bits MSB-first. Modifies the buffer in place. Returns bytes written (0 if it does not fit).
#[no_mangle]
pub unsafe extern "C" fn lsb_embed(p: *mut u8, w: u32, h: u32, data: *const u8, len: u32, chmask: u32, bits: u32) -> u32 {
    let px = ws(p, w, h);
    let data = core::slice::from_raw_parts(data, len as usize);
    let bits = bits.clamp(1, 8);
    let nch = (chmask & 15).count_ones() as u64;
    let capacity = px.len() as u64 / 4 * nch * bits as u64 / 8;
    if (len as u64) > capacity {
        return 0;
    }
    let total = len as u64 * 8;
    let mut pos = 0u64;
    let mask = !(((1u16 << bits) - 1) as u8);
    'outer: for (i, v) in px.iter_mut().enumerate() {
        if chmask & (1 << (i & 3)) == 0 {
            continue;
        }
        let mut chunk = 0u8;
        for _ in 0..bits {
            let bit = if pos < total { (data[(pos / 8) as usize] >> (7 - (pos % 8))) & 1 } else { 0 };
            chunk = (chunk << 1) | bit;
            pos += 1;
        }
        *v = (*v & mask) | chunk;
        if pos >= total {
            break 'outer;
        }
    }
    len
}

/// Inverse of lsb_embed: read up to `max` bytes. Returns the number of bytes produced.
#[no_mangle]
pub unsafe extern "C" fn lsb_extract(p: *const u8, w: u32, h: u32, out: *mut u8, max: u32, chmask: u32, bits: u32) -> u32 {
    let px = rs(p, w, h);
    let out = core::slice::from_raw_parts_mut(out, max as usize);
    let bits = bits.clamp(1, 8);
    let (mut cur, mut nb, mut n) = (0u8, 0u32, 0usize);
    for (i, &v) in px.iter().enumerate() {
        if chmask & (1 << (i & 3)) == 0 {
            continue;
        }
        for b in (0..bits).rev() {
            cur = (cur << 1) | ((v >> b) & 1);
            nb += 1;
            if nb == 8 {
                if n >= out.len() {
                    return n as u32;
                }
                out[n] = cur;
                n += 1;
                cur = 0;
                nb = 0;
            }
        }
        if n >= out.len() {
            break;
        }
    }
    n as u32
}

/// Chi-square LSB test per channel (Westfeld & Pfitzmann pairs-of-values): for each value pair (2k, 2k+1) compare the two counts
/// with their mean. out f64[8]: chi2 for R,G,B,A then the fraction of LSBs set for R,G,B,A.
/// Sequential LSB embedding of random-looking data equalises the pair counts and drives chi2 towards 0.
#[no_mangle]
pub unsafe extern "C" fn lsb_stats(p: *const u8, w: u32, h: u32, out: *mut f64) {
    let px = rs(p, w, h);
    let out = core::slice::from_raw_parts_mut(out, 12);
    let mut hist = [[0u32; 256]; 4];
    for q in px.chunks_exact(4) {
        for c in 0..4 {
            hist[c][q[c] as usize] += 1;
        }
    }
    let n = (px.len() / 4).max(1) as f64;
    for c in 0..4 {
        let (mut chi, mut ones, mut df) = (0f64, 0u64, 0u32);
        for k in 0..128 {
            let (a, b) = (hist[c][2 * k] as f64, hist[c][2 * k + 1] as f64);
            ones += hist[c][2 * k + 1] as u64;
            let e = (a + b) / 2.0;
            if e >= 5.0 {
                chi += (a - e) * (a - e) / e;
                df += 1;
            }
        }
        out[c] = chi;
        out[4 + c] = ones as f64 / n;
        out[8 + c] = df.saturating_sub(1) as f64;
    }
}
