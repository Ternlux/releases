# Python Executor Skill - Installation Guide

Quick start guide for installing and configuring the Python Executor skill.

## Prerequisites

- Python 3.6 or higher
- pip (Python package manager)

## Installation Steps

### Step 1: Check Python Installation

```bash
python3 --version
```

If Python is not installed:
- **macOS**: `brew install python3`
- **Ubuntu/Debian**: `sudo apt install python3 python3-pip`
- **Windows**: Download from [python.org](https://www.python.org/downloads/)

### Step 2: Run Setup Script

**macOS/Linux:**
```bash
cd plugins/skills/python-executor
./setup.sh
```

**Windows:**
```cmd
cd plugins\skills\python-executor
setup.bat
```

The setup script will:
- Verify Python is installed
- Install required packages (pandas, numpy, scipy, scikit-learn)
- Install optional packages (matplotlib, seaborn)

### Step 3: Verify Installation

Run the test script:

```bash
python3 test_setup.py
```

You should see:
```
==================================================
Testing Python Executor Skill Setup
==================================================

✓ pandas       1.5.x      - Data manipulation library
✓ numpy        1.23.x     - Numerical computing library
✓ scipy        1.9.x      - Scientific computing library
✓ sklearn      1.1.x      - Machine learning library (scikit-learn)
✓ matplotlib   3.6.x      - Plotting library (optional)
✓ seaborn      0.12.x     - Statistical visualization (optional)

==================================================
✓ All required packages are installed!
  Python Executor Skill is ready to use.
==================================================
```

### Step 4: Test in Ternlux

1. Open Ternlux application
2. Create or open a workflow
3. Add a Transformer node
4. Try a Python transformation:
   ```
   Calculate the moving average of sales over 7 days using pandas
   ```

## Troubleshooting

### Python Not Found

**Error**: `python3: command not found`

**Solution**:
- Make sure Python is installed
- Add Python to your system PATH
- On Windows, reinstall Python and check "Add Python to PATH"

### pip Not Found

**Error**: `pip3: command not found`

**Solution**:
```bash
python3 -m ensurepip --upgrade
```

### Package Installation Failed

**Error**: `Failed to install Python packages`

**Solutions**:
1. Update pip: `pip3 install --upgrade pip`
2. Use virtual environment:
   ```bash
   python3 -m venv ternlux-env
   source ternlux-env/bin/activate  # Unix/macOS
   # or ternlux-env\Scripts\activate  # Windows
   pip install -r requirements.txt
   ```

### Permission Denied

**Error**: `Permission denied` when running setup.sh

**Solution**:
```bash
chmod +x setup.sh
./setup.sh
```

### Import Errors in Ternlux

**Error**: Python packages not found when executing transformations

**Solutions**:
1. Verify installation: `python3 test_setup.py`
2. Check which Python: `which python3`
3. Install packages for the correct Python:
   ```bash
   /path/to/python3 -m pip install -r requirements.txt
   ```

## Manual Installation

If the setup script doesn't work, install packages manually:

```bash
# Required packages
pip3 install pandas>=1.5.0
pip3 install numpy>=1.23.0
pip3 install scipy>=1.9.0
pip3 install scikit-learn>=1.1.0

# Optional packages
pip3 install matplotlib>=3.6.0
pip3 install seaborn>=0.12.0
```

## Using Virtual Environments (Recommended)

For isolated Python environment:

```bash
# Create virtual environment
python3 -m venv ternlux-python-env

# Activate it
source ternlux-python-env/bin/activate  # Unix/macOS
# or
ternlux-python-env\Scripts\activate  # Windows

# Install packages
pip install -r requirements.txt

# Verify
python test_setup.py

# Note: You'll need to configure Ternlux to use this Python path:
# /path/to/ternlux-python-env/bin/python (Unix/macOS)
# C:\path\to\ternlux-python-env\Scripts\python.exe (Windows)
```

## Next Steps

- Read [README.md](./README.md) for usage examples
- Check [examples](#) for common transformation patterns
- Visit [Ternlux documentation](#) for more information

## Getting Help

If you continue to have issues:

1. Check the error messages carefully
2. Verify Python version: `python3 --version`
3. Verify pip version: `pip3 --version`
4. Run test script: `python3 test_setup.py`
5. Check Ternlux logs for detailed error messages
