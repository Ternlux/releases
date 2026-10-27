# Python Executor Skill Plugin

Execute Python code directly on your local machine for complex data transformations in Ternlux workflows.

## Overview

The Python Executor skill allows you to use Python for transformations that are too complex for SQL or require specialized Python libraries like pandas, numpy, scipy, or scikit-learn.

## Requirements

- Python 3.6 or higher installed on your system
- Python accessible via `python3` command (or custom path)

## Installation

### Quick Setup (Recommended)

Run the setup script to install all required Python dependencies:

**macOS/Linux:**
```bash
cd plugins/skills/python-executor
chmod +x setup.sh
./setup.sh
```

**Windows:**
```cmd
cd plugins\skills\python-executor
setup.bat
```

### Manual Installation

If you prefer to install packages manually:

```bash
pip install -r requirements.txt
```

Or install individual packages:
```bash
pip install pandas numpy scipy scikit-learn
```

## Recommended Libraries

The following Python libraries are included in `requirements.txt`:

**Required:**
- **pandas** (>=1.5.0) - Data manipulation and analysis
- **numpy** (>=1.23.0) - Numerical computing

**Recommended:**
- **scipy** (>=1.9.0) - Scientific computing
- **scikit-learn** (>=1.1.0) - Machine learning

**Optional:**
- **matplotlib** (>=3.6.0) - Data visualization
- **seaborn** (>=0.12.0) - Statistical visualization

## Verify Installation

### Quick Verification

Run the included test script:

```bash
python3 test_setup.py
```

This will:
- Check if all required packages are installed
- Show package versions
- Run a sample transformation to verify everything works

### Manual Verification

Alternatively, verify your Python environment manually:

```bash
# Check Python version
python3 --version

# Verify required packages are installed
python3 -c "import pandas; import numpy; import scipy; print('✓ All packages installed')"

# Check package versions
python3 -c "import pandas as pd; import numpy as np; import scipy; print(f'pandas: {pd.__version__}'); print(f'numpy: {np.__version__}'); print(f'scipy: {scipy.__version__}')"
```

Expected output:
```
✓ All packages installed
pandas: 1.5.x
numpy: 1.23.x
scipy: 1.9.x
```

## Usage in Workflows

### In Transformer Nodes

When configuring a Transformer node, you can describe your transformation in natural language, and the AI will generate Python code if appropriate.

Examples:
- "Calculate the moving average of sales over 7 days using pandas"
- "Remove outliers using z-score method"
- "Normalize numerical columns using min-max scaling"
- "Group by customer and calculate aggregate statistics"

### Python Code Format

Your Python code must include a `transform(data)` function:

```python
import pandas as pd

def transform(data):
    # data is a list of dictionaries
    df = pd.DataFrame(data)

    # Perform your transformation
    df['new_column'] = df['existing_column'] * 2

    # Return as list of dictionaries
    return df.to_dict('records')
```

### Input/Output Format

- **Input**: List of dictionaries `[{col1: val1, col2: val2}, ...]`
- **Output**: List of dictionaries with the same or modified structure

## Example Transformations

### 1. Calculate Moving Average

```python
import pandas as pd

def transform(data):
    df = pd.DataFrame(data)
    df = df.sort_values('date')
    df['moving_avg'] = df['value'].rolling(window=7).mean()
    return df.to_dict('records')
```

### 2. Remove Outliers (Z-Score Method)

```python
import pandas as pd
import numpy as np
from scipy import stats

def transform(data):
    df = pd.DataFrame(data)
    z_scores = np.abs(stats.zscore(df['value']))
    df_clean = df[z_scores < 3]
    return df_clean.to_dict('records')
```

### 3. Normalize Data

```python
import pandas as pd
from sklearn.preprocessing import MinMaxScaler

def transform(data):
    df = pd.DataFrame(data)
    scaler = MinMaxScaler()
    df['normalized_value'] = scaler.fit_transform(df[['value']])
    return df.to_dict('records')
```

### 4. Text Processing

```python
import pandas as pd
import re

def transform(data):
    df = pd.DataFrame(data)

    # Clean text
    df['clean_text'] = df['text'].str.lower()
    df['clean_text'] = df['clean_text'].apply(lambda x: re.sub(r'[^a-z0-9\s]', '', x))

    # Extract hashtags
    df['hashtags'] = df['text'].apply(lambda x: re.findall(r'#\w+', x))

    return df.to_dict('records')
```

## Error Handling

The plugin automatically handles:
- Input/output serialization
- Temporary file management
- Process timeouts (5 minutes)
- Error messages from Python execution

If your transformation fails, check:
1. Required libraries are installed
2. The `transform` function is defined correctly
3. Input data format matches expectations
4. No infinite loops or excessive memory usage

## Security Considerations

- Python code executes with the same permissions as the Ternlux application
- Code runs in a temporary directory that's automatically cleaned up
- 5-minute timeout prevents runaway processes
- No network access restrictions (use caution with external API calls)

## Advanced Configuration

### Custom Python Path

If Python is not in your system PATH or you want to use a specific version:

1. Set the `pythonPath` parameter when executing
2. Example: `/usr/local/bin/python3.9`

### Virtual Environments

To use a Python virtual environment:

```bash
# Create virtual environment
python3 -m venv ternlux-env

# Activate it
source ternlux-env/bin/activate  # Unix/macOS
# or
ternlux-env\Scripts\activate  # Windows

# Install libraries
pip install pandas numpy scipy

# Use the venv Python path in Ternlux
# /path/to/ternlux-env/bin/python
```

## Limitations

- **Execution Time**: Maximum 5 minutes per transformation
- **Memory**: Limited by system RAM
- **Libraries**: Only installed Python libraries are available
- **State**: Each execution is isolated (no persistent state between runs)

## Troubleshooting

### "Python not found"
Ensure Python 3 is installed and accessible via `python3` command.

```bash
# Test Python installation
python3 --version
```

### "Module not found"
Install the required library:

```bash
pip install <library-name>
```

### "Transformation timed out"
Optimize your code or process data in smaller batches.

### Memory errors
Reduce batch size or use more memory-efficient operations.

## Performance Tips

1. **Use pandas efficiently**: Avoid loops, use vectorized operations
2. **Batch processing**: For large datasets, process in chunks
3. **Memory management**: Delete large intermediate variables
4. **Optimize imports**: Only import what you need

Example of efficient pandas code:
```python
import pandas as pd

def transform(data):
    df = pd.DataFrame(data)

    # Good: Vectorized operation
    df['result'] = df['a'] * df['b'] + df['c']

    # Avoid: Loop (slow)
    # for idx, row in df.iterrows():
    #     df.at[idx, 'result'] = row['a'] * row['b'] + row['c']

    return df.to_dict('records')
```
