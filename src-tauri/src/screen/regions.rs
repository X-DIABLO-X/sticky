use image::RgbaImage;

/// Detects compact icon-like UI regions (e.g., toolbar buttons, viewport gizmos, unlabeled controls)
/// in a full-resolution screenshot using lightweight classical computer vision (no external dependencies).
///
/// `text_boxes` are OCR word boxes `[x, y, w, h]` in the same full-resolution pixel space;
/// regions overlapping text boxes are excluded so OCR owns text labels while this module owns icons.
/// Returns up to `max_regions` boxes `[x, y, w, h]` in full-res image pixels, sorted top-to-bottom, left-to-right.
pub fn detect_icon_regions(
    img: &RgbaImage,
    text_boxes: &[[i32; 4]],
    max_regions: usize,
) -> Vec<[i32; 4]> {
    let orig_w = img.width() as usize;
    let orig_h = img.height() as usize;
    if orig_w < 16 || orig_h < 16 || max_regions == 0 {
        return Vec::new();
    }

    // 1. Downscale by 2x (2x2 box average) to grayscale for speed (~15-30ms on 1080p release)
    let dw = orig_w / 2;
    let dh = orig_h / 2;
    if dw < 8 || dh < 8 {
        return Vec::new();
    }

    let raw = img.as_raw();
    let mut gray = vec![0u8; dw * dh];
    for y in 0..dh {
        let sy = y * 2;
        let row0 = sy * orig_w * 4;
        let row1 = (sy + 1) * orig_w * 4;
        for x in 0..dw {
            let sx = x * 2 * 4;
            let i00 = row0 + sx;
            let i01 = i00 + 4;
            let i10 = row1 + sx;
            let i11 = i10 + 4;

            let l00 = (raw[i00] as u32 * 77 + raw[i00 + 1] as u32 * 150 + raw[i00 + 2] as u32 * 29) >> 8;
            let l01 = (raw[i01] as u32 * 77 + raw[i01 + 1] as u32 * 150 + raw[i01 + 2] as u32 * 29) >> 8;
            let l10 = (raw[i10] as u32 * 77 + raw[i10 + 1] as u32 * 150 + raw[i10 + 2] as u32 * 29) >> 8;
            let l11 = (raw[i11] as u32 * 77 + raw[i11 + 1] as u32 * 150 + raw[i11 + 2] as u32 * 29) >> 8;

            gray[y * dw + x] = ((l00 + l01 + l10 + l11) >> 2) as u8;
        }
    }

    // 2. Sobel gradient magnitude (L1 approximation: |gx| + |gy|, clamped to 0..255)
    let mut grad = vec![0u8; dw * dh];
    let mut sum: u64 = 0;
    let mut sum_sq: u64 = 0;
    let interior_count = ((dw - 2) * (dh - 2)) as f64;

    for y in 1..(dh - 1) {
        let ym1 = (y - 1) * dw;
        let y0 = y * dw;
        let yp1 = (y + 1) * dw;
        for x in 1..(dw - 1) {
            let tl = gray[ym1 + x - 1] as i32;
            let tc = gray[ym1 + x] as i32;
            let tr = gray[ym1 + x + 1] as i32;
            let ml = gray[y0 + x - 1] as i32;
            let mr = gray[y0 + x + 1] as i32;
            let bl = gray[yp1 + x - 1] as i32;
            let bc = gray[yp1 + x] as i32;
            let br = gray[yp1 + x + 1] as i32;

            let gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
            let gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
            let mag = ((gx.abs() + gy.abs()) >> 2).min(255) as u8;
            grad[y0 + x] = mag;
            sum += mag as u64;
            sum_sq += (mag as u64) * (mag as u64);
        }
    }

    let mean = sum as f64 / interior_count.max(1.0);
    let variance = (sum_sq as f64 / interior_count.max(1.0) - mean * mean).max(0.0);
    let std_dev = variance.sqrt();
    if std_dev < 1.5 && mean < 2.0 {
        // Uniform / blank image
        return Vec::new();
    }

    let thresh = (mean + 1.15 * std_dev).max(26.0).min(110.0) as u8;

    let mut edges = vec![0u8; dw * dh];
    for i in 0..(dw * dh) {
        if grad[i] >= thresh {
            edges[i] = 1;
        }
    }

    // 3. Single 3x3 dilation to merge disjoint strokes of a single icon into one connected blob
    let mut dilated = vec![0u8; dw * dh];
    for y in 1..(dh - 1) {
        let ym1 = (y - 1) * dw;
        let y0 = y * dw;
        let yp1 = (y + 1) * dw;
        for x in 1..(dw - 1) {
            if edges[y0 + x] != 0
                || edges[y0 + x - 1] != 0
                || edges[y0 + x + 1] != 0
                || edges[ym1 + x] != 0
                || edges[yp1 + x] != 0
                || edges[ym1 + x - 1] != 0
                || edges[ym1 + x + 1] != 0
                || edges[yp1 + x - 1] != 0
                || edges[yp1 + x + 1] != 0
            {
                dilated[y0 + x] = 1;
            }
        }
    }

    // 4. Iterative 4-connected component extraction (stack flood-fill, zero recursion)
    let scale = (orig_w as f32 / 1920.0).clamp(0.6, 2.0);
    let min_dim = (11.0 * scale).round() as i32;
    let max_dim = (76.0 * scale).round() as i32;

    let mut visited = vec![0u8; dw * dh];
    let mut stack: Vec<(usize, usize)> = Vec::with_capacity(256);
    let mut candidates: Vec<([i32; 4], f32)> = Vec::new();

    for y in 1..(dh - 1) {
        for x in 1..(dw - 1) {
            let idx = y * dw + x;
            if dilated[idx] == 0 || visited[idx] != 0 {
                continue;
            }

            visited[idx] = 1;
            stack.clear();
            stack.push((x, y));

            let mut min_x = x;
            let mut max_x = x;
            let mut min_y = y;
            let mut max_y = y;
            let mut edge_pixels: u32 = 0;

            while let Some((cx, cy)) = stack.pop() {
                let cidx = cy * dw + cx;
                if edges[cidx] != 0 {
                    edge_pixels += 1;
                }
                if cx < min_x { min_x = cx; }
                if cx > max_x { max_x = cx; }
                if cy < min_y { min_y = cy; }
                if cy > max_y { max_y = cy; }

                // 4-neighbors
                if cx > 1 {
                    let n = cidx - 1;
                    if dilated[n] != 0 && visited[n] == 0 {
                        visited[n] = 1;
                        stack.push((cx - 1, cy));
                    }
                }
                if cx + 1 < dw - 1 {
                    let n = cidx + 1;
                    if dilated[n] != 0 && visited[n] == 0 {
                        visited[n] = 1;
                        stack.push((cx + 1, cy));
                    }
                }
                if cy > 1 {
                    let n = cidx - dw;
                    if dilated[n] != 0 && visited[n] == 0 {
                        visited[n] = 1;
                        stack.push((cx, cy - 1));
                    }
                }
                if cy + 1 < dh - 1 {
                    let n = cidx + dw;
                    if dilated[n] != 0 && visited[n] == 0 {
                        visited[n] = 1;
                        stack.push((cx, cy + 1));
                    }
                }
            }

            // Map back to full-res coordinates
            let fx = (min_x * 2) as i32;
            let fy = (min_y * 2) as i32;
            let fw = ((max_x - min_x + 1) * 2) as i32;
            let fh = ((max_y - min_y + 1) * 2) as i32;

            // 5. Filter by icon size, aspect ratio, and edge density (rejects grid lines, borders, huge panels)
            if fw < min_dim || fh < min_dim || fw > max_dim || fh > max_dim {
                continue;
            }
            let aspect = fw as f32 / fh.max(1) as f32;
            if !(0.45..=2.2).contains(&aspect) {
                continue;
            }

            let ds_area = ((max_x - min_x + 1) * (max_y - min_y + 1)).max(1) as f32;
            let edge_density = edge_pixels as f32 / ds_area;
            if !(0.06..=0.78).contains(&edge_density) {
                continue;
            }

            let bbox = [fx, fy, fw, fh];

            // 6. Exclude regions that overlap OCR text boxes (>25% area or center inside a text box)
            if overlaps_any_text(&bbox, text_boxes) {
                continue;
            }

            // Score favors compact, near-square icons with clean stroke density
            let ideal_size = 28.0 * scale;
            let size_err = ((fw as f32 - ideal_size).abs() + (fh as f32 - ideal_size).abs()) / ideal_size;
            let aspect_err = (aspect - 1.0).abs();
            let score = 1.0 / (1.0 + size_err * 0.5 + aspect_err * 0.8);

            candidates.push((bbox, score));
        }
    }

    // 7. Non-Maximum Suppression (IoU > 0.40 or >70% containment)
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut kept: Vec<[i32; 4]> = Vec::new();
    for (cand, _score) in candidates {
        let suppressed = kept.iter().any(|existing| {
            let inter = intersection_area(&cand, existing);
            if inter <= 0.0 {
                return false;
            }
            let a_cand = (cand[2] * cand[3]).max(1) as f32;
            let a_exist = (existing[2] * existing[3]).max(1) as f32;
            let iou = inter / (a_cand + a_exist - inter).max(1.0);
            let contain = inter / a_cand.min(a_exist);
            iou > 0.40 || contain > 0.70
        });
        if !suppressed {
            kept.push(cand);
        }
    }

    // 8. Sort top-to-bottom (row bands of ~8*s px), left-to-right, and truncate to max_regions
    let row_band = (8.0 * scale).round().max(4.0) as i32;
    kept.sort_by_key(|b| (b[1] / row_band, b[0]));
    kept.truncate(max_regions);
    kept
}

fn intersection_area(a: &[i32; 4], b: &[i32; 4]) -> f32 {
    let x1 = a[0].max(b[0]);
    let y1 = a[1].max(b[1]);
    let x2 = (a[0] + a[2]).min(b[0] + b[2]);
    let y2 = (a[1] + a[3]).min(b[1] + b[3]);
    let w = (x2 - x1).max(0);
    let h = (y2 - y1).max(0);
    (w * h) as f32
}

fn overlaps_any_text(region: &[i32; 4], text_boxes: &[[i32; 4]]) -> bool {
    let r_area = (region[2] * region[3]).max(1) as f32;
    let cx = region[0] + region[2] / 2;
    let cy = region[1] + region[3] / 2;

    for tb in text_boxes {
        if tb[2] <= 0 || tb[3] <= 0 {
            continue;
        }
        // Center lies inside a text box (with 2px tolerance)
        if cx >= tb[0] - 2
            && cx <= tb[0] + tb[2] + 2
            && cy >= tb[1] - 2
            && cy <= tb[1] + tb[3] + 2
        {
            return true;
        }
        let inter = intersection_area(region, tb);
        if inter / r_area > 0.25 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn draw_icon_square(img: &mut RgbaImage, x: u32, y: u32, size: u32) {
        let fg = Rgba([220, 225, 235, 255]);
        for dx in 0..size {
            img.put_pixel(x + dx, y, fg);
            img.put_pixel(x + dx, y + 1, fg);
            img.put_pixel(x + dx, y + size - 1, fg);
            img.put_pixel(x + dx, y + size - 2, fg);
        }
        for dy in 0..size {
            img.put_pixel(x, y + dy, fg);
            img.put_pixel(x + 1, y + dy, fg);
            img.put_pixel(x + size - 1, y + dy, fg);
            img.put_pixel(x + size - 2, y + dy, fg);
        }
        // Plus shape inside icon
        let mid = size / 2;
        for d in 5..(size - 5) {
            img.put_pixel(x + d, y + mid, fg);
            img.put_pixel(x + mid, y + d, fg);
        }
    }

    #[test]
    fn test_regions_empty_inputs() {
        let tiny = RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255]));
        assert!(detect_icon_regions(&tiny, &[], 50).is_empty());

        let black = RgbaImage::from_pixel(320, 240, Rgba([0, 0, 0, 255]));
        assert!(detect_icon_regions(&black, &[], 50).is_empty());

        let white = RgbaImage::from_pixel(320, 240, Rgba([255, 255, 255, 255]));
        assert!(detect_icon_regions(&white, &[], 50).is_empty());
    }

    #[test]
    fn test_regions_detects_synthetic_icons() {
        let mut img = RgbaImage::from_pixel(800, 600, Rgba([40, 40, 44, 255]));

        // 4 synthetic toolbar icons
        let icons = [(30u32, 80u32), (30, 140), (30, 200), (720, 90)];
        for &(ix, iy) in &icons {
            draw_icon_square(&mut img, ix, iy, 28);
        }

        // Long 1px horizontal divider line across the whole width (must NOT be detected)
        for x in 0..800 {
            img.put_pixel(x, 400, Rgba([180, 180, 180, 255]));
        }

        let detected = detect_icon_regions(&img, &[], 60);
        assert!(
            detected.len() >= 4,
            "Expected at least 4 detected icons, got {:?}",
            detected
        );
        for b in &detected {
            assert!(b[2] <= 200, "Long line/border leaked into icon regions: {:?}", b);
        }

        for &(ix, iy) in &icons {
            let cx = (ix + 14) as i32;
            let cy = (iy + 14) as i32;
            let hit = detected.iter().any(|b| {
                cx >= b[0] - 4 && cx <= b[0] + b[2] + 4 && cy >= b[1] - 4 && cy <= b[1] + b[3] + 4
            });
            assert!(hit, "Expected icon at ({},{}) to be detected; got {:?}", cx, cy, detected);
        }
    }

    #[test]
    fn test_regions_excludes_text() {
        let mut img = RgbaImage::from_pixel(640, 480, Rgba([38, 38, 42, 255]));
        draw_icon_square(&mut img, 100, 100, 28);
        draw_icon_square(&mut img, 240, 100, 28);

        let text_boxes = [[96, 96, 36, 36]];
        let detected = detect_icon_regions(&img, &text_boxes, 40);

        let hit_covered = detected.iter().any(|b| {
            let cx = 114;
            let cy = 114;
            cx >= b[0] && cx <= b[0] + b[2] && cy >= b[1] && cy <= b[1] + b[3]
        });
        assert!(!hit_covered, "Covered text box should have been excluded: {:?}", detected);

        let hit_uncovered = detected.iter().any(|b| {
            let cx = 254;
            let cy = 114;
            cx >= b[0] - 4 && cx <= b[0] + b[2] + 4 && cy >= b[1] - 4 && cy <= b[1] + b[3] + 4
        });
        assert!(hit_uncovered, "Uncovered icon should still be detected: {:?}", detected);
    }
}
