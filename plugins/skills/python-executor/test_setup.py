#!/usr/bin/env python3
"""
Test script to verify Python Executor Skill setup
Run this to ensure all dependencies are correctly installed
"""

import sys
import json

def test_imports():
    """Test if all required packages can be imported"""
    print("=" * 50)
    print("Testing Python Executor Skill Setup")
    print("=" * 50)
    print()

    packages = {
        'pandas': 'Data manipulation library',
        'numpy': 'Numerical computing library',
        'scipy': 'Scientific computing library',
        'sklearn': 'Machine learning library (scikit-learn)',
        'matplotlib': 'Plotting library (optional)',
        'seaborn': 'Statistical visualization (optional)'
    }

    results = {}
    all_passed = True

    for package, description in packages.items():
        try:
            module = __import__(package if package != 'sklearn' else 'sklearn')
            version = getattr(module, '__version__', 'unknown')
            print(f"✓ {package:12} {version:10} - {description}")
            results[package] = {'installed': True, 'version': version}
        except ImportError:
            is_optional = package in ['matplotlib', 'seaborn']
            symbol = "⚠" if is_optional else "✗"
            status = "optional" if is_optional else "REQUIRED"
            print(f"{symbol} {package:12} {'N/A':10} - {description} ({status})")
            results[package] = {'installed': False, 'version': None}
            if not is_optional:
                all_passed = False

    print()
    print("=" * 50)

    if all_passed:
        print("✓ All required packages are installed!")
        print("  Python Executor Skill is ready to use.")
    else:
        print("✗ Some required packages are missing.")
        print("  Please run: pip install -r requirements.txt")
        sys.exit(1)

    print("=" * 50)
    print()

    return results


def test_transformation():
    """Test a simple transformation to ensure everything works"""
    print("Testing sample transformation...")
    print("-" * 50)

    try:
        import pandas as pd
        import numpy as np

        # Sample data
        data = [
            {'name': 'Alice', 'age': 30, 'salary': 50000},
            {'name': 'Bob', 'age': 25, 'salary': 45000},
            {'name': 'Charlie', 'age': 35, 'salary': 60000}
        ]

        # Transform
        df = pd.DataFrame(data)
        df['salary_increase'] = df['salary'] * 1.1
        df['age_group'] = pd.cut(df['age'], bins=[0, 30, 40, 100], labels=['Young', 'Middle', 'Senior'])

        print("\nOriginal Data:")
        print(df[['name', 'age', 'salary']].to_string(index=False))

        print("\nTransformed Data:")
        print(df.to_string(index=False))

        print("\n✓ Transformation test passed!")
        print("  pandas and numpy are working correctly.")

    except Exception as e:
        print(f"\n✗ Transformation test failed: {e}")
        sys.exit(1)

    print("-" * 50)
    print()


if __name__ == '__main__':
    print()
    results = test_imports()
    test_transformation()

    print("=" * 50)
    print("Setup verification complete!")
    print("=" * 50)
    print()
    print("You can now use Python transformations in Ternlux.")
    print()
    print("Example transformation:")
    print("""
import pandas as pd

def transform(data):
    df = pd.DataFrame(data)
    df['new_column'] = df['existing_column'] * 2
    return df.to_dict('records')
    """)
    print()
