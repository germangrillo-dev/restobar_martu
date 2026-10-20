@echo off
title Martu Resto Bar
cd /d C:\MartuRestoBar
color 0E

echo ============================================
echo        MARTU RESTO BAR - Arranque
echo ============================================
echo.

REM --- 1) Servidor (node server.js) ---
powershell -NoProfile -Command "if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 3456 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo [1] Levantando servidor...
    if not exist "server.js" (
        echo      ERROR: no se encuentra server.js en C:\MartuRestoBar
        goto fin
    )
    start "Martu Servidor" /min cmd /c "node server.js"
    timeout /t 5 /nobreak >nul
) else (
    echo [1] Servidor ya corriendo en el puerto 3456.
)

REM --- 2) cloudflared (tunnel Cloudflare, opcional) ---
tasklist /fi "imagename eq cloudflared.exe" 2>nul | find /i "cloudflared.exe" >nul
if errorlevel 1 (
    if exist "cloudflared.exe" (
        if exist "C:\ProgramData\cloudflared\token" (
            echo [2] Levantando cloudflared...
            start "Cloudflared" /min cmd /c "cloudflared.exe tunnel run --token-file C:\ProgramData\cloudflared\token"
        ) else (
            echo [2] cloudflared sin token, se omite.
        )
    )
) else (
    echo [2] cloudflared ya corriendo.
)

echo.
echo [3] Abriendo el sistema...
start "" "http://127.0.0.1:3456/marturestobar.html"

echo.
echo Listo. Deja esta ventana abierta o minimizala.
echo Para detener todo: cerrar esta ventana y el icono del servidor.
echo.
pause

:fin
