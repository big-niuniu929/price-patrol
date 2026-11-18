$ErrorActionPreference = "Stop"

$candidates = @()
$localPython = Join-Path $env:LocalAppData 'Programs\Python\Python312\python.exe'
if (Test-Path -LiteralPath $localPython) { $candidates += $localPython }
$pyCommand = Get-Command py -ErrorAction SilentlyContinue
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($pyCommand) { $candidates += $pyCommand.Source }
if ($pythonCommand) { $candidates += $pythonCommand.Source }

$pythonPath = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    try {
        & $candidate --version *> $null
        if ($LASTEXITCODE -eq 0) {
            $pythonPath = $candidate
            break
        }
    } catch {
        continue
    }
}

if (-not $pythonPath) {
    Write-Host "未找到 Python 3。请安装包含 Tcl/Tk 的 Python 3.11 或更高版本。" -ForegroundColor Yellow
    exit 1
}

$dependencyCheckFailed = $false
try {
    & $pythonPath -c "import openpyxl" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $dependencyCheckFailed = $true }
} catch {
    $dependencyCheckFailed = $true
}
if ($dependencyCheckFailed) {
    Write-Host "正在安装项目依赖 openpyxl..." -ForegroundColor Cyan
    & $pythonPath -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "依赖安装失败，请执行：$pythonPath -m pip install -r requirements.txt" -ForegroundColor Yellow
        exit 1
    }
}

& $pythonPath (Join-Path $PSScriptRoot 'web_app.py')
