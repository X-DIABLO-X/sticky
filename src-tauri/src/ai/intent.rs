//! Query intent classification for talk mode: EXPLAIN vs INSTRUCT vs CHAT.

use crate::ai::providers::{ChatMessage, LlmProvider};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryIntent {
    Explain,
    Instruct,
    Chat,
}

impl QueryIntent {
    pub fn as_str(&self) -> &'static str {
        match self {
            QueryIntent::Explain => "explain",
            QueryIntent::Instruct => "instruct",
            QueryIntent::Chat => "chat",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IntentGuess {
    pub intent: QueryIntent,
    /// true when the heuristic is sure enough to skip the LLM fallback.
    pub confident: bool,
}

fn has_any(s: &str, pats: &[&str]) -> bool {
    pats.iter().any(|p| s.contains(p))
}

/// True if the query refers to what is currently on the user's screen.
pub fn is_screen_referential(query: &str) -> bool {
    let q = query.to_lowercase();
    has_any(
        &q,
        &[
            "on my screen", "on the screen", "this page", "this window", "this app", "this button",
            "this menu", "this tab", "what am i looking at", "what's this", "whats this", "what is this",
            "here on", "in front of me", "i'm looking at", "im looking at", "this error", "this code",
        ],
    )
}

pub fn classify_heuristic(query: &str) -> IntentGuess {
    let q = query.trim().to_lowercase();
    let g = |intent, confident| IntentGuess { intent, confident };
    if q.is_empty() {
        return g(QueryIntent::Chat, true);
    }
    let words = q.split_whitespace().count();

    let instruct_strong = [
        "how do i", "how can i", "how to ", "how do you ", "where is", "where's", "where do i", "where can i",
        "show me where", "point to", "point at", "walk me through", "guide me", "help me find",
        "click", "which button", "what button", "take me to", "step by step how", "how would i",
    ];
    let explain_strong = [
        "explain", "what is ", "what are ", "what's the difference", "why does", "why do", "why is", "why are",
        "how does", "how do ", "how is ", "how are ", "visualize", "visualise", "animate", "teach me", "help me understand",
        "intuition", "tell me about", "what happens when", "describe how", "illustrate", "simulate",
    ];
    let action_verbs = [
        "add ", "create ", "delete ", "remove ", "open ", "enable ", "disable ", "install ", "uninstall ",
        "change ", "set up ", "setup ", "turn on", "turn off", "save ", "export ", "import ", "rename ",
        "share ", "find ", "go to ", "navigate ", "switch ", "log in", "sign in", "upload ", "download ",
    ];
    let app_ctx = [
        " in ", " on ", " from ", " using ", " with ", " to my ", " settings", " menu", " button", " tab", " file", " folder",
    ];

    let instruct = has_any(&q, &instruct_strong);
    let explain = has_any(&q, &explain_strong);
    let action = action_verbs.iter().any(|v| q.starts_with(v) || q.contains(&format!("i {}", v.trim_end())) || q.contains(&format!("to {}", v)))
        && (has_any(&q, &app_ctx) || words <= 5);
    let referential = is_screen_referential(&q);

    // "how do I ..." is an instruct, but "how do X work" is explain.
    let how_work = (q.contains("how does") || q.contains("how do ") || q.contains("how is ") || q.contains("how are "))
        && has_any(&q, &[" work", " works", " function", " happen"])
        && !q.contains("how do i") && !q.contains("how do you ");
    if how_work || (explain && !instruct && !action) {
        // "what is this" about screen -> still explain, screenshot kept by caller
        if q.contains("how do i") {
            return g(QueryIntent::Instruct, true);
        }
        return g(QueryIntent::Explain, true);
    }
    if instruct || action {
        if explain && !q.contains("how do i") && !q.contains("how can i") && !q.contains("how to ") {
            return g(QueryIntent::Explain, false);
        }
        return g(QueryIntent::Instruct, true);
    }
    if referential {
        return g(QueryIntent::Explain, false);
    }
    let chat_markers = [
        "hello", "hi ", "hey", "thanks", "thank you", "good morning", "good night", "how are you", "who are you",
        "what's up", "whats up", "lol", "ok", "okay", "cool", "nice", "bye",
    ];
    let first = q.split_whitespace().next().unwrap_or("");
    if words <= 4 && (has_any(&q, &chat_markers) || matches!(first, "hi" | "hey" | "hello" | "thanks" | "ok" | "okay")) {
        return g(QueryIntent::Chat, true);
    }
    // Long or ambiguous: low confidence.
    g(if words <= 3 { QueryIntent::Chat } else { QueryIntent::Explain }, false)
}

pub fn llm_classifier_system_prompt() -> &'static str {
    "Classify the user's spoken query for a screen companion. Answer with EXACTLY ONE WORD, no punctuation:\n\
EXPLAIN = asks to explain/teach/visualize a concept, idea, mechanism or why something is so.\n\
INSTRUCT = asks how to do something or where something is in an app/on their screen (needs click guidance).\n\
CHAT = greeting, thanks, opinion, small talk, or anything else short."
}

pub fn parse_llm_label(text: &str) -> Option<QueryIntent> {
    let t = text.trim().to_uppercase();
    if t.contains("EXPLAIN") {
        Some(QueryIntent::Explain)
    } else if t.contains("INSTRUCT") {
        Some(QueryIntent::Instruct)
    } else if t.contains("CHAT") {
        Some(QueryIntent::Chat)
    } else {
        None
    }
}

/// LLM fallback via a provider. Returns None on any failure.
pub async fn classify_with_provider(provider: &dyn LlmProvider, model: &str, query: &str) -> Option<QueryIntent> {
    let messages = vec![
        ChatMessage::system(llm_classifier_system_prompt()),
        ChatMessage::user(query),
    ];
    let mut rx = provider.stream_chat(model, &messages, &[]).await.ok()?;
    let mut out = String::new();
    let fut = async {
        while let Some(chunk) = rx.recv().await {
            if let Some(d) = chunk.ok()?.delta_text {
                out.push_str(&d);
                if out.len() > 40 {
                    break;
                }
            }
        }
        Some(())
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(6), fut).await;
    parse_llm_label(&out)
}

/// Heuristic first; the caller-provided async fallback runs only on low confidence.
pub async fn classify_query<F, Fut>(query: &str, fallback: F) -> QueryIntent
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<QueryIntent>>,
{
    let guess = classify_heuristic(query);
    if guess.confident {
        return guess.intent;
    }
    fallback().await.unwrap_or(guess.intent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(q: &str) -> QueryIntent {
        classify_heuristic(q).intent
    }

    #[test]
    fn explain_queries() {
        for q in [
            "Explain how gradient descent works",
            "What is a hash map?",
            "Why is the sky blue?",
            "How does a neural network work?",
            "Visualize the Fourier transform",
            "Teach me about recursion",
            "How does TCP handshake work",
        ] {
            assert_eq!(h(q), QueryIntent::Explain, "{q}");
        }
    }

    #[test]
    fn instruct_queries() {
        for q in [
            "How do I save my document?",
            "Where is the settings button?",
            "Add a new slide in PowerPoint",
            "Open the extensions tab in VS Code",
            "Click on the export button",
            "How can I enable dark mode?",
            "Delete this file from the folder",
        ] {
            assert_eq!(h(q), QueryIntent::Instruct, "{q}");
        }
    }

    #[test]
    fn chat_queries() {
        for q in ["hey", "thanks!", "hello there", "ok cool"] {
            assert_eq!(h(q), QueryIntent::Chat, "{q}");
        }
    }

    #[test]
    fn llm_label_parsing() {
        assert_eq!(parse_llm_label(" explain."), Some(QueryIntent::Explain));
        assert_eq!(parse_llm_label("INSTRUCT"), Some(QueryIntent::Instruct));
        assert_eq!(parse_llm_label("chat\n"), Some(QueryIntent::Chat));
        assert_eq!(parse_llm_label("banana"), None);
    }

    #[test]
    fn low_confidence_uses_fallback() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let r = rt.block_on(classify_query("so the thing with the whole stack and memory layout", || async {
            Some(QueryIntent::Instruct)
        }));
        assert_eq!(r, QueryIntent::Instruct);
    }
}
