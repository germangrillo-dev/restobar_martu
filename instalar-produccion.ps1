#Requires -RunAsAdministrator
param(
    [string]$InstalarEn = "C:\MartuRestoBar",
    [string]$TokenGitHub = "",
    [switch]$DesdeGitHub = $true,
    [switch]$IniciarAhora = $true
)

$ErrorActionPreference = "Stop"

function Escribir-Texto($texto, $color = "White") {
    Write-Host $texto -ForegroundColor $color
}

Escribir-Texto "========================================" "Cyan"
Escribir-Texto "  INSTALADOR MARTU RESTO BAR" "Cyan"
Escribir-Texto "========================================" "Cyan"

# 1. Verificar/instalar Node.js
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    Escribir-Texto "Node.js no encontrado. Descargando e instalando..." "Yellow"
    $nodeInstaller = "$env:TEMP\node-installer.msi"
    $nodeUrl = "https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /qn /norestart" -Wait
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) {
        Escribir-Texto "No se pudo instalar Node.js. Instalar manualmente y reintentar." "Red"
        exit 1
    }
    Escribir-Texto "Node.js instalado correctamente." "Green"
} else {
    Escribir-Texto "Node.js encontrado: $nodePath" "Green"
}

# 2. Crear directorio de instalacion
if (-not (Test-Path $InstalarEn)) {
    New-Item -ItemType Directory -Path $InstalarEn -Force | Out-Null
}

# 3. Descargar o copiar archivos
if ($DesdeGitHub) {
    Escribir-Texto "Descargando ultima version desde GitHub..." "Yellow"
    if (-not $TokenGitHub) {
        Escribir-Texto "No se proporciono token de GitHub. Se intentara descarga publica (fallara si el repo es privado)." "Yellow"
    }
    # Descargar usando installer-download.js
    $downloaderPath = "$env:TEMP\martu-install-download.js"
    if (Test-Path "$PSScriptRoot\installer-download.js") {
        Copy-Item "$PSScriptRoot\installer-download.js" $downloaderPath -Force
    } elseif (Test-Path "$PSScriptRoot\..\installer-download.js") {
        Copy-Item "$PSScriptRoot\..\installer-download.js" $downloaderPath -Force
    } else {
        Escribir-Texto "No se encontro installer-download.js. Descarguelo del repo." "Red"
        exit 1
    }
    node $downloaderPath $InstalarEn $TokenGitHub
} else {
    Escribir-Texto "Copiando archivos desde ubicacion actual..." "Yellow"
    $origen = $PSScriptRoot
    if (-not $origen) { $origen = Get-Location }
    robocopy $origen $InstalarEn /E /XD data node_modules .git backups-instalacion /XF caja-state.json caja-state.json.bak
}

# 4. Instalar dependencias
Escribir-Texto "Instalando dependencias de Node.js..." "Yellow"
Set-Location $InstalarEn
npm install

# 5. Crear accesos directos
$shell = New-Object -ComObject WScript.Shell
$desktop = [System.Environment]::GetFolderPath("Desktop")

$startupFolder = [System.Environment]::GetFolderPath("Startup")
$startupShortcut = $shell.CreateShortcut("$startupFolder\Martu Resto Bar.lnk")
$startupShortcut.TargetPath = "cmd.exe"
$startupShortcut.Arguments = "/c `"$InstalarEn\INICIAR.bat`""
$startupShortcut.WorkingDirectory = $InstalarEn
$startupShortcut.IconLocation = "$InstalarEn\icon-192.png"
$startupShortcut.Save()
Escribir-Texto "Acceso directo de inicio creado en carpeta Startup." "Green"

# 6. Crear acceso directo en escritorio
$shortcut = $shell.CreateShortcut("$desktop\Martu Resto Bar.lnk")
$shortcut.TargetPath = "http://localhost:3456/prototipo-gestion-bar.html"
$shortcut.IconLocation = "$InstalarEn\icon-192.png"
$shortcut.Save()
Escribir-Texto "Acceso directo creado en el escritorio." "Green"

# 7. Crear script de desinstalacion
$uninstallScript = @"
#Requires -RunAsAdministrator
`$startup = [System.Environment]::GetFolderPath('Startup')
Remove-Item -Path '`$startup\Martu Resto Bar.lnk' -Force -ErrorAction SilentlyContinue
Remove-Item -Path '$($InstalarEn -replace '\\', '\\')' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path '$desktop\Martu Resto Bar.lnk' -Force -ErrorAction SilentlyContinue
Write-Host 'Martu Resto Bar desinstalado.' -ForegroundColor Green
pause
"@
Set-Content -Path "$InstalarEn\desinstalar.ps1" -Value $uninstallScript -Encoding UTF8

# 8. Iniciar ahora
if ($IniciarAhora) {
    Escribir-Texto "Iniciando servidor..." "Yellow"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$InstalarEn\INICIAR.bat`"" -WorkingDirectory $InstalarEn
    Start-Sleep -Seconds 3
}

Escribir-Texto "========================================" "Green"
Escribir-Texto "  INSTALACION COMPLETA" "Green"
Escribir-Texto "========================================" "Green"
Escribir-Texto "Sistema: http://localhost:3456/prototipo-gestion-bar.html" "Green"
Escribir-Texto "Desinstalar: $InstalarEn\desinstalar.ps1" "Green"
Escribir-Texto "Para actualizar: Configuracion -> Sistema -> Actualizar sistema" "Green"

pause
