@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Telechargez la version LTS sur https://nodejs.org puis relancez ce fichier.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installation des dependances, premiere fois uniquement...
  call npm install
  if errorlevel 1 (
    echo L'installation a echoue.
    pause
    exit /b 1
  )
)

echo Lancement de ValPal sur http://localhost:3000 ...
start "" cmd /c "timeout /t 8 >nul && start http://localhost:3000"
call npm run dev
pause
