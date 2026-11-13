param(
    [string]$Text = "Hello, this is HeyClicky speaking.",
    [string]$OutFile = ""
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 1
$synth.Volume = 100

if ($OutFile -ne "") {
    $synth.SetOutputToWaveFile($OutFile)
    $synth.Speak($Text)
    $synth.Dispose()
    Write-Output "Generated: $OutFile"
} else {
    $synth.Speak($Text)
    $synth.Dispose()
    Write-Output "Spoke directly"
}
