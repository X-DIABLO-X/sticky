use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum OverlayCommand {
    Point {
        x: i32,
        y: i32,
        label: String,
        screen: String,
    },
    Draw {
        shape: String,
        coords: Vec<i32>,
        color: Option<String>,
        label: Option<String>,
    },
    Model3D {
        model: String,
        title: String,
    },
    Step {
        index: usize,
        total: usize,
        bbox: [i32; 4],
        instruction: String,
    },
    Raw(String),
}

pub struct TagStreamParser {
    tag_buffer: String,
    is_in_tag: bool,
    last_char_was_space: bool,
    just_closed_tag: bool,
}

impl Default for TagStreamParser {
    fn default() -> Self {
        Self::new()
    }
}

impl TagStreamParser {
    pub fn new() -> Self {
        Self {
            tag_buffer: String::with_capacity(256),
            is_in_tag: false,
            last_char_was_space: false,
            just_closed_tag: false,
        }
    }

    /// Process an incoming streaming token.
    /// Returns clean text to send to TTS and any parsed overlay commands.
    pub fn feed_token(&mut self, token: &str) -> (String, Vec<OverlayCommand>) {
        let mut clean_text = String::new();
        let mut commands = Vec::new();

        for ch in token.chars() {
            if self.is_in_tag {
                self.tag_buffer.push(ch);
                if ch == ']' {
                    // Closed bracket: parse tag
                    let tag_content = self.tag_buffer.trim_matches(|c| c == '[' || c == ']');
                    if let Some(cmd) = parse_tag(tag_content) {
                        commands.push(cmd);
                        self.just_closed_tag = true;
                    } else {
                        // Unrecognized tag: output as raw text
                        clean_text.push_str(&self.tag_buffer);
                        self.last_char_was_space = self.tag_buffer.ends_with(' ');
                    }
                    self.tag_buffer.clear();
                    self.is_in_tag = false;
                } else if self.tag_buffer.len() > 128 {
                    // Tag too long without closing bracket, abort and flush as text
                    clean_text.push_str(&self.tag_buffer);
                    self.last_char_was_space = self.tag_buffer.ends_with(' ');
                    self.tag_buffer.clear();
                    self.is_in_tag = false;
                }
            } else if ch == '[' {
                self.is_in_tag = true;
                self.tag_buffer.clear();
                self.tag_buffer.push('[');
            } else {
                if self.just_closed_tag && ch == ' ' && self.last_char_was_space {
                    // Skip redundant space left behind after stripping an inline tag
                    self.just_closed_tag = false;
                    continue;
                }
                self.just_closed_tag = false;
                self.last_char_was_space = ch == ' ';
                clean_text.push(ch);
            }
        }

        (clean_text, commands)
    }

    /// Flush any remaining buffered characters at the end of the stream
    pub fn flush(&mut self) -> (String, Vec<OverlayCommand>) {
        let mut clean_text = String::new();
        let mut commands = Vec::new();

        if self.is_in_tag && !self.tag_buffer.is_empty() {
            let tag_content = self.tag_buffer.trim_matches(|c| c == '[' || c == ']');
            if let Some(cmd) = parse_tag(tag_content) {
                commands.push(cmd);
            } else {
                clean_text.push_str(&self.tag_buffer);
            }
            self.tag_buffer.clear();
            self.is_in_tag = false;
        }

        (clean_text, commands)
    }
}

fn parse_tag(content: &str) -> Option<OverlayCommand> {
    let parts: Vec<&str> = content.split(':').collect();
    if parts.is_empty() {
        return None;
    }

    match parts[0].to_uppercase().as_str() {
        "POINT" => {
            // [POINT:x,y:label:screenN] or [POINT:x,y:label]
            if parts.len() >= 3 {
                let coords: Vec<&str> = parts[1].split(',').collect();
                let x = coords.first()?.trim().parse::<i32>().ok()?;
                let y = coords.get(1)?.trim().parse::<i32>().ok()?;
                let label = parts[2].trim().to_string();
                let screen = parts.get(3).unwrap_or(&"screen0").trim().to_string();
                Some(OverlayCommand::Point { x, y, label, screen })
            } else {
                None
            }
        }
        "DRAW" => {
            // [DRAW:circle:x,y,r:color] or [DRAW:box:x1,y1,x2,y2:label]
            if parts.len() >= 3 {
                let shape = parts[1].trim().to_string();
                let coords: Vec<i32> = parts[2]
                    .split(',')
                    .filter_map(|s| s.trim().parse::<i32>().ok())
                    .collect();
                let color_or_label = parts.get(3).map(|s| s.trim().to_string());
                Some(OverlayCommand::Draw {
                    shape,
                    coords,
                    color: color_or_label.clone(),
                    label: color_or_label,
                })
            } else {
                None
            }
        }
        "3D" => {
            // [3D:preset_or_gltf:title]
            if parts.len() >= 2 {
                let model = parts[1].trim().to_string();
                let title = parts.get(2).unwrap_or(&"3D Object").trim().to_string();
                Some(OverlayCommand::Model3D { model, title })
            } else {
                None
            }
        }
        "STEP" => {
            // [STEP:idx/total:x1,y1,x2,y2:instruction]
            if parts.len() >= 4 {
                let idx_parts: Vec<&str> = parts[1].split('/').collect();
                let index = idx_parts.first()?.trim().parse::<usize>().ok()?;
                let total = idx_parts.get(1).and_then(|s| s.trim().parse::<usize>().ok()).unwrap_or(15);
                let coords: Vec<i32> = parts[2]
                    .split(',')
                    .filter_map(|s| s.trim().parse::<i32>().ok())
                    .collect();
                let bbox = if coords.len() == 4 {
                    [coords[0], coords[1], coords[2], coords[3]]
                } else {
                    [0, 0, 100, 100]
                };
                let instruction = parts[3].trim().to_string();
                Some(OverlayCommand::Step {
                    index,
                    total,
                    bbox,
                    instruction,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point_tag_extraction_and_speech_clean() {
        let mut parser = TagStreamParser::new();
        let tokens = vec![
            "Click ", "the ", "export ", "button ",
            "[POINT:850,60:Export:screen0]",
            " to save your video."
        ];

        let mut all_clean = String::new();
        let mut all_cmds = Vec::new();

        for t in tokens {
            let (clean, cmds) = parser.feed_token(t);
            all_clean.push_str(&clean);
            all_cmds.extend(cmds);
        }
        let (clean, cmds) = parser.flush();
        all_clean.push_str(&clean);
        all_cmds.extend(cmds);

        assert_eq!(all_clean, "Click the export button to save your video.");
        assert_eq!(all_cmds.len(), 1);
        match &all_cmds[0] {
            OverlayCommand::Point { x, y, label, screen } => {
                assert_eq!(*x, 850);
                assert_eq!(*y, 60);
                assert_eq!(label, "Export");
                assert_eq!(screen, "screen0");
            }
            _ => panic!("Expected Point command"),
        }
    }

    #[test]
    fn test_chunked_tag_split_across_tokens() {
        let mut parser = TagStreamParser::new();
        // Tag split across multiple streaming tokens
        let tokens = vec!["Look ", "here ", "[PO", "INT:50", "0,250:Logo]", " now."];

        let mut all_clean = String::new();
        let mut all_cmds = Vec::new();

        for t in tokens {
            let (clean, cmds) = parser.feed_token(t);
            all_clean.push_str(&clean);
            all_cmds.extend(cmds);
        }

        assert_eq!(all_clean, "Look here now.");
        assert_eq!(all_cmds.len(), 1);
        match &all_cmds[0] {
            OverlayCommand::Point { x, y, label, .. } => {
                assert_eq!(*x, 500);
                assert_eq!(*y, 250);
                assert_eq!(label, "Logo");
            }
            _ => panic!("Expected Point command"),
        }
    }

    #[test]
    fn test_draw_tags() {
        let mut parser = TagStreamParser::new();
        let (clean, cmds) = parser.feed_token("Examine [DRAW:circle:400,300,80:#38bdf8] the canvas.");
        assert_eq!(clean, "Examine the canvas.");
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            OverlayCommand::Draw { shape, coords, color, .. } => {
                assert_eq!(shape, "circle");
                assert_eq!(coords, &[400, 300, 80]);
                assert_eq!(color.as_deref(), Some("#38bdf8"));
            }
            _ => panic!("Expected Draw circle command"),
        }
    }

    #[test]
    fn test_step_tag() {
        let mut parser = TagStreamParser::new();
        let (clean, cmds) = parser.feed_token("Step 1: [STEP:1/4:120,80,240,110:Click Settings] Open menu.");
        assert_eq!(clean, "Step 1: Open menu.");
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            OverlayCommand::Step { index, total, bbox, instruction } => {
                assert_eq!(*index, 1);
                assert_eq!(*total, 4);
                assert_eq!(bbox, &[120, 80, 240, 110]);
                assert_eq!(instruction, "Click Settings");
            }
            _ => panic!("Expected Step command"),
        }
    }
}
