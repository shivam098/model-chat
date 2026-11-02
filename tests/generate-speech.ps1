$ErrorActionPreference = 'Stop'
if (-not $env:MODEL_CHAT_MEDIA_FIXTURES) { throw 'A private fixture directory is required.' }
$file = Join-Path $env:MODEL_CHAT_MEDIA_FIXTURES 'speech.wav'
$stream = New-Object -ComObject SAPI.SpFileStream
$voice = New-Object -ComObject SAPI.SpVoice
try {
    $stream.Open($file, 3, $false)
    $voice.AudioOutputStream = $stream
    $voice.Speak('The blue notebook costs twenty dollars.') | Out-Null
} finally {
    $stream.Close()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($voice) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($stream) | Out-Null
}
