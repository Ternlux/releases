@echo off
REM Setup script for Ternlux Python Executor Skill (Windows)
REM This script checks Python installation and installs required dependencies

echo ======================================
echo Ternlux Python Executor Setup
echo ======================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo X Python is not installed or not in PATH
    echo.
    echo Please install Python 3.6 or higher:
    echo   Download from https://www.python.org/downloads/
    echo   Make sure to check "Add Python to PATH" during installation
    pause
    exit /b 1
)

REM Show Python version
for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PYTHON_VERSION=%%i
echo √ Found Python %PYTHON_VERSION%

REM Check if pip is installed
pip --version >nul 2>&1
if errorlevel 1 (
    echo X pip is not installed
    echo.
    echo Please install pip:
    echo   python -m ensurepip --upgrade
    pause
    exit /b 1
)

echo √ Found pip
echo.

REM Install required packages
echo Installing required Python packages...
echo --------------------------------------

pip install -r "%~dp0requirements.txt"

if errorlevel 0 (
    echo.
    echo ======================================
    echo √ Setup completed successfully!
    echo ======================================
    echo.
    echo Python Executor Skill is ready to use.
    echo You can now use Python transformations in Ternlux workflows.
) else (
    echo.
    echo X Failed to install Python packages
    echo Please check the error messages above and try again.
    pause
    exit /b 1
)

pause
