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
echo  Para detener: DETENER-SERVIDOR.bat
echo ============================================
echo.

rem El servidor sabe que corre dentro de este bucle (al actualizar solo sale y aca se vuelve a levantar)
set "MARTU_SUPERVISADO=1"
if not exist "data" mkdir "data"
if exist "data\detener.flag" del /f /q "data\detener.flag" >nul 2>&1

:restart
if "%MARTU_OCULTO%"=="1" (
  rem Sin ventana: lo que muestra el servidor queda en data\servidor.log, se rota a los 5 MB
  for %%A in ("data\servidor.log") do if %%~zA GTR 5000000 move /y "data\servidor.log" "data\servidor-anterior.log" >nul 2>&1
  echo [%date% %time%] Arranca el servidor >> "data\servidor.log"
  node server.js >> "data\servidor.log" 2>&1
) else (
  node server.js
)
echo.
rem Lo detuvieron a proposito con DETENER-SERVIDOR.bat
if exist "data\detener.flag" (
  del /f /q "data\detener.flag" >nul 2>&1
  exit /b
)
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
