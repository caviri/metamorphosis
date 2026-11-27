//! μεταμόρφωσις compute kernel.
//!
//! Raw C ABI over linear memory, no wasm-bindgen. Every image is RGBA8, row-major.
//! The caller allocates buffers with `k_alloc`, copies pixels in, calls an op, copies the
//! result out and releases with `k_free`. Source and destination never alias.
#![allow(clippy::missing_safety_doc, clippy::too_many_arguments, clippy::needless_range_loop)]

use std::alloc::{alloc, dealloc, Layout};

mod analysis;
mod color;
mod dither;
mod fft;
mod filters;
mod geom;

#[no_mangle]
pub unsafe extern "C" fn k_alloc(n: usize) -> *mut u8 {
    if n == 0 {
        return 16 as *mut u8;
    }
    match Layout::from_size_align(n, 16) {
        Ok(l) => alloc(l),
        Err(_) => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn k_free(p: *mut u8, n: usize) {
    if n != 0 && !p.is_null() {
        dealloc(p, Layout::from_size_align_unchecked(n, 16));
    }
}

#[no_mangle]
pub extern "C" fn k_version() -> u32 {
    1
}

// ───────────────────────────────────────────────────────────── shared ──

#[inline(always)]
pub(crate) unsafe fn rs<'a>(p: *const u8, w: u32, h: u32) -> &'a [u8] {
    core::slice::from_raw_parts(p, w as usize * h as usize * 4)
}
#[inline(always)]
pub(crate) unsafe fn ws<'a>(p: *mut u8, w: u32, h: u32) -> &'a mut [u8] {
    core::slice::from_raw_parts_mut(p, w as usize * h as usize * 4)
}
/// round-to-nearest with saturation to 0..255
#[inline(always)]
pub(crate) fn clamp8(v: f32) -> u8 {
    (v + 0.5) as u8 // `as` saturates and maps NaN to 0
}
/// Rec.709 luma of an RGBA pixel, 0..255, not rounded
#[inline(always)]
pub(crate) fn luma(p: &[u8]) -> f32 {
    0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32
}
pub(crate) fn luma_plane(s: &[u8]) -> Vec<f32> {
    s.chunks_exact(4).map(luma).collect()
}
pub(crate) fn luma_u8(s: &[u8]) -> Vec<u8> {
    s.chunks_exact(4).map(|p| clamp8(luma(p))).collect()
}
#[inline(always)]
pub(crate) fn cl(i: isize, n: usize) -> usize {
    if i < 0 {
        0
    } else if i as usize >= n {
        n - 1
    } else {
        i as usize
    }
}

/// xorshift32 — deterministic, seedable
pub(crate) struct Rng(pub u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9E37_79B9 } else { seed })
    }
    #[inline(always)]
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// uniform in [0,1)
    #[inline(always)]
    pub fn f(&mut self) -> f32 {
        (self.next() >> 8) as f32 / 16_777_216.0
    }
}
