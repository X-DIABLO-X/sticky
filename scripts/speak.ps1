param(
    [string]$Text = "",
    [string]$TextBase64 = "",
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

if ($TextBase64 -ne "") {
    $bytes = [System.Convert]::FromBase64String($TextBase64)
    $Text = [System.Text.Encoding]::UTF8.GetString($bytes)
}

if ([string]::IsNullOrWhiteSpace($Text)) {
    exit 0
}

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 1
$synth.Volume = 100

try {
    if ($OutFile -ne "") {
        $synth.SetOutputToWaveFile($OutFile)
        $synth.Speak($Text)
    } else {
        $synth.Speak($Text)
    }
} finally {
    $synth.Dispose()
}
