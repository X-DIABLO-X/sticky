use std::time::Instant;

use heyclicky_lib::ai::prompts::Prompts;
use heyclicky_lib::ai::providers::local_llamacpp::LocalLlamaProvider;
use heyclicky_lib::ai::providers::openai_codex::{OpenAiCodexProvider, DEFAULT_CODEX_MODEL};
use heyclicky_lib::ai::providers::{ChatMessage, LlmProvider};
use heyclicky_lib::ai::tag_stream::{OverlayCommand, TagStreamParser};

/// Automated end-to-end test runner verifying Sticky's LLM drawing (`[DRAW:...]`) and
/// live code-generated visualization (`[VIZ:html|three|mermaid|chart:...]...[/VIZ]`) pipeline.
///
/// Automatically uses ChatGPT Codex (`gpt-6-luna`) if signed in, otherwise falls back to local Ollama (`bonsai-2:9b`).
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
    println!(" STICKY DRAWING & CODE-VISUALIZATION PIPELINE TEST ({provider_label}: {model})");
    println!("==========================================================================");

    let test_cases = [
        (
            "1. Multi-shape Whiteboard Drawing",
            "Draw a big green triangle polygon in the middle of the screen with an arrow pointing to its top corner and a text label saying Apex.",
        ),
        (
            "2. Interactive HTML5 Canvas Physics Visualization",
            "Create an interactive live visualization comparing ease-in-out vs spring physics with sliders so I can see how they move differently.",
        ),
        (
            "3. Interactive 3D Three.js Visualization",
            "Show me an interactive 3D visualization of a rotating cube and wireframe sphere using Three.js.",
        ),
        (
            "4. Mermaid Diagram Visualization",
            "Visualize a flowchart diagram showing User Voice -> Speech to Text -> LLM -> Screen Overlay.",
        ),
    ];

    let mut passed = 0usize;
    let total = test_cases.len();

    for (title, prompt) in test_cases {
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

        let draw_count = cmds
            .iter()
            .filter(|c| matches!(c, OverlayCommand::Draw { .. } | OverlayCommand::DrawRef { .. }))
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

        let speech_clean = !clean_speech.contains("[DRAW:")
            && !clean_speech.contains("[VIZ:")
            && !clean_speech.contains("[/VIZ]");
        let ok = speech_clean && (draw_count > 0 || !viz_renders.is_empty());
        if ok {
            passed += 1;
        }

        println!(
            "    Status : [{}] in {:.2}s | draws={} | viz_blocks={:?} | speech_clean={}",
            if ok { "PASS" } else { "FAIL" },
            t0.elapsed().as_secs_f32(),
            draw_count,
            viz_renders,
            speech_clean
        );
        println!("    Speech : \"{}\"", clean_speech.trim());
    }

    println!("\n==========================================================================");
    println!(" SUMMARY: {passed}/{total} PASSED");
    println!("==========================================================================");
    Ok(())
}
