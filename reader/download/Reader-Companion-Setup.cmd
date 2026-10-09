@echo off
rem Reader Companion: double-click to set this PC up for the reader at https://saurav717.github.io/reader/
rem (the Companion, the VS Code extension, and starting it at every login).
title Reader Companion setup
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://saurav717.github.io/reader/companion-setup.ps1 | iex"
echo.
pause
