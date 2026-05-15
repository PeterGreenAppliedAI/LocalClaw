# CSV Summary

A simple CLI tool to summarize CSV files with basic statistics for numeric columns.

## Installation

```bash
pip install -r requirements.txt
```

## Usage

```bash
csv_summary <path_to_csv_file>
```

## Features

- Displays row count
- Lists column names
- Shows basic statistics (mean, median, std dev, min, max) for numeric columns only
- Handles missing values gracefully
- Provides clear error messages for invalid files

## Example Output

```
Row count: 5
Column names:
  name
  age
  salary
  department

Numeric columns summary:
  age:
    Mean: 30.00
    Median: 30.00
    Std Dev: 5.00
    Min: 25.00
    Max: 35.00
  salary:
    Mean: 60000.00
    Median: 60000.00
    Std Dev: 6000.00
    Min: 50000.00
    Max: 70000.00
```

## Testing

Run unit tests with:

```bash
python test_csv_summary.py
```