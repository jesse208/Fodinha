@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado. Instale em https://nodejs.org e tente de novo.
  pause
  exit /b
)
echo Ligando o Fodinha... NAO feche esta janela enquanto estiver jogando.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"
node server.js
pause
