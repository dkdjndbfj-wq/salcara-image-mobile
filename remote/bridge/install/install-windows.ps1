# Salcara Bridge · Windows 一键安装（PowerShell）
#
#   irm {{SALCARA_BASE_URL}}/download/install-windows.ps1 | iex
#
# 下载适合这台电脑的 SalcaraBridge.exe 到 %LOCALAPPDATA%\Programs\SalcaraBridge（不需要管理员），
# 在开始菜单建快捷方式，然后启动它，浏览器里出现控制台。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Hub = if ($env:SALCARA_HUB) { $env:SALCARA_HUB } else { '{{SALCARA_BASE_URL}}' }
$Relay = '{{SALCARA_RELAY_URL}}'
if ($Hub -like '*{{*') { throw '没有中转站地址。请先设置 $env:SALCARA_HUB = "https://你的中转站/salcara-hub"' }
if ($Relay -like '*{{*') { $Relay = '' }
$Hub = $Hub.TrimEnd('/')

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'amd64' }
$name = "SalcaraBridge-windows-$arch.exe"
$dir = Join-Path $env:LOCALAPPDATA 'Programs\SalcaraBridge'
$exe = Join-Path $dir 'SalcaraBridge.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "==> 下载 $Hub/download/$name"
Invoke-WebRequest -UseBasicParsing -Uri "$Hub/download/$name" -OutFile "$exe.new"

Get-Process -Name 'SalcaraBridge', 'SalcaraBridge-windows-amd64', 'SalcaraBridge-windows-arm64' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
Move-Item -Force "$exe.new" $exe
Unblock-File $exe

$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Salcara Bridge.lnk'
try {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Description = 'Salcara 远程编程助手'
  $s.Save()
} catch { Write-Warning "无法创建开始菜单快捷方式：$_" }

Write-Host "==> 已安装到 $exe，正在启动（浏览器会打开 http://127.0.0.1:47831）"
if ($Relay) { Start-Process $exe -ArgumentList '--relay', $Relay } else { Start-Process $exe }
Write-Host ''
Write-Host '安装完成：在控制台填写 API Key 并登录，然后在「项目文件夹」添加你的代码文件夹。'
