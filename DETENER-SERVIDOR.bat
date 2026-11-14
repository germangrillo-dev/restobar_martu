@echo off
title Detener servidor Martu
cd /d "%~dp0"
echo ============================================
echo   MARTU RESTO BAR - Detener servidor
echo ============================================
echo.
echo  OJO: mientras este detenido, ninguna pantalla ni celular funciona.
echo.
choice /c SN /m "Detener el servidor"
if errorlevel 2 exit /b
if not exist "data" mkdir "data"
echo x> "data\detener.flag"
set "PID="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /C:":3456 " ^| findstr /C:"LISTENING"') do set "PID=%%p"
if defined PID (
  taskkill /F /PID %PID% >nul 2>&1
  echo Servidor detenido. Para volver a levantarlo: doble clic en iniciar-oculto.vbs
) else (
  del /f /q "data\detener.flag" >nul 2>&1
  echo No habia ningun servidor corriendo.
)
timeout /t 6 /nobreak >nul
