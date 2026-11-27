//! Geometry: resampling, crop, pad, flips, right-angle and arbitrary rotation.
use crate::*;

struct Contrib {
    taps: usize,
    idx: Vec<u32>, // n·taps source indices (clamped)
    wt: Vec<f32>,  // n·taps weights, each row sums to 1
}

#[inline]
fn kernel_fn(kind: u32, t: f64) -> f64 {
    let a = t.abs();
    match kind {
        3 => {
            // Catmull-Rom cubic (a = −0.5)
            if a < 1.0 {
                (1.5 * a - 2.5) * a * a + 1.0
            } else if a < 2.0 {
                ((-0.5 * a + 2.5) * a - 4.0) * a + 2.0
            } else {
                0.0
            }
        }
        4 => {
            if a < 1e-9 {
                1.0
            } else if a < 3.0 {
                let p = core::f64::consts::PI * a;
                3.0 * p.sin() * (p / 3.0).sin() / (p * p)
            } else {
                0.0
            }
        }
        _ => (1.0 - a).max(0.0), // triangle
    }
}

/// kind 2 = area (exact box average when shrinking, nearest when enlarging), 3 = Catmull-Rom, 4 = Lanczos-3, 5 = triangle.
/// When shrinking, the filter support is stretched by the scale factor so every source pixel contributes (no aliasing).
fn contribs(sn: usize, dn: usize, kind: u32) -> Contrib {
    let scale = sn as f64 / dn as f64;
    let mut starts: Vec<(isize, Vec<f64>)> = Vec::with_capacity(dn);
    let mut taps = 1usize;
    for x in 0..dn {
        let (i0, ws): (isize, Vec<f64>) = if kind == 2 {
            if scale <= 1.0 {
                ((((x as f64 + 0.5) * scale).floor()) as isize, vec![1.0])
            } else {
                let (lo, hi) = (x as f64 * scale, (x as f64 + 1.0) * scale);
                let i0 = lo.floor() as isize;
                let i1 = (hi.ceil() as isize).min(sn as isize).max(i0 + 1);
                (i0, (i0..i1).map(|i| ((i as f64 + 1.0).min(hi) - (i as f64).max(lo)).max(0.0)).collect())
            }
        } else {
            let fs = scale.max(1.0);
            let base = match kind {
                3 => 2.0,
                4 => 3.0,
                _ => 1.0,
            };
            let sup = base * fs;
            let c = (x as f64 + 0.5) * scale;
            let i0 = (c - sup).floor() as isize;
            let i1 = (c + sup).ceil() as isize;
            (i0, (i0..i1).map(|i| kernel_fn(kind, (i as f64 + 0.5 - c) / fs)).collect())
        };
        taps = taps.max(ws.len());
        starts.push((i0, ws));
    }
    let mut idx = vec![0u32; dn * taps];
    let mut wt = vec![0f32; dn * taps];
    for (x, (i0, ws)) in starts.iter().enumerate() {
        let sum: f64 = ws.iter().sum();
        let sum = if sum.abs() < 1e-12 { 1.0 } else { sum };
        for t in 0..taps {
            if t < ws.len() {
                idx[x * taps + t] = cl(i0 + t as isize, sn) as u32;
                wt[x * taps + t] = (ws[t] / sum) as f32;
            } else {
                idx[x * taps + t] = cl(*i0, sn) as u32; // zero weight
            }
        }
    }
    Contrib { taps, idx, wt }
}

/// Separable resample with alpha-premultiplied accumulation. kind as in `contribs`.
pub(crate) fn resize_sep(s: &[u8], sw: usize, sh: usize, d: &mut [u8], dw: usize, dh: usize, kind: u32) {
    let cx = contribs(sw, dw, kind);
    let cy = contribs(sh, dh, kind);
    let rw = dw * 4;
    // horizontal pass → premultiplied f32, dw × sh
    let mut tmp = vec![0f32; rw * sh];
    for y in 0..sh {
        let row = &s[y * sw * 4..(y + 1) * sw * 4];
        let out = &mut tmp[y * rw..(y + 1) * rw];
        for x in 0..dw {
            let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
            for t in 0..cx.taps {
                let i = cx.idx[x * cx.taps + t] as usize * 4;
                let wa = cx.wt[x * cx.taps + t] * row[i + 3] as f32 * (1.0 / 255.0);
                r += wa * row[i] as f32;
                g += wa * row[i + 1] as f32;
                b += wa * row[i + 2] as f32;
                a += wa;
            }
            out[x * 4] = r;
            out[x * 4 + 1] = g;
            out[x * 4 + 2] = b;
            out[x * 4 + 3] = a;
        }
    }
    let mut acc = vec![0f32; rw];
    for y in 0..dh {
        acc.fill(0.0);
        for t in 0..cy.taps {
            let wv = cy.wt[y * cy.taps + t];
            if wv == 0.0 {
                continue;
            }
            let sy = cy.idx[y * cy.taps + t] as usize;
            let row = &tmp[sy * rw..(sy + 1) * rw];
            for (a, &v) in acc.iter_mut().zip(row) {
                *a += v * wv;
            }
        }
        let o = &mut d[y * rw..(y + 1) * rw];
        for x in 0..dw {
            let a = acc[x * 4 + 3];
            if a > 1e-6 {
                let inv = 1.0 / a;
                o[x * 4] = clamp8(acc[x * 4] * inv);
                o[x * 4 + 1] = clamp8(acc[x * 4 + 1] * inv);
                o[x * 4 + 2] = clamp8(acc[x * 4 + 2] * inv);
                o[x * 4 + 3] = clamp8(a * 255.0);
            } else {
                o[x * 4..x * 4 + 4].copy_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
}

/// filter 0 nearest, 1 bilinear — both point-sampled with pixel-centre alignment (src = (dst+0.5)·scale − 0.5), straight alpha,
/// identical to the WebGPU kernel; 2 area, 3 bicubic (Catmull-Rom), 4 lanczos3, 5 triangle — antialiased, premultiplied alpha.
#[no_mangle]
pub unsafe extern "C" fn resize(s: *const u8, sw: u32, sh: u32, d: *mut u8, dw: u32, dh: u32, filter: u32) {
    let (s, d) = (rs(s, sw, sh), ws(d, dw, dh));
    let (sw, sh, dw, dh) = (sw as usize, sh as usize, dw as usize, dh as usize);
    if filter >= 2 {
        return resize_sep(s, sw, sh, d, dw, dh, filter);
    }
    let (kx, ky) = (sw as f32 / dw as f32, sh as f32 / dh as f32);
    if filter == 0 {
        for y in 0..dh {
            let sy = cl(((y as f32 + 0.5) * ky).floor() as isize, sh);
            for x in 0..dw {
                let sx = cl(((x as f32 + 0.5) * kx).floor() as isize, sw);
                let (a, b) = ((sy * sw + sx) * 4, (y * dw + x) * 4);
                d[b..b + 4].copy_from_slice(&s[a..a + 4]);
            }
        }
        return;
    }
    let mut xs = vec![(0usize, 0usize, 0f32); dw];
    for (x, e) in xs.iter_mut().enumerate() {
        let f = (x as f32 + 0.5) * kx - 0.5;
        let i = f.floor();
        *e = (cl(i as isize, sw) * 4, cl(i as isize + 1, sw) * 4, f - i);
    }
    for y in 0..dh {
        let f = (y as f32 + 0.5) * ky - 0.5;
        let j = f.floor();
        let (r0, r1, ty) = (cl(j as isize, sh) * sw * 4, cl(j as isize + 1, sh) * sw * 4, f - j);
        let o = &mut d[y * dw * 4..(y + 1) * dw * 4];
        for x in 0..dw {
            let (x0, x1, tx) = xs[x];
            for c in 0..4 {
                let top = s[r0 + x0 + c] as f32 * (1.0 - tx) + s[r0 + x1 + c] as f32 * tx;
                let bot = s[r1 + x0 + c] as f32 * (1.0 - tx) + s[r1 + x1 + c] as f32 * tx;
                o[x * 4 + c] = clamp8(top * (1.0 - ty) + bot * ty);
            }
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn crop(s: *const u8, sw: u32, sh: u32, d: *mut u8, x: u32, y: u32, w: u32, h: u32) {
    let (s, d) = (rs(s, sw, sh), ws(d, w, h));
    let (sw, x, y, w, h) = (sw as usize, x as usize, y as usize, w as usize, h as usize);
    for r in 0..h {
        let a = ((y + r) * sw + x) * 4;
        d[r * w * 4..(r + 1) * w * 4].copy_from_slice(&s[a..a + w * 4]);
    }
}

/// Place src at (left, top) inside a dw×dh canvas. mode 0 constant colour, 1 edge replicate, 2 reflect (mirror without repeating the edge).
#[no_mangle]
pub unsafe extern "C" fn pad(s: *const u8, sw: u32, sh: u32, d: *mut u8, dw: u32, dh: u32, left: i32, top: i32, mode: u32, rgba: u32) {
    let (s, d) = (rs(s, sw, sh), ws(d, dw, dh));
    let (sw, sh, dw, dh) = (sw as isize, sh as isize, dw as isize, dh as isize);
    let col = [(rgba >> 24) as u8, (rgba >> 16) as u8, (rgba >> 8) as u8, rgba as u8];
    let refl = |i: isize, n: isize| -> isize {
        if n == 1 {
            return 0;
        }
        let p = 2 * (n - 1);
        let m = i.rem_euclid(p);
        if m < n {
            m
        } else {
            p - m
        }
    };
    for y in 0..dh {
        let sy = y - top as isize;
        for x in 0..dw {
            let sx = x - left as isize;
            let o = ((y * dw + x) * 4) as usize;
            let inside = sx >= 0 && sy >= 0 && sx < sw && sy < sh;
            if !inside && mode == 0 {
                d[o..o + 4].copy_from_slice(&col);
                continue;
            }
            let (ux, uy) = if inside {
                (sx, sy)
            } else if mode == 1 {
                (cl(sx, sw as usize) as isize, cl(sy, sh as usize) as isize)
            } else {
                (refl(sx, sw), refl(sy, sh))
            };
            let i = ((uy * sw + ux) * 4) as usize;
            d[o..o + 4].copy_from_slice(&s[i..i + 4]);
        }
    }
}

/// mode 0 horizontal (mirror left↔right), 1 vertical (top↔bottom), 2 both.
#[no_mangle]
pub unsafe extern "C" fn flip(s: *const u8, w: u32, h: u32, d: *mut u8, mode: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    for y in 0..h {
        let sy = if mode >= 1 { h - 1 - y } else { y };
        for x in 0..w {
            let sx = if mode != 1 { w - 1 - x } else { x };
            let (a, b) = ((sy * w + sx) * 4, (y * w + x) * 4);
            d[b..b + 4].copy_from_slice(&s[a..a + 4]);
        }
    }
}

/// Lossless clockwise rotation by k·90°. dst is h×w for odd k.
#[no_mangle]
pub unsafe extern "C" fn rot90(s: *const u8, w: u32, h: u32, d: *mut u8, k: u32) {
    let s = rs(s, w, h);
    let (w, h) = (w as usize, h as usize);
    let d = core::slice::from_raw_parts_mut(d, w * h * 4);
    let k = k % 4;
    let (dw, dh) = if k % 2 == 1 { (h, w) } else { (w, h) };
    for y in 0..dh {
        for x in 0..dw {
            let (sx, sy) = match k {
                1 => (y, h - 1 - x),
                2 => (w - 1 - x, h - 1 - y),
                3 => (w - 1 - y, x),
                _ => (x, y),
            };
            let (a, b) = ((sy * w + sx) * 4, (y * dw + x) * 4);
            d[b..b + 4].copy_from_slice(&s[a..a + 4]);
        }
    }
}

/// premultiplied sample (rgb·a/255, a) with transparent black outside the image
#[inline(always)]
fn pm(s: &[u8], sw: isize, sh: isize, x: isize, y: isize) -> [f32; 4] {
    if x < 0 || y < 0 || x >= sw || y >= sh {
        return [0.0; 4];
    }
    let i = ((y * sw + x) * 4) as usize;
    let a = s[i + 3] as f32;
    let k = a * (1.0 / 255.0);
    [s[i] as f32 * k, s[i + 1] as f32 * k, s[i + 2] as f32 * k, a]
}

/// Rotate clockwise by `angle` degrees about the centre into a dw×dh canvas (inverse mapping).
/// filter 0 nearest, 1 bilinear, 3 bicubic (Catmull-Rom). Uncovered area is filled with `rgba`; edges are antialiased against it.
#[no_mangle]
pub unsafe extern "C" fn rotate(s: *const u8, sw: u32, sh: u32, d: *mut u8, dw: u32, dh: u32, angle: f32, filter: u32, rgba: u32) {
    let (s, d) = (rs(s, sw, sh), ws(d, dw, dh));
    let (swi, shi) = (sw as isize, sh as isize);
    let (dw, dh) = (dw as usize, dh as usize);
    let (sn, cs) = (angle as f64).to_radians().sin_cos();
    let (sn, cs) = (sn as f32, cs as f32);
    let bg_a = (rgba & 255) as f32;
    let bg = [(rgba >> 24) as u8 as f32 * bg_a / 255.0, (rgba >> 16) as u8 as f32 * bg_a / 255.0, (rgba >> 8) as u8 as f32 * bg_a / 255.0, bg_a];
    let (cxs, cys) = (sw as f32 / 2.0, sh as f32 / 2.0);
    let (cxd, cyd) = (dw as f32 / 2.0, dh as f32 / 2.0);
    let cub = |t: f32| -> [f32; 4] {
        let k = |a: f32| -> f32 {
            let a = a.abs();
            if a < 1.0 {
                (1.5 * a - 2.5) * a * a + 1.0
            } else if a < 2.0 {
                ((-0.5 * a + 2.5) * a - 4.0) * a + 2.0
            } else {
                0.0
            }
        };
        [k(t + 1.0), k(t), k(1.0 - t), k(2.0 - t)]
    };
    for y in 0..dh {
        let ry = y as f32 + 0.5 - cyd;
        for x in 0..dw {
            let rx = x as f32 + 0.5 - cxd;
            let fx = cs * rx + sn * ry + cxs - 0.5;
            let fy = -sn * rx + cs * ry + cys - 0.5;
            let mut p = [0f32; 4];
            if fx > -2.0 && fy > -2.0 && fx < sw as f32 + 1.0 && fy < sh as f32 + 1.0 {
                match filter {
                    0 => p = pm(s, swi, shi, (fx + 0.5).floor() as isize, (fy + 0.5).floor() as isize),
                    1 => {
                        let (x0, y0) = (fx.floor(), fy.floor());
                        let (tx, ty) = (fx - x0, fy - y0);
                        let (x0, y0) = (x0 as isize, y0 as isize);
                        let (a, b, c, e) = (pm(s, swi, shi, x0, y0), pm(s, swi, shi, x0 + 1, y0), pm(s, swi, shi, x0, y0 + 1), pm(s, swi, shi, x0 + 1, y0 + 1));
                        for k in 0..4 {
                            p[k] = (a[k] * (1.0 - tx) + b[k] * tx) * (1.0 - ty) + (c[k] * (1.0 - tx) + e[k] * tx) * ty;
                        }
                    }
                    _ => {
                        let (x0, y0) = (fx.floor(), fy.floor());
                        let (wx, wy) = (cub(fx - x0), cub(fy - y0));
                        let (x0, y0) = (x0 as isize, y0 as isize);
                        for j in 0..4 {
                            for i in 0..4 {
                                let q = pm(s, swi, shi, x0 + i as isize - 1, y0 + j as isize - 1);
                                let wgt = wx[i] * wy[j];
                                for k in 0..4 {
                                    p[k] += q[k] * wgt;
                                }
                            }
                        }
                        p[3] = p[3].clamp(0.0, 255.0);
                    }
                }
            }
            // source-over onto the background, both premultiplied
            let ia = 1.0 - p[3] / 255.0;
            let a = p[3] + bg[3] * ia;
            let o = (y * dw + x) * 4;
            if a > 1e-4 {
                let k = 255.0 / a;
                d[o] = clamp8((p[0] + bg[0] * ia) * k);
                d[o + 1] = clamp8((p[1] + bg[1] * ia) * k);
                d[o + 2] = clamp8((p[2] + bg[2] * ia) * k);
                d[o + 3] = clamp8(a);
            } else {
                d[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
}
