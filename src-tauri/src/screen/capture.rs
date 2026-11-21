use std::io::Cursor;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, GenericImageView, ImageFormat, RgbaImage};
use xcap::Monitor;
use crate::error::{AppError, Result};

pub struct ScreenCaptureService;

#[derive(Debug, Clone)]
pub struct CapturedScreen {
    pub monitor_index: usize,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub data: Vec<u8>,
    pub base64_data: String,
}

impl ScreenCaptureService {
    /// Returns (origin_x, origin_y, width, height) in physical pixels for the given monitor (defaulting to primary).
    pub fn monitor_bounds(monitor_index: usize) -> (i32, i32, u32, u32) {
        if let Ok(monitors) = Monitor::all() {
            if let Some(m) = monitors.get(monitor_index).or_else(|| monitors.first()) {
                let x = m.x().unwrap_or(0);
                let y = m.y().unwrap_or(0);
                let w = m.width().unwrap_or(1920).max(1);
                let h = m.height().unwrap_or(1080).max(1);
                return (x, y, w, h);
            }
        }
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
            unsafe {
                let w = GetSystemMetrics(SM_CXSCREEN).max(1) as u32;
                let h = GetSystemMetrics(SM_CYSCREEN).max(1) as u32;
                return (0, 0, w, h);
            }
        }
        #[cfg(not(windows))]
        (0, 0, 1920, 1080)
    }

    /// Returns the top-left origin (vx, vy) of the virtual desktop (important when monitors sit left/above primary).
    pub fn virtual_desktop_origin() -> (i32, i32) {
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
            };
            unsafe {
                return (
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                );
            }
        }
        #[cfg(not(windows))]
        (0, 0)
    }

    /// Converts normalized 0..1000 coordinates into exact physical screen pixels on `monitor_index`.
    pub fn normalized_to_physical(nx: f64, ny: f64, monitor_index: usize) -> (i32, i32) {
        let (mx, my, mw, mh) = Self::monitor_bounds(monitor_index);
        let px = mx + ((nx.clamp(0.0, 1000.0) / 1000.0) * mw as f64).round() as i32;
        let py = my + ((ny.clamp(0.0, 1000.0) / 1000.0) * mh as f64).round() as i32;
        (px, py)
    }

    /// Converts a physical `[x, y, width, height]` UIA bounding box into normalized 0..1000 `([x1, y1, x2, y2], [cx, cy])`.
    pub fn physical_bbox_to_normalized(
        bbox: [i32; 4],
        mon_x: i32,
        mon_y: i32,
        mon_w: u32,
        mon_h: u32,
    ) -> ([i32; 4], [i32; 2]) {
        let mw = mon_w.max(1) as f64;
        let mh = mon_h.max(1) as f64;
        let x1 = (((bbox[0] - mon_x) as f64 / mw) * 1000.0).round().clamp(0.0, 1000.0) as i32;
        let y1 = (((bbox[1] - mon_y) as f64 / mh) * 1000.0).round().clamp(0.0, 1000.0) as i32;
        let x2 = (((bbox[0] + bbox[2] - mon_x) as f64 / mw) * 1000.0).round().clamp(0.0, 1000.0) as i32;
        let y2 = (((bbox[1] + bbox[3] - mon_y) as f64 / mh) * 1000.0).round().clamp(0.0, 1000.0) as i32;
        let cx = (x1 + x2) / 2;
        let cy = (y1 + y2) / 2;
        ([x1, y1, x2, y2], [cx, cy])
    }

    /// Capture screen from monitor_index, optional crop_bbox: [x1, y1, x2, y2], downscaled to max 1280px width
    pub fn capture(
        monitor_index: usize,
        crop_bbox: Option<[u32; 4]>,
        max_width: Option<u32>,
    ) -> Result<CapturedScreen> {
        let monitors = Monitor::all()
            .map_err(|e| AppError::Screen(format!("Failed to enumerate monitors: {}", e)))?;

        let monitor = monitors.get(monitor_index)
            .ok_or_else(|| AppError::Screen(format!("Monitor index {} out of range", monitor_index)))?;

        let img = monitor.capture_image()
            .map_err(|e| AppError::Screen(format!("Failed to capture screen: {}", e)))?;

        let (orig_w, orig_h) = img.dimensions();

        // Handle crop if specified
        let cropped = if let Some([x1, y1, x2, y2]) = crop_bbox {
            let left = x1.min(orig_w);
            let top = y1.min(orig_h);
            let right = x2.min(orig_w);
            let bottom = y2.min(orig_h);
            let w = right.saturating_sub(left).max(1);
            let h = bottom.saturating_sub(top).max(1);
            img.view(left, top, w, h).to_image()
        } else {
            img
        };

        let (w, h) = cropped.dimensions();
        let target_max_w = max_width.unwrap_or(1280);

        // Resize down to target_max_w if needed
        let final_img = if w > target_max_w {
            let new_h = (h as f32 * (target_max_w as f32 / w as f32)) as u32;
            image::imageops::resize(&cropped, target_max_w, new_h, FilterType::Triangle)
        } else {
            cropped
        };

        let (final_w, final_h) = final_img.dimensions();

        // Encode as JPEG with 80% quality
        let mut jpeg_bytes = Vec::new();
        let mut cursor = Cursor::new(&mut jpeg_bytes);
        final_img.write_to(&mut cursor, ImageFormat::Jpeg)
            .map_err(|e| AppError::Screen(format!("Failed to encode JPEG: {}", e)))?;

        use base64::Engine;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

        Ok(CapturedScreen {
            monitor_index,
            width: final_w,
            height: final_h,
            format: "image/jpeg".to_string(),
            data: jpeg_bytes,
            base64_data,
        })
    }

    /// Captures the monitor for Vision-Language Model (VLM) grounding, resized to `max_width.unwrap_or(1280)`
    /// with a crisp 0-1000 coordinate grid, minor ruler ticks, and bitmap coordinate labels baked into the copy.
    pub fn capture_for_vlm(monitor_index: usize, max_width: Option<u32>) -> Result<CapturedScreen> {
        let monitors = Monitor::all()
            .map_err(|e| AppError::Screen(format!("Failed to enumerate monitors: {}", e)))?;

        let monitor = monitors
            .get(monitor_index)
            .ok_or_else(|| AppError::Screen(format!("Monitor index {} out of range", monitor_index)))?;

        let img = monitor
            .capture_image()
            .map_err(|e| AppError::Screen(format!("Failed to capture screen: {}", e)))?;

        let (w, h) = img.dimensions();
        let target_max_w = max_width.unwrap_or(1280).max(1);

        let mut final_img = if w > target_max_w {
            let new_h = ((h as f32 * (target_max_w as f32 / w as f32)).round() as u32).max(1);
            image::imageops::resize(&img, target_max_w, new_h, FilterType::Triangle)
        } else {
            img
        };

        draw_coordinate_grid(&mut final_img);

        let (final_w, final_h) = final_img.dimensions();

        // Encode annotated RGB image as JPEG at 82% quality
        let rgb_img = DynamicImage::ImageRgba8(final_img).to_rgb8();
        let mut jpeg_bytes = Vec::new();
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 82);
        rgb_img
            .write_with_encoder(encoder)
            .map_err(|e| AppError::Screen(format!("Failed to encode VLM JPEG: {}", e)))?;

        use base64::Engine;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

        Ok(CapturedScreen {
            monitor_index,
            width: final_w,
            height: final_h,
            format: "image/jpeg".to_string(),
            data: jpeg_bytes,
            base64_data,
        })
    }
}

/// Compact built-in 5x7 bitmap font for digits '0'-'9' and ','.
/// Each byte encodes a 5-pixel row in its lower 5 bits (bit 4 = leftmost pixel).
fn glyph_5x7(ch: char) -> Option<[u8; 7]> {
    match ch {
        '0' => Some([0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E]),
        '1' => Some([0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E]),
        '2' => Some([0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F]),
        '3' => Some([0x0E, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0E]),
        '4' => Some([0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02]),
        '5' => Some([0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E]),
        '6' => Some([0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E]),
        '7' => Some([0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08]),
        '8' => Some([0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E]),
        '9' => Some([0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C]),
        ',' => Some([0x00, 0x00, 0x00, 0x00, 0x06, 0x04, 0x08]),
        _ => None,
    }
}

#[inline]
fn blend_pixel(img: &mut RgbaImage, x: i32, y: i32, r: u8, g: u8, b: u8, alpha: f32) {
    if x < 0 || y < 0 {
        return;
    }
    let (ux, uy) = (x as u32, y as u32);
    if ux >= img.width() || uy >= img.height() {
        return;
    }
    let p = img.get_pixel_mut(ux, uy);
    let inv = 1.0 - alpha;
    p[0] = (r as f32 * alpha + p[0] as f32 * inv).round().clamp(0.0, 255.0) as u8;
    p[1] = (g as f32 * alpha + p[1] as f32 * inv).round().clamp(0.0, 255.0) as u8;
    p[2] = (b as f32 * alpha + p[2] as f32 * inv).round().clamp(0.0, 255.0) as u8;
    p[3] = 255;
}

fn draw_filled_rect(
    img: &mut RgbaImage,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    r: u8,
    g: u8,
    b: u8,
    alpha: f32,
) {
    for dy in 0..h {
        for dx in 0..w {
            // Subtle rounded pill corners
            let is_corner = (dx == 0 || dx == w - 1) && (dy == 0 || dy == h - 1);
            if !is_corner {
                blend_pixel(img, x + dx, y + dy, r, g, b, alpha);
            }
        }
    }
}

fn draw_label_pill(
    img: &mut RgbaImage,
    text: &str,
    anchor_x: i32,
    anchor_y: i32,
    scale: i32,
    bg_alpha: f32,
    fg_rgb: (u8, u8, u8),
) {
    let char_count = text.chars().count() as i32;
    if char_count == 0 {
        return;
    }
    let glyph_w = 5 * scale;
    let glyph_h = 7 * scale;
    let spacing = scale;
    let pad_x = 3 * scale;
    let pad_y = 2 * scale;

    let text_w = char_count * glyph_w + (char_count - 1).max(0) * spacing;
    let box_w = text_w + pad_x * 2;
    let box_h = glyph_h + pad_y * 2;

    let max_x = (img.width() as i32 - box_w).max(0);
    let max_y = (img.height() as i32 - box_h).max(0);
    let bx = anchor_x.clamp(0, max_x);
    let by = anchor_y.clamp(0, max_y);

    // Dark translucent pill background + subtle bright border
    draw_filled_rect(img, bx, by, box_w, box_h, 10, 16, 24, bg_alpha);
    for dx in 1..(box_w - 1) {
        blend_pixel(img, bx + dx, by, fg_rgb.0, fg_rgb.1, fg_rgb.2, bg_alpha * 0.65);
        blend_pixel(img, bx + dx, by + box_h - 1, fg_rgb.0, fg_rgb.1, fg_rgb.2, bg_alpha * 0.65);
    }
    for dy in 1..(box_h - 1) {
        blend_pixel(img, bx, by + dy, fg_rgb.0, fg_rgb.1, fg_rgb.2, bg_alpha * 0.65);
        blend_pixel(img, bx + box_w - 1, by + dy, fg_rgb.0, fg_rgb.1, fg_rgb.2, bg_alpha * 0.65);
    }

    // Crisp bitmap digits
    let mut cursor_x = bx + pad_x;
    let cursor_y = by + pad_y;
    for ch in text.chars() {
        if let Some(rows) = glyph_5x7(ch) {
            for (row_idx, &bits) in rows.iter().enumerate() {
                for col_idx in 0..5 {
                    if (bits & (1 << (4 - col_idx))) != 0 {
                        for sy in 0..scale {
                            for sx in 0..scale {
                                blend_pixel(
                                    img,
                                    cursor_x + col_idx * scale + sx,
                                    cursor_y + (row_idx as i32) * scale + sy,
                                    fg_rgb.0,
                                    fg_rgb.1,
                                    fg_rgb.2,
                                    0.96,
                                );
                            }
                        }
                    }
                }
            }
        }
        cursor_x += glyph_w + spacing;
    }
}

/// Draws a 0-1000 normalized coordinate grid, ruler ticks, and bitmap coordinate labels
/// directly onto `img` for Vision-Language Model spatial grounding.
pub fn draw_coordinate_grid(img: &mut RgbaImage) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    if w < 16 || h < 16 {
        return;
    }

    let grid_rgb = (0u8, 240u8, 210u8); // Bright cyan-emerald
    let label_rgb = (110u8, 255u8, 235u8);
    let scale = if w >= 900 { 2 } else { 1 };
    let dash_len = 5;
    let dash_period = 10;

    // 1. Major dashed grid lines at 100..=900
    for step in (100..=900).step_by(100) {
        let is_center = step == 500;
        let line_alpha = if is_center { 0.65 } else { 0.48 };

        let gx = (((step as f64) / 1000.0) * w as f64).round() as i32;
        for y in 0..h {
            if (y % dash_period) < dash_len {
                blend_pixel(img, gx, y, grid_rgb.0, grid_rgb.1, grid_rgb.2, line_alpha);
            }
        }

        let gy = (((step as f64) / 1000.0) * h as f64).round() as i32;
        for x in 0..w {
            if (x % dash_period) < dash_len {
                blend_pixel(img, x, gy, grid_rgb.0, grid_rgb.1, grid_rgb.2, line_alpha);
            }
        }
    }

    // 2. Minor ruler tick marks along top and left borders at 50, 150, ..., 950
    let tick_len = 7 * scale;
    for step in (50..=950).step_by(100) {
        let tx = (((step as f64) / 1000.0) * w as f64).round() as i32;
        for dy in 0..tick_len {
            blend_pixel(img, tx, dy, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.85);
            if scale > 1 {
                blend_pixel(img, tx + 1, dy, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.85);
            }
        }

        let ty = (((step as f64) / 1000.0) * h as f64).round() as i32;
        for dx in 0..tick_len {
            blend_pixel(img, dx, ty, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.85);
            if scale > 1 {
                blend_pixel(img, dx, ty + 1, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.85);
            }
        }
    }

    // 3. Bold, high-contrast coordinate labels along top edge (X) and left edge (Y)
    let pill_w_3digits = (3 * 5 * scale) + (2 * scale) + (6 * scale);
    let pill_h = (7 * scale) + (4 * scale);

    for step in (100..=900).step_by(100) {
        let label = step.to_string();

        // Top ruler X label centered on gx
        let gx = (((step as f64) / 1000.0) * w as f64).round() as i32;
        draw_label_pill(
            img,
            &label,
            gx - pill_w_3digits / 2,
            2,
            scale,
            0.80,
            label_rgb,
        );

        // Left ruler Y label centered on gy
        let gy = (((step as f64) / 1000.0) * h as f64).round() as i32;
        draw_label_pill(
            img,
            &label,
            2,
            gy - pill_h / 2,
            scale,
            0.80,
            label_rgb,
        );
    }

    // 4. Center (500, 500) crosshair & subtle intersection label
    let cx = w / 2;
    let cy = h / 2;
    let arm = 6 * scale;
    for d in -arm..=arm {
        blend_pixel(img, cx + d, cy, 255, 255, 255, 0.85);
        blend_pixel(img, cx, cy + d, 255, 255, 255, 0.85);
    }
    draw_label_pill(
        img,
        "500,500",
        cx + 6,
        cy + 6,
        1,
        0.65,
        label_rgb,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn test_draw_coordinate_grid_smoke() {
        let mut img = RgbaImage::from_pixel(640, 360, Rgba([30, 30, 30, 255]));
        let baseline = img.clone();

        draw_coordinate_grid(&mut img);

        let modified_pixels = img
            .pixels()
            .zip(baseline.pixels())
            .filter(|(a, b)| a != b)
            .count();

        assert!(
            modified_pixels > 1000,
            "Expected coordinate grid to modify pixels, got {}",
            modified_pixels
        );
        // Verify center crosshair was drawn
        assert_ne!(img.get_pixel(320, 180), baseline.get_pixel(320, 180));
        // Verify top ruler tick at X=50 (px = 32) was drawn
        assert_ne!(img.get_pixel(32, 0), baseline.get_pixel(32, 0));
    }
}
