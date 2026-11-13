#!/usr/bin/env bash
# ==============================================================================
# HeyClicky macOS & Linux Release Build & Packaging Script
# ==============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${ROOT_DIR}/dist/release-bundle"
SKIP_FRONTEND=0
SKIP_CARGO=0
CREATE_ARCHIVE=1

# Print banner
echo -e "\033[1;36m==========================================================\033[0m"
echo -e "\033[1;36m       HeyClicky Desktop Agent - Unix Release Build       \033[0m"
echo -e "\033[1;36m==========================================================\033[0m"
echo -e "Workspace Root: ${ROOT_DIR}"

# Parse command line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-frontend)
      SKIP_FRONTEND=1
      shift
      ;;
    --skip-cargo)
      SKIP_CARGO=1
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --no-archive)
      CREATE_ARCHIVE=0
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# 1. Prerequisite verification
echo -e "\n\033[1;33m[1/5] Verifying toolchain prerequisites...\033[0m"
for cmd in node npm cargo python3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo -e "\033[0;31m[ERROR] Required command '$cmd' is not installed or not in PATH.\033[0m"
    exit 1
  fi
  echo -e "\033[0;32m  [OK] $cmd found ($(command -v "$cmd"))\033[0m"
done

# 2. Frontend Build
if [[ $SKIP_FRONTEND -eq 0 ]]; then
  echo -e "\n\033[1;33m[2/5] Building Vite React frontend...\033[0m"
  cd "${ROOT_DIR}"
  if [[ ! -d "node_modules" ]]; then
    echo "Installing npm dependencies..."
    npm install
  fi
  npm run build
  echo -e "\033[0;32m  [OK] Frontend built successfully.\033[0m"
else
  echo -e "\n\033[1;30m[2/5] Skipping frontend build (--skip-frontend).\033[0m"
fi

# 3. Rust Backend Build
if [[ $SKIP_CARGO -eq 0 ]]; then
  echo -e "\n\033[1;33m[3/5] Building Rust Tauri v2 core binary (release mode)...\033[0m"
  cd "${ROOT_DIR}/src-tauri"
  cargo build --release
  echo -e "\033[0;32m  [OK] Rust core compiled.\033[0m"
else
  echo -e "\n\033[1;30m[3/5] Skipping cargo build (--skip-cargo).\033[0m"
fi

# 4. Assemble Release Bundle
echo -e "\n\033[1;33m[4/5] Assembling release bundle in ${OUTPUT_DIR}...\033[0m"
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

BINARY_PATH="${ROOT_DIR}/src-tauri/target/release/heyclicky-clone"
if [[ ! -f "$BINARY_PATH" ]]; then
  # Check alternate name
  if [[ -f "${ROOT_DIR}/src-tauri/target/release/cliky" ]]; then
    BINARY_PATH="${ROOT_DIR}/src-tauri/target/release/cliky"
  fi
fi

if [[ -f "$BINARY_PATH" ]]; then
  cp "$BINARY_PATH" "${OUTPUT_DIR}/heyclicky-clone"
  chmod +x "${OUTPUT_DIR}/heyclicky-clone"
  echo -e "\033[0;32m  Copied main binary: heyclicky-clone\033[0m"
else
  echo -e "\033[0;33m  [NOTICE] Binary not found at $BINARY_PATH. Adding placeholder.\033[0m"
  touch "${OUTPUT_DIR}/heyclicky-clone.placeholder"
fi

# Copy Browser Extension
cp -r "${ROOT_DIR}/browser-extension" "${OUTPUT_DIR}/browser-extension"
echo -e "\033[0;32m  Bundled browser-extension/\033[0m"

# Copy Python Vision Sidecar
cp -r "${ROOT_DIR}/sidecar-vision" "${OUTPUT_DIR}/sidecar-vision"
echo -e "\033[0;32m  Bundled sidecar-vision/\033[0m"

# Copy Scripts & Setup
mkdir -p "${OUTPUT_DIR}/scripts"
cp "${ROOT_DIR}/scripts/download_models.py" "${OUTPUT_DIR}/scripts/download_models.py"
chmod +x "${OUTPUT_DIR}/scripts/download_models.py"
echo -e "\033[0;32m  Bundled scripts/download_models.py\033[0m"

# Copy Configuration & Docs
[[ -f "${ROOT_DIR}/.env.example" ]] && cp "${ROOT_DIR}/.env.example" "${OUTPUT_DIR}/.env.example"
[[ -f "${ROOT_DIR}/README.md" ]] && cp "${ROOT_DIR}/README.md" "${OUTPUT_DIR}/README.md"

# Generate Unix Native Host Registration Script
cat << 'EOF' > "${OUTPUT_DIR}/register-native-host.sh"
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_SOURCE="${SCRIPT_DIR}/browser-extension/native-host/com.heyclicky.clone.json"
BINARY_PATH="${SCRIPT_DIR}/heyclicky-clone"

# Update path in host manifest
if command -v jq &>/dev/null; then
  jq --arg p "$BINARY_PATH" '.path = $p' "$MANIFEST_SOURCE" > "${MANIFEST_SOURCE}.tmp" && mv "${MANIFEST_SOURCE}.tmp" "$MANIFEST_SOURCE"
fi

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  mkdir -p "$TARGET_DIR"
  cp "$MANIFEST_SOURCE" "$TARGET_DIR/com.heyclicky.clone.json"
  echo "Registered for Google Chrome on macOS ($TARGET_DIR)"
elif [[ "$OS" == "Linux" ]]; then
  TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  mkdir -p "$TARGET_DIR"
  cp "$MANIFEST_SOURCE" "$TARGET_DIR/com.heyclicky.clone.json"
  # Also register for Chromium and Brave if present
  mkdir -p "$HOME/.config/chromium/NativeMessagingHosts"
  cp "$MANIFEST_SOURCE" "$HOME/.config/chromium/NativeMessagingHosts/com.heyclicky.clone.json"
  mkdir -p "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  cp "$MANIFEST_SOURCE" "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.heyclicky.clone.json"
  echo "Registered for Chrome/Chromium/Brave on Linux"
fi
EOF

chmod +x "${OUTPUT_DIR}/register-native-host.sh"
echo -e "\033[0;32m  Generated register-native-host.sh installer script\033[0m"

# 5. Archive
if [[ $CREATE_ARCHIVE -eq 1 ]]; then
  echo -e "\n\033[1;33m[5/5] Creating tar.gz release archive...\033[0m"
  ARCHIVE_PATH="${ROOT_DIR}/dist/heyclicky-unix-x64.tar.gz"
  mkdir -p "${ROOT_DIR}/dist"
  tar -czf "$ARCHIVE_PATH" -C "${ROOT_DIR}/dist" "release-bundle"
  echo -e "\033[0;32m  [OK] Release archive created: ${ARCHIVE_PATH}\033[0m"
fi

echo -e "\n\033[1;36m==========================================================\033[0m"
echo -e "\033[1;36m  Release Build Complete!\033[0m"
echo -e "\033[1;36m  Bundle Output: ${OUTPUT_DIR}\033[0m"
echo -e "\033[1;36m==========================================================\033[0m"
