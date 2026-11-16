@echo off
title CRM Vocacional - Pruebas
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run typecheck
call npm test
pause
