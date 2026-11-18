# 编译 esp32sim 并把产物按 Tauri 要求的名字放进 src-tauri/binaries。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-sidecar.ps1
param(
    [string]$Source = (Join-Path $PSScriptRoot "..\vendor\esp32sim")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $Source "Cargo.toml"))) {
    throw "找不到上游源码：$Source（先按 README 克隆上游并 checkout d043ff1）"
}

Push-Location $Source
try {
    Write-Output "[sidecar] cargo build --release -p esp32sim"
    cargo build --release -p esp32sim
    if ($LASTEXITCODE -ne 0) { throw "cargo build 失败，退出码 $LASTEXITCODE" }

    $triple = (rustc --print host-tuple).Trim()
    if (-not $triple) { throw "无法获取目标三元组" }

    $dest = Join-Path $PSScriptRoot "..\src-tauri\binaries"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $exe = Join-Path $Source "target\release\esp32sim.exe"
    if (-not (Test-Path $exe)) { throw "产物不存在：$exe" }

    $target = Join-Path $dest "esp32sim-$triple.exe"
    Copy-Item $exe $target -Force
    Write-Output "[sidecar] 已复制到 $target"

    & $target --version
    if ($LASTEXITCODE -ne 0) { throw "sidecar --version 校验失败" }
    Write-Output "[sidecar] OK"
}
finally {
    Pop-Location
}
