# HeyClicky Companion Browser Extension (Chrome MV3)

The **HeyClicky Companion Extension** is an MV3 browser extension that bridges your everyday Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Arc, Vivaldi) to the HeyClicky desktop engine via **Chrome Native Messaging**.

This architecture bypasses Playwright/Puppeteer overhead and enables seamless, zero-latency automation of your authenticated user tabs without requiring `--remote-debugging-port` or browser restarts.

---

## 1. Security Architecture & Mandatory Redaction

To prevent sensitive credentials and payment data from leaking to local or cloud AI models, `content.js` strictly enforces **non-bypassable sensitive field redaction**:

1. **Passwords:** Any element with `type="password"`.
2. **Tokens & One-Time Codes:** Any element with `autocomplete` matching:
   ```regex
   /one-time-code|cc-number|cc-exp|cc-csc|current-password/i
   ```
3. **Identifiers & Names:** Any element whose `name`, `id`, `aria-label`, or `placeholder` matches:
   ```regex
   /password|passcode|otp|cvv|cvc|ssn|card.?number/i
   ```

### Redaction Behavior
- In `browser_get_dom`: Matching elements are returned as:
  ```json
  {
    "selector": "#user-password-input",
    "role": "REDACTED_SENSITIVE_FIELD",
    "interactive": false,
    "text": "[REDACTED_SENSITIVE_FIELD]",
    "rect": { "x": 420, "y": 310, "width": 240, "height": 38 }
  }
  ```
- In `browser_type`: Attempts to type into a sensitive element are immediately blocked and return:
  ```json
  {
    "success": false,
    "error": "Refused: sensitive field"
  }
  ```

---

## 2. Installing the Unpacked Extension

1. Open your Chromium browser and navigate to:
   - **Google Chrome:** `chrome://extensions/`
   - **Brave Browser:** `brave://extensions/`
   - **Microsoft Edge:** `edge://extensions/`
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked** and select the folder:
   ```text
   D:\cliky\browser-extension
   ```
4. Note the generated **Extension ID** (a 32-character lowercase string, e.g. `abcdefghijklmnopabcdefghijklmnop`).

---

## 3. Registering the Native Messaging Host

The extension communicates with the HeyClicky desktop binary using stdio length-prefixed JSON packets. The host manifest file is located at `native-host/com.heyclicky.clone.json`.

### Step A: Update `allowed_origins`
Edit `native-host/com.heyclicky.clone.json` and replace `<EXTENSION_ID>` with your extension ID:
```json
{
  "name": "com.heyclicky.clone",
  "description": "HeyClicky Clone Native Messaging Bridge",
  "path": "D:\\cliky\\target\\release\\heyclicky-clone.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
  ]
}
```

### Step B: Register with the Operating System

#### Windows (Registry Key)
Run the following PowerShell command (run as your current user):
```powershell
# For Google Chrome:
$ManifestPath = "D:\cliky\browser-extension\native-host\com.heyclicky.clone.json"
New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.heyclicky.clone" -Force
Set-ItemProperty -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.heyclicky.clone" -Name "(Default)" -Value $ManifestPath

# For Microsoft Edge:
New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.heyclicky.clone" -Force
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.heyclicky.clone" -Name "(Default)" -Value $ManifestPath

# For Brave Browser:
New-Item -Path "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.heyclicky.clone" -Force
Set-ItemProperty -Path "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.heyclicky.clone" -Name "(Default)" -Value $ManifestPath
```

#### macOS
```bash
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"
cp "native-host/com.heyclicky.clone.json" "$MANIFEST_DIR/com.heyclicky.clone.json"
```

#### Linux
```bash
MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"
cp "native-host/com.heyclicky.clone.json" "$MANIFEST_DIR/com.heyclicky.clone.json"
```

---

## 4. Native Messaging Protocol Specification

All communication between the Rust core and `background.js` uses standard Chrome Native Messaging:
- Each message is prefixed with a **32-bit unsigned integer (native/little endian)** denoting the payload byte length.
- Followed by the UTF-8 encoded JSON payload.

### Supported Commands

| Action | Parameters | Description |
| :--- | :--- | :--- |
| `ping` | `{ id: "..." }` | Returns `{ type: "pong", timestamp: ... }`. |
| `list_tabs` | `{ id: "..." }` | Returns an array of open tabs with `id`, `url`, `title`, and `active`. |
| `browser_navigate` | `{ id: "...", url: "...", tab_id?: number }` | Navigates the target tab or opens a new tab. |
| `browser_get_dom` | `{ id: "...", tab_id?: number }` | Extracts interactive elements, selectors, bounding rects, and redacts sensitive inputs. |
| `browser_click` | `{ id: "...", selector: "...", tab_id?: number }` | Scrolls to element and dispatches simulated mouse click events. |
| `browser_type` | `{ id: "...", selector: "...", text: "...", tab_id?: number }` | Types text into input fields; strictly rejects sensitive fields. |
