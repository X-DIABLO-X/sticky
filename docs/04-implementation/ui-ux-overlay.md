# UI/UX & Spatial Overlay Specification (`ui-ux-overlay.md`)

---

## 1. Tauri v2 Multi-Window Configuration (`tauri.conf.json`)
Configure 4 windows with `transparent: true`, `decorations: false`, `shadow: false`, `alwaysOnTop: true` ([Tauri v2 Config](https://v2.tauri.app/reference/config/)):
- **macOS:** Enable `macOSPrivateApi: true` so `NSPanel`-style floating windows appear over full-screen apps and Spaces without stealing focus.
- **Windows:** Disable window animations on `overlay` and `bubble` so showing/hiding is instantaneous.
- **Linux/Wayland:** Keep `pill` and `bubble` as compact floating windows; only spawn `overlay` on X11 or Wayland compositors supporting layer-shell/transparent input regions ([Tauri Window Customization](https://v2.tauri.app/learn/window-customization/)).

---

## 2. Transparent Click-Through Hit-Testing (`OverlayWindow.tsx`)
By default, `overlay` calls `appWindow.setIgnoreCursorEvents(true)` so all mouse clicks pass straight through to underlying apps ([GitHub #13070](https://github.com/tauri-apps/tauri/issues/13070)).
- **Interactive Regions (3D Viewer / Close Annotation Button):**
  - Register interactive bounding boxes `[x, y, w, h]` in Rust (`OverlayState`).
  - A `60 Hz` cursor-position poller checks if `(cursor_x, cursor_y)` enters any interactive box; if yes, call `set_ignore_cursor_events(false)`, and restore `true` immediately when the cursor leaves.
- **Draw-to-Focus Mode (`Shift` + Push-to-Talk):**
  - Holding `Shift` during Talk Mode temporarily sets `set_ignore_cursor_events(false)` so the user can scribble a circle/box on `DrawingCanvas.tsx`; releasing `Shift` crops that bounding box and restores click-through.

---

## 3. Spatial Components
1. **`AnimatedPointer.tsx`:**
   - Receives `{ x, y, label, screenIndex }` normalized `0..1000`.
   - Converts to monitor-local CSS pixels, interpolates from `(prevX, prevY)` to `(x, y)` over `420 ms` using a cubic Bezier easing curve (`bezier.ts`), and renders a glowing cursor + floating pill label ([AGENTS.md](https://github.com/farzaa/clicky/blob/main/AGENTS.md)).
2. **`DrawingCanvas.tsx`:**
   - Uses `roughjs` (or HTML5 Canvas sketchy-stroke helper) for Excalidraw-style 2D circles, arrows, and boxes with auto-fade (`8 s` default, or persistent until `Esc`).
3. **`GuidedStepBox.tsx`:**
   - Highlights the active walkthrough target `[x1, y1, x2, y2]` with a pulsing border and `Step X / N` tooltip.
   - Rust monitors global mouse clicks (or A11y focus change) inside `[x1, y1, x2, y2]` to auto-advance to `Step X + 1`.
4. **`Model3DViewer.tsx`:**
   - Draggable `360x360 px` floating card using `@react-three/fiber` + `three` with `OrbitControls` and clickable HTML part-callout pins.
5. **`PillWindow.tsx` & `BubbleWindow.tsx`:**
   - `PillWindow`: `320x44 px` collapsed at top-center (`y = 8 px`), expands to `440x560 px` drawer showing Agents ("Clickys"), Cron Jobs, Memory, and Settings.
   - `BubbleWindow`: `260x64 px` pill positioned `24 px` below-right of cursor during Talk/Dictation, displaying live `ArrayBuffer` audio waveform + streaming captions.
