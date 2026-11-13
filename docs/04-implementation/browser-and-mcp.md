# Browser Extension, Native Messaging & MCP (`browser-and-mcp.md`)

---

## 1. Dual Browser Control Strategy
1. **Direct CDP (`chromiumoxide`):** When launching or attaching to a debug-enabled Chrome/Chromium instance (`--remote-debugging-port`), Rust connects directly over **Chrome DevTools Protocol** via [`chromiumoxide`](https://crates.io/crates/chromiumoxide), avoiding Playwright's Node.js relay hop ([Browser Use](https://browser-use.com/posts/playwright-to-cdp)).
2. **Chrome MV3 Extension + Native Messaging (Signed-In User Tabs):** For the user's everyday browser (Chrome, Edge, Brave, Arc, Vivaldi) without restart flags, use an MV3 extension communicating over **Chrome Native Messaging** (stdin/stdout length-prefixed JSON pipe to the Rust binary—zero open localhost ports) ([Privacy Policy](https://www.heyclicky.com/privacy-policy)).

### Native Messaging Host Manifest (`com.heyclicky.clone.json`)
- **Linux:** `~/.config/google-chrome/NativeMessagingHosts/com.heyclicky.clone.json`
- **macOS:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.heyclicky.clone.json`
- **Windows:** Registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.heyclicky.clone`
```json
{
  "name": "com.heyclicky.clone",
  "description": "HeyClicky Clone Native Messaging Bridge",
  "path": "/ABSOLUTE/PATH/TO/heyclicky-clone --native-messaging",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
```

### Mandatory Sensitive-Field Redaction (`browser-extension/content.js`)
Before returning DOM snapshots or executing `browser_type`, `content.js` **must** block and redact:
- Any `<input>` with `type="password"`
- Any element with `autocomplete` matching `one-time-code`, `cc-number`, `cc-exp`, `cc-csc`, or `current-password`
- Any element whose `name`/`id`/`aria-label` matches `/password|passcode|otp|cvv|cvc|ssn|card.?number/i`
Blocked fields are replaced with `{"role": "REDACTED_SENSITIVE_FIELD", "interactive": false}` and `browser_type` returns `Err("Refused: sensitive field")`.

---

## 2. MCP (Model Context Protocol) Client (`src-tauri/src/tools/mcp_client.rs`)
Supports both **local stdio MCP servers** (spawned as child processes) and **remote HTTP/SSE MCP servers**, configured in `~/.heyclicky/mcp.json`:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/Documents"]
    },
    "gmail": {
      "url": "https://your-local-or-remote-mcp/sse",
      "headers": { "Authorization": "Bearer ${GMAIL_MCP_TOKEN}" }
    }
  }
}
```
On startup, `McpClient` runs `initialize` + `tools/list` on each enabled server and registers discovered tools into `ToolRegistry` prefixed as `mcp_<server>_<tool>` so any Clicky agent can invoke them seamlessly.
