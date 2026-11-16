@echo off
title CRM Vocacional - Demo local
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install
)
echo.
echo Abriendo http://localhost:4000 ...
start "" http://localhost:4000
call npm run dev
pause
