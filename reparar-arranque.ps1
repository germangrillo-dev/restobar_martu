# Repara el arranque del sistema Martu Resto Bar
# Ejecutar como Administrador en la PC de Martu
$dir = "C:\MartuRestoBar"
$shell = New-Object -ComObject WScript.Shell

if (-not (Test-Path $dir)) {
    Write-Host "ERROR: no existe $dir" -ForegroundColor Red
    exit 1
}

# 1) Icono de escritorio (abre el navegador)
$desktop = "C:\Users\Public\Desktop\Martu Resto Bar.lnk"
if (-not (Test-Path $desktop)) {
    $sc = $shell.CreateShortcut($desktop)
    $sc.TargetPath = "http://localhost:3456/marturestobar.html"
    $sc.IconLocation = "$dir\icon-192.png"
    $sc.Save()
    Write-Host "Creado icono de escritorio" -ForegroundColor Green
} else {
    Write-Host "Icono de escritorio OK" -ForegroundColor Yellow
}

# 2) Acceso de Inicio (arranca el servidor al prender la PC)
$startup = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\Martu Resto Bar.lnk"
if (-not (Test-Path $startup)) {
    $sc2 = $shell.CreateShortcut($startup)
    $sc2.TargetPath = "cmd.exe"
    $sc2.Arguments = "/c `"$dir\INICIAR.bat`""
    $sc2.WorkingDirectory = $dir
    $sc2.IconLocation = "$dir\icon-192.png"
    $sc2.Save()
    Write-Host "Creado acceso de Inicio (arranque automatico)" -ForegroundColor Green
} else {
    Write-Host "Acceso de Inicio OK" -ForegroundColor Yellow
}

# 3) Levantar el servidor ahora si no esta corriendo
$up = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3456 -WarningAction SilentlyContinue).TcpTestSucceeded
if (-not $up) {
    Write-Host "Levantando servidor..." -ForegroundColor Cyan
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$dir\INICIAR.bat`"" -WorkingDirectory $dir
    Start-Sleep -Seconds 6
} else {
    Write-Host "Servidor ya corriendo" -ForegroundColor Yellow
}

# 4) Verificar
$up2 = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3456 -WarningAction SilentlyContinue).TcpTestSucceeded
if ($up2) {
    Write-Host "OK: servidor respondiendo en el puerto 3456" -ForegroundColor Green
    Start-Process "http://localhost:3456/marturestobar.html"
} else {
    Write-Host "El servidor no respondio. Fijate la ventana negra de node." -ForegroundColor Red
}
Write-Host ""
Write-Host "Deja abierta la ventana del servidor." -ForegroundColor Cyan
pause
