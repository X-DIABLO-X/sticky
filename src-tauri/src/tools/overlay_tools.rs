use std::sync::Arc;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use crate::ai::providers::ToolDefinition;
use crate::tools::ToolRegistry;

pub fn register_overlay_tools(registry: &mut ToolRegistry, app_handle: AppHandle) {
    // 1. overlay_point
    let point_def = ToolDefinition {
        name: "overlay_point".to_string(),
        description: "Animate glowing Bezier cursor to point at a screen element with a label.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["x", "y", "label"],
            "properties": {
                "x": { "type": "integer", "description": "0-1000 normalized X" },
                "y": { "type": "integer", "description": "0-1000 normalized Y" },
                "label": { "type": "string" },
                "screen_index": { "type": "integer", "default": 0 }
            }
        }),
    };
    let app1 = app_handle.clone();
    registry.register(
        point_def,
        Arc::new(move |args| {
            let app = app1.clone();
            Box::pin(async move {
                let _ = app.emit("overlay:point", &args);
                Ok(json!({ "status": "point_emitted", "data": args }))
            })
        }),
    );

    // 2. overlay_draw
    let draw_def = ToolDefinition {
        name: "overlay_draw".to_string(),
        description: "Draw a 2D Excalidraw-style annotation (circle, box, arrow) on screen overlay.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["shape", "coords"],
            "properties": {
                "shape": { "type": "string", "enum": ["circle", "box", "arrow"] },
                "coords": { "type": "array", "items": { "type": "integer" } },
                "label": { "type": "string" },
                "color": { "type": "string", "default": "#3186ff" }
            }
        }),
    };
    let app2 = app_handle.clone();
    registry.register(
        draw_def,
        Arc::new(move |args| {
            let app = app2.clone();
            Box::pin(async move {
                let _ = app.emit("overlay:draw", &args);
                Ok(json!({ "status": "draw_emitted", "data": args }))
            })
        }),
    );

    // 3. overlay_3d
    let d3_def = ToolDefinition {
        name: "overlay_3d".to_string(),
        description: "Open the interactive Three.js 3D viewer on screen with a specific 3D model/preset.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["model"],
            "properties": {
                "model": { "type": "string" },
                "title": { "type": "string", "default": "3D Visualizer" }
            }
        }),
    };
    let app3 = app_handle.clone();
    registry.register(
        d3_def,
        Arc::new(move |args| {
            let app = app3.clone();
            Box::pin(async move {
                let _ = app.emit("overlay:3d", &args);
                Ok(json!({ "status": "3d_emitted", "data": args }))
            })
        }),
    );

    // 4. start_walkthrough
    let walk_def = ToolDefinition {
        name: "start_walkthrough".to_string(),
        description: "Start an interactive guided walkthrough with highlight boxes and instructions.".to_string(),
        parameters: json!({
            "type": "object",
            "required": ["steps"],
            "properties": {
                "steps": {
                    "type": "array",
                    "maxItems": 15,
                    "items": {
                        "type": "object",
                        "required": ["instruction", "bbox"],
                        "properties": {
                            "instruction": { "type": "string" },
                            "bbox": { "type": "array", "items": { "type": "integer" } }
                        }
                    }
                }
            }
        }),
    };
    let app4 = app_handle.clone();
    registry.register(
        walk_def,
        Arc::new(move |args| {
            let app = app4.clone();
            Box::pin(async move {
                let _ = app.emit("overlay:walkthrough", &args);
                Ok(json!({ "status": "walkthrough_started", "data": args }))
            })
        }),
    );
}
