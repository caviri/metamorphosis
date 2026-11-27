//! Point operations: tone, colour, thresholds, histogram equalisation, channel shuffles, compositing.
use crate::*;

#[no_mangle]
pub unsafe extern "C" fn grayscale(s: *const u8, w: u32, h: u32, d: *mut u8) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let y = clamp8(luma(i));
        o[0] = y;
        o[1] = y;
        o[2] = y;
        o[3] = i[3];
    }
}

#[no_mangle]
pub unsafe extern "C" fn invert(s: *const u8, w: u32, h: u32, d: *mut u8) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        o[0] = 255 - i[0];
        o[1] = 255 - i[1];
        o[2] = 255 - i[2];
        o[3] = i[3];
    }
}

/// luma ≥ t → white else black, alpha 255
#[no_mangle]
pub unsafe extern "C" fn threshold(s: *const u8, w: u32, h: u32, d: *mut u8, t: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let v = if luma(i) >= t { 255 } else { 0 };
        o[0] = v;
        o[1] = v;
        o[2] = v;
        o[3] = 255;
    }
}

pub(crate) fn otsu_hist(hist: &[u32; 256]) -> u32 {
    let total: f64 = hist.iter().map(|&v| v as f64).sum();
    let sum_all: f64 = hist.iter().enumerate().map(|(i, &v)| i as f64 * v as f64).sum();
    let (mut wb, mut sum_b, mut best, mut best_t) = (0f64, 0f64, -1f64, 0u32);
    for t in 0..256 {
        wb += hist[t] as f64;
        if wb == 0.0 {
            continue;
        }
        let wf = total - wb;
        if wf == 0.0 {
            break;
        }
        sum_b += t as f64 * hist[t] as f64;
        let mb = sum_b / wb;
        let mf = (sum_all - sum_b) / wf;
        let var = wb * wf * (mb - mf) * (mb - mf);
        if var > best {
            best = var;
            best_t = t as u32;
        }
    }
    best_t + 1 // classes are {≤T} and {>T}; return the first foreground level so `luma ≥ t` is foreground
}

/// Otsu threshold of the rounded Rec.709 luma. Returns t such that `luma ≥ t` is the bright class.
#[no_mangle]
pub unsafe extern "C" fn otsu(s: *const u8, w: u32, h: u32) -> u32 {
    let s = rs(s, w, h);
    let mut hist = [0u32; 256];
    for p in s.chunks_exact(4) {
        hist[clamp8(luma(p)) as usize] += 1;
    }
    otsu_hist(&hist).min(255)
}

/// Local threshold: white where luma > local mean − c. method 0 = box mean (integral image), 1 = gaussian (sigma = radius/2).
#[no_mangle]
pub unsafe extern "C" fn adaptive_threshold(s: *const u8, w: u32, h: u32, d: *mut u8, radius: u32, c: f32, method: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h, r) = (w as usize, h as usize, radius.max(1) as usize);
    let l = luma_plane(s);
    let mean: Vec<f32> = if method == 1 {
        let mut m = l.clone();
        let k = crate::filters::gauss_kernel(r as f32 / 2.0);
        crate::filters::blur_plane(&mut m, w, h, &k);
        m
    } else {
        // summed-area table in f64, window clipped at the borders
        let iw = w + 1;
        let mut sat = vec![0f64; iw * (h + 1)];
        for y in 0..h {
            let mut row = 0f64;
            for x in 0..w {
                row += l[y * w + x] as f64;
                sat[(y + 1) * iw + x + 1] = sat[y * iw + x + 1] + row;
            }
        }
        let mut m = vec![0f32; w * h];
        for y in 0..h {
            let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
            for x in 0..w {
                let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
                let sum = sat[y1 * iw + x1] - sat[y0 * iw + x1] - sat[y1 * iw + x0] + sat[y0 * iw + x0];
                m[y * w + x] = (sum / ((x1 - x0) * (y1 - y0)) as f64) as f32;
            }
        }
        m
    };
    for i in 0..w * h {
        let v = if l[i] > mean[i] - c { 255 } else { 0 };
        d[i * 4] = v;
        d[i * 4 + 1] = v;
        d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
    }
}

/// 4×5 row-major matrix on 0..1 values; the 5th column is an offset in 0..1 (SVG feColorMatrix).
#[no_mangle]
pub unsafe extern "C" fn color_matrix(s: *const u8, w: u32, h: u32, d: *mut u8, m: *const f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let m = core::slice::from_raw_parts(m, 20);
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let (r, g, b, a) = (i[0] as f32, i[1] as f32, i[2] as f32, i[3] as f32);
        for c in 0..4 {
            let k = &m[c * 5..c * 5 + 5];
            o[c] = clamp8(k[0] * r + k[1] * g + k[2] * b + k[3] * a + k[4] * 255.0);
        }
    }
}

/// gamma → contrast (about mid-gray) → brightness as one LUT, then saturation and hue rotation (SVG matrices, Rec.709 weights).
#[no_mangle]
pub unsafe extern "C" fn adjust(s: *const u8, w: u32, h: u32, d: *mut u8, brightness: f32, contrast: f32, gamma: f32, saturation: f32, hue_deg: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let mut lut = [0f32; 256];
    for (i, l) in lut.iter_mut().enumerate() {
        let mut v = i as f32 / 255.0;
        if gamma != 1.0 {
            v = v.powf(1.0 / gamma.max(1e-3));
        }
        v = (v - 0.5) * contrast + 0.5 + brightness;
        *l = v.clamp(0.0, 1.0) * 255.0;
    }
    let sat = saturation;
    let ms = [
        0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat,
        0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat,
        0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat,
    ];
    let (sn, cs) = hue_deg.to_radians().sin_cos();
    let mh = [
        0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
        0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
        0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
    ];
    let mut m = [0f32; 9];
    for r in 0..3 {
        for c in 0..3 {
            m[r * 3 + c] = (0..3).map(|k| mh[r * 3 + k] * ms[k * 3 + c]).sum();
        }
    }
    let ident = saturation == 1.0 && hue_deg == 0.0;
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let (r, g, b) = (lut[i[0] as usize], lut[i[1] as usize], lut[i[2] as usize]);
        if ident {
            o[0] = clamp8(r);
            o[1] = clamp8(g);
            o[2] = clamp8(b);
        } else {
            o[0] = clamp8(m[0] * r + m[1] * g + m[2] * b);
            o[1] = clamp8(m[3] * r + m[4] * g + m[5] * b);
            o[2] = clamp8(m[6] * r + m[7] * g + m[8] * b);
        }
        o[3] = i[3];
    }
}

fn eq_lut(hist: &[u32; 256]) -> [u8; 256] {
    let total: u64 = hist.iter().map(|&v| v as u64).sum();
    let mut lut = [0u8; 256];
    let cdf_min = hist.iter().copied().find(|&v| v > 0).unwrap_or(0) as u64;
    let denom = total.saturating_sub(cdf_min);
    let mut acc = 0u64;
    for i in 0..256 {
        acc += hist[i] as u64;
        lut[i] = if denom == 0 { i as u8 } else { clamp8(acc.saturating_sub(cdf_min) as f32 / denom as f32 * 255.0) };
    }
    lut
}

/// Global histogram equalisation. mode 0: equalise Rec.709 luma and shift RGB by the luma change (chroma kept); mode 1: each channel independently.
#[no_mangle]
pub unsafe extern "C" fn equalize(s: *const u8, w: u32, h: u32, d: *mut u8, mode: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    if mode == 1 {
        let mut hist = [[0u32; 256]; 3];
        for p in s.chunks_exact(4) {
            hist[0][p[0] as usize] += 1;
            hist[1][p[1] as usize] += 1;
            hist[2][p[2] as usize] += 1;
        }
        let luts = [eq_lut(&hist[0]), eq_lut(&hist[1]), eq_lut(&hist[2])];
        for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
            o[0] = luts[0][i[0] as usize];
            o[1] = luts[1][i[1] as usize];
            o[2] = luts[2][i[2] as usize];
            o[3] = i[3];
        }
        return;
    }
    let mut hist = [0u32; 256];
    for p in s.chunks_exact(4) {
        hist[clamp8(luma(p)) as usize] += 1;
    }
    let lut = eq_lut(&hist);
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let y = luma(i);
        let dy = lut[clamp8(y) as usize] as f32 - y;
        o[0] = clamp8(i[0] as f32 + dy);
        o[1] = clamp8(i[1] as f32 + dy);
        o[2] = clamp8(i[2] as f32 + dy);
        o[3] = i[3];
    }
}

/// CLAHE on Rec.709 luma: tx×ty tiles, clipped histograms (clip × uniform bin height), bilinear blending of the tile LUTs.
#[no_mangle]
pub unsafe extern "C" fn clahe(s: *const u8, w: u32, h: u32, d: *mut u8, tx: u32, ty: u32, clip: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let tx = (tx.max(1) as usize).min(w);
    let ty = (ty.max(1) as usize).min(h);
    let y8 = luma_u8(s);
    let mut luts = vec![0f32; tx * ty * 256];
    for j in 0..ty {
        let (y0, y1) = (j * h / ty, (j + 1) * h / ty);
        for i in 0..tx {
            let (x0, x1) = (i * w / tx, (i + 1) * w / tx);
            let mut hist = [0u32; 256];
            for y in y0..y1 {
                for &v in &y8[y * w + x0..y * w + x1] {
                    hist[v as usize] += 1;
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as u32;
            if clip > 0.0 {
                let limit = ((clip * n as f32 / 256.0) as u32).max(1);
                let mut excess = 0u32;
                for v in hist.iter_mut() {
                    if *v > limit {
                        excess += *v - limit;
                        *v = limit;
                    }
                }
                let (add, rem) = (excess / 256, (excess % 256) as usize);
                for (k, v) in hist.iter_mut().enumerate() {
                    *v += add;
                    // spread the remainder evenly over the range
                    if rem > 0 && (k * rem) / 256 != ((k + 1) * rem) / 256 {
                        *v += 1;
                    }
                }
            }
            let lut = &mut luts[(j * tx + i) * 256..(j * tx + i + 1) * 256];
            let mut acc = 0u32;
            for k in 0..256 {
                acc += hist[k];
                lut[k] = acc as f32 / n.max(1) as f32 * 255.0;
            }
        }
    }
    // per-column interpolation setup
    let mut xi = vec![(0usize, 0usize, 0f32); w];
    for (x, e) in xi.iter_mut().enumerate() {
        let f = (x as f32 + 0.5) * tx as f32 / w as f32 - 0.5;
        let i0 = f.floor();
        *e = (cl(i0 as isize, tx), cl(i0 as isize + 1, tx), f - i0);
    }
    for y in 0..h {
        let f = (y as f32 + 0.5) * ty as f32 / h as f32 - 0.5;
        let j0f = f.floor();
        let (j0, j1, ay) = (cl(j0f as isize, ty), cl(j0f as isize + 1, ty), f - j0f);
        for x in 0..w {
            let (i0, i1, ax) = xi[x];
            let v = y8[y * w + x] as usize;
            let a = luts[(j0 * tx + i0) * 256 + v];
            let b = luts[(j0 * tx + i1) * 256 + v];
            let c = luts[(j1 * tx + i0) * 256 + v];
            let e = luts[(j1 * tx + i1) * 256 + v];
            let ny = (a * (1.0 - ax) + b * ax) * (1.0 - ay) + (c * (1.0 - ax) + e * ax) * ay;
            let p = (y * w + x) * 4;
            let dy = ny - luma(&s[p..p + 4]);
            d[p] = clamp8(s[p] as f32 + dy);
            d[p + 1] = clamp8(s[p + 1] as f32 + dy);
            d[p + 2] = clamp8(s[p + 2] as f32 + dy);
            d[p + 3] = s[p + 3];
        }
    }
}

/// False colour: rounded luma indexes a 256×RGB lookup table. Alpha preserved.
#[no_mangle]
pub unsafe extern "C" fn colormap(s: *const u8, w: u32, h: u32, d: *mut u8, lut: *const u8) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let lut = core::slice::from_raw_parts(lut, 768);
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let y = clamp8(luma(i)) as usize * 3;
        o[0] = lut[y];
        o[1] = lut[y + 1];
        o[2] = lut[y + 2];
        o[3] = i[3];
    }
}

/// Channel shuffle. Each output channel takes source channel 0..3 (R,G,B,A), 4 = constant 0, 5 = constant 255, 6 = rounded luma.
#[no_mangle]
pub unsafe extern "C" fn permute(s: *const u8, w: u32, h: u32, d: *mut u8, m0: u32, m1: u32, m2: u32, m3: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let m = [m0, m1, m2, m3];
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        for c in 0..4 {
            o[c] = match m[c] {
                0..=3 => i[m[c] as usize],
                4 => 0,
                5 => 255,
                _ => clamp8(luma(i)),
            };
        }
    }
}

/// out[0]=min alpha, out[1]=max alpha, out[2]=pixels with alpha<255, out[3]=1 if every pixel has r==g==b, out[4]=pixels with alpha==0
#[no_mangle]
pub unsafe extern "C" fn alpha_info(s: *const u8, w: u32, h: u32, out: *mut u32) {
    let s = rs(s, w, h);
    let out = core::slice::from_raw_parts_mut(out, 5);
    let (mut mn, mut mx, mut cnt, mut zero, mut gray) = (255u8, 0u8, 0u32, 0u32, true);
    for p in s.chunks_exact(4) {
        mn = mn.min(p[3]);
        mx = mx.max(p[3]);
        cnt += (p[3] < 255) as u32;
        zero += (p[3] == 0) as u32;
        gray &= p[0] == p[1] && p[1] == p[2];
    }
    out[0] = mn as u32;
    out[1] = mx as u32;
    out[2] = cnt;
    out[3] = gray as u32;
    out[4] = zero;
}

#[inline(always)]
fn blend(mode: u32, b: f32, s: f32) -> f32 {
    match mode {
        1 => b * s,                                                        // multiply
        2 => b + s - b * s,                                                // screen
        3 => if b <= 0.5 { 2.0 * b * s } else { 1.0 - 2.0 * (1.0 - b) * (1.0 - s) }, // overlay
        4 => b.min(s),                                                     // darken
        5 => b.max(s),                                                     // lighten
        6 => if b == 0.0 { 0.0 } else if s >= 1.0 { 1.0 } else { (b / (1.0 - s)).min(1.0) }, // color-dodge
        7 => if b >= 1.0 { 1.0 } else if s <= 0.0 { 0.0 } else { 1.0 - ((1.0 - b) / s).min(1.0) }, // color-burn
        8 => if s <= 0.5 { 2.0 * b * s } else { 1.0 - 2.0 * (1.0 - b) * (1.0 - s) }, // hard-light
        9 => {
            // soft-light (W3C compositing spec)
            if s <= 0.5 {
                b - (1.0 - 2.0 * s) * b * (1.0 - b)
            } else {
                let dd = if b <= 0.25 { ((16.0 * b - 12.0) * b + 4.0) * b } else { b.sqrt() };
                b + (2.0 * s - 1.0) * (dd - b)
            }
        }
        10 => (b - s).abs(),          // difference
        11 => b + s - 2.0 * b * s,    // exclusion
        12 => (b + s).min(1.0),       // add (linear dodge)
        13 => (b - s).max(0.0),       // subtract
        _ => s,                       // normal
    }
}

/// Composite `top` over `base` at (x,y) with a blend mode and opacity (W3C compositing: source-over with separable blend).
/// dst has the base's size.
#[no_mangle]
pub unsafe extern "C" fn composite(base: *const u8, bw: u32, bh: u32, top: *const u8, tw: u32, th: u32, d: *mut u8, x: i32, y: i32, opacity: f32, mode: u32) {
    let (b, t, d) = (rs(base, bw, bh), rs(top, tw, th), ws(d, bw, bh));
    d.copy_from_slice(b);
    let (bw, bh, tw, th) = (bw as i32, bh as i32, tw as i32, th as i32);
    for ty in 0..th {
        let by = ty + y;
        if by < 0 || by >= bh {
            continue;
        }
        for tx in (-x).max(0)..tw.min(bw - x) {
            let bx = tx + x;
            let si = ((ty * tw + tx) * 4) as usize;
            let di = ((by * bw + bx) * 4) as usize;
            let sa = t[si + 3] as f32 / 255.0 * opacity;
            if sa <= 0.0 {
                continue;
            }
            let ba = b[di + 3] as f32 / 255.0;
            let oa = sa + ba * (1.0 - sa);
            for c in 0..3 {
                let cs = t[si + c] as f32 / 255.0;
                let cb = b[di + c] as f32 / 255.0;
                let mixed = (1.0 - ba) * cs + ba * blend(mode, cb, cs);
                let co = sa * mixed + (1.0 - sa) * ba * cb;
                d[di + c] = clamp8(co / oa * 255.0);
            }
            d[di + 3] = clamp8(oa * 255.0);
        }
    }
}

/// Draw src into dst at (x,y), clipped, in place. over = 0: raw copy; over != 0: alpha-over (source-over) blending.
#[no_mangle]
pub unsafe extern "C" fn blit(s: *const u8, sw: u32, sh: u32, d: *mut u8, dw: u32, dh: u32, x: i32, y: i32, over: u32) {
    let (s, d) = (rs(s, sw, sh), ws(d, dw, dh));
    let (sw, sh, dw, dh) = (sw as i32, sh as i32, dw as i32, dh as i32);
    let x0 = (-x).max(0);
    let x1 = sw.min(dw - x);
    if x1 <= x0 {
        return;
    }
    for sy in 0..sh {
        let dy = sy + y;
        if dy < 0 || dy >= dh {
            continue;
        }
        let a = ((sy * sw + x0) * 4) as usize;
        let n = ((x1 - x0) * 4) as usize;
        let b = ((dy * dw + x0 + x) * 4) as usize;
        if over == 0 {
            d[b..b + n].copy_from_slice(&s[a..a + n]);
            continue;
        }
        for (o, i) in d[b..b + n].chunks_exact_mut(4).zip(s[a..a + n].chunks_exact(4)) {
            if i[3] == 255 {
                o.copy_from_slice(i);
                continue;
            }
            let sa = i[3] as f32 / 255.0;
            let ba = o[3] as f32 / 255.0;
            let oa = sa + ba * (1.0 - sa);
            if oa <= 0.0 {
                continue;
            }
            for c in 0..3 {
                o[c] = clamp8((i[c] as f32 * sa + o[c] as f32 * ba * (1.0 - sa)) / oa);
            }
            o[3] = clamp8(oa * 255.0);
        }
    }
}

/// Fill a buffer with one RGBA colour.
#[no_mangle]
pub unsafe extern "C" fn fill(d: *mut u8, w: u32, h: u32, r: u32, g: u32, b: u32, a: u32) {
    let d = ws(d, w, h);
    for o in d.chunks_exact_mut(4) {
        o[0] = r as u8;
        o[1] = g as u8;
        o[2] = b as u8;
        o[3] = a as u8;
    }
}

/// Flatten transparency onto a solid colour (used before JPEG encoding). Alpha becomes 255.
#[no_mangle]
pub unsafe extern "C" fn flatten(s: *const u8, w: u32, h: u32, d: *mut u8, r: u32, g: u32, b: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let bg = [r as f32, g as f32, b as f32];
    for (o, i) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let a = i[3] as f32 / 255.0;
        for c in 0..3 {
            o[c] = clamp8(i[c] as f32 * a + bg[c] * (1.0 - a));
        }
        o[3] = 255;
    }
}
