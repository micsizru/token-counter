[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
$pkgJsonPath = Join-Path $repoRoot 'package.json'
$pkg = Get-Content -Path $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$extensionId = "{0}.{1}" -f $pkg.publisher, $pkg.name

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

Write-Host "=== Token Sayar (Antigravity) Kaldırma ===" -ForegroundColor Cyan

$targets = @(
    @{ Name = 'Antigravity IDE (2.x)'; Cli = 'antigravity-ide' },
    @{ Name = 'Visual Studio Code';    Cli = 'code'            },
    @{ Name = 'Antigravity (1.x)';     Cli = 'antigravity'     }
)

$foundCliCount = 0
$removedCount = 0

foreach ($target in $targets) {
    $cmd = Get-Command $target.Cli -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host ("  [-] {0} ({1}) PATH içinde bulunamadı, atlandı." -f $target.Name, $target.Cli) -ForegroundColor DarkGray
        continue
    }

    $foundCliCount++
    Write-Host ("  [*] {0} ({1}) içinden '{2}' kaldırılıyor..." -f $target.Name, $target.Cli, $extensionId) -ForegroundColor White

    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        & $cmd.Source --uninstall-extension $extensionId
        $uninstallExit = $LASTEXITCODE
        if ($uninstallExit -eq 0) {
            Write-Host ("  [OK] {0} üzerinden kaldırıldı." -f $target.Name) -ForegroundColor Green
            $removedCount++
        } elseif (-not (Test-ExtensionInstalled -CliPath $cmd.Source -ExtId $extensionId)) {
            Write-Host ("  [OK] {0} üzerinde eklenti artık kurulu değil (CLI çıkış kodu: {1})." -f $target.Name, $uninstallExit) -ForegroundColor Green
            $removedCount++
        } else {
            Write-Host ("  [HATA] {0} üzerinden kaldırılamadı (çıkış kodu: {1})." -f $target.Name, $uninstallExit) -ForegroundColor Red
        }
    } catch {
        if (-not (Test-ExtensionInstalled -CliPath $cmd.Source -ExtId $extensionId)) {
            Write-Host ("  [OK] {0} üzerinde eklenti artık kurulu değil." -f $target.Name) -ForegroundColor Green
            $removedCount++
        } else {
            Write-Host ("  [HATA] {0} kaldırma sırasında hata: {1}" -f $target.Name, $_.Exception.Message) -ForegroundColor Red
        }
    } finally {
        $ErrorActionPreference = $prevPref
    }
}

Write-Host ""
if ($foundCliCount -eq 0) {
    Write-Warning "PATH içinde desteklenen hiçbir IDE CLI komutu bulunamadı."
    exit 1
}

Write-Host ("Kaldırma tamamlandı ({0} IDE temizlendi). Açık pencereleri yenilemek için 'Developer: Reload Window' çalıştırabilirsiniz." -f $removedCount) -ForegroundColor Cyan
