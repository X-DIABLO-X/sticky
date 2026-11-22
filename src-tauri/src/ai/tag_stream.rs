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
    PointRef {
        element_id: u32,
        label: String,
        screen: String,
    },
    Draw {
        shape: String,
        coords: Vec<i32>,
        color: Option<String>,
        label: Option<String>,
    },
    DrawRef {
        shape: String,
        element_id: u32,
        target_element_id: Option<u32>,
        color: Option<String>,
        label: Option<String>,
    },
    Model3D {
        model: String,
        title: String,
    },
    VizLoading {
        kind: String,
        title: String,
    },
    VizRender {
        id: String,
        kind: String,
        title: String,
        code: String,
        width: Option<u32>,
        height: Option<u32>,
    },
    VizClose,
    Step {
        index: usize,
        total: usize,
        bbox: [i32; 4],
        instruction: String,
    },
    ClearDrawings,
    Guide {
        active: bool,
    },
    Raw(String),
}

const MAX_INLINE_TAG_BYTES: usize = 2048;
const MAX_VIZ_CODE_BYTES: usize = 65536;

pub struct TagStreamParser {
    tag_buffer: String,
    is_in_tag: bool,
    last_char_was_space: bool,
    just_closed_tag: bool,
    in_viz_block: bool,
    viz_kind: String,
    viz_title: String,
    viz_width: Option<u32>,
    viz_height: Option<u32>,
    viz_code_buffer: String,
}

impl Default for TagStreamParser {
    fn default() -> Self {
        Self::new()
    }
}

impl TagStreamParser {
    pub fn new() -> Self {
        Self {
            tag_buffer: String::with_capacity(512),
            is_in_tag: false,
            last_char_was_space: false,
            just_closed_tag: false,
            in_viz_block: false,
            viz_kind: String::new(),
            viz_title: String::new(),
            viz_width: None,
            viz_height: None,
            viz_code_buffer: String::new(),
        }
    }

    fn finalize_viz_block(&mut self) -> Option<OverlayCommand> {
        let code = strip_outer_code_fence(&self.viz_code_buffer);
        let kind = std::mem::take(&mut self.viz_kind);
        let title = std::mem::take(&mut self.viz_title);
        let width = self.viz_width.take();
        let height = self.viz_height.take();
        self.viz_code_buffer.clear();
        self.in_viz_block = false;
        self.just_closed_tag = true;

        if code.is_empty() {
            return None;
        }

        Some(OverlayCommand::VizRender {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            title,
            code,
            width,
            height,
        })
    }

    /// Process an incoming streaming token.
    /// Returns clean text to send to TTS and any parsed overlay commands.
    pub fn feed_token(&mut self, token: &str) -> (String, Vec<OverlayCommand>) {
        let mut clean_text = String::new();
        let mut commands = Vec::new();

        for ch in token.chars() {
            if self.in_viz_block {
                self.viz_code_buffer.push(ch);
                if ends_with_viz_close(&self.viz_code_buffer) {
                    let new_len = self.viz_code_buffer.len() - 6;
                    self.viz_code_buffer.truncate(new_len);
                    if let Some(cmd) = self.finalize_viz_block() {
                        commands.push(cmd);
                    }
                } else if self.viz_code_buffer.len() > MAX_VIZ_CODE_BYTES {
                    if let Some(cmd) = self.finalize_viz_block() {
                        commands.push(cmd);
                    }
                }
                continue;
            }

            if self.is_in_tag {
                if ch == '[' {
                    // Unclosed '[' in prose before a real tag: flush old buffer as prose and start fresh
                    clean_text.push_str(&self.tag_buffer);
                    self.last_char_was_space = self.tag_buffer.ends_with(' ');
                    self.tag_buffer.clear();
                    self.tag_buffer.push('[');
                    continue;
                }
                self.tag_buffer.push(ch);
                if ch == ']' {
                    // Closed bracket: parse tag
                    let tag_content = self.tag_buffer.trim_matches(|c| c == '[' || c == ']');
                    if let Some((kind, title, width, height)) = parse_viz_open_tag(tag_content) {
                        self.in_viz_block = true;
                        self.viz_kind = kind.clone();
                        self.viz_title = title.clone();
                        self.viz_width = width;
                        self.viz_height = height;
                        self.viz_code_buffer.clear();
                        commands.push(OverlayCommand::VizLoading { kind, title });
                        self.just_closed_tag = true;
                    } else if let Some(cmd) = parse_tag(tag_content) {
                        commands.push(cmd);
                        self.just_closed_tag = true;
                    } else {
                        // Unrecognized tag: output as raw text
                        clean_text.push_str(&self.tag_buffer);
                        self.last_char_was_space = self.tag_buffer.ends_with(' ');
                    }
                    self.tag_buffer.clear();
                    self.is_in_tag = false;
                } else if self.tag_buffer.len() > MAX_INLINE_TAG_BYTES {
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

        if self.in_viz_block {
            if let Some(cmd) = self.finalize_viz_block() {
                commands.push(cmd);
            }
            return (clean_text, commands);
        }

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

fn ends_with_viz_close(s: &str) -> bool {
    let len = s.len();
    len >= 6
        && s.is_char_boundary(len - 6)
        && s[len - 6..].eq_ignore_ascii_case("[/viz]")
}

fn strip_outer_code_fence(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(after_open) = trimmed.strip_prefix("```") {
        let body = match after_open.find('\n') {
            Some(idx) => &after_open[idx + 1..],
            None => after_open,
        };
        let body_trimmed = body.trim_end();
        let stripped = body_trimmed.strip_suffix("```").unwrap_or(body_trimmed);
        stripped.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_dimensions(raw: &str) -> Option<(u32, u32)> {
    let trimmed = raw.trim();
    let (w_str, h_str) = trimmed
        .split_once('x')
        .or_else(|| trimmed.split_once('X'))?;
    let w = w_str.trim().parse::<u32>().ok()?;
    let h = h_str.trim().parse::<u32>().ok()?;
    if w > 0 && h > 0 {
        Some((w, h))
    } else {
        None
    }
}

fn parse_viz_open_tag(content: &str) -> Option<(String, String, Option<u32>, Option<u32>)> {
    let parts: Vec<&str> = content.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    if !parts[0].trim().eq_ignore_ascii_case("VIZ") {
        return None;
    }

    let kind = parts[1].trim().to_lowercase();
    match kind.as_str() {
        "html" | "canvas" | "svg" | "mermaid" | "three" | "chart" => {}
        _ => return None,
    }

    let (title, width, height) = if parts.len() >= 4 {
        if let Some((w, h)) = parse_dimensions(parts[parts.len() - 1]) {
            let t = parts[2..parts.len() - 1].join(":").trim().to_string();
            (t, Some(w), Some(h))
        } else {
            let t = parts[2..].join(":").trim().to_string();
            (t, None, None)
        }
    } else if parts.len() == 3 {
        (parts[2].trim().to_string(), None, None)
    } else {
        (String::new(), None, None)
    };

    let final_title = if title.is_empty() {
        "Visualization".to_string()
    } else {
        title
    };

    Some((kind, final_title, width, height))
}

fn parse_color_and_label_slice(tail: &[&str]) -> (Option<String>, Option<String>) {
    let mut color: Option<String> = None;
    let mut label: Option<String> = None;

    if let Some(first) = tail.first() {
        let trimmed = first.trim();
        if trimmed.starts_with('#') {
            color = Some(trimmed.to_string());
            if tail.len() >= 2 {
                let lbl = tail[1..].join(":").trim().to_string();
                if !lbl.is_empty() {
                    label = Some(lbl);
                }
            }
        } else if !trimmed.is_empty() {
            let lbl = tail.join(":").trim().to_string();
            if !lbl.is_empty() {
                label = Some(lbl);
            }
        } else if tail.len() >= 2 {
            let lbl = tail[1..].join(":").trim().to_string();
            if !lbl.is_empty() {
                label = Some(lbl);
            }
        }
    }

    (color, label)
}

fn parse_element_id_token(raw: &str) -> Option<u32> {
    let trimmed = raw.trim();
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed).trim();
    digits.parse::<u32>().ok()
}

fn parse_tag(content: &str) -> Option<OverlayCommand> {
    let parts: Vec<&str> = content.split(':').collect();
    if parts.is_empty() {
        return None;
    }

    match parts[0].trim().to_uppercase().as_str() {
        "POINT" => {
            // [POINT:#12:Add], [POINT: #12 : Add], [POINT:12:Add], [POINT:#12:Add:screen0], [POINT:#12]
            if parts.len() >= 2 {
                let target = parts[1].trim();
                if !target.contains(',') {
                    let element_id = parse_element_id_token(target)?;
                    let label = parts
                        .get(2)
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    let screen = parts
                        .get(3)
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("screen0")
                        .to_string();
                    return Some(OverlayCommand::PointRef {
                        element_id,
                        label,
                        screen,
                    });
                }
            }

            // [POINT:x,y:label:screenN] or [POINT:x,y:label]
            if parts.len() >= 3 {
                let coords: Vec<&str> = parts[1].split(',').collect();
                let x = coords.first()?.trim().parse::<i32>().ok()?;
                let y = coords.get(1)?.trim().parse::<i32>().ok()?;
                let label = parts[2].trim().to_string();
                let screen = parts
                    .get(3)
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("screen0")
                    .to_string();
                Some(OverlayCommand::Point { x, y, label, screen })
            } else {
                None
            }
        }
        "HIGHLIGHT" | "BOX" => {
            // [HIGHLIGHT:#8], [HIGHLIGHT:#8:Add], [HIGHLIGHT:8:Add], [BOX:#8], [BOX:#8:Add]
            if parts.len() >= 2 {
                let target = parts[1].trim();
                if !target.contains(',') {
                    let element_id = parse_element_id_token(target)?;
                    let (parsed_color, label) =
                        parse_color_and_label_slice(parts.get(2..).unwrap_or(&[]));
                    let color = parsed_color.or_else(|| Some("#10b981".to_string()));
                    return Some(OverlayCommand::DrawRef {
                        shape: "box".to_string(),
                        element_id,
                        target_element_id: None,
                        color,
                        label,
                    });
                }
            }
            None
        }
        "DRAW" => {
            // [DRAW:clear]
            // [DRAW:shape:#12[:#color][:label]] or [DRAW:shape:12[:#color][:label]]
            // [DRAW:shape:#12->#24[:#color][:label]] or [DRAW:shape:12->24[:#color][:label]]
            // [DRAW:shape:coords[:#color][:label]]
            if parts.len() >= 2 && parts[1].trim().eq_ignore_ascii_case("clear") {
                return Some(OverlayCommand::ClearDrawings);
            }
            if parts.len() >= 3 {
                let shape = parts[1].trim().to_lowercase();
                match shape.as_str() {
                    "line"
                    | "dashed"
                    | "arrow"
                    | "curve"
                    | "polygon"
                    | "polyline"
                    | "circle"
                    | "ellipse"
                    | "box"
                    | "text" => {}
                    _ => return None,
                }

                let target_spec = parts[2].trim();
                if !target_spec.contains(',') {
                    let (element_id, target_element_id) =
                        if let Some((src, dst)) = target_spec.split_once("->") {
                            let id1 = parse_element_id_token(src)?;
                            let id2 = parse_element_id_token(dst)?;
                            (id1, Some(id2))
                        } else {
                            let id1 = parse_element_id_token(target_spec)?;
                            (id1, None)
                        };
                    let (color, label) =
                        parse_color_and_label_slice(parts.get(3..).unwrap_or(&[]));
                    return Some(OverlayCommand::DrawRef {
                        shape,
                        element_id,
                        target_element_id,
                        color,
                        label,
                    });
                }

                let coords: Vec<i32> = target_spec
                    .split(',')
                    .filter_map(|s| s.trim().parse::<i32>().ok())
                    .collect();
                if coords.is_empty() {
                    return None;
                }

                let (color, label) =
                    parse_color_and_label_slice(parts.get(3..).unwrap_or(&[]));

                Some(OverlayCommand::Draw {
                    shape,
                    coords,
                    color,
                    label,
                })
            } else {
                None
            }
        }
        "GUIDE" => {
            // [GUIDE:continue] or [GUIDE:done]
            if parts.len() >= 2 {
                match parts[1].trim().to_lowercase().as_str() {
                    "continue" | "next" | "active" => Some(OverlayCommand::Guide { active: true }),
                    "done" | "complete" | "stop" => Some(OverlayCommand::Guide { active: false }),
                    _ => None,
                }
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
        "VIZ" => {
            // [VIZ:close] or [VIZ:clear]
            if parts.len() >= 2 {
                let action = parts[1].trim();
                if action.eq_ignore_ascii_case("close") || action.eq_ignore_ascii_case("clear") {
                    return Some(OverlayCommand::VizClose);
                }
            }
            None
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
            OverlayCommand::Draw { shape, coords, color, label } => {
                assert_eq!(shape, "circle");
                assert_eq!(coords, &[400, 300, 80]);
                assert_eq!(color.as_deref(), Some("#38bdf8"));
                assert_eq!(label.as_deref(), None);
            }
            _ => panic!("Expected Draw circle command"),
        }
    }

    #[test]
    fn test_draw_polygon_curve_line_and_clear() {
        let mut parser = TagStreamParser::new();
        let input = "Look at [DRAW:polygon:100,100,200,120,180,220,90,200:#10b981:Mesh] then follow [DRAW:curve:100,200,250,50,400,200:#10b981:Arc] and [DRAW:line:10,20,300,400:#f59e0b:Guide Line] then [DRAW:clear] done.";
        let (clean, cmds) = parser.feed_token(input);
        assert_eq!(clean, "Look at then follow and then done.");
        assert_eq!(cmds.len(), 4);

        match &cmds[0] {
            OverlayCommand::Draw { shape, coords, color, label } => {
                assert_eq!(shape, "polygon");
                assert_eq!(coords, &[100, 100, 200, 120, 180, 220, 90, 200]);
                assert_eq!(color.as_deref(), Some("#10b981"));
                assert_eq!(label.as_deref(), Some("Mesh"));
            }
            _ => panic!("Expected Draw polygon command"),
        }
        match &cmds[1] {
            OverlayCommand::Draw { shape, coords, color, label } => {
                assert_eq!(shape, "curve");
                assert_eq!(coords, &[100, 200, 250, 50, 400, 200]);
                assert_eq!(color.as_deref(), Some("#10b981"));
                assert_eq!(label.as_deref(), Some("Arc"));
            }
            _ => panic!("Expected Draw curve command"),
        }
        match &cmds[2] {
            OverlayCommand::Draw { shape, coords, color, label } => {
                assert_eq!(shape, "line");
                assert_eq!(coords, &[10, 20, 300, 400]);
                assert_eq!(color.as_deref(), Some("#f59e0b"));
                assert_eq!(label.as_deref(), Some("Guide Line"));
            }
            _ => panic!("Expected Draw line command"),
        }
        assert_eq!(cmds[3], OverlayCommand::ClearDrawings);
    }

    #[test]
    fn test_long_polygon_over_128_bytes() {
        let mut parser = TagStreamParser::new();
        let long_tag = "[DRAW:polygon:100,100,150,110,200,120,250,140,300,160,350,190,400,220,420,260,390,310,340,350,280,370,220,360,160,330,120,280,95,220,90,160:#10b981:Complex Outline]";
        assert!(long_tag.len() > 128);
        let (clean, cmds) = parser.feed_token(&format!("Trace {} here.", long_tag));
        assert_eq!(clean, "Trace here.");
        assert_eq!(cmds.len(), 1);
        match &cmds[0] {
            OverlayCommand::Draw { shape, coords, color, label } => {
                assert_eq!(shape, "polygon");
                assert_eq!(coords.len(), 32);
                assert_eq!(color.as_deref(), Some("#10b981"));
                assert_eq!(label.as_deref(), Some("Complex Outline"));
            }
            _ => panic!("Expected long Draw polygon command"),
        }
    }

    #[test]
    fn test_guide_tags() {
        let mut parser = TagStreamParser::new();
        let (clean1, cmds1) = parser.feed_token("First click Add at the top. [POINT:120,45:Add] [GUIDE:continue]");
        assert_eq!(clean1, "First click Add at the top. ");
        assert_eq!(cmds1.len(), 2);
        assert_eq!(cmds1[1], OverlayCommand::Guide { active: true });

        let (clean2, cmds2) = parser.feed_token("Awesome, your cube is right there! [GUIDE:done]");
        assert_eq!(clean2, "Awesome, your cube is right there! ");
        assert_eq!(cmds2.len(), 1);
        assert_eq!(cmds2[0], OverlayCommand::Guide { active: false });
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

    #[test]
    fn test_point_ref_tags() {
        let mut parser = TagStreamParser::new();
        let (clean, cmds) = parser.feed_token(
            "Click [POINT:#8:Add] then [POINT:#12:Export:screen0] and [POINT:#5] done.",
        );
        assert_eq!(clean, "Click then and done.");
        assert_eq!(cmds.len(), 3);
        assert_eq!(
            cmds[0],
            OverlayCommand::PointRef {
                element_id: 8,
                label: "Add".to_string(),
                screen: "screen0".to_string(),
            }
        );
        assert_eq!(
            cmds[1],
            OverlayCommand::PointRef {
                element_id: 12,
                label: "Export".to_string(),
                screen: "screen0".to_string(),
            }
        );
        assert_eq!(
            cmds[2],
            OverlayCommand::PointRef {
                element_id: 5,
                label: String::new(),
                screen: "screen0".to_string(),
            }
        );

        // Non-numeric target without ',' must NOT be parsed as PointRef or Point
        let mut parser2 = TagStreamParser::new();
        let (clean2, cmds2) = parser2.feed_token("Bad [POINT:abc:Add] tag.");
        assert_eq!(clean2, "Bad [POINT:abc:Add] tag.");
        assert!(cmds2.is_empty());
    }

    #[test]
    fn test_tolerant_small_model_tags() {
        let mut parser = TagStreamParser::new();
        let input = "Click [POINT:8:Add] or [POINT: #8 : Add] then [HIGHLIGHT:#8] [HIGHLIGHT:#8:Add] [BOX:#8] [DRAW:box:8:#10b981] [DRAW:arrow:8->14:#10b981] [DRAW:arrow:#8->14:#10b981:Step] [DRAW:arrow:8->#14:#10b981] done.";
        let (clean, cmds) = parser.feed_token(input);
        assert_eq!(clean, "Click or then done.");
        assert_eq!(cmds.len(), 9);

        assert_eq!(
            cmds[0],
            OverlayCommand::PointRef {
                element_id: 8,
                label: "Add".to_string(),
                screen: "screen0".to_string(),
            }
        );
        assert_eq!(
            cmds[1],
            OverlayCommand::PointRef {
                element_id: 8,
                label: "Add".to_string(),
                screen: "screen0".to_string(),
            }
        );
        assert_eq!(
            cmds[2],
            OverlayCommand::DrawRef {
                shape: "box".to_string(),
                element_id: 8,
                target_element_id: None,
                color: Some("#10b981".to_string()),
                label: None,
            }
        );
        assert_eq!(
            cmds[3],
            OverlayCommand::DrawRef {
                shape: "box".to_string(),
                element_id: 8,
                target_element_id: None,
                color: Some("#10b981".to_string()),
                label: Some("Add".to_string()),
            }
        );
        assert_eq!(
            cmds[4],
            OverlayCommand::DrawRef {
                shape: "box".to_string(),
                element_id: 8,
                target_element_id: None,
                color: Some("#10b981".to_string()),
                label: None,
            }
        );
        assert_eq!(
            cmds[5],
            OverlayCommand::DrawRef {
                shape: "box".to_string(),
                element_id: 8,
                target_element_id: None,
                color: Some("#10b981".to_string()),
                label: None,
            }
        );
        assert_eq!(
            cmds[6],
            OverlayCommand::DrawRef {
                shape: "arrow".to_string(),
                element_id: 8,
                target_element_id: Some(14),
                color: Some("#10b981".to_string()),
                label: None,
            }
        );
        assert_eq!(
            cmds[7],
            OverlayCommand::DrawRef {
                shape: "arrow".to_string(),
                element_id: 8,
                target_element_id: Some(14),
                color: Some("#10b981".to_string()),
                label: Some("Step".to_string()),
            }
        );
        assert_eq!(
            cmds[8],
            OverlayCommand::DrawRef {
                shape: "arrow".to_string(),
                element_id: 8,
                target_element_id: Some(14),
                color: Some("#10b981".to_string()),
                label: None,
            }
        );
    }

    #[test]
    fn test_draw_ref_tags() {
        let mut parser = TagStreamParser::new();
        let input = "Look [DRAW:box:#8:#10b981:Add] [DRAW:circle:#8:#38bdf8] [DRAW:text:#8:Click here] [DRAW:circle:#8] [DRAW:arrow:#8->#14:#10b981:Move] [DRAW:line:#8->#14:Connect] done.";
        let (clean, cmds) = parser.feed_token(input);
        assert_eq!(clean, "Look done.");
        assert_eq!(cmds.len(), 6);

        assert_eq!(
            cmds[0],
            OverlayCommand::DrawRef {
                shape: "box".to_string(),
                element_id: 8,
                target_element_id: None,
                color: Some("#10b981".to_string()),
                label: Some("Add".to_string()),
            }
        );
        assert_eq!(
            cmds[1],
            OverlayCommand::DrawRef {
                shape: "circle".to_string(),
                element_id: 8,
                target_element_id: None,
                color: Some("#38bdf8".to_string()),
                label: None,
            }
        );
        assert_eq!(
            cmds[2],
            OverlayCommand::DrawRef {
                shape: "text".to_string(),
                element_id: 8,
                target_element_id: None,
                color: None,
                label: Some("Click here".to_string()),
            }
        );
        assert_eq!(
            cmds[3],
            OverlayCommand::DrawRef {
                shape: "circle".to_string(),
                element_id: 8,
                target_element_id: None,
                color: None,
                label: None,
            }
        );
        assert_eq!(
            cmds[4],
            OverlayCommand::DrawRef {
                shape: "arrow".to_string(),
                element_id: 8,
                target_element_id: Some(14),
                color: Some("#10b981".to_string()),
                label: Some("Move".to_string()),
            }
        );
        assert_eq!(
            cmds[5],
            OverlayCommand::DrawRef {
                shape: "line".to_string(),
                element_id: 8,
                target_element_id: Some(14),
                color: None,
                label: Some("Connect".to_string()),
            }
        );
    }

    #[test]
    fn test_viz_block_streaming_and_speech_clean() {
        let mut parser = TagStreamParser::new();
        let tokens = vec![
            "Here is ",
            "how spring physics compares to easing. ",
            "[VI",
            "Z:html:Spring vs Easing:600x440]",
            "\n```html\n<div class=\"card\">",
            "const pts = [1, 2, 3]; // arrow → curve\n",
            "<canvas id=\"c\"></canvas></div>\n```\n",
            "[/V",
            "IZ]",
            " Try dragging the controls!",
        ];

        let mut all_clean = String::new();
        let mut all_cmds = Vec::new();
        let mut saw_loading_before_close = false;

        for (idx, t) in tokens.iter().enumerate() {
            let (clean, cmds) = parser.feed_token(t);
            all_clean.push_str(&clean);
            if idx == 3 {
                saw_loading_before_close = cmds.iter().any(|c| {
                    matches!(
                        c,
                        OverlayCommand::VizLoading { kind, title }
                            if kind == "html" && title == "Spring vs Easing"
                    )
                });
            }
            all_cmds.extend(cmds);
        }
        let (clean, cmds) = parser.flush();
        all_clean.push_str(&clean);
        all_cmds.extend(cmds);

        assert!(saw_loading_before_close, "VizLoading must emit immediately on opening tag");
        assert_eq!(
            all_clean,
            "Here is how spring physics compares to easing. Try dragging the controls!"
        );
        assert_eq!(all_cmds.len(), 2);
        assert_eq!(
            all_cmds[0],
            OverlayCommand::VizLoading {
                kind: "html".to_string(),
                title: "Spring vs Easing".to_string(),
            }
        );
        match &all_cmds[1] {
            OverlayCommand::VizRender {
                id,
                kind,
                title,
                code,
                width,
                height,
            } => {
                assert!(!id.is_empty());
                assert_eq!(kind, "html");
                assert_eq!(title, "Spring vs Easing");
                assert_eq!(*width, Some(600));
                assert_eq!(*height, Some(440));
                assert!(!code.contains("```"));
                assert_eq!(
                    code,
                    "<div class=\"card\">const pts = [1, 2, 3]; // arrow → curve\n<canvas id=\"c\"></canvas></div>"
                );
            }
            other => panic!("Expected VizRender, got {:?}", other),
        }

        // Also verify flush() emits VizRender if stream ends without [/VIZ]
        let mut unclosed_parser = TagStreamParser::new();
        let (c1, cmds1) = unclosed_parser.feed_token("Check this diagram. [VIZ:mermaid:Flow]\ngraph LR\nA[Start] --> B[Done]");
        let (c2, cmds2) = unclosed_parser.flush();
        assert_eq!(format!("{}{}", c1, c2), "Check this diagram. ");
        assert_eq!(cmds1.len(), 1);
        assert_eq!(cmds2.len(), 1);
        match &cmds2[0] {
            OverlayCommand::VizRender {
                kind,
                title,
                code,
                width,
                height,
                ..
            } => {
                assert_eq!(kind, "mermaid");
                assert_eq!(title, "Flow");
                assert_eq!(code, "graph LR\nA[Start] --> B[Done]");
                assert_eq!(*width, None);
                assert_eq!(*height, None);
            }
            other => panic!("Expected VizRender on flush, got {:?}", other),
        }
    }

    #[test]
    fn test_extended_draw_shapes_dashed_ellipse_polyline() {
        let mut parser = TagStreamParser::new();
        let input = concat!(
            "Watch ",
            "[DRAW:dashed:100,200,500,200:#f59e0b:Baseline] ",
            "[DRAW:ellipse:500,400,120,70:#38bdf8:Orbit] ",
            "[DRAW:polyline:100,400,200,320,300,360,400,220:#10b981:Trend] ",
            "[VIZ:close] ",
            "[VIZ:CLEAR] ",
            "done."
        );
        let (clean, cmds) = parser.feed_token(input);
        assert_eq!(clean, "Watch done.");
        assert_eq!(cmds.len(), 5);

        assert_eq!(
            cmds[0],
            OverlayCommand::Draw {
                shape: "dashed".to_string(),
                coords: vec![100, 200, 500, 200],
                color: Some("#f59e0b".to_string()),
                label: Some("Baseline".to_string()),
            }
        );
        assert_eq!(
            cmds[1],
            OverlayCommand::Draw {
                shape: "ellipse".to_string(),
                coords: vec![500, 400, 120, 70],
                color: Some("#38bdf8".to_string()),
                label: Some("Orbit".to_string()),
            }
        );
        assert_eq!(
            cmds[2],
            OverlayCommand::Draw {
                shape: "polyline".to_string(),
                coords: vec![100, 400, 200, 320, 300, 360, 400, 220],
                color: Some("#10b981".to_string()),
                label: Some("Trend".to_string()),
            }
        );
        assert_eq!(cmds[3], OverlayCommand::VizClose);
        assert_eq!(cmds[4], OverlayCommand::VizClose);

        // Verify extended 2048-byte inline tag buffer accepts >512-byte polylines
        let many_coords: Vec<String> = (0..100).map(|i| format!("{},{}", i * 10, 500 - i * 3)).collect();
        let long_polyline = format!("[DRAW:polyline:{}:#10b981:DenseWave]", many_coords.join(","));
        assert!(long_polyline.len() > 512 && long_polyline.len() < 2048);
        let mut long_parser = TagStreamParser::new();
        let (long_clean, long_cmds) = long_parser.feed_token(&format!("Wave {} ready.", long_polyline));
        assert_eq!(long_clean, "Wave ready.");
        assert_eq!(long_cmds.len(), 1);
        match &long_cmds[0] {
            OverlayCommand::Draw { shape, coords, .. } => {
                assert_eq!(shape, "polyline");
                assert_eq!(coords.len(), 200);
            }
            other => panic!("Expected long polyline Draw, got {:?}", other),
        }
    }
}
