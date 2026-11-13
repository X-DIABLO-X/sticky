use std::sync::Arc;
use serde_json::json;
use crate::ai::providers::ToolDefinition;
use crate::screen::a11y::get_focused_window_tree;
use crate::screen::capture::ScreenCaptureService;
use crate::screen::input::InputSimulator;
use crate::tools::ToolRegistry;

pub fn register_os_tools(registry: &mut ToolRegistry) {
    // 1. capture_screen
    let capture_def = ToolDefinition {
        name: "capture_screen".to_string(),
        description: "Capture the active monitor (or a cropped bbox) at full resolution as base64 JPEG.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "monitor_index": { "type": "integer", "default": 0 },
                "crop_bbox": {
                    "type": "array",
                    "items": { "type": "integer" },
                    "description": "Optional [x1, y1, x2, y2] pixel coordinates"
                }
            }
        }),
    };
    registry.register(
        capture_def,
        Arc::new(|args| {
            Box::pin(async move {
                let monitor_idx = args.get("monitor_index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let crop = args.get("crop_bbox").and_then(|v| v.as_array()).and_then(|arr| {
                    if arr.len() == 4 {
                        Some([
                            arr[0].as_u64()? as u32,
                            arr[1].as_u64()? as u32,
                            arr[2].as_u64()? as u32,
                            arr[3].as_u64()? as u32,
                        ])
                    } else {
                        None
                    }
                });

                let captured = tauri::async_runtime::spawn_blocking(move || {
                    ScreenCaptureService::capture(monitor_idx, crop, Some(1280))
                }).await.unwrap_or(Err(crate::error::AppError::Screen("timeout".into())))?;

                Ok(json!({
                    "width": captured.width,
                    "height": captured.height,
                    "format": captured.format,
                    "base64": captured.base64_data,
                }))
            })
        }),
    );

    // 2. get_a11y_tree
    let a11y_def = ToolDefinition {
        name: "get_a11y_tree".to_string(),
        description: "Returns interactive UI elements (buttons, inputs, menus) and bounding boxes from the active focused window.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "max_depth": { "type": "integer", "default": 6 }
            }
        }),
    };
    registry.register(
        a11y_def,
        Arc::new(|args| {
            Box::pin(async move {
                let max_depth = args.get("max_depth").and_then(|v| v.as_u64()).unwrap_or(6) as usize;
                let tree = tauri::async_runtime::spawn_blocking(move || {
                    get_focused_window_tree(max_depth)
                }).await.unwrap_or(Err(crate::error::AppError::A11y("timeout".into())))?;

                let mut interactive_nodes = Vec::new();
                tree.root.collect_interactive(&mut interactive_nodes);

                Ok(json!({
                    "window_title": tree.window_title,
                    "interactive_elements": interactive_nodes
                }))
            })
        }),
    );

    // 3. mouse_click
    let click_def = ToolDefinition {
        name: "mouse_click".to_string(),
        description: "Click a screen coordinate with the mouse (left, right, or double).".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["x", "y"],
            "properties": {
                "x": { "type": "integer" },
                "y": { "type": "integer" },
                "button": { "type": "string", "enum": ["left", "right", "double"], "default": "left" }
            }
        }),
    };
    registry.register(
        click_def,
        Arc::new(|args| {
            Box::pin(async move {
                let x = args.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let y = args.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
                let btn = args.get("button").and_then(|v| v.as_str()).unwrap_or("left").to_string();
                let btn_clone = btn.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    let mut sim = InputSimulator::new()?;
                    sim.click(x, y, &btn_clone)?;
                    Ok::<(), crate::error::AppError>(())
                }).await.unwrap_or(Err(crate::error::AppError::Internal("timeout".into())))?;

                Ok(json!({ "status": "clicked", "x": x, "y": y, "button": btn }))
            })
        }),
    );

    // 4. type_text
    let type_def = ToolDefinition {
        name: "type_text".to_string(),
        description: "Type keyboard text at the current caret position.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["text"],
            "properties": {
                "text": { "type": "string" },
                "press_enter": { "type": "boolean", "default": false }
            }
        }),
    };
    registry.register(
        type_def,
        Arc::new(|args| {
            Box::pin(async move {
                let text = args.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let enter = args.get("press_enter").and_then(|v| v.as_bool()).unwrap_or(false);
                let text_clone = text.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    let mut sim = InputSimulator::new()?;
                    sim.type_text(&text_clone, enter)?;
                    Ok::<(), crate::error::AppError>(())
                }).await.unwrap_or(Err(crate::error::AppError::Internal("timeout".into())))?;

                Ok(json!({ "status": "typed", "length": text.len() }))
            })
        }),
    );

    // 5. press_hotkey
    let hotkey_def = ToolDefinition {
        name: "press_hotkey".to_string(),
        description: "Simulate pressing a keyboard shortcut combination (e.g. ['Ctrl', 'S']).".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["keys"],
            "properties": {
                "keys": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            }
        }),
    };
    registry.register(
        hotkey_def,
        Arc::new(|args| {
            Box::pin(async move {
                let keys: Vec<String> = args.get("keys")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|k| k.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let keys_clone = keys.clone();

                tauri::async_runtime::spawn_blocking(move || {
                    let mut sim = InputSimulator::new()?;
                    sim.press_hotkey(&keys_clone)?;
                    Ok::<(), crate::error::AppError>(())
                }).await.unwrap_or(Err(crate::error::AppError::Internal("timeout".into())))?;

                Ok(json!({ "status": "hotkey_pressed", "keys": keys }))
            })
        }),
    );
}
