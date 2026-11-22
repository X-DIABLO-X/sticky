use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::RgbaImage;
use heyclicky_lib::screen::capture::ScreenCaptureService;

/// Simulates `WDA_EXCLUDEFROMCAPTURE` on historical screenshots that still have Sticky's old
/// floating Pill (top-center), Speech Bubble (mid-right), and Step HUD banner (bottom-center) baked in,
/// by filling those exact Sticky-window rectangles with their local border background pixel.
fn mask_old_sticky_overlays(img: &RgbaImage) -> RgbaImage {
    let mut clean = img.clone();
    let (w, h) = clean.dimensions();
    let rects_norm: [[f32; 4]; 3] = [
        [0.455, 0.015, 0.585, 0.062], // Sticky Ready top-center pill
        [0.705, 0.415, 0.880, 0.485], // Checking your click... floating bubble
        [0.312, 0.910, 0.692, 0.962], // STEP 4 bottom HUD banner
    ];

    for [nx1, ny1, nx2, ny2] in rects_norm {
        let x1 = ((nx1 * w as f32).round() as u32).min(w.saturating_sub(1));
        let y1 = ((ny1 * h as f32).round() as u32).min(h.saturating_sub(1));
        let x2 = ((nx2 * w as f32).round() as u32).min(w);
        let y2 = ((ny2 * h as f32).round() as u32).min(h);
        if x2 <= x1 || y2 <= y1 {
            continue;
        }
        // Sample clean background pixel just outside the top-left of the overlay box
        let sample_x = x1.saturating_sub(4);
        let sample_y = y1.saturating_sub(4);
        let bg = *clean.get_pixel(sample_x, sample_y);
        for y in y1..y2 {
            for x in x1..x2 {
                clean.put_pixel(x, y, bg);
            }
        }
    }
    clean
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let simulate_wda = args.iter().any(|a| a == "--simulate-wda");
    let ss_dir: PathBuf = match args.iter().find(|a| !a.starts_with("--")) {
        Some(arg) => PathBuf::from(arg),
        None => Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("ss"),
    };

    if !ss_dir.exists() {
        return Err(format!("Screenshots directory does not exist: {}", ss_dir.display()).into());
    }

    let out_dir = ss_dir.join("out");
    fs::create_dir_all(&out_dir)?;

    let mut files: Vec<PathBuf> = fs::read_dir(&ss_dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            if !path.is_file() {
                return false;
            }
            match path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()) {
                Some(ext) => matches!(ext.as_str(), "png" | "jpg" | "jpeg"),
                None => false,
            }
        })
        .collect();

    files.sort();

    if files.is_empty() {
        println!("No .png/.jpg files found in {}", ss_dir.display());
        return Ok(());
    }

    println!(
        "{:<36} | {:<11} | {:<11} | {:>4} | {:>5} | {:>5} | {:>8} | {:>7}",
        "Screenshot", "Input Px", "Output Px", "OCR", "Icons", "Total", "JPEG KB", "Elapsed"
    );
    println!("{}", "-".repeat(106));

    for path in files {
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("image");

        let raw_rgba = image::open(&path)?.to_rgba8();
        let (in_w, in_h) = raw_rgba.dimensions();

        let variants: Vec<(&str, RgbaImage)> = if simulate_wda {
            vec![
                ("grounded_", raw_rgba.clone()),
                ("grounded_clean_", mask_old_sticky_overlays(&raw_rgba)),
            ]
        } else {
            vec![("grounded_", raw_rgba)]
        };

        for (prefix, rgba) in variants {
            let t0 = Instant::now();
            let grounded = ScreenCaptureService::ground_image_for_vlm(&rgba, 0, 0, 0, Some(1440), &[])?;
            let elapsed_ms = t0.elapsed().as_millis();

            let ocr_count = grounded.elements.iter().filter(|e| e.source == "ocr").count();
            let icon_count = grounded.elements.iter().filter(|e| e.source == "icon").count();
            let total_count = grounded.elements.len();

            let jpg_path = out_dir.join(format!("{}{}.jpg", prefix, stem));
            let json_path = out_dir.join(format!("{}{}.json", prefix, stem));

            fs::write(&jpg_path, &grounded.screen.data)?;
            let json = serde_json::to_string_pretty(&grounded.elements)?;
            fs::write(&json_path, json)?;

            let jpeg_kb = grounded.screen.data.len() as f64 / 1024.0;
            let label = if prefix == "grounded_clean_" {
                format!("[WDA-clean] {}", file_name)
            } else {
                file_name.to_string()
            };

            println!(
                "{:<36} | {:>4}x{:<6} | {:>4}x{:<6} | {:>4} | {:>5} | {:>5} | {:>7.1}K | {:>5}ms",
                label,
                in_w,
                in_h,
                grounded.screen.width,
                grounded.screen.height,
                ocr_count,
                icon_count,
                total_count,
                jpeg_kb,
                elapsed_ms
            );
            println!("  -> JPEG: {}", jpg_path.display());
            println!("  -> JSON: {}", json_path.display());
        }
    }

    Ok(())
}
