use image::RgbaImage;

/// A detected text word or short UI phrase with its pixel bounding box `[x, y, width, height]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrWord {
    pub text: String,
    pub bbox: [i32; 4],
}

/// Extracts text words and short tightly-spaced UI phrases (e.g. `"Object Mode"`, `"Add Modifier"`)
/// from an RGBA image using native Windows `Windows.Media.Ocr`.
///
/// Returns an empty `Vec` gracefully on non-Windows platforms or if WinRT OCR is unavailable.
pub fn extract_ocr_words(img: &RgbaImage) -> Vec<OcrWord> {
    #[cfg(windows)]
    {
        if img.width() == 0 || img.height() == 0 {
            return Vec::new();
        }
        match extract_ocr_words_winrt(img) {
            Ok(words) => words,
            Err(e) => {
                eprintln!("[OCR] WinRT OCR failed: {e}");
                Vec::new()
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = img;
        Vec::new()
    }
}

#[cfg(windows)]
fn extract_ocr_words_winrt(img: &RgbaImage) -> windows::core::Result<Vec<OcrWord>> {
    use image::imageops::FilterType;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let max_dim = OcrEngine::MaxImageDimension().unwrap_or(2600).max(64);

    let orig_w = img.width();
    let orig_h = img.height();

    // Scale down only if image exceeds WinRT OcrEngine's maximum supported dimension
    let (work_img, scale_x, scale_y) = if orig_w > max_dim || orig_h > max_dim {
        let ratio = (max_dim as f64 / orig_w.max(orig_h) as f64).min(1.0);
        let new_w = ((orig_w as f64 * ratio).floor() as u32).max(1);
        let new_h = ((orig_h as f64 * ratio).floor() as u32).max(1);
        let resized = image::imageops::resize(img, new_w, new_h, FilterType::Triangle);
        (
            Some(resized),
            orig_w as f64 / new_w as f64,
            orig_h as f64 / new_h as f64,
        )
    } else {
        (None, 1.0, 1.0)
    };

    let src = work_img.as_ref().unwrap_or(img);
    let buf = CryptographicBuffer::CreateFromByteArray(src.as_raw())?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buf,
        BitmapPixelFormat::Rgba8,
        src.width() as i32,
        src.height() as i32,
        BitmapAlphaMode::Premultiplied,
    )?;

    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    let lines = result.Lines()?;

    let mut out = Vec::new();

    for line in lines {
        let Ok(words) = line.Words() else {
            continue;
        };

        let mut line_words: Vec<OcrWord> = Vec::new();
        for word in words {
            let Ok(text_hstr) = word.Text() else {
                continue;
            };
            let text = text_hstr.to_string();
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }

            let Ok(rect) = word.BoundingRect() else {
                continue;
            };

            let x = (rect.X as f64 * scale_x).round() as i32;
            let y = (rect.Y as f64 * scale_y).round() as i32;
            let w = (rect.Width as f64 * scale_x).round() as i32;
            let h = (rect.Height as f64 * scale_y).round() as i32;

            if w < 4 || h < 4 {
                continue;
            }

            line_words.push(OcrWord {
                text: trimmed.to_string(),
                bbox: [x, y, w, h],
            });
        }

        if line_words.is_empty() {
            continue;
        }

        // Ensure left-to-right ordering within the line before phrase merging
        line_words.sort_by_key(|w| w.bbox[0]);

        // Merge tightly-spaced adjacent words on the same line (e.g. "Object Mode",
        // "Add Modifier", "Back to Previous") while keeping separate menu items
        // ("View  Select  Add  Object") as distinct bounding boxes.
        let mut iter = line_words.into_iter();
        if let Some(mut current) = iter.next() {
            for next in iter {
                let cur_right = current.bbox[0] + current.bbox[2];
                let gap = next.bbox[0] - cur_right;
                let max_h = current.bbox[3].max(next.bbox[3]);
                let merge_threshold = ((max_h as f32) * 0.78).round() as i32;
                let merged_len = current.text.len() + 1 + next.text.len();

                if gap <= merge_threshold && gap >= -(max_h / 2) && merged_len <= 40 {
                    let nx1 = current.bbox[0].min(next.bbox[0]);
                    let ny1 = current.bbox[1].min(next.bbox[1]);
                    let nx2 = (current.bbox[0] + current.bbox[2]).max(next.bbox[0] + next.bbox[2]);
                    let ny2 = (current.bbox[1] + current.bbox[3]).max(next.bbox[1] + next.bbox[3]);
                    current.text.push(' ');
                    current.text.push_str(&next.text);
                    current.bbox = [nx1, ny1, (nx2 - nx1).max(1), (ny2 - ny1).max(1)];
                } else {
                    out.push(current);
                    current = next;
                }
            }
            out.push(current);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn test_winrt_ocr_smoke() {
        // 1. Blank image should run cleanly without panicking and return 0 words.
        let blank = RgbaImage::from_pixel(200, 60, Rgba([255, 255, 255, 255]));
        let words = extract_ocr_words(&blank);
        assert!(
            words.is_empty(),
            "Expected no OCR words on blank image, got {:?}",
            words
        );

        // 2. If a real monitor is available in this test session, also verify OCR runs cleanly on it.
        if let Ok(monitors) = xcap::Monitor::all() {
            if let Some(monitor) = monitors.first() {
                if let Ok(screen_img) = monitor.capture_image() {
                    let detected = extract_ocr_words(&screen_img);
                    // Verify all returned bounding boxes are valid positive dimensions
                    for w in &detected {
                        assert!(!w.text.is_empty());
                        assert!(w.bbox[2] >= 4 && w.bbox[3] >= 4);
                    }
                }
            }
        }
    }
}
