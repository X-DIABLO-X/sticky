<#
.SYNOPSIS
    HeyClicky Windows Release Build & Packaging Script

.DESCRIPTION
    Builds the production-ready release bundle for HeyClicky Clone on Windows:
    1. Verifies prerequisites (Node.js, Cargo/Rust, Python)
    2. Builds the Vite React frontend
    3. Builds the Rust Tauri core release binary
    4. Packages the release bundle (Binary + MV3 Extension + Vision Sidecar + Setup scripts)
    5. Generates native host registry installer script and release ZIP archive

.EXAMPLE
    .\scripts\build_release.ps1
    .\scripts\build_release.ps1 -SkipCargo -Zip
#>

[CmdletBinding()]
param(
    [string]$OutputDir = "dist\release-bundle",
    [switch]$SkipFrontend,
    [switch]$SkipCargo,
    [switch]$Zip = $true
)

$ErrorActionPreference = "Stop"
$RootPath = (Get-Item -Path $PSScriptRoot\..).FullName

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       HeyClicky Desktop Agent - Windows Release Build     " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Workspace Root: $RootPath" -ForegroundColor Gray

# 1. Prerequisite Checks
Write-Host "`n[1/5] Verifying toolchain prerequisites..." -ForegroundColor Yellow

function Test-CommandAvailable($cmd) {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $found) {
        throw "Required tool '$cmd' is not installed or not in PATH."
    }
    Write-Host "  [OK] $cmd found ($($found.Source))" -ForegroundColor Green
}

Test-CommandAvailable "node"
Test-CommandAvailable "npm"
Test-CommandAvailable "cargo"
Test-CommandAvailable "python"

# 2. Frontend Build
if (-not $SkipFrontend) {
    Write-Host "`n[2/5] Building Vite React frontend..." -ForegroundColor Yellow
    Push-Location $RootPath
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host "Installing npm dependencies..." -ForegroundColor Gray
            npm install
        }
        Write-Host "Compiling frontend assets..." -ForegroundColor Gray
        npm run build
        Write-Host "  [OK] Frontend compiled to dist/" -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
} else {
    Write-Host "`n[2/5] Skipping frontend build (-SkipFrontend passed)" -ForegroundColor DarkGray
}

# 3. Rust Backend Build
if (-not $SkipCargo) {
    Write-Host "`n[3/5] Building Rust Tauri v2 core binary (release mode)..." -ForegroundColor Yellow
    $CargoDir = Join-Path $RootPath "src-tauri"
    Push-Location $CargoDir
    try {
        cargo build --release
        Write-Host "  [OK] Rust binary compiled." -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
} else {
    Write-Host "`n[3/5] Skipping cargo build (-SkipCargo passed)" -ForegroundColor DarkGray
}

# 4. Assemble Release Bundle
Write-Host "`n[4/5] Assembling release bundle in $OutputDir..." -ForegroundColor Yellow
$TargetBundle = Join-Path $RootPath $OutputDir
if (Test-Path $TargetBundle) {
    Remove-Item -Path $TargetBundle -Recurse -Force
}
New-Item -ItemType Directory -Path $TargetBundle -Force | Out-Null

# Locate release binary
$BinarySource = Join-Path $RootPath "src-tauri\target\release\heyclicky-clone.exe"
if (-not (Test-Path $BinarySource)) {
    # Check alternate binary name
    $AltBinary = Join-Path $RootPath "src-tauri\target\release\cliky.exe"
    if (Test-Path $AltBinary) {
        $BinarySource = $AltBinary
    }
}

if (Test-Path $BinarySource) {
    Copy-Item $BinarySource -Destination (Join-Path $TargetBundle "heyclicky-clone.exe")
    Write-Host "  Copied main binary: heyclicky-clone.exe" -ForegroundColor Green
} else {
    Write-Host "  [NOTICE] Binary not found at $BinarySource yet. Creating placeholder for packaging." -ForegroundColor DarkYellow
    Set-Content -Path (Join-Path $TargetBundle "heyclicky-clone.exe.placeholder") -Value "Compiled binary will be located here."
}

# Copy Browser Extension
$ExtensionDest = Join-Path $TargetBundle "browser-extension"
Copy-Item (Join-Path $RootPath "browser-extension") -Destination $ExtensionDest -Recurse
Write-Host "  Bundled browser-extension/" -ForegroundColor Green

# Copy Python Vision Sidecar
$SidecarDest = Join-Path $TargetBundle "sidecar-vision"
Copy-Item (Join-Path $RootPath "sidecar-vision") -Destination $SidecarDest -Recurse
Write-Host "  Bundled sidecar-vision/" -ForegroundColor Green

# Copy Setup & Model Download Scripts
$ScriptsDest = Join-Path $TargetBundle "scripts"
New-Item -ItemType Directory -Path $ScriptsDest -Force | Out-Null
Copy-Item (Join-Path $RootPath "scripts\download_models.py") -Destination (Join-Path $ScriptsDest "download_models.py")
Write-Host "  Bundled scripts/download_models.py" -ForegroundColor Green

# Copy Configuration & Documentation
if (Test-Path (Join-Path $RootPath ".env.example")) {
    Copy-Item (Join-Path $RootPath ".env.example") -Destination (Join-Path $TargetBundle ".env.example")
}
if (Test-Path (Join-Path $RootPath "README.md")) {
    Copy-Item (Join-Path $RootPath "README.md") -Destination (Join-Path $TargetBundle "README.md")
}

# Generate Register-NativeHost.ps1 helper script for easy user installation
$RegisterScript = @"
# Register HeyClicky Chrome Native Messaging Host on Windows
`$ScriptDir = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$ManifestSource = Join-Path `$ScriptDir "browser-extension\native-host\com.heyclicky.clone.json"
`$BinaryPath = (Join-Path `$ScriptDir "heyclicky-clone.exe").Replace('\', '\\')

# Update host manifest with absolute binary path
`$ManifestJson = Get-Content `$ManifestSource -Raw | ConvertFrom-Json
`$ManifestJson.path = `$BinaryPath
`$ManifestJson | ConvertTo-Json -Depth 4 | Set-Content `$ManifestSource

# Register for Google Chrome
New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.heyclicky.clone" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.heyclicky.clone" -Name "(Default)" -Value `$ManifestSource

# Register for Microsoft Edge
New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.heyclicky.clone" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.heyclicky.clone" -Name "(Default)" -Value `$ManifestSource

Write-Host "HeyClicky Native Messaging Host successfully registered!" -ForegroundColor Green
"@
Set-Content -Path (Join-Path $TargetBundle "register-native-host.ps1") -Value $RegisterScript
Write-Host "  Generated register-native-host.ps1 helper script" -ForegroundColor Green

# 5. Archive Bundle (Optional ZIP)
if ($Zip) {
    Write-Host "`n[5/5] Creating release zip archive..." -ForegroundColor Yellow
    $ZipPath = Join-Path $RootPath "dist\heyclicky-windows-x64.zip"
    if (Test-Path $ZipPath) {
        Remove-Item $ZipPath -Force
    }
    Compress-Archive -Path "$TargetBundle\*" -DestinationPath $ZipPath -CompressionLevel Optimal
    Write-Host "  [OK] Release archive created: $ZipPath" -ForegroundColor Green
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "  Release Build Complete!" -ForegroundColor Cyan
Write-Host "  Bundle Output: $TargetBundle" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
