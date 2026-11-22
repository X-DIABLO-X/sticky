use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use heyclicky_lib::ai::prompts::Prompts;
use heyclicky_lib::ai::providers::openai_codex::{OpenAiCodexProvider, DEFAULT_CODEX_MODEL};
use heyclicky_lib::ai::providers::{ChatMessage, LlmProvider};
use heyclicky_lib::ai::tag_stream::{OverlayCommand, TagStreamParser};
use heyclicky_lib::screen::capture::DetectedElement;

/// End-to-end live test case runner for ChatGPT Codex OAuth (`gpt-6-luna`) on Sticky's
/// calibrated Set-of-Mark Chrome & Blender screenshots (`D:\cliky\ss\out`).
///
/// Usage:
///   cargo run --manifest-path src-tauri/Cargo.toml --example test_codex_testcase
///   cargo run --manifest-path src-tauri/Cargo.toml --example test_codex_testcase -- --login
///   cargo run --manifest-path src-tauri/Cargo.toml --example test_codex_testcase -- --model gpt-6-luna
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let force_login = args.iter().any(|a| a == "--login");
    let model = args
        .windows(2)
        .find(|w| w[0] == "--model")
        .map(|w| w[1].clone())
        .unwrap_or_else(|| DEFAULT_CODEX_MODEL.to_string());

    if force_login || !OpenAiCodexProvider::is_authenticated() {
        println!(">>> ChatGPT Codex auth not found (or --login specified).");
        println!(">>> Opening browser for ChatGPT OAuth sign-in (http://localhost:1455/auth/callback)...");
        let status = OpenAiCodexProvider::start_oauth_login(&model, true).await?;
        println!(
            ">>> Signed in! email={:?} account_id={:?} saved={}",
            status.email, status.account_id, status.auth_path
        );
    } else {
        let status = OpenAiCodexProvider::get_status(&model, true);
        println!(
            ">>> Using existing ChatGPT Codex auth: email={:?} account_id={:?} model={}",
            status.email, status.account_id, status.model
        );
    }

    let provider = OpenAiCodexProvider::new();

    // Test 1: Fast text connectivity smoke test on gpt-6-luna
    println!("\n=== [Test 1] Text Connectivity Smoke Test ({model}) ===");
    let t0 = Instant::now();
    let mut rx = provider
        .stream_chat(
            &model,
            &[
                ChatMessage::system("You are Sticky. Reply concisely in one short sentence."),
                ChatMessage::user("Confirm you are running and ready to help with screen tasks."),
            ],
            &[],
        )
        .await?;
    let mut reply = String::new();
    while let Some(chunk) = rx.recv().await {
        if let Some(delta) = chunk?.delta_text {
            reply.push_str(&delta);
        }
    }
    println!(
        "PASS [{:.2}s]: {}",
        t0.elapsed().as_secs_f32(),
        reply.trim()
    );

    // Test 2: Real Set-of-Mark multimodal vision test cases on Chrome & Blender
    let ss_out = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("ss")
        .join("out");

    let cases = [
        (
            "Chrome Add Shortcut",
            "New Tab - Google Chrome",
            "How do I add a shortcut in Chrome?",
            "grounded_clean_Screenshot 2026-11-22 094019",
        ),
        (
            "Chrome Open Extensions",
            "New Tab - Google Chrome",
            "How do I open extensions or add an extension in Chrome?",
            "grounded_clean_Screenshot 2026-11-22 094019",
        ),
        (
            "Blender Add Cube",
            "Blender 5.3.0",
            "How do I add a cube in Blender?",
            "grounded_clean_Screenshot 2026-11-22 094025",
        ),
        (
            "Blender Delete Cube",
            "Blender 5.3.0",
            "How do I delete a cube in Blender?",
            "grounded_clean_Screenshot 2026-11-22 094025",
        ),
    ];

    use base64::Engine;
    for (name, win_title, query, stem) in cases {
        let jpg_path = ss_out.join(format!("{stem}.jpg"));
        let json_path = ss_out.join(format!("{stem}.json"));
        if !jpg_path.exists() || !json_path.exists() {
            println!("\n[SKIP] {name}: missing {}", jpg_path.display());
            continue;
        }

        let jpeg_bytes = std::fs::read(&jpg_path)?;
        let img_b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
        let elements: Vec<DetectedElement> =
            serde_json::from_str(&std::fs::read_to_string(&json_path)?)?;
        let el_map: HashMap<u32, DetectedElement> =
            elements.iter().map(|e| (e.id, e.clone())).collect();

        let items: Vec<String> = elements
            .iter()
            .map(|el| {
                format!(
                    "#{} \"{}\" ({},{})",
                    el.id,
                    el.label.replace('"', "'"),
                    el.center_norm[0],
                    el.center_norm[1]
                )
            })
            .collect();

        let user_prompt = format!(
            "{query}\n\n[Active Window: \"{win_title}\"]\n[Detected Screen Elements]: {}",
            items.join(", ")
        );

        println!("\n=== [SoM Vision Test] {name} ({model}) ===");
        let t_case = Instant::now();
        let mut rx = provider
            .stream_chat(
                &model,
                &[
                    ChatMessage::system(Prompts::talk_mode_system_prompt()),
                    ChatMessage::user_with_image(user_prompt, img_b64),
                ],
                &[],
            )
            .await?;

        let mut raw = String::new();
        let mut parser = TagStreamParser::new();
        let mut clean_speech = String::new();
        let mut cmds = Vec::new();
        while let Some(chunk) = rx.recv().await {
            if let Some(delta) = chunk?.delta_text {
                raw.push_str(&delta);
                let (c, k) = parser.feed_token(&delta);
                clean_speech.push_str(&c);
                cmds.extend(k);
            }
        }
        let (fc, fk) = parser.flush();
        clean_speech.push_str(&fc);
        cmds.extend(fk);

        println!("Latency: {:.2}s", t_case.elapsed().as_secs_f32());
        println!("Speech : {}", clean_speech.trim());
        println!("Raw    : {}", raw.trim());
        for cmd in &cmds {
            match cmd {
                OverlayCommand::PointRef { element_id, label, .. } => {
                    if let Some(el) = el_map.get(element_id) {
                        println!(
                            "  -> POINT #{} \"{}\" => resolved \"{}\" at ({}, {})",
                            element_id, label, el.label, el.center_norm[0], el.center_norm[1]
                        );
                    } else {
                        println!("  -> POINT #{} \"{}\" => UNKNOWN ID", element_id, label);
                    }
                }
                OverlayCommand::DrawRef { shape, element_id, .. } => {
                    if let Some(el) = el_map.get(element_id) {
                        println!(
                            "  -> DRAW {} #{} => bbox {:?}",
                            shape, element_id, el.bbox_norm
                        );
                    }
                }
                OverlayCommand::Guide { active } => {
                    println!("  -> GUIDE active={active}");
                }
                other => println!("  -> {:?}", other),
            }
        }
    }

    Ok(())
}
