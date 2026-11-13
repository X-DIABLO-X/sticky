# Agent Tool Definitions & Schemas (`tools.md`)

All tools exposed to the `AgentRuntime` (`src-tauri/src/tools/mod.rs`) follow the **OpenAI-compatible JSON Schema** format so they work identically across `llama.cpp`, Groq, Gemini, and OpenRouter.

---

## 1. Screen & Accessibility Tools (Read-Only, Auto-Approved)

### `capture_screen`
Captures the active monitor (or a specific cropped region) as a compressed WebP/JPEG image.
```json
{
  "name": "capture_screen",
  "description": "Capture the current screen or a specific bounding box at full resolution.",
  "parameters": {
    "type": "object",
    "properties": {
      "monitor_index": { "type": "integer", "default": 0 },
      "crop_bbox": {
        "type": "array",
        "items": { "type": "integer" },
        "description": "Optional [x1, y1, x2, y2] in pixels to crop at 100% resolution."
      }
    }
  }
}
```

### `get_a11y_tree`
Queries the OS Accessibility Tree (`uiautomation` / `atspi` / `AXUIElement`) for the focused window.
```json
{
  "name": "get_a11y_tree",
  "description": "Returns interactive UI elements (buttons, inputs, menus) and their pixel bounding boxes from the focused window.",
  "parameters": {
    "type": "object",
    "properties": {
      "max_depth": { "type": "integer", "default": 8 }
    }
  }
}
```

---

## 2. Spatial Overlay Tools (Non-Destructive, Auto-Approved)

### `overlay_point`
Moves the animated Bezier pointer to `(x, y)` on `screen_index`.
```json
{
  "name": "overlay_point",
  "description": "Point at a UI element on screen with an animated glowing cursor and label.",
  "parameters": {
    "type": "object",
    "required": ["x", "y", "label"],
    "properties": {
      "x": { "type": "integer", "description": "Normalized 0-1000 X coordinate" },
      "y": { "type": "integer", "description": "Normalized 0-1000 Y coordinate" },
      "label": { "type": "string" },
      "screen_index": { "type": "integer", "default": 0 }
    }
  }
}
```

### `overlay_draw`
Draws 2D Excalidraw-style annotations (`circle`, `box`, `arrow`) on the transparent overlay.
```json
{
  "name": "overlay_draw",
  "description": "Draw a 2D annotation on the screen overlay.",
  "parameters": {
    "type": "object",
    "required": ["shape", "coords"],
    "properties": {
      "shape": { "type": "string", "enum": ["circle", "box", "arrow"] },
      "coords": { "type": "array", "items": { "type": "integer" } },
      "label": { "type": "string" },
      "color": { "type": "string", "default": "#3186ff" }
    }
  }
}
```

### `start_walkthrough`
Starts an interactive guided walkthrough (up to 15 steps) that auto-advances when the user clicks each target bbox.
```json
{
  "name": "start_walkthrough",
  "description": "Launch a step-by-step interactive walkthrough on screen.",
  "parameters": {
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
  }
}
```

---

## 3. Desktop Drive Tools (Mutating — Requires Confirmation Gate)
Every tool in this group is intercepted by `DriveController` (`src-tauri/src/features/drive.rs`) and requires user confirmation before execution via [`enigo`](https://github.com/enigo-rs/enigo).

- `mouse_click`: `{ "x": int, "y": int, "button": "left"|"right"|"double", "screen_index": int }`
- `type_text`: `{ "text": string, "press_enter": bool }`
- `press_hotkey`: `{ "keys": ["Ctrl", "S"] }`
- `scroll`: `{ "x": int, "y": int, "delta_y": int }`

---

## 4. Browser Automation Tools (CDP / MV3 Extension)
Executed via [`chromiumoxide`](https://crates.io/crates/chromiumoxide) or Chrome Native Messaging, with **hard redaction** of password, OTP, and payment card fields:

- `browser_get_dom`: `{ "tab_id": int | null }` -> Returns sanitized interactive elements (`selector`, `text`, `role`, `bbox`).
- `browser_click`: `{ "selector": string }`
- `browser_type`: `{ "selector": string, "text": string }` -> **Rejected** if element matches `type="password"`, `autocomplete="one-time-code"`, or `cc-*`.
- `browser_navigate`: `{ "url": string }`

---

## 5. Memory, Scheduler & MCP Tools

- `memory_upsert`: `{ "scope": "preference"|"project"|"fact", "key": string, "value": string }` -> Persists to SQLite `memories` table.
- `schedule_cron`: `{ "agent_id": string, "cron_expr": string, "prompt": string }` -> Registers recurring job in `SchedulerService`.
- `mcp_call`: `{ "server_name": string, "tool_name": string, "arguments": object }` -> Forwards to connected stdio/SSE MCP server.
