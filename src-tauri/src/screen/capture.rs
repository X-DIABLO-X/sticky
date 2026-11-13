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
