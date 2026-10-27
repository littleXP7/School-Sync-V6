@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time - this takes a few minutes...
  call npm install
)
npm start
