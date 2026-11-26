$ErrorActionPreference = 'Stop'

if ($env:TAURI_ENV_ARCH -and $env:TAURI_ENV_ARCH -ne 'x86_64') {
    throw 'The bundled image runtime targets Windows x64.'
}

$worker = Join-Path (Split-Path -Parent $PSScriptRoot) 'worker'
$runtime = Join-Path $worker 'runtime\python'
$runtimeVersion = 'CPython 3.13.12 x64 / Pillow 13.0.0'
$versionFile = Join-Path $runtime 'version.txt'
if ((Test-Path -LiteralPath $versionFile) -and (Get-Content -LiteralPath $versionFile) -eq $runtimeVersion -and
    (Test-Path -LiteralPath (Join-Path $runtime 'python.exe')) -and
    (Test-Path -LiteralPath (Join-Path $runtime 'PIL\Image.py'))) {
    return
}

function Save-VerifiedArchive($Uri, $Path, $Sha256) {
    Invoke-WebRequest -Uri $Uri -OutFile $Path -UseBasicParsing -TimeoutSec 90
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
    if ($hash -ne $Sha256) {
        throw "SHA-256 verification failed: $Uri"
    }
}

$stage = Join-Path $worker ('.image-runtime-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $pythonZip = Join-Path $stage 'python.zip'
    $pillowZip = Join-Path $stage 'pillow.zip'
    Save-VerifiedArchive 'https://www.python.org/ftp/python/3.13.12/python-3.13.12-embed-amd64.zip' `
        $pythonZip '76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0'
    Save-VerifiedArchive 'https://files.pythonhosted.org/packages/d7/ed/1b16fb66a37e1b9e41370b93b2c614c7da761a5b2a41dc333f7af4639962/pillow-13.0.0-cp313-cp313-win_amd64.whl' `
        $pillowZip '9dda0788a9932776a75d8bcc020076edc308ce2508b51f6739a45e3158b3fc42'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stagedRuntime = Join-Path $stage 'python'
    [IO.Compression.ZipFile]::ExtractToDirectory($pythonZip, $stagedRuntime)
    [IO.Compression.ZipFile]::ExtractToDirectory($pillowZip, $stagedRuntime)
    $probe = Join-Path $stage 'probe.py'
    Set-Content -LiteralPath $probe -Encoding Ascii -Value 'from io import BytesIO; from PIL import Image, ImageCms; Image.new("RGB", (4, 4)).save(BytesIO(), format="PNG")'
    & (Join-Path $stagedRuntime 'python.exe') -B $probe
    if ($LASTEXITCODE -ne 0) { throw 'The embedded image runtime failed its smoke check.' }
    Set-Content -LiteralPath (Join-Path $stagedRuntime 'version.txt') -Value $runtimeVersion -Encoding Ascii

    if (Test-Path -LiteralPath $runtime) {
        $oldRuntime = (Resolve-Path -LiteralPath $runtime).Path
        if ($oldRuntime -ne [IO.Path]::GetFullPath($runtime)) { throw 'Unexpected runtime path.' }
        Move-Item -LiteralPath $oldRuntime -Destination (Join-Path $stage 'previous-python')
    }
    Move-Item -LiteralPath $stagedRuntime -Destination $runtime
} finally {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ($resolvedStage -eq [IO.Path]::GetFullPath($stage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
