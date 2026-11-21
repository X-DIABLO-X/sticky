use std::io::Cursor;
use image::{imageops::FilterType, GenericImageView, ImageFormat};
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
}
