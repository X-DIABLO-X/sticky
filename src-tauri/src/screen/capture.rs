use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, GenericImageView, RgbaImage};
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DetectedElement {
    pub id: u32,
    pub label: String,
    pub source: String, // "ocr", "a11y", or "icon"
    pub bbox_norm: [i32; 4], // [x1, y1, x2, y2] in 0..1000
    pub center_norm: [i32; 2], // [cx, cy] in 0..1000
}

#[derive(Debug, Clone)]
pub struct GroundedCapture {
    pub screen: CapturedScreen,
    pub elements: Vec<DetectedElement>,
}

impl ScreenCaptureService {
    fn select_monitor(monitors: &[Monitor], monitor_index: usize) -> Option<&Monitor> {
        if monitor_index == 0 {
            monitors
                .iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or_else(|| monitors.first())
        } else {
            monitors.get(monitor_index).or_else(|| monitors.first())
        }
    }

    /// Returns (origin_x, origin_y, width, height) in physical pixels for the given monitor (defaulting to primary).
    pub fn monitor_bounds(monitor_index: usize) -> (i32, i32, u32, u32) {
        if let Ok(monitors) = Monitor::all() {
            if let Some(m) = Self::select_monitor(&monitors, monitor_index) {
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

    /// Returns the virtual desktop bounding rect (vx, vy, vw, vh) in physical pixels.
    pub fn virtual_desktop_bounds() -> (i32, i32, u32, u32) {
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
                SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
            };
            unsafe {
                let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32;
                let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32;
                return (vx, vy, vw, vh);
            }
        }
        #[cfg(not(windows))]
        Self::monitor_bounds(0)
    }

    /// Returns the top-left origin (vx, vy) of the virtual desktop (important when monitors sit left/above primary).
    pub fn virtual_desktop_origin() -> (i32, i32) {
        let (vx, vy, _, _) = Self::virtual_desktop_bounds();
        (vx, vy)
    }

    /// Maps monitor-local normalized 0..1000 coordinates into virtual-desktop overlay 0..1000 coordinates.
    /// On a single monitor this is the identity transform; on multi-monitor desktops it removes cross-screen drift.
    pub fn monitor_to_overlay_norm(nx: i32, ny: i32, monitor_index: usize) -> (i32, i32) {
        let (mx, my, mw, mh) = Self::monitor_bounds(monitor_index);
        let (vx, vy, vw, vh) = Self::virtual_desktop_bounds();
        if mx == vx && my == vy && mw == vw && mh == vh {
            return (nx.clamp(0, 1000), ny.clamp(0, 1000));
        }
        let px = mx as f64 + (nx.clamp(0, 1000) as f64 / 1000.0) * mw as f64;
        let py = my as f64 + (ny.clamp(0, 1000) as f64 / 1000.0) * mh as f64;
        let ox = (((px - vx as f64) / vw.max(1) as f64) * 1000.0)
            .round()
            .clamp(0.0, 1000.0) as i32;
        let oy = (((py - vy as f64) / vh.max(1) as f64) * 1000.0)
            .round()
            .clamp(0.0, 1000.0) as i32;
        (ox, oy)
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

        let monitor = Self::select_monitor(&monitors, monitor_index)
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

        // Convert RGBA -> RGB before JPEG encoding (image 0.25 JpegEncoder rejects Rgba8)
        let rgb_img = DynamicImage::ImageRgba8(final_img).to_rgb8();
        let mut jpeg_bytes = Vec::new();
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 85);
        rgb_img
            .write_with_encoder(encoder)
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

        let monitor = Self::select_monitor(&monitors, monitor_index)
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

    /// Captures the monitor at full resolution, runs native WinRT OCR, merges Windows UIA (`a11y_nodes`),
    /// detects classical CV icon regions, resizes to `max_width.unwrap_or(1440)`, and draws BOTH the
    /// 0..1000 coordinate grid and high-contrast Set-of-Mark (`#id`) overlays for every detected element.
    pub fn capture_grounded_for_vlm(
        monitor_index: usize,
        max_width: Option<u32>,
        a11y_nodes: &[crate::screen::a11y::A11yNodeCompact],
    ) -> Result<GroundedCapture> {
        let monitors = Monitor::all()
            .map_err(|e| AppError::Screen(format!("Failed to enumerate monitors: {}", e)))?;

        let monitor = Self::select_monitor(&monitors, monitor_index)
            .ok_or_else(|| AppError::Screen(format!("Monitor index {} out of range", monitor_index)))?;

        let mon_x = monitor.x().unwrap_or(0);
        let mon_y = monitor.y().unwrap_or(0);

        let img = monitor
            .capture_image()
            .map_err(|e| AppError::Screen(format!("Failed to capture screen: {}", e)))?;

        let grounded = Self::ground_image_for_vlm(
            &img,
            monitor_index,
            mon_x,
            mon_y,
            max_width,
            a11y_nodes,
        )?;

        // Best-effort save of the exact encoded JPEG sent to the VLM for live debugging/inspection
        if let Some(home) = dirs::home_dir() {
            let dir = home.join(".heyclicky");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("last_vlm_frame.jpg"), &grounded.screen.data);
        }

        Ok(grounded)
    }

    /// Runs the complete grounding pipeline (full-res WinRT OCR + UIA merge + CV icon detection +
    /// 0..1000 grid + high-contrast Set-of-Mark badges + JPEG encoding) on any supplied `RgbaImage`.
    pub fn ground_image_for_vlm(
        img: &RgbaImage,
        monitor_index: usize,
        mon_x: i32,
        mon_y: i32,
        max_width: Option<u32>,
        a11y_nodes: &[crate::screen::a11y::A11yNodeCompact],
    ) -> Result<GroundedCapture> {
        const MAX_TOTAL_ELEMENTS: usize = 160;
        const MAX_ICON_REGIONS: usize = 75;

        let (orig_w, orig_h) = img.dimensions();

        // 1. Run WinRT OCR on the FULL-RES image for maximum text detection accuracy
        let ocr_words = crate::screen::ocr::extract_ocr_words(img);
        let ocr_raw_boxes: Vec<[i32; 4]> = ocr_words.iter().map(|w| w.bbox).collect();

        // 1b. Run classical CV icon detector on FULL-RES image to capture unlabeled toolbar buttons & gizmos
        let icon_boxes =
            crate::screen::regions::detect_icon_regions(img, &ocr_raw_boxes, MAX_ICON_REGIONS);

        let mut elements: Vec<DetectedElement> =
            Vec::with_capacity(ocr_words.len() + a11y_nodes.len() + icon_boxes.len());

        for word in ocr_words {
            let label = word.text.trim();
            if label.is_empty() || is_ocr_noise_token(label) {
                continue;
            }
            let (bbox_norm, center_norm) =
                Self::physical_bbox_to_normalized(word.bbox, 0, 0, orig_w, orig_h);
            if bbox_norm[2] <= bbox_norm[0] || bbox_norm[3] <= bbox_norm[1] {
                continue;
            }
            elements.push(DetectedElement {
                id: 0,
                label: label.to_string(),
                source: "ocr".to_string(),
                bbox_norm,
                center_norm,
            });
        }

        // Remove horizontal numeric ruler/timeline tick rows (e.g. Blender's 12, 24, ..., 252)
        filter_ruler_tick_rows(&mut elements);

        // 2. Merge UIA nodes, deduplicating against existing elements near the same center with similar label
        for node in a11y_nodes {
            if node.bbox[2] <= 4 || node.bbox[3] <= 4 {
                continue;
            }
            let raw_label = if !node.name.trim().is_empty() {
                node.name.trim()
            } else if let Some(ref val) = node.value {
                val.trim()
            } else {
                ""
            };
            if raw_label.is_empty() {
                continue;
            }

            // Skip nodes completely outside this monitor's physical bounds
            let node_right = node.bbox[0] + node.bbox[2];
            let node_bottom = node.bbox[1] + node.bbox[3];
            if node_right <= mon_x
                || node_bottom <= mon_y
                || node.bbox[0] >= mon_x + orig_w as i32
                || node.bbox[1] >= mon_y + orig_h as i32
            {
                continue;
            }

            let (bbox_norm, center_norm) =
                Self::physical_bbox_to_normalized(node.bbox, mon_x, mon_y, orig_w, orig_h);
            if bbox_norm[2] <= bbox_norm[0] || bbox_norm[3] <= bbox_norm[1] {
                continue;
            }

            let is_dup = elements.iter().any(|existing| {
                let dx = (existing.center_norm[0] - center_norm[0]).abs();
                let dy = (existing.center_norm[1] - center_norm[1]).abs();
                dx <= 12 && dy <= 12 && labels_similar(&existing.label, raw_label)
            });

            if !is_dup {
                elements.push(DetectedElement {
                    id: 0,
                    label: raw_label.to_string(),
                    source: "a11y".to_string(),
                    bbox_norm,
                    center_norm,
                });
            }
        }

        // Keep OCR + A11y elements first (sorted top-to-bottom, left-to-right) before allocating
        // remaining slots up to MAX_TOTAL_ELEMENTS (160) for up to MAX_ICON_REGIONS (75) CV icons.
        elements.sort_by_key(|el| (el.bbox_norm[1] / 8, el.bbox_norm[0]));
        elements.truncate(MAX_TOTAL_ELEMENTS);

        let icon_budget = MAX_TOTAL_ELEMENTS
            .saturating_sub(elements.len())
            .min(MAX_ICON_REGIONS);

        // 2b. Merge CV-detected icon regions (skip any already covered by OCR/A11y)
        let mut added_icons = 0usize;
        for ibox in icon_boxes {
            if added_icons >= icon_budget {
                break;
            }
            let (bbox_norm, center_norm) =
                Self::physical_bbox_to_normalized(ibox, 0, 0, orig_w, orig_h);
            if bbox_norm[2] <= bbox_norm[0] || bbox_norm[3] <= bbox_norm[1] {
                continue;
            }
            let is_dup = elements.iter().any(|existing| {
                let dx = (existing.center_norm[0] - center_norm[0]).abs();
                let dy = (existing.center_norm[1] - center_norm[1]).abs();
                dx <= 10 && dy <= 10
            });
            if !is_dup {
                elements.push(DetectedElement {
                    id: 0,
                    label: spatial_icon_label(center_norm),
                    source: "icon".to_string(),
                    bbox_norm,
                    center_norm,
                });
                added_icons += 1;
            }
        }

        // 3. Sort all kept elements top-to-bottom (8-unit row bands), left-to-right so menus & toolbars come first
        elements.sort_by_key(|el| (el.bbox_norm[1] / 8, el.bbox_norm[0]));

        // 4. Assign sequential 1-based IDs
        for (idx, el) in elements.iter_mut().enumerate() {
            el.id = (idx + 1) as u32;
        }

        // 5. Resize down to max_width (default 1440 for ultra-crisp VLM digit legibility)
        let target_max_w = max_width.unwrap_or(1440).max(1);
        let mut final_img = if orig_w > target_max_w {
            let new_h = ((orig_h as f32 * (target_max_w as f32 / orig_w as f32)).round() as u32).max(1);
            image::imageops::resize(img, target_max_w, new_h, FilterType::Triangle)
        } else {
            img.clone()
        };

        // 6. Draw coordinate grid + high-contrast Set-of-Mark bounding boxes & [id] badges
        draw_coordinate_grid(&mut final_img);
        draw_som_overlays(&mut final_img, &elements);

        let (final_w, final_h) = final_img.dimensions();

        // 7. Encode JPEG at 92% quality so solid badge digits stay razor-sharp without chroma smear
        let rgb_img = DynamicImage::ImageRgba8(final_img).to_rgb8();
        let mut jpeg_bytes = Vec::new();
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 92);
        rgb_img
            .write_with_encoder(encoder)
            .map_err(|e| AppError::Screen(format!("Failed to encode grounded VLM JPEG: {}", e)))?;

        use base64::Engine;
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

        let screen = CapturedScreen {
            monitor_index,
            width: final_w,
            height: final_h,
            format: "image/jpeg".to_string(),
            data: jpeg_bytes,
            base64_data,
        };

        Ok(GroundedCapture { screen, elements })
    }
}

/// Convenience wrapper for `ScreenCaptureService::capture_grounded_for_vlm`.
pub fn capture_grounded_for_vlm(
    monitor_index: usize,
    max_width: Option<u32>,
    a11y_nodes: &[crate::screen::a11y::A11yNodeCompact],
) -> Result<GroundedCapture> {
    ScreenCaptureService::capture_grounded_for_vlm(monitor_index, max_width, a11y_nodes)
}

fn is_ocr_noise_token(label: &str) -> bool {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return true;
    }
    let char_count = trimmed.chars().count();
    if char_count == 1 {
        let ch = trimmed.chars().next().unwrap();
        // Keep genuine single-character UI actions like close ('x'/'X'), add ('+'), help ('?')
        return !matches!(ch, 'x' | 'X' | '+' | '?');
    }
    // Reject purely punctuation/symbol OCR fragments (e.g. "...", "—", "-|", ">>")
    trimmed
        .chars()
        .all(|c| !c.is_alphanumeric() && c != '+' && c != '?')
}

/// Drops horizontal ruler/timeline numeric tick spam (e.g. Blender/video-editor frame ticks `12, 24, 36...`)
/// when 5 or more narrow pure-integer OCR tokens lie on the same horizontal band.
fn filter_ruler_tick_rows(elements: &mut Vec<DetectedElement>) {
    let mut row_counts: std::collections::HashMap<i32, usize> = std::collections::HashMap::new();
    for el in elements.iter() {
        if el.source == "ocr"
            && (el.bbox_norm[2] - el.bbox_norm[0]) <= 28
            && !el.label.is_empty()
            && el.label.chars().all(|c| c.is_ascii_digit())
        {
            let band = el.center_norm[1] / 6;
            *row_counts.entry(band).or_insert(0) += 1;
        }
    }
    elements.retain(|el| {
        if el.source == "ocr"
            && (el.bbox_norm[2] - el.bbox_norm[0]) <= 28
            && !el.label.is_empty()
            && el.label.chars().all(|c| c.is_ascii_digit())
        {
            let band = el.center_norm[1] / 6;
            row_counts.get(&band).copied().unwrap_or(0) < 5
        } else {
            true
        }
    });
}

fn labels_similar(a: &str, b: &str) -> bool {
    let al = a.trim().to_ascii_lowercase();
    let bl = b.trim().to_ascii_lowercase();
    if al.is_empty() || bl.is_empty() {
        return false;
    }
    if al == bl {
        return true;
    }
    al.len().min(bl.len()) >= 3 && (al.contains(&bl) || bl.contains(&al))
}

/// Gives unlabeled CV-detected icon regions descriptive screen-zone names
/// so the VLM can disambiguate toolbar buttons, window caption controls, taskbar items, and panels.
fn spatial_icon_label(center_norm: [i32; 2]) -> String {
    let [cx, cy] = center_norm;
    if cy < 32 && cx > 890 {
        return "window-control (top-right)".to_string();
    }
    if cy > 955 {
        return "taskbar-icon (bottom)".to_string();
    }
    let region = if cy < 115 {
        if cx < 180 {
            "toolbar-left"
        } else if cx > 720 {
            "toolbar-right"
        } else {
            "top-bar"
        }
    } else if cy > 880 {
        if cx < 180 {
            "bottom-left"
        } else if cx > 820 {
            "bottom-right"
        } else {
            "bottom-bar"
        }
    } else if cx < 120 {
        "left-toolbar"
    } else if cx > 760 {
        "right-panel"
    } else {
        "center"
    };
    format!("icon ({})", region)
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

/// Draws a subtle 0-1000 normalized coordinate grid, border ruler ticks, and compact edge labels
/// directly onto `img` without obscuring the top/left application menu bars.
pub fn draw_coordinate_grid(img: &mut RgbaImage) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    if w < 16 || h < 16 {
        return;
    }

    let grid_rgb = (0u8, 225u8, 200u8); // Subtle cyan-emerald
    let label_rgb = (130u8, 255u8, 235u8);
    let dash_len = 4;
    let dash_period = 12;

    // 1. Subtle dashed grid lines at 100..=900 so UI text and SoM boxes remain crystal-clear
    for step in (100..=900).step_by(100) {
        let is_center = step == 500;
        let line_alpha = if is_center { 0.28 } else { 0.17 };

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

    // 2. Crisp minor ruler tick marks along top & bottom and left & right borders at 50..=950
    let tick_len = 6;
    for step in (50..=950).step_by(100) {
        let tx = (((step as f64) / 1000.0) * w as f64).round() as i32;
        for dy in 0..tick_len {
            blend_pixel(img, tx, dy, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.7);
            blend_pixel(img, tx, h - 1 - dy, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.7);
        }

        let ty = (((step as f64) / 1000.0) * h as f64).round() as i32;
        for dx in 0..tick_len {
            blend_pixel(img, dx, ty, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.7);
            blend_pixel(img, w - 1 - dx, ty, grid_rgb.0, grid_rgb.1, grid_rgb.2, 0.7);
        }
    }

    // 3. Compact scale=1 coordinate labels along BOTTOM edge (X) and RIGHT edge (Y)
    //    so top-left app menus (File/Edit/View/Select/Add/Object) & left toolbars are NEVER covered!
    let pill_w_3digits = (3 * 5) + 2 + 6;
    let pill_h = 7 + 4;

    for step in (100..=900).step_by(100) {
        let label = step.to_string();

        let gx = (((step as f64) / 1000.0) * w as f64).round() as i32;
        draw_label_pill(
            img,
            &label,
            gx - pill_w_3digits / 2,
            h - pill_h - 2,
            1,
            0.78,
            label_rgb,
        );

        let gy = (((step as f64) / 1000.0) * h as f64).round() as i32;
        draw_label_pill(
            img,
            &label,
            w - pill_w_3digits - 2,
            gy - pill_h / 2,
            1,
            0.78,
            label_rgb,
        );
    }

    // 4. Subtle center (500, 500) crosshair
    let cx = w / 2;
    let cy = h / 2;
    let arm = 6;
    for d in -arm..=arm {
        blend_pixel(img, cx + d, cy, 255, 255, 255, 0.65);
        blend_pixel(img, cx, cy + d, 255, 255, 255, 0.65);
    }
}

/// Draws crisp Set-of-Mark (SoM) 2px bounding boxes and high-contrast collision-free `#id` badges
/// for every `DetectedElement` directly onto `img` so even compact VLMs can read every element ID.
pub fn draw_som_overlays(img: &mut RgbaImage, elements: &[DetectedElement]) {
    let w = img.width() as i32;
    let h = img.height() as i32;
    if w < 16 || h < 16 || elements.is_empty() {
        return;
    }

    let scale: i32 = if img.width() >= 1000 { 2 } else { 1 };

    // Precompute pixel boxes and source-coded accent colors
    let mut box_entries: Vec<([i32; 4], (u8, u8, u8), String)> = Vec::with_capacity(elements.len());
    let mut box_rects: Vec<[i32; 4]> = Vec::with_capacity(elements.len());

    for el in elements {
        let px1 = (((el.bbox_norm[0] as f64) / 1000.0) * w as f64).round() as i32;
        let py1 = (((el.bbox_norm[1] as f64) / 1000.0) * h as f64).round() as i32;
        let px2 = (((el.bbox_norm[2] as f64) / 1000.0) * w as f64).round() as i32;
        let py2 = (((el.bbox_norm[3] as f64) / 1000.0) * h as f64).round() as i32;

        let x1 = px1.clamp(0, w - 1);
        let y1 = py1.clamp(0, h - 1);
        let x2 = px2.clamp(x1, w - 1);
        let y2 = py2.clamp(y1, h - 1);

        // Color-coded by source with high contrast for pure white digits:
        // OCR = vivid emerald green, UIA = vivid amber/orange, CV icon = vivid magenta/rose
        let rgb = match el.source.as_str() {
            "a11y" => (217u8, 119u8, 6u8),
            "icon" => (219u8, 39u8, 119u8),
            _ => (16u8, 163u8, 107u8),
        };

        box_rects.push([x1, y1, (x2 - x1 + 1).max(1), (y2 - y1 + 1).max(1)]);
        box_entries.push(([x1, y1, x2, y2], rgb, el.id.to_string()));
    }

    // Pass 1: Draw all 2px bounding boxes first (1px on box edge + 1px outward so small icons stay clear)
    let box_alpha = 0.94;
    for &([x1, y1, x2, y2], (r, g, b), _) in &box_entries {
        let ox1 = (x1 - 1).max(0);
        let oy1 = (y1 - 1).max(0);
        let ox2 = (x2 + 1).min(w - 1);
        let oy2 = (y2 + 1).min(h - 1);

        for x in ox1..=ox2 {
            blend_pixel(img, x, oy1, r, g, b, box_alpha);
            if y1 != oy1 {
                blend_pixel(img, x, y1, r, g, b, box_alpha);
            }
            blend_pixel(img, x, y2, r, g, b, box_alpha);
            if oy2 != y2 {
                blend_pixel(img, x, oy2, r, g, b, box_alpha);
            }
        }
        for y in (y1 + 1)..y2 {
            blend_pixel(img, ox1, y, r, g, b, box_alpha);
            if x1 != ox1 {
                blend_pixel(img, x1, y, r, g, b, box_alpha);
            }
            blend_pixel(img, x2, y, r, g, b, box_alpha);
            if ox2 != x2 {
                blend_pixel(img, ox2, y, r, g, b, box_alpha);
            }
        }
    }

    // Pass 2: Draw solid high-contrast `#id` pills ON TOP of all boxes so lines never cut across digits
    let mut placed_tags: Vec<[i32; 4]> = Vec::with_capacity(elements.len());
    for (idx, ([x1, y1, x2, y2], rgb, id_text)) in box_entries.iter().enumerate() {
        if let Some(tag_rect) = draw_compact_som_tag(
            img,
            id_text,
            *x1,
            *y1,
            *x2,
            *y2,
            scale,
            *rgb,
            &placed_tags,
            &box_rects,
            idx,
        ) {
            placed_tags.push(tag_rect);
        }
    }
}

fn rects_overlap_padded(a: &[i32; 4], b: &[i32; 4], pad: i32) -> bool {
    a[0] - pad < b[0] + b[2]
        && a[0] + a[2] + pad > b[0]
        && a[1] - pad < b[1] + b[3]
        && a[1] + a[3] + pad > b[1]
}

#[allow(clippy::too_many_arguments)]
fn draw_compact_som_tag(
    img: &mut RgbaImage,
    text: &str,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    scale: i32,
    bg_rgb: (u8, u8, u8),
    placed_tags: &[[i32; 4]],
    element_boxes: &[[i32; 4]],
    self_idx: usize,
) -> Option<[i32; 4]> {
    let char_count = text.chars().count() as i32;
    if char_count == 0 {
        return None;
    }
    let scale = scale.max(1);
    let glyph_w = 5 * scale;
    let glyph_h = 7 * scale;
    let spacing = scale;
    let pad_x = if scale >= 2 { 4 } else { 2 };
    let pad_y = if scale >= 2 { 3 } else { 2 };

    let text_w = char_count * glyph_w + (char_count - 1).max(0) * spacing;
    let tag_w = text_w + pad_x * 2;
    let tag_h = glyph_h + pad_y * 2;

    let max_x = (img.width() as i32 - tag_w).max(0);
    let max_y = (img.height() as i32 - tag_h).max(0);
    let gap = 2;

    // Candidate anchor positions around the bounding box
    let candidates = [
        (x1, y1 - tag_h - gap),                    // above-left
        (x1, y2 + gap),                            // below-left
        (x2 + gap, y1),                            // right-top
        (x1 - tag_w - gap, y1),                    // left-top
        (x2 - tag_w, y1 - tag_h - gap),            // above-right
        (x2 - tag_w, y2 + gap),                    // below-right
        (x2 + gap, y2 - tag_h),                    // right-bottom
        (x1 - tag_w - gap, y2 - tag_h),            // left-bottom
        ((x1 + x2 - tag_w) / 2, y1 - tag_h - gap), // above-center
        ((x1 + x2 - tag_w) / 2, y2 + gap),         // below-center
    ];

    let mut chosen: Option<[i32; 4]> = None;

    // Tier 1: No overlap with any placed badge (1px margin) AND no overlap with any other element box
    for (cx, cy) in candidates {
        if cx < 0 || cy < 0 || cx > max_x || cy > max_y {
            continue;
        }
        let rect = [cx, cy, tag_w, tag_h];
        if placed_tags.iter().any(|p| rects_overlap_padded(&rect, p, 1)) {
            continue;
        }
        let hits_other_box = element_boxes
            .iter()
            .enumerate()
            .any(|(i, b)| i != self_idx && rects_overlap_padded(&rect, b, 0));
        if !hits_other_box {
            chosen = Some(rect);
            break;
        }
    }

    // Tier 2: No overlap with any placed badge (1px margin)
    if chosen.is_none() {
        for (cx, cy) in candidates {
            if cx < 0 || cy < 0 || cx > max_x || cy > max_y {
                continue;
            }
            let rect = [cx, cy, tag_w, tag_h];
            if !placed_tags.iter().any(|p| rects_overlap_padded(&rect, p, 1)) {
                chosen = Some(rect);
                break;
            }
        }
    }

    // Tier 3: Nudged secondary ring (for densely packed rows/strips)
    if chosen.is_none() {
        let nudged = [
            (x1, y1 - 2 * tag_h - gap - 2),
            (x1, y2 + tag_h + gap + 2),
            (x2 + tag_w + gap + 2, y1),
            (x1 - 2 * tag_w - gap - 2, y1),
            (x1 + tag_w + 2, y1 - tag_h - gap),
            (x1 + tag_w + 2, y2 + gap),
        ];
        for (cx, cy) in nudged {
            if cx < 0 || cy < 0 || cx > max_x || cy > max_y {
                continue;
            }
            let rect = [cx, cy, tag_w, tag_h];
            if !placed_tags.iter().any(|p| rects_overlap_padded(&rect, p, 1)) {
                chosen = Some(rect);
                break;
            }
        }
    }

    let rect = chosen.unwrap_or([
        x1.clamp(0, max_x),
        (y1 - tag_h - gap).clamp(0, max_y),
        tag_w,
        tag_h,
    ]);
    let (tx, ty) = (rect[0], rect[1]);

    // Solid vivid color-coded pill background (100% opaque for maximum contrast)
    draw_filled_rect(img, tx, ty, tag_w, tag_h, bg_rgb.0, bg_rgb.1, bg_rgb.2, 1.0);

    // Crisp 1px dark outer hairline to separate pills cleanly from both light & dark UI backgrounds
    for dx in 1..(tag_w - 1) {
        blend_pixel(img, tx + dx, ty, 10, 14, 20, 0.85);
        blend_pixel(img, tx + dx, ty + tag_h - 1, 10, 14, 20, 0.85);
    }
    for dy in 1..(tag_h - 1) {
        blend_pixel(img, tx, ty + dy, 10, 14, 20, 0.85);
        blend_pixel(img, tx + tag_w - 1, ty + dy, 10, 14, 20, 0.85);
    }

    // Pure white bold bitmap digits (`10x14` px per digit when scale=2, `5x7` when scale=1)
    let mut cursor_x = tx + pad_x;
    let cursor_y = ty + pad_y;
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
                                    255,
                                    255,
                                    255,
                                    1.0,
                                );
                            }
                        }
                    }
                }
            }
        }
        cursor_x += glyph_w + spacing;
    }

    Some(rect)
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

    #[test]
    fn test_spatial_icon_labels() {
        assert_eq!(spatial_icon_label([956, 21]), "window-control (top-right)");
        assert_eq!(spatial_icon_label([895, 65]), "icon (toolbar-right)");
        assert_eq!(spatial_icon_label([30, 300]), "icon (left-toolbar)");
        assert_eq!(spatial_icon_label([835, 420]), "icon (right-panel)");
        assert_eq!(spatial_icon_label([450, 50]), "icon (top-bar)");
        assert_eq!(spatial_icon_label([500, 640]), "icon (center)");
        assert_eq!(spatial_icon_label([500, 960]), "taskbar-icon (bottom)");
    }

    #[test]
    fn test_draw_som_overlays_high_contrast_scale2() {
        let mut img = RgbaImage::from_pixel(1440, 900, Rgba([40, 40, 44, 255]));
        let elements = vec![
            DetectedElement {
                id: 1,
                label: "File".to_string(),
                source: "ocr".to_string(),
                bbox_norm: [10, 40, 40, 60],
                center_norm: [25, 50],
            },
            DetectedElement {
                id: 2,
                label: "Allow".to_string(),
                source: "a11y".to_string(),
                bbox_norm: [600, 100, 660, 130],
                center_norm: [630, 115],
            },
            DetectedElement {
                id: 3,
                label: "icon (top-right)".to_string(),
                source: "icon".to_string(),
                bbox_norm: [890, 55, 910, 80],
                center_norm: [900, 67],
            },
        ];

        draw_som_overlays(&mut img, &elements);

        // Verify pure white digits and each source's vivid pill color were painted
        let has_white = img.pixels().any(|p| p.0[0] == 255 && p.0[1] == 255 && p.0[2] == 255);
        let has_emerald = img.pixels().any(|p| p.0[0] == 16 && p.0[1] == 163 && p.0[2] == 107);
        let has_amber = img.pixels().any(|p| p.0[0] == 217 && p.0[1] == 119 && p.0[2] == 6);
        let has_magenta = img.pixels().any(|p| p.0[0] == 219 && p.0[1] == 39 && p.0[2] == 119);

        assert!(has_white, "Expected pure white digits on SoM pills");
        assert!(has_emerald, "Expected emerald OCR pill/border");
        assert!(has_amber, "Expected amber UIA pill/border");
        assert!(has_magenta, "Expected magenta CV icon pill/border");
    }

    #[test]
    fn test_ground_image_for_vlm_smoke() {
        let mut img = RgbaImage::from_pixel(1200, 800, Rgba([42, 42, 46, 255]));
        // Draw a crisp synthetic icon in the top-right corner
        let fg = Rgba([180, 185, 195, 255]);
        for dx in 0..28 {
            img.put_pixel(1080 + dx, 44, fg);
            img.put_pixel(1080 + dx, 45, fg);
            img.put_pixel(1080 + dx, 70, fg);
            img.put_pixel(1080 + dx, 71, fg);
        }
        for dy in 0..28 {
            img.put_pixel(1080, 44 + dy, fg);
            img.put_pixel(1081, 44 + dy, fg);
            img.put_pixel(1106, 44 + dy, fg);
            img.put_pixel(1107, 44 + dy, fg);
        }

        let grounded = ScreenCaptureService::ground_image_for_vlm(&img, 0, 0, 0, Some(1440), &[])
            .expect("ground_image_for_vlm should succeed");
        assert_eq!(grounded.screen.width, 1200);
        assert_eq!(grounded.screen.height, 800);
        assert!(!grounded.screen.data.is_empty());
        assert!(
            grounded.elements.iter().any(|e| e.source == "icon" && e.label == "icon (toolbar-right)"),
            "Expected top-right toolbar icon element with spatial label, got {:?}",
            grounded.elements
        );
    }

    #[test]
    fn test_ocr_noise_and_ruler_tick_filtering() {
        assert!(is_ocr_noise_token(">"));
        assert!(is_ocr_noise_token("v"));
        assert!(is_ocr_noise_token("•"));
        assert!(is_ocr_noise_token("1"));
        assert!(!is_ocr_noise_token("x"));
        assert!(!is_ocr_noise_token("+"));
        assert!(!is_ocr_noise_token("Add"));

        let mut elements: Vec<DetectedElement> = (1..=8)
            .map(|i| DetectedElement {
                id: i,
                label: (i * 12).to_string(),
                source: "ocr".to_string(),
                bbox_norm: [(i as i32) * 50, 899, (i as i32) * 50 + 10, 908],
                center_norm: [(i as i32) * 50 + 5, 903],
            })
            .collect();
        elements.push(DetectedElement {
            id: 99,
            label: "Add".to_string(),
            source: "ocr".to_string(),
            bbox_norm: [168, 59, 182, 68],
            center_norm: [175, 63],
        });

        filter_ruler_tick_rows(&mut elements);
        assert_eq!(elements.len(), 1);
        assert_eq!(elements[0].label, "Add");
    }
}
