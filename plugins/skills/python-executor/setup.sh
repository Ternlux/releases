#!/bin/bash

# Setup script for Ternlux Python Executor Skill
# This script checks Python installation and installs required dependencies

echo "======================================"
echo "Ternlux Python Executor Setup"
echo "======================================"
echo ""

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed or not in PATH"
    echo ""
    echo "Please install Python 3.6 or higher:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu/Debian: sudo apt install python3 python3-pip"
    echo "  Windows: Download from https://www.python.org/downloads/"
    exit 1
fi

# Check Python version
PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo "✓ Found Python $PYTHON_VERSION"

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is not installed"
    echo "Please install pip3:"
    echo "  macOS/Linux: python3 -m ensurepip --upgrade"
    echo "  Ubuntu/Debian: sudo apt install python3-pip"
    exit 1
fi

echo "✓ Found pip3"
echo ""

# Install required packages
echo "Installing required Python packages..."
echo "--------------------------------------"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
pip3 install -r "$SCRIPT_DIR/requirements.txt"

if [ $? -eq 0 ]; then
    echo ""
    echo "======================================"
    echo "✓ Setup completed successfully!"
    echo "======================================"
    echo ""
    echo "Python Executor Skill is ready to use."
    echo "You can now use Python transformations in Ternlux workflows."
else
    echo ""
    echo "❌ Failed to install Python packages"
    echo "Please check the error messages above and try again."
    exit 1
fi
