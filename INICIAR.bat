@echo off
title Martu Resto Bar - Servidor
cd /d "%~dp0"

rem Si ya hay un servidor escuchando en el 3456, esta ventana no hace falta
netstat -ano -p TCP | findstr /C:":3456 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo ============================================
  echo   MARTU RESTO BAR - Servidor
  echo ============================================
  echo.
  echo  El servidor ya esta corriendo en el puerto 3456.
  echo  Esta ventana se cierra sola.
  echo ============================================
  timeout /t 3 /nobreak >nul
  exit /b
)

echo ============================================
echo   MARTU RESTO BAR - Servidor
echo ============================================
echo.
echo  Abri el sistema en el navegador:
echo  http://localhost:3456/marturestobar.html
echo.
echo  Para detener: cerrar esta ventana
echo ============================================
echo.

:restart
node server.js
echo.
rem Si otra instancia se quedo con el puerto, no reinciamos en bucle
netstat -ano -p TCP | findstr /C:":3456 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [STOP] El puerto 3456 lo esta usando otra instancia del sistema.
  echo [STOP] Esta ventana se cierra para no duplicar el servidor.
  timeout /t 3 /nobreak >nul
  exit /b
)
echo [RESTART] Servidor detenido. Reiniciando en 3 segundos...
timeout /t 3 /nobreak >nul
goto restart
