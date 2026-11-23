[CmdletBinding()]
param(
    [switch]$SkipLegacy
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
$pkgJsonPath = Join-Path $repoRoot 'package.json'
$pkg = Get-Content -Path $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$extensionId = "{0}.{1}" -f $pkg.publisher, $pkg.name
$vsixPath = Join-Path $repoRoot ("dist\{0}-{1}.vsix" -f $pkg.name, $pkg.version)

function Test-ExtensionInstalled {
    param(
        [string]$CliPath,
        [string]$ExtId
    )
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $CliPath --list-extensions 2>$null
        $pattern = "^" + [regex]::Escape($ExtId) + "(@.*)?$"
        foreach ($line in @($lines)) {
            if ($null -ne $line -and ($line.ToString().Trim() -match $pattern)) {
                return $true
            }
        }
        return $false
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $prevPref
    }
}

Write-Host "=== Token Sayar (Antigravity) Kurulum ===" -ForegroundColor Cyan
Write-Host "1/2 VSIX paketi oluşturuluyor..." -ForegroundColor Yellow

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "Node.js (node) PATH içinde bulunamadı. Lütfen Node.js kurun."
    exit 1
}

Push-Location $repoRoot
try {
    & $nodeCmd.Source "scripts/package-vsix.js"
    if ($LASTEXITCODE -ne 0) {
        throw "VSIX paketleme başarısız oldu (çıkış kodu: $LASTEXITCODE)."
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $vsixPath)) {
    throw "Beklenen VSIX dosyası bulunamadı: $vsixPath"
}

Write-Host ""
Write-Host "2/2 Tespit edilen IDE'lere eklenti kuruluyor..." -ForegroundColor Yellow

$targets = @(
    @{ Name = 'Antigravity IDE (2.x)'; Cli = 'antigravity-ide'; Legacy = $false },
    @{ Name = 'Visual Studio Code';    Cli = 'code';            Legacy = $false },
    @{ Name = 'Antigravity (1.x)';     Cli = 'antigravity';     Legacy = $true  }
)

$installedCount = 0
$failedCount = 0

foreach ($target in $targets) {
    if ($SkipLegacy -and $target.Legacy) {
        Write-Host ("  [-] {0} atlandı (-SkipLegacy)." -f $target.Name) -ForegroundColor DarkGray
        continue
    }

    $cmd = Get-Command $target.Cli -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host ("  [-] {0} ({1}) PATH içinde bulunamadı, atlandı." -f $target.Name, $target.Cli) -ForegroundColor DarkGray
        continue
    }

    Write-Host ("  [*] {0} ({1}) için kuruluyor..." -f $target.Name, $target.Cli) -ForegroundColor White
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        & $cmd.Source --install-extension $vsixPath --force
        $installExit = $LASTEXITCODE
        if ($installExit -eq 0) {
            Write-Host ("  [OK] {0} kurulumu tamamlandı." -f $target.Name) -ForegroundColor Green
            $installedCount++
        } elseif (Test-ExtensionInstalled -CliPath $cmd.Source -ExtId $extensionId) {
            Write-Host ("  [OK] {0} kurulumu doğrulandı (CLI çıkış kodu: {1}, '{2}' kurulu görünüyor)." -f $target.Name, $installExit, $extensionId) -ForegroundColor Green
            $installedCount++
        } else {
            Write-Host ("  [HATA] {0} kurulumu başarısız (çıkış kodu: {1})." -f $target.Name, $installExit) -ForegroundColor Red
            $failedCount++
        }
    } catch {
        if (Test-ExtensionInstalled -CliPath $cmd.Source -ExtId $extensionId) {
            Write-Host ("  [OK] {0} kurulumu doğrulandı ('{1}' kurulu görünüyor)." -f $target.Name, $extensionId) -ForegroundColor Green
            $installedCount++
        } else {
            Write-Host ("  [HATA] {0} kurulumu sırasında hata: {1}" -f $target.Name, $_.Exception.Message) -ForegroundColor Red
            $failedCount++
        }
    } finally {
        $ErrorActionPreference = $prevPref
    }
}

Write-Host ""
if ($installedCount -eq 0) {
    Write-Warning "Hiçbir IDE'ye kurulum yapılamadı. 'antigravity-ide' veya 'code' komutlarının PATH içinde olduğundan emin olun."
    exit 1
}

Write-Host ("Kurulum özeti: {0} IDE başarılı, {1} hatalı." -f $installedCount, $failedCount) -ForegroundColor Cyan
Write-Host "Değişikliklerin etkinleşmesi için açık pencerelerde 'Developer: Reload Window' çalıştırabilirsiniz." -ForegroundColor Gray

if ($failedCount -gt 0) {
    exit 1
}
