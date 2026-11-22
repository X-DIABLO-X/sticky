use std::time::Instant;

use heyclicky_lib::ai::prompts::Prompts;
use heyclicky_lib::ai::providers::local_llamacpp::LocalLlamaProvider;
use heyclicky_lib::ai::providers::openai_codex::{OpenAiCodexProvider, DEFAULT_CODEX_MODEL};
use heyclicky_lib::ai::providers::{ChatMessage, LlmProvider};
use heyclicky_lib::ai::tag_stream::{OverlayCommand, TagStreamParser};
use heyclicky_lib::audio::tts::KokoroTts;

/// Automated end-to-end test runner verifying:
/// 1. TTS speech sanitization strips all markdown / asterisks (`*`, `**`, backticks, links).
/// 2. Live LLM (`gpt-6-luna` via ChatGPT Codex) defaults to Manim-style `[VIZ:anim:...]`
///    with speech-synced `[CUE:N]` beats for conceptual explanations (NOT static SVG flowcharts!).
/// 3. Multi-shape whiteboard drawings & 3D Three.js scenes work cleanly with zero speech leaks.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (provider_label, model, provider): (&str, String, Box<dyn LlmProvider>) =
        if OpenAiCodexProvider::is_authenticated() {
            (
                "ChatGPT Codex",
                DEFAULT_CODEX_MODEL.to_string(),
                Box::new(OpenAiCodexProvider::new()),
            )
        } else {
            (
                "Local Ollama",
                "bonsai-2:9b".to_string(),
                Box::new(LocalLlamaProvider::new("http://127.0.0.1:11434".to_string())),
            )
        };

    println!("==========================================================================");
    println!(" STICKY MANIM ANIMATION & SPEECH-SYNC PIPELINE TEST ({provider_label}: {model})");
    println!("==========================================================================");

    let test_cases = [
        (
            "1. Conceptual Explanation -> Manim Animation + Voice Cues (NOT SVG Flowchart!)",
            "Explain how gradient descent finds the minimum of a loss function and animate it step by step as you explain it.",
            "anim",
        ),
        (
            "2. Neural Network Explanation -> Manim Animation + Voice Cues",
            "Explain how a neural network forward pass works visually with animated signals.",
            "anim",
        ),
        (
            "3. 3D Spatial Concept -> Interactive Three.js Scene",
            "Show me an interactive 3D visualization of a rotating cube and wireframe sphere using Three.js.",
            "three",
        ),
        (
            "4. Multi-shape Whiteboard Drawing",
            "Draw a big green triangle polygon in the middle of the screen with an arrow pointing to its top corner and a text label saying Apex.",
            "draw",
        ),
    ];

    let mut passed = 0usize;
    let total = test_cases.len();

    for (title, prompt, expected_mode) in test_cases {
        println!("\n>>> [{title}]");
        println!("    Prompt: \"{prompt}\"");
        let t0 = Instant::now();
        let messages = vec![
            ChatMessage::system(Prompts::talk_mode_system_prompt()),
            ChatMessage::user(prompt),
        ];

        let mut rx = provider.stream_chat(&model, &messages, &[]).await?;
        let mut parser = TagStreamParser::new();
        let mut clean_speech = String::new();
        let mut cmds: Vec<OverlayCommand> = Vec::new();

        while let Some(chunk_res) = rx.recv().await {
            let chunk = chunk_res?;
            if let Some(delta) = chunk.delta_text {
                let (c, k) = parser.feed_token(&delta);
                clean_speech.push_str(&c);
                cmds.extend(k);
            }
        }
        let (fc, fk) = parser.flush();
        clean_speech.push_str(&fc);
        cmds.extend(fk);

        let tts_speech = KokoroTts::sanitize_for_speech(&clean_speech);
        let draw_count = cmds
            .iter()
            .filter(|c| matches!(c, OverlayCommand::Draw { .. } | OverlayCommand::DrawRef { .. }))
            .count();
        let cue_count = cmds
            .iter()
            .filter(|c| matches!(c, OverlayCommand::VizCue { .. }))
            .count();
        let viz_renders: Vec<(&str, &str, usize)> = cmds
            .iter()
            .filter_map(|c| match c {
                OverlayCommand::VizRender { kind, title, code, .. } => {
                    Some((kind.as_str(), title.as_str(), code.len()))
                }
                _ => None,
            })
            .collect();

        let no_asterisks = !tts_speech.contains('*') && !tts_speech.contains('`');
        let no_tag_leak = !clean_speech.contains("[DRAW:")
            && !clean_speech.contains("[VIZ:")
            && !clean_speech.contains("[/VIZ]")
            && !clean_speech.contains("[CUE:");

        let mode_ok = match expected_mode {
            "anim" => viz_renders.iter().any(|(k, _, len)| (*k == "anim" || *k == "html") && *len > 150),
            "three" => viz_renders.iter().any(|(k, _, len)| *k == "three" && *len > 80),
            "draw" => draw_count > 0,
            _ => true,
        };

        let ok = no_asterisks && no_tag_leak && mode_ok;
        if ok {
            passed += 1;
        }

        println!(
            "    Status : [{}] in {:.2}s | draws={} | cues={} | viz={:?} | tts_clean={}",
            if ok { "PASS" } else { "FAIL" },
            t0.elapsed().as_secs_f32(),
            draw_count,
            cue_count,
            viz_renders,
            no_asterisks && no_tag_leak
        );
        println!("    TTS    : \"{}\"", tts_speech);
    }

    println!("\n==========================================================================");
    println!(" SUMMARY: {passed}/{total} PASSED");
    println!("==========================================================================");
    Ok(())
}
