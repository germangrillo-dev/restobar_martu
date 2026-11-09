@echo off
title Reiniciar servidor Martu
cd /d "%~dp0"
echo ============================================
echo   MARTU RESTO BAR - Reiniciar servidor
echo ============================================
echo.
set "PID="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /C:":3456 " ^| findstr /C:"LISTENING"') do set "PID=%%p"
if defined PID (
  echo Cerrando el servidor actual - proceso %PID% ...
  taskkill /F /PID %PID% >nul 2>&1
) else (
  echo No habia ningun servidor corriendo.
)
echo Esperando unos segundos...
timeout /t 6 /nobreak >nul
netstat -ano -p TCP | findstr /C:":3456 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo El servidor ya se volvio a levantar solo con la version nueva.
) else (
  echo Levantando el servidor...
  start "Martu Resto Bar - Servidor" cmd /c "%~dp0INICIAR.bat"
)
echo.
echo LISTO. Recarga el sistema en el navegador con Ctrl+F5.
echo Esta ventana se cierra sola.
timeout /t 8 /nobreak >nul
