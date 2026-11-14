@echo off
rem Pasa el servidor a modo "sin ventana" (una sola vez). Pide permiso de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
title Activar servidor sin ventana - Martu
echo ============================================
echo   MARTU RESTO BAR - Servidor sin ventana
echo ============================================
echo.
echo [1] Arranque automatico al prender la PC (sin ventana)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%~dp0'.TrimEnd('\'); $sh=New-Object -ComObject WScript.Shell; $l=$sh.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\Martu Resto Bar.lnk'); $l.TargetPath='wscript.exe'; $l.Arguments=('"'+$d+'\iniciar-oculto.vbs"'); $l.WorkingDirectory=$d; $l.IconLocation=($d+'\icon-192.png'); $l.Save(); $u=[Environment]::GetFolderPath('Startup'); Get-ChildItem $u -Filter *.lnk -EA SilentlyContinue | ? { $_.Name -like '*Martu*' -or $_.Name -like '*Resto*' } | Remove-Item -Force"
echo.
echo [2] Cerrando el servidor actual (y su ventana negra)...
for /f "tokens=2 delims=," %%p in ('tasklist /v /fo csv ^| findstr /i /c:"Martu Resto Bar - Servidor"') do taskkill /F /T /PID %%~p >nul 2>&1
set "PID="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /C:":3456 " ^| findstr /C:"LISTENING"') do set "PID=%%p"
if defined PID taskkill /F /PID %PID% >nul 2>&1
timeout /t 3 /nobreak >nul
echo.
echo [3] Levantando el servidor sin ventana...
wscript.exe "%~dp0iniciar-oculto.vbs"
timeout /t 8 /nobreak >nul
netstat -ano -p TCP | findstr /C:":3456 " | findstr /C:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo ERROR: el servidor no respondio. Mira data\servidor.log
) else (
  echo LISTO. El servidor corre sin ventana y se levanta solo si se cae.
  echo   - Reiniciar: REINICIAR-SERVIDOR.bat
  echo   - Detener:   DETENER-SERVIDOR.bat
  echo   - Ver lo que muestra: data\servidor.log
)
echo.
pause
