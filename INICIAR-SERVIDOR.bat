@echo off
title El Mostrador - Servidor
cd /d "%~dp0"
echo ============================================
echo   EL MOSTRADOR - Servidor
echo ============================================
echo.
echo  Abri el sistema en el navegador:
echo  http://localhost:3456/prototipo-gestion-bar.html
echo.
echo  Para detener: cerrar esta ventana
echo ============================================
echo.
:restart
node server.js
echo.
echo [RESTART] Servidor detenido. Reiniciando en 3 segundos...
timeout /t 3 /nobreak >nul
goto restart
