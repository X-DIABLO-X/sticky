use heyclicky_lib::ai::intent::{classify_heuristic, classify_with_provider, QueryIntent};
use heyclicky_lib::ai::prompts::Prompts;
use heyclicky_lib::ai::providers::local_llamacpp::LocalLlamaProvider;
use heyclicky_lib::ai::providers::openai_codex::{OpenAiCodexProvider, DEFAULT_CODEX_MODEL};
use heyclicky_lib::ai::providers::{ChatMessage, LlmProvider};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (label, model, provider): (&str, String, Box<dyn LlmProvider>) =
        if OpenAiCodexProvider::is_authenticated() {
            ("ChatGPT Codex", DEFAULT_CODEX_MODEL.to_string(), Box::new(OpenAiCodexProvider::new()))
        } else {
            ("Local Ollama", "bonsai-2:9b".to_string(), Box::new(LocalLlamaProvider::new("http://127.0.0.1:11434".to_string())))
        };
    println!("INTENT TEST ({label}: {model})");

    let explain = [
        "Explain how gradient descent works",
        "What is a hash map?",
        "Why is the sky blue?",
        "How does a neural network work?",
        "Visualize the Fourier transform",
        "Teach me how recursion works",
        "How does TCP handshake work?",
        "Help me understand how transformers use attention",
    ];
    let instruct = [
        "How do I save my document?",
        "Where is the settings button?",
        "Add a new slide in PowerPoint",
        "Open the extensions tab in VS Code",
        "Click on the export button",
        "How can I enable dark mode?",
        "Delete this file from the folder",
        "Where do I find the print option?",
    ];

    let mut fails = 0usize;
    let mut cases: Vec<(&str, QueryIntent)> = vec![];
    cases.extend(explain.iter().map(|q| (*q, QueryIntent::Explain)));
    cases.extend(instruct.iter().map(|q| (*q, QueryIntent::Instruct)));

    for (q, expected) in cases {
        let guess = classify_heuristic(q);
        let mut intent = guess.intent;
        let mut src = "heuristic";
        if !guess.confident {
            if let Some(i) = classify_with_provider(provider.as_ref(), &model, q).await {
                intent = i;
                src = "llm";
            }
        }
        let class_ok = intent == expected;
        let user_content = if expected == QueryIntent::Instruct {
            format!("{q}\n\n[Detected Screen Elements]:\n#1 \"File\" (24, 36)\n#2 \"Edit\" (58, 36)\n#3 \"Settings\" (940, 36)\n#4 \"Extensions\" (48, 120)\n#5 \"New Slide\" (120, 80)\n#6 \"Export\" (340, 260)\n#7 \"Print\" (60, 200)\n#8 \"Delete\" (450, 300)")
        } else {
            q.to_string()
        };
        let messages = vec![
            ChatMessage::system(Prompts::talk_mode_system_prompt_for(intent)),
            ChatMessage::user(user_content),
        ];
        let mut rx = provider.stream_chat(&model, &messages, &[]).await?;
        let mut reply = String::new();
        while let Some(c) = rx.recv().await {
            if let Some(d) = c?.delta_text {
                reply.push_str(&d);
            }
        }
        let reply_ok = match expected {
            QueryIntent::Explain => reply.contains("[VIZ:anim") && !reply.contains("[POINT") && !reply.contains("[GUIDE"),
            QueryIntent::Instruct => (reply.contains("[POINT") || reply.contains("[DRAW:box")) && !reply.contains("[VIZ:"),
            QueryIntent::Chat => true,
        };
        let ok = class_ok && reply_ok;
        if !ok {
            fails += 1;
        }
        println!(
            "{} [{src}] {:?} -> {:?} (class_ok={class_ok} reply_ok={reply_ok}) {q}",
            if ok { "PASS" } else { "FAIL" },
            expected,
            intent
        );
        if !reply_ok {
            println!("    reply: {}", reply.chars().take(300).collect::<String>().replace('\n', " "));
        }
    }
    println!("failures: {fails}");
    if fails > 0 {
        std::process::exit(1);
    }
    Ok(())
}
