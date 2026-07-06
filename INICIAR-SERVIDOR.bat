@echo off
title El Mostrador - Servidor WhatsApp
cd /d "%~dp0"
echo ============================================
echo   EL MOSTRADOR - Servidor WhatsApp
echo ============================================
echo.
echo  El QR aparecera abajo. Escanealo con:
echo  iPhone: WhatsApp ^> Config ^> Dispositivos vinculados
echo.
echo  Abri el sistema en el navegador:
echo  http://localhost:3456/prototipo-gestion-bar.html
echo.
echo ============================================
echo.
node server.js
pause
