//! Neighbourhood filters: gaussian, convolution, unsharp mask, edge detectors, canny, median, bilateral, morphology.
//! Borders are clamp-to-edge everywhere. RGB is filtered; alpha is carried through unless stated.
use crate::*;
use core::arch::wasm32::*;

/// Normalised gaussian taps, radius = ceil(3·sigma).
pub(crate) fn gauss_kernel(sigma: f32) -> Vec<f32> {
    let s = sigma.max(1e-3);
    let r = (3.0 * s).ceil() as i32;
    let mut k: Vec<f32> = (-r..=r).map(|i| (-((i * i) as f32) / (2.0 * s * s)).exp()).collect();
    let sum: f32 = k.iter().sum();
    for v in &mut k {
        *v /= sum;
    }
    k
}

#[inline(always)]
unsafe fn store_px(p: *mut u8, v: v128) {
    let i = i32x4_trunc_sat_f32x4(f32x4_add(v, f32x4_splat(0.5)));
    let w = i16x8_narrow_i32x4(i, i);
    let b = u8x16_narrow_i16x8(w, w);
    (p as *mut u32).write_unaligned(u32x4_extract_lane::<0>(b));
}

/// edge-replicated f32 copy of one RGBA row: out has (w + 2r)·4 floats
#[inline]
fn pad_row(row: &[u8], w: usize, r: usize, out: &mut [f32]) {
    for x in 0..w + 2 * r {
        let sx = cl(x as isize - r as isize, w) * 4;
        out[x * 4] = row[sx] as f32;
        out[x * 4 + 1] = row[sx + 1] as f32;
        out[x * 4 + 2] = row[sx + 2] as f32;
        out[x * 4 + 3] = row[sx + 3] as f32;
    }
}

/// Separable filter on RGBA8 → f32 rows handed to `sink(y, row)`; all four channels are filtered.
/// Horizontal pass is explicit SIMD (one pixel = one f32x4); the vertical pass is an axpy over a ring of rows.
pub(crate) fn sep_rows<F: FnMut(usize, &[f32])>(s: &[u8], w: usize, h: usize, k: &[f32], mut sink: F) {
    let len = k.len();
    let r = len / 2;
    let rw = w * 4;
    let mut pad = vec![0f32; (w + 2 * r) * 4];
    let mut ring = vec![0f32; len * rw];
    let mut acc = vec![0f32; rw];
    let mut done: isize = -1;
    for y in 0..h {
        let need = (y + r).min(h - 1) as isize;
        while done < need {
            done += 1;
            let yy = done as usize;
            pad_row(&s[yy * rw..(yy + 1) * rw], w, r, &mut pad);
            let slot = yy % len;
            let out = &mut ring[slot * rw..(slot + 1) * rw];
            unsafe {
                for x in 0..w {
                    let p = pad.as_ptr().add(x * 4);
                    let mut a = f32x4_splat(0.0);
                    for t in 0..len {
                        a = f32x4_add(a, f32x4_mul(v128_load(p.add(t * 4) as *const v128), f32x4_splat(*k.get_unchecked(t))));
                    }
                    v128_store(out.as_mut_ptr().add(x * 4) as *mut v128, a);
                }
            }
        }
        acc.fill(0.0);
        for t in 0..len {
            let yy = cl(y as isize + t as isize - r as isize, h) % len;
            let row = &ring[yy * rw..(yy + 1) * rw];
            let kv = k[t];
            for (a, &v) in acc.iter_mut().zip(row) {
                *a += v * kv;
            }
        }
        sink(y, &acc);
    }
}

/// Gaussian blur of RGB into d; alpha copied from the source.
pub(crate) fn gaussian_into(s: &[u8], w: usize, h: usize, d: &mut [u8], sigma: f32) {
    let k = gauss_kernel(sigma);
    let rw = w * 4;
    sep_rows(s, w, h, &k, |y, acc| {
        let o = &mut d[y * rw..(y + 1) * rw];
        let sr = &s[y * rw..(y + 1) * rw];
        for x in 0..w {
            unsafe { store_px(o.as_mut_ptr().add(x * 4), v128_load(acc.as_ptr().add(x * 4) as *const v128)) };
            o[x * 4 + 3] = sr[x * 4 + 3];
        }
    });
}

#[no_mangle]
pub unsafe extern "C" fn gaussian(s: *const u8, w: u32, h: u32, d: *mut u8, sigma: f32) {
    gaussian_into(rs(s, w, h), w as usize, h as usize, ws(d, w, h), sigma);
}

/// Unsharp mask: out = src + amount·(src − gaussian(src, sigma)) where |src − blur| ≥ threshold.
#[no_mangle]
pub unsafe extern "C" fn unsharp(s: *const u8, w: u32, h: u32, d: *mut u8, sigma: f32, amount: f32, thresh: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let k = gauss_kernel(sigma);
    let rw = w * 4;
    sep_rows(s, w, h, &k, |y, acc| {
        let o = &mut d[y * rw..(y + 1) * rw];
        let sr = &s[y * rw..(y + 1) * rw];
        for x in 0..w {
            for c in 0..3 {
                let v = sr[x * 4 + c] as f32;
                let diff = v - acc[x * 4 + c];
                o[x * 4 + c] = if diff.abs() >= thresh { clamp8(v + amount * diff) } else { sr[x * 4 + c] };
            }
            o[x * 4 + 3] = sr[x * 4 + 3];
        }
    });
}

/// size×size convolution (correlation orientation, row-major kernel) on RGB: out = Σ k·p / divisor + bias.
#[no_mangle]
pub unsafe extern "C" fn convolve(s: *const u8, w: u32, h: u32, d: *mut u8, kern: *const f32, size: u32, divisor: f32, bias: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h, n) = (w as usize, h as usize, size as usize);
    let kern = core::slice::from_raw_parts(kern, n * n);
    let r = n / 2;
    let rw = w * 4;
    let pw = (w + 2 * r) * 4;
    let mut ring = vec![0f32; n * pw];
    let mut done: isize = -1;
    let inv = f32x4_splat(1.0 / if divisor == 0.0 { 1.0 } else { divisor });
    let bias = f32x4_splat(bias);
    let mut rows: Vec<*const f32> = vec![core::ptr::null(); n];
    for y in 0..h {
        let need = (y + r).min(h - 1) as isize;
        while done < need {
            done += 1;
            let yy = done as usize;
            let slot = yy % n;
            pad_row(&s[yy * rw..(yy + 1) * rw], w, r, &mut ring[slot * pw..(slot + 1) * pw]);
        }
        for j in 0..n {
            rows[j] = ring.as_ptr().add((cl(y as isize + j as isize - r as isize, h) % n) * pw);
        }
        let o = d.as_mut_ptr().add(y * rw);
        for x in 0..w {
            let mut a = f32x4_splat(0.0);
            for j in 0..n {
                let p = rows[j].add(x * 4);
                for i in 0..n {
                    a = f32x4_add(a, f32x4_mul(v128_load(p.add(i * 4) as *const v128), f32x4_splat(*kern.get_unchecked(j * n + i))));
                }
            }
            store_px(o.add(x * 4), f32x4_add(f32x4_mul(a, inv), bias));
            *o.add(x * 4 + 3) = s[y * rw + x * 4 + 3];
        }
    }
}

/// In-place separable blur of an f32 plane.
pub(crate) fn blur_plane(p: &mut [f32], w: usize, h: usize, k: &[f32]) {
    let len = k.len();
    let r = len / 2;
    let mut tmp = vec![0f32; w * h];
    let mut pad = vec![0f32; w + 2 * r];
    for y in 0..h {
        let row = &p[y * w..(y + 1) * w];
        for x in 0..w + 2 * r {
            pad[x] = row[cl(x as isize - r as isize, w)];
        }
        let out = &mut tmp[y * w..(y + 1) * w];
        for x in 0..w {
            let mut a = 0f32;
            for t in 0..len {
                a += pad[x + t] * k[t];
            }
            out[x] = a;
        }
    }
    for y in 0..h {
        let out = &mut p[y * w..(y + 1) * w];
        out.fill(0.0);
        for t in 0..len {
            let yy = cl(y as isize + t as isize - r as isize, h);
            let row = &tmp[yy * w..(yy + 1) * w];
            let kv = k[t];
            for (a, &v) in out.iter_mut().zip(row) {
                *a += v * kv;
            }
        }
    }
}

/// 3×3 gradient of a plane with clamp-to-edge. kind 0 sobel, 1 scharr, 2 prewitt.
pub(crate) fn gradient(l: &[f32], w: usize, h: usize, kind: u32) -> (Vec<f32>, Vec<f32>) {
    let (a, b) = match kind {
        1 => (3.0f32, 10.0f32),
        2 => (1.0, 1.0),
        _ => (1.0, 2.0),
    };
    let mut gx = vec![0f32; w * h];
    let mut gy = vec![0f32; w * h];
    for y in 0..h {
        let (r0, r1, r2) = (cl(y as isize - 1, h) * w, y * w, cl(y as isize + 1, h) * w);
        for x in 0..w {
            let (x0, x2) = (cl(x as isize - 1, w), cl(x as isize + 1, w));
            let (tl, tc, tr) = (l[r0 + x0], l[r0 + x], l[r0 + x2]);
            let (ml, mr) = (l[r1 + x0], l[r1 + x2]);
            let (bl, bc, br) = (l[r2 + x0], l[r2 + x], l[r2 + x2]);
            gx[r1 + x] = a * (tr - tl) + b * (mr - ml) + a * (br - bl);
            gy[r1 + x] = a * (bl - tl) + b * (bc - tc) + a * (br - tr);
        }
    }
    (gx, gy)
}

/// Edge magnitude on Rec.709 luma → R=G=B, alpha 255.
/// method 0 sobel, 1 scharr, 2 prewitt: sqrt(gx²+gy²)·scale; 3 laplacian (4-neighbour), 4 laplacian (8-neighbour): |L|·scale.
#[no_mangle]
pub unsafe extern "C" fn edges(s: *const u8, w: u32, h: u32, d: *mut u8, method: u32, scale: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let l = luma_plane(s);
    let put = |d: &mut [u8], i: usize, v: f32| {
        let v = clamp8(v);
        d[i * 4] = v;
        d[i * 4 + 1] = v;
        d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
    };
    if method <= 2 {
        let (gx, gy) = gradient(&l, w, h, method);
        for i in 0..w * h {
            put(d, i, (gx[i] * gx[i] + gy[i] * gy[i]).sqrt() * scale);
        }
    } else {
        for y in 0..h {
            let (r0, r1, r2) = (cl(y as isize - 1, h) * w, y * w, cl(y as isize + 1, h) * w);
            for x in 0..w {
                let (x0, x2) = (cl(x as isize - 1, w), cl(x as isize + 1, w));
                let v = if method == 3 {
                    l[r0 + x] + l[r2 + x] + l[r1 + x0] + l[r1 + x2] - 4.0 * l[r1 + x]
                } else {
                    l[r0 + x0] + l[r0 + x] + l[r0 + x2] + l[r1 + x0] + l[r1 + x2] + l[r2 + x0] + l[r2 + x] + l[r2 + x2] - 8.0 * l[r1 + x]
                };
                put(d, r1 + x, v.abs() * scale);
            }
        }
    }
}

/// Canny on a luma plane. Returns a 0/1 mask. Thresholds are on sobel magnitude / 4 (a full black→white step = 255).
/// low/high < 0 → automatic: high = the magnitude below which 70 % of pixels fall, low = 0.4·high (MATLAB's rule).
pub(crate) fn canny_mask(l: &mut Vec<f32>, w: usize, h: usize, sigma: f32, mut low: f32, mut high: f32) -> (Vec<u8>, f32, f32) {
    if sigma > 0.0 {
        let k = gauss_kernel(sigma);
        blur_plane(l, w, h, &k);
    }
    let (gx, gy) = gradient(l, w, h, 0);
    let mut mag = vec![0f32; w * h];
    for i in 0..w * h {
        mag[i] = (gx[i] * gx[i] + gy[i] * gy[i]).sqrt() * 0.25;
    }
    if high < 0.0 {
        let mx = mag.iter().cloned().fold(0f32, f32::max).max(1e-6);
        const BINS: usize = 1024;
        let mut hist = vec![0u32; BINS];
        for &m in &mag {
            hist[((m / mx * (BINS - 1) as f32) as usize).min(BINS - 1)] += 1;
        }
        let target = (0.7 * (w * h) as f64) as u64;
        let mut acc = 0u64;
        let mut bin = BINS - 1;
        for (i, &c) in hist.iter().enumerate() {
            acc += c as u64;
            if acc > target {
                bin = i;
                break;
            }
        }
        high = ((bin + 1) as f32 / BINS as f32 * mx).max(1.0);
        low = 0.4 * high;
    } else if low < 0.0 {
        low = 0.4 * high;
    }
    // non-maximum suppression along the quantised gradient direction
    let mut out = vec![0u8; w * h]; // 0 none, 1 weak, 2 strong
    let mut stack: Vec<u32> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let m = mag[i];
            if m < low {
                continue;
            }
            let (ax, ay) = (gx[i].abs(), gy[i].abs());
            let (dx, dy): (isize, isize) = if ay <= ax * 0.41421357 {
                (1, 0)
            } else if ax <= ay * 0.41421357 {
                (0, 1)
            } else if (gx[i] > 0.0) == (gy[i] > 0.0) {
                (1, 1)
            } else {
                (1, -1)
            };
            let a = mag[cl(y as isize + dy, h) * w + cl(x as isize + dx, w)];
            let b = mag[cl(y as isize - dy, h) * w + cl(x as isize - dx, w)];
            // strict on one side so a two-pixel plateau keeps exactly one ridge
            if m > a && m >= b {
                if m >= high {
                    out[i] = 2;
                    stack.push(i as u32);
                } else {
                    out[i] = 1;
                }
            }
        }
    }
    // hysteresis: grow strong edges through 8-connected weak ones
    while let Some(i) = stack.pop() {
        let (x, y) = ((i as usize % w) as isize, (i as usize / w) as isize);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if out[j] == 1 {
                    out[j] = 2;
                    stack.push(j as u32);
                }
            }
        }
    }
    for v in out.iter_mut() {
        *v = (*v == 2) as u8;
    }
    (out, low, high)
}

/// Canny edge map (white edges on black, alpha 255). thr_out receives [low, high] actually used.
#[no_mangle]
pub unsafe extern "C" fn canny(s: *const u8, w: u32, h: u32, d: *mut u8, sigma: f32, low: f32, high: f32, thr_out: *mut f32) -> u32 {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let mut l = luma_plane(s);
    let (mask, lo, hi) = canny_mask(&mut l, w as usize, h as usize, sigma, low, high);
    if !thr_out.is_null() {
        *thr_out = lo;
        *thr_out.add(1) = hi;
    }
    let mut n = 0u32;
    for (o, &m) in d.chunks_exact_mut(4).zip(&mask) {
        let v = m * 255;
        n += m as u32;
        o[0] = v;
        o[1] = v;
        o[2] = v;
        o[3] = 255;
    }
    n
}

/// Median filter, square window (2r+1)², per RGB channel. Huang's sliding histogram: O(r) per pixel.
#[no_mangle]
pub unsafe extern "C" fn median(s: *const u8, w: u32, h: u32, d: *mut u8, radius: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h, r) = (w as isize, h as isize, radius as isize);
    let th = (((2 * r + 1) * (2 * r + 1)) / 2) as u32; // median = smallest v with count(≤v) > th
    let px = |x: isize, y: isize, c: usize| -> u8 { s[(cl(y, h as usize) * w as usize + cl(x, w as usize)) * 4 + c] };
    for c in 0..3 {
        for y in 0..h {
            let mut hist = [0u32; 256];
            for dy in -r..=r {
                for dx in -r..=r {
                    hist[px(dx, y + dy, c) as usize] += 1;
                }
            }
            let mut med = 0usize;
            let mut lt = 0u32; // count of values < med
            while lt + hist[med] <= th {
                lt += hist[med];
                med += 1;
            }
            d[(y * w) as usize * 4 + c] = med as u8;
            for x in 1..w {
                for dy in -r..=r {
                    let out = px(x - r - 1, y + dy, c) as usize;
                    let inn = px(x + r, y + dy, c) as usize;
                    hist[out] -= 1;
                    lt -= (out < med) as u32;
                    hist[inn] += 1;
                    lt += (inn < med) as u32;
                }
                while lt > th {
                    med -= 1;
                    lt -= hist[med];
                }
                while lt + hist[med] <= th {
                    lt += hist[med];
                    med += 1;
                }
                d[(y * w + x) as usize * 4 + c] = med as u8;
            }
        }
    }
    for i in 0..(w * h) as usize {
        d[i * 4 + 3] = s[i * 4 + 3];
    }
}

/// Bilateral filter. radius = ceil(2·sigmaSpace); weight = exp(−(dx²+dy²)/2σs²)·exp(−‖ΔRGB‖²/2σc²), colour distance in 0..255 units.
#[no_mangle]
pub unsafe extern "C" fn bilateral(s: *const u8, w: u32, h: u32, d: *mut u8, sigma_space: f32, sigma_color: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let ss = sigma_space.max(1e-3);
    let sc = sigma_color.max(1e-3);
    let r = (2.0 * ss).ceil() as isize;
    let n = (2 * r + 1) as usize;
    let mut sp = vec![0f32; n * n];
    for dy in -r..=r {
        for dx in -r..=r {
            sp[((dy + r) as usize) * n + (dx + r) as usize] = (-((dx * dx + dy * dy) as f32) / (2.0 * ss * ss)).exp();
        }
    }
    // colour weight LUT over squared distance 0..=3·255²
    let inv = -1.0 / (2.0 * sc * sc);
    let cw: Vec<f32> = (0..=195_075u32).map(|q| (q as f32 * inv).exp()).collect();
    for y in 0..h {
        for x in 0..w {
            let ci = (y * w + x) * 4;
            let (cr, cg, cb) = (s[ci] as i32, s[ci + 1] as i32, s[ci + 2] as i32);
            let (mut ar, mut ag, mut ab, mut aw) = (0f32, 0f32, 0f32, 0f32);
            for dy in -r..=r {
                let row = cl(y as isize + dy, h) * w;
                let spr = &sp[((dy + r) as usize) * n..((dy + r) as usize + 1) * n];
                for dx in -r..=r {
                    let i = (row + cl(x as isize + dx, w)) * 4;
                    let (pr, pg, pb) = (s[i] as i32, s[i + 1] as i32, s[i + 2] as i32);
                    let q = (pr - cr) * (pr - cr) + (pg - cg) * (pg - cg) + (pb - cb) * (pb - cb);
                    let wt = spr[(dx + r) as usize] * *cw.get_unchecked(q as usize);
                    ar += wt * pr as f32;
                    ag += wt * pg as f32;
                    ab += wt * pb as f32;
                    aw += wt;
                }
            }
            d[ci] = clamp8(ar / aw);
            d[ci + 1] = clamp8(ag / aw);
            d[ci + 2] = clamp8(ab / aw);
            d[ci + 3] = s[ci + 3];
        }
    }
}

/// Square min/max filter of radius r on all bytes (alpha fixed up by the caller). Both passes are byte-wise
/// min/max over shifted rows, which the compiler turns into u8x16 SIMD.
fn minmax(s: &[u8], w: usize, h: usize, d: &mut [u8], r: usize, is_max: bool) {
    let rw = w * 4;
    let mut tmp = vec![0u8; s.len()];
    let mut pad = vec![0u8; (w + 2 * r) * 4];
    for y in 0..h {
        let row = &s[y * rw..(y + 1) * rw];
        for x in 0..w + 2 * r {
            let sx = cl(x as isize - r as isize, w) * 4;
            pad[x * 4..x * 4 + 4].copy_from_slice(&row[sx..sx + 4]);
        }
        let out = &mut tmp[y * rw..(y + 1) * rw];
        out.copy_from_slice(&pad[..rw]);
        for t in 1..=2 * r {
            let sh = &pad[t * 4..t * 4 + rw];
            if is_max {
                for (o, &v) in out.iter_mut().zip(sh) {
                    *o = (*o).max(v);
                }
            } else {
                for (o, &v) in out.iter_mut().zip(sh) {
                    *o = (*o).min(v);
                }
            }
        }
    }
    for y in 0..h {
        let out = &mut d[y * rw..(y + 1) * rw];
        let y0 = y.saturating_sub(r);
        let y1 = (y + r).min(h - 1);
        out.copy_from_slice(&tmp[y0 * rw..(y0 + 1) * rw]);
        for yy in y0 + 1..=y1 {
            let row = &tmp[yy * rw..(yy + 1) * rw];
            if is_max {
                for (o, &v) in out.iter_mut().zip(row) {
                    *o = (*o).max(v);
                }
            } else {
                for (o, &v) in out.iter_mut().zip(row) {
                    *o = (*o).min(v);
                }
            }
        }
    }
}

/// Morphology with a (2r+1)² square, per RGB channel; alpha preserved.
/// op 0 erode, 1 dilate, 2 open, 3 close, 4 gradient (dilate − erode), 5 top-hat (src − open), 6 black-hat (close − src).
#[no_mangle]
pub unsafe extern "C" fn morph(s: *const u8, w: u32, h: u32, d: *mut u8, op: u32, radius: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h, r) = (w as usize, h as usize, radius as usize);
    match op {
        0 => minmax(s, w, h, d, r, false),
        1 => minmax(s, w, h, d, r, true),
        2 | 3 | 5 | 6 => {
            let first_max = op == 3 || op == 6;
            let mut t = vec![0u8; s.len()];
            minmax(s, w, h, &mut t, r, first_max);
            minmax(&t, w, h, d, r, !first_max);
            if op == 5 {
                for (o, &v) in d.iter_mut().zip(s) {
                    *o = v.saturating_sub(*o);
                }
            } else if op == 6 {
                for (o, &v) in d.iter_mut().zip(s) {
                    *o = o.saturating_sub(v);
                }
            }
        }
        _ => {
            let mut t = vec![0u8; s.len()];
            minmax(s, w, h, &mut t, r, false);
            minmax(s, w, h, d, r, true);
            for (o, &v) in d.iter_mut().zip(&t) {
                *o -= v;
            }
        }
    }
    for i in 0..w * h {
        d[i * 4 + 3] = s[i * 4 + 3];
    }
}
