//! Dithering and quantisation: error diffusion, ordered thresholds, blue noise (void-and-cluster), palette mapping,
//! median-cut palettes and rotated-screen halftones.
use crate::*;

type Tap = (i32, i32, f32);
const FS: &[Tap] = &[(1, 0, 7.0), (-1, 1, 3.0), (0, 1, 5.0), (1, 1, 1.0)];
const ATKINSON: &[Tap] = &[(1, 0, 1.0), (2, 0, 1.0), (-1, 1, 1.0), (0, 1, 1.0), (1, 1, 1.0), (0, 2, 1.0)];
const JJN: &[Tap] = &[(1, 0, 7.0), (2, 0, 5.0), (-2, 1, 3.0), (-1, 1, 5.0), (0, 1, 7.0), (1, 1, 5.0), (2, 1, 3.0), (-2, 2, 1.0), (-1, 2, 3.0), (0, 2, 5.0), (1, 2, 3.0), (2, 2, 1.0)];
const STUCKI: &[Tap] = &[(1, 0, 8.0), (2, 0, 4.0), (-2, 1, 2.0), (-1, 1, 4.0), (0, 1, 8.0), (1, 1, 4.0), (2, 1, 2.0), (-2, 2, 1.0), (-1, 2, 2.0), (0, 2, 4.0), (1, 2, 2.0), (2, 2, 1.0)];
const BURKES: &[Tap] = &[(1, 0, 8.0), (2, 0, 4.0), (-2, 1, 2.0), (-1, 1, 4.0), (0, 1, 8.0), (1, 1, 4.0), (2, 1, 2.0)];
const SIERRA: &[Tap] = &[(1, 0, 5.0), (2, 0, 3.0), (-2, 1, 2.0), (-1, 1, 4.0), (0, 1, 5.0), (1, 1, 4.0), (2, 1, 2.0), (-1, 2, 2.0), (0, 2, 3.0), (1, 2, 2.0)];
const SIERRA2: &[Tap] = &[(1, 0, 4.0), (2, 0, 3.0), (-2, 1, 1.0), (-1, 1, 2.0), (0, 1, 3.0), (1, 1, 2.0), (2, 1, 1.0)];
const SIERRA_LITE: &[Tap] = &[(1, 0, 2.0), (-1, 1, 1.0), (0, 1, 1.0)];

/// (taps, divisor). Atkinson deliberately diffuses only 6/8 of the error.
fn kern(method: u32) -> (&'static [Tap], f32) {
    match method {
        1 => (ATKINSON, 8.0),
        2 => (JJN, 48.0),
        3 => (STUCKI, 42.0),
        4 => (BURKES, 32.0),
        5 => (SIERRA, 32.0),
        6 => (SIERRA2, 16.0),
        7 => (SIERRA_LITE, 4.0),
        _ => (FS, 16.0),
    }
}

/// Generic error diffusion over RGB with a caller-supplied quantiser. `clamp` limits value+error to 0..255 before quantising
/// (needed for sparse palettes, where unbounded error otherwise smears).
fn diffuse<F: FnMut([f32; 3]) -> [u8; 3]>(s: &[u8], w: usize, h: usize, d: &mut [u8], method: u32, serp: bool, strength: f32, mono: bool, clamp: bool, mut q: F) {
    let (k, div) = kern(method);
    let pw = w + 4;
    let mut err = vec![0f32; 3 * pw * 3];
    for y in 0..h {
        let rev = serp && (y & 1) == 1;
        for xi in 0..w {
            let x = if rev { w - 1 - xi } else { xi };
            let i = (y * w + x) * 4;
            let mut v = if mono {
                let l = luma(&s[i..i + 4]);
                [l, l, l]
            } else {
                [s[i] as f32, s[i + 1] as f32, s[i + 2] as f32]
            };
            let e0 = (x + 2) * 3;
            for c in 0..3 {
                v[c] += err[e0 + c];
                if clamp {
                    v[c] = v[c].clamp(0.0, 255.0);
                }
            }
            let o = q(v);
            d[i] = o[0];
            d[i + 1] = o[1];
            d[i + 2] = o[2];
            d[i + 3] = s[i + 3];
            for c in 0..3 {
                let e = (v[c] - o[c] as f32) * strength / div;
                if e != 0.0 {
                    for &(dx, dy, wt) in k {
                        let dx = if rev { -dx } else { dx };
                        let xx = (x as i32 + 2 + dx) as usize;
                        err[(dy as usize * pw + xx) * 3 + c] += e * wt;
                    }
                }
            }
        }
        err.copy_within(pw * 3.., 0);
        let l = err.len();
        err[l - pw * 3..].fill(0.0);
    }
}

#[inline(always)]
fn quant_level(v: f32, l1: f32) -> u8 {
    clamp8(((v * (1.0 / 255.0)).clamp(0.0, 1.0) * l1 + 0.5).floor() / l1 * 255.0)
}

/// Error-diffusion dither to `levels` evenly spaced values per channel (2 = 1 bit per channel; with mono → pure black/white).
/// method 0 floyd-steinberg, 1 atkinson, 2 jarvis-judice-ninke, 3 stucki, 4 burkes, 5 sierra, 6 sierra two-row, 7 sierra-lite.
#[no_mangle]
pub unsafe extern "C" fn dither_ed(s: *const u8, w: u32, h: u32, d: *mut u8, method: u32, levels: u32, serpentine: u32, mono: u32, strength: f32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let l1 = (levels.max(2) - 1) as f32;
    diffuse(s, w as usize, h as usize, d, method, serpentine != 0, strength, mono != 0, false, |v| [quant_level(v[0], l1), quant_level(v[1], l1), quant_level(v[2], l1)]);
}

/// Ordered (threshold-matrix) dither. mat: mw×mh thresholds in (−0.5, 0.5); null → white noise from `seed`.
/// out = round(clamp(v/255 + thr·strength/(levels−1), 0, 1)·(levels−1))/(levels−1)·255. mono: applied to luma, written as gray.
#[no_mangle]
pub unsafe extern "C" fn dither_ordered(s: *const u8, w: u32, h: u32, d: *mut u8, mat: *const f32, mw: u32, mh: u32, levels: u32, mono: u32, strength: f32, seed: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h, mw, mh) = (w as usize, h as usize, mw.max(1) as usize, mh.max(1) as usize);
    let l1 = (levels.max(2) - 1) as f32;
    let mat: &[f32] = if mat.is_null() { &[] } else { core::slice::from_raw_parts(mat, mw * mh) };
    let mut rng = Rng::new(seed);
    let k = strength / l1;
    let q = |v: f32, t: f32| -> u8 { clamp8(((v * (1.0 / 255.0) + t).clamp(0.0, 1.0) * l1 + 0.5).floor() / l1 * 255.0) };
    for y in 0..h {
        let mrow = if mat.is_empty() { &[][..] } else { &mat[(y % mh) * mw..(y % mh + 1) * mw] };
        for x in 0..w {
            let t = if mat.is_empty() { rng.f() - 0.5 } else { mrow[x % mw] } * k;
            let i = (y * w + x) * 4;
            if mono != 0 {
                let g = q(luma(&s[i..i + 4]), t);
                d[i] = g;
                d[i + 1] = g;
                d[i + 2] = g;
            } else {
                d[i] = q(s[i] as f32, t);
                d[i + 1] = q(s[i + 1] as f32, t);
                d[i + 2] = q(s[i + 2] as f32, t);
            }
            d[i + 3] = s[i + 3];
        }
    }
}

/// Blue-noise threshold tile by void-and-cluster (Ulichney 1993), toroidal gaussian energy σ = 1.9.
/// out: f32[n·n] thresholds (rank + 0.5)/n² − 0.5.
#[no_mangle]
pub unsafe extern "C" fn blue_noise(out: *mut f32, n: u32, seed: u32) {
    let n = n as usize;
    let nn = n * n;
    let out = core::slice::from_raw_parts_mut(out, nn);
    let sigma = 1.9f32;
    // toroidal gaussian footprint centred on (0,0)
    let mut g = vec![0f32; nn];
    for y in 0..n {
        let dy = y.min(n - y) as f32;
        for x in 0..n {
            let dx = x.min(n - x) as f32;
            g[y * n + x] = (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp();
        }
    }
    let splat = |e: &mut [f32], p: usize, sign: f32| {
        let (px, py) = (p % n, p / n);
        for y in 0..n {
            let gy = (y + n - py) % n;
            let (erow, grow) = (&mut e[y * n..(y + 1) * n], &g[gy * n..(gy + 1) * n]);
            // rotate the footprint row by px
            let (a, b) = erow.split_at_mut(px);
            for (ev, gv) in b.iter_mut().zip(&grow[..n - px]) {
                *ev += sign * gv;
            }
            for (ev, gv) in a.iter_mut().zip(&grow[n - px..]) {
                *ev += sign * gv;
            }
        }
    };
    let extreme = |e: &[f32], bits: &[bool], want: bool, largest: bool| -> usize {
        let (mut bi, mut bv) = (usize::MAX, if largest { f32::MIN } else { f32::MAX });
        for i in 0..nn {
            if bits[i] == want && ((largest && e[i] > bv) || (!largest && e[i] < bv)) {
                bv = e[i];
                bi = i;
            }
        }
        bi
    };
    let mut rng = Rng::new(seed);
    let mut bits = vec![false; nn];
    let mut energy = vec![0f32; nn];
    let ones0 = (nn / 10).max(1);
    let mut placed = 0;
    while placed < ones0 {
        let p = rng.next() as usize % nn;
        if !bits[p] {
            bits[p] = true;
            splat(&mut energy, p, 1.0);
            placed += 1;
        }
    }
    // relax the seed pattern: move the tightest cluster into the largest void until stable
    for _ in 0..nn * 4 {
        let c = extreme(&energy, &bits, true, true);
        bits[c] = false;
        splat(&mut energy, c, -1.0);
        let v = extreme(&energy, &bits, false, false);
        bits[v] = true;
        splat(&mut energy, v, 1.0);
        if v == c {
            break;
        }
    }
    let mut rank = vec![0u32; nn];
    // phase 1: peel the seed pattern, tightest cluster first → ranks ones0−1 … 0
    {
        let (mut b, mut e) = (bits.clone(), energy.clone());
        for r in (0..ones0).rev() {
            let c = extreme(&e, &b, true, true);
            b[c] = false;
            splat(&mut e, c, -1.0);
            rank[c] = r as u32;
        }
    }
    // phases 2+3: fill the largest void each time → ranks ones0 … n²−1
    for r in ones0..nn {
        let v = extreme(&energy, &bits, false, false);
        bits[v] = true;
        splat(&mut energy, v, 1.0);
        rank[v] = r as u32;
    }
    for i in 0..nn {
        out[i] = (rank[i] as f32 + 0.5) / nn as f32 - 0.5;
    }
}

#[inline(always)]
fn nearest(pal: &[[f32; 3]], v: &[f32; 3]) -> usize {
    let (mut best, mut bd) = (0usize, f32::MAX);
    for (i, p) in pal.iter().enumerate() {
        let (a, b, c) = (v[0] - p[0], v[1] - p[1], v[2] - p[2]);
        let dist = a * a + b * b + c * c;
        if dist < bd {
            bd = dist;
            best = i;
        }
    }
    best
}

/// Map every pixel to the nearest palette colour (Euclidean distance in RGB), optionally dithered.
/// pal: u8[k·3]. method −1 none; 0..7 error diffusion (as dither_ed); 100 ordered with the threshold matrix `mat`
/// (null → white noise): the threshold is scaled by `spread` (RGB units) and added before the nearest-colour search.
/// counts: u32[k] receives how many pixels took each palette entry.
#[no_mangle]
pub unsafe extern "C" fn dither_palette(s: *const u8, w: u32, h: u32, d: *mut u8, pal: *const u8, k: u32, method: i32, serpentine: u32, strength: f32, mat: *const f32, mw: u32, mh: u32, spread: f32, seed: u32, counts: *mut u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let palb = core::slice::from_raw_parts(pal, k as usize * 3);
    let pal: Vec<[f32; 3]> = palb.chunks_exact(3).map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    let counts = core::slice::from_raw_parts_mut(counts, k as usize);
    counts.fill(0);
    if (0..100).contains(&method) {
        diffuse(s, w, h, d, method as u32, serpentine != 0, strength, false, true, |v| {
            let i = nearest(&pal, &v);
            counts[i] += 1;
            [palb[i * 3], palb[i * 3 + 1], palb[i * 3 + 2]]
        });
        return;
    }
    let (mw, mh) = (mw.max(1) as usize, mh.max(1) as usize);
    let mat: &[f32] = if mat.is_null() { &[] } else { core::slice::from_raw_parts(mat, mw * mh) };
    let mut rng = Rng::new(seed);
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let t = if method < 0 {
                0.0
            } else if mat.is_empty() {
                (rng.f() - 0.5) * spread * strength
            } else {
                mat[(y % mh) * mw + x % mw] * spread * strength
            };
            let v = [s[i] as f32 + t, s[i + 1] as f32 + t, s[i + 2] as f32 + t];
            let j = nearest(&pal, &v);
            counts[j] += 1;
            d[i] = palb[j * 3];
            d[i + 1] = palb[j * 3 + 1];
            d[i + 2] = palb[j * 3 + 2];
            d[i + 3] = s[i + 3];
        }
    }
}

/// Median-cut palette (Heckbert 1982) over a 5-bit-per-channel histogram that also tracks exact colour sums, so each
/// palette entry is the true mean of its box. Boxes are split at the population median of their longest axis; the box to split
/// is the most populous one for the first half of the palette and population × volume afterwards. Fully transparent pixels
/// are ignored. out: u8[k·3]. Returns the number of colours produced (≤ k).
#[no_mangle]
pub unsafe extern "C" fn median_cut(s: *const u8, w: u32, h: u32, k: u32, out: *mut u8) -> u32 {
    let s = rs(s, w, h);
    let k = k.max(1) as usize;
    let out = core::slice::from_raw_parts_mut(out, k * 3);
    const B: usize = 32;
    let mut cnt = vec![0u32; B * B * B];
    let mut sum = vec![[0u64; 3]; B * B * B];
    for p in s.chunks_exact(4) {
        if p[3] == 0 {
            continue;
        }
        let i = ((p[0] as usize >> 3) * B + (p[1] as usize >> 3)) * B + (p[2] as usize >> 3);
        cnt[i] += 1;
        sum[i][0] += p[0] as u64;
        sum[i][1] += p[1] as u64;
        sum[i][2] += p[2] as u64;
    }
    #[derive(Clone, Copy)]
    struct Bx {
        lo: [usize; 3],
        hi: [usize; 3], // inclusive
        n: u64,
    }
    let shrink = |b: &mut Bx, cnt: &[u32]| {
        let (mut lo, mut hi, mut n) = ([B; 3], [0usize; 3], 0u64);
        for r in b.lo[0]..=b.hi[0] {
            for g in b.lo[1]..=b.hi[1] {
                for bl in b.lo[2]..=b.hi[2] {
                    let c = cnt[(r * B + g) * B + bl];
                    if c > 0 {
                        n += c as u64;
                        let v = [r, g, bl];
                        for a in 0..3 {
                            lo[a] = lo[a].min(v[a]);
                            hi[a] = hi[a].max(v[a]);
                        }
                    }
                }
            }
        }
        b.n = n;
        if n > 0 {
            b.lo = lo;
            b.hi = hi;
        }
    };
    let mut first = Bx { lo: [0; 3], hi: [B - 1; 3], n: 0 };
    shrink(&mut first, &cnt);
    if first.n == 0 {
        return 0;
    }
    let mut boxes = vec![first];
    while boxes.len() < k {
        let vol = |b: &Bx| ((b.hi[0] - b.lo[0] + 1) * (b.hi[1] - b.lo[1] + 1) * (b.hi[2] - b.lo[2] + 1)) as f64;
        let by_pop = boxes.len() < k / 2;
        let (mut pick, mut score) = (usize::MAX, -1f64);
        for (i, b) in boxes.iter().enumerate() {
            if b.lo == b.hi {
                continue; // a single histogram cell cannot be split
            }
            let sc = if by_pop { b.n as f64 } else { b.n as f64 * vol(b) };
            if sc > score {
                score = sc;
                pick = i;
            }
        }
        if pick == usize::MAX {
            break;
        }
        let b = boxes[pick];
        let axis = (0..3).max_by_key(|&a| b.hi[a] - b.lo[a]).unwrap();
        // population along the axis
        let len = b.hi[axis] - b.lo[axis] + 1;
        let mut along = vec![0u64; len];
        for r in b.lo[0]..=b.hi[0] {
            for g in b.lo[1]..=b.hi[1] {
                for bl in b.lo[2]..=b.hi[2] {
                    let v = [r, g, bl];
                    along[v[axis] - b.lo[axis]] += cnt[(r * B + g) * B + bl] as u64;
                }
            }
        }
        let half = b.n / 2;
        let mut acc = 0u64;
        let mut cut = 0usize; // last index of the lower part
        for (i, &c) in along.iter().enumerate().take(len - 1) {
            acc += c;
            cut = i;
            if acc >= half.max(1) {
                break;
            }
        }
        let (mut b1, mut b2) = (b, b);
        b1.hi[axis] = b.lo[axis] + cut;
        b2.lo[axis] = b.lo[axis] + cut + 1;
        shrink(&mut b1, &cnt);
        shrink(&mut b2, &cnt);
        if b1.n == 0 || b2.n == 0 {
            // cannot happen after shrink, but never loop forever
            break;
        }
        boxes[pick] = b1;
        boxes.push(b2);
    }
    for (i, b) in boxes.iter().enumerate() {
        let (mut t, mut n) = ([0u64; 3], 0u64);
        for r in b.lo[0]..=b.hi[0] {
            for g in b.lo[1]..=b.hi[1] {
                for bl in b.lo[2]..=b.hi[2] {
                    let j = (r * B + g) * B + bl;
                    n += cnt[j] as u64;
                    for a in 0..3 {
                        t[a] += sum[j][a];
                    }
                }
            }
        }
        for a in 0..3 {
            out[i * 3 + a] = ((t[a] as f64 / n.max(1) as f64) + 0.5) as u8;
        }
    }
    boxes.len() as u32
}

/// Fraction of a unit cell covered by a centred disc of radius r (in cell units), for r up to √2/2.
fn disc_coverage(r: f32) -> f32 {
    let full = core::f32::consts::PI * r * r;
    if r <= 0.5 {
        full
    } else if r >= core::f32::consts::FRAC_1_SQRT_2 {
        1.0
    } else {
        // subtract the four circular segments that stick out of the square
        let seg = r * r * (0.5 / r).acos() - 0.5 * (r * r - 0.25).sqrt();
        full - 4.0 * seg
    }
}

/// Halftone with round dots on rotated screens. cell = screen period in px; angles in degrees.
/// mode 0: mono (ink = 1 − luma, screen angle a3, black dots on white).
/// mode 1: CMYK with full gray-component replacement; angles a0..a3 for C, M, Y, K; inks multiply subtractively.
/// Each cell's dot is sized so its area equals the ink coverage sampled (bilinear, from a gaussian-smoothed copy,
/// σ = cell/3) at the cell centre; dot edges are antialiased over one pixel. Alpha 255.
#[no_mangle]
pub unsafe extern "C" fn halftone(s: *const u8, w: u32, h: u32, d: *mut u8, cell: f32, a0: f32, a1: f32, a2: f32, a3: f32, mode: u32) {
    let (s, d) = (rs(s, w, h), ws(d, w, h));
    let (w, h) = (w as usize, h as usize);
    let cell = cell.max(2.0);
    let mut sm = vec![0u8; s.len()];
    crate::filters::gaussian_into(s, w, h, &mut sm, cell / 3.0);
    // radius LUT: coverage t → radius (cell units), by bisection on disc_coverage
    let mut rad = [0f32; 257];
    for (i, v) in rad.iter_mut().enumerate() {
        let t = i as f32 / 256.0;
        let (mut lo, mut hi) = (0f32, core::f32::consts::FRAC_1_SQRT_2);
        for _ in 0..24 {
            let m = 0.5 * (lo + hi);
            if disc_coverage(m) < t {
                lo = m;
            } else {
                hi = m;
            }
        }
        *v = 0.5 * (lo + hi);
    }
    let inks = |p: [f32; 3]| -> [f32; 4] {
        // p in 0..1 RGB → C, M, Y, K
        let kk = 1.0 - p[0].max(p[1]).max(p[2]);
        if kk >= 0.9999 {
            [0.0, 0.0, 0.0, 1.0]
        } else {
            [(1.0 - p[0] - kk) / (1.0 - kk), (1.0 - p[1] - kk) / (1.0 - kk), (1.0 - p[2] - kk) / (1.0 - kk), kk]
        }
    };
    let sample = |fx: f32, fy: f32| -> [f32; 3] {
        let (fx, fy) = (fx.clamp(0.0, w as f32 - 1.0), fy.clamp(0.0, h as f32 - 1.0));
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let mut o = [0f32; 3];
        for c in 0..3 {
            let a = sm[(y0 * w + x0) * 4 + c] as f32 * (1.0 - tx) + sm[(y0 * w + x1) * 4 + c] as f32 * tx;
            let b = sm[(y1 * w + x0) * 4 + c] as f32 * (1.0 - tx) + sm[(y1 * w + x1) * 4 + c] as f32 * tx;
            o[c] = (a * (1.0 - ty) + b * ty) / 255.0;
        }
        o
    };
    let chans: &[usize] = if mode == 0 { &[3] } else { &[0, 1, 2, 3] };
    let angles = [a0, a1, a2, a3];
    let mut ink = vec![0f32; w * h * 4];
    for &ch in chans {
        let (sn, cs) = angles[ch].to_radians().sin_cos();
        for y in 0..h {
            for x in 0..w {
                let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                let u = px * cs + py * sn;
                let v = -px * sn + py * cs;
                let uc = ((u / cell).floor() + 0.5) * cell;
                let vc = ((v / cell).floor() + 0.5) * cell;
                let (cx, cy) = (uc * cs - vc * sn, uc * sn + vc * cs);
                let p = sample(cx - 0.5, cy - 0.5);
                let t = if mode == 0 { 1.0 - (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) } else { inks(p)[ch] };
                let r = rad[(t.clamp(0.0, 1.0) * 256.0) as usize] * cell;
                let dist = ((u - uc) * (u - uc) + (v - vc) * (v - vc)).sqrt();
                ink[(y * w + x) * 4 + ch] = if t <= 0.002 { 0.0 } else { (r - dist + 0.5).clamp(0.0, 1.0) };
            }
        }
    }
    for i in 0..w * h {
        let k = &ink[i * 4..i * 4 + 4];
        let (r, g, b) = if mode == 0 { (1.0 - k[3], 1.0 - k[3], 1.0 - k[3]) } else { ((1.0 - k[0]) * (1.0 - k[3]), (1.0 - k[1]) * (1.0 - k[3]), (1.0 - k[2]) * (1.0 - k[3])) };
        d[i * 4] = clamp8(r * 255.0);
        d[i * 4 + 1] = clamp8(g * 255.0);
        d[i * 4 + 2] = clamp8(b * 255.0);
        d[i * 4 + 3] = 255;
    }
}
