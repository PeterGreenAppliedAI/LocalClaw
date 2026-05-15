#!/usr/bin/env python3
"""
A simple CLI tool to summarize CSV files.
"""

import argparse
import pandas as pd
import sys
from typing import List

def get_csv_summary(file_path: str) -> None:
    """Generate summary statistics for a CSV file."""
    try:
        # Read the CSV file
        df = pd.read_csv(file_path)
        
        # Print row count
        print(f"Row count: {len(df)}")
        
        # Print column names
        print("Column names:")
        for col in df.columns:
            print(f"  {col}")
        
        # Get numeric columns only
        numeric_columns = df.select_dtypes(include=['number']).columns.tolist()
        
        if not numeric_columns:
            print("No numeric columns found.")
            return
        
        print("\nNumeric columns summary:")
        for col in numeric_columns:
            series = df[col].dropna()
            if len(series) == 0:
                print(f"  {col}: No data")
                continue
            
            mean_val = series.mean()
            median_val = series.median()
            std_val = series.std()
            min_val = series.min()
            max_val = series.max()
            
            print(f"  {col}:")
            print(f"    Mean: {mean_val:.2f}")
            print(f"    Median: {median_val:.2f}")
            print(f"    Std Dev: {std_val:.2f}")
            print(f"    Min: {min_val:.2f}")
            print(f"    Max: {max_val:.2f}")
            
    except FileNotFoundError:
        print(f"Error: File '{file_path}' not found.", file=sys.stderr)
        sys.exit(1)
    except pd.errors.EmptyDataError:
        print("Error: CSV file is empty.", file=sys.stderr)
        sys.exit(1)
    except pd.errors.ParserError as e:
        print(f"Error parsing CSV file: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

def main() -> None:
    """Main function to handle CLI arguments."""
    parser = argparse.ArgumentParser(description="Summarize a CSV file")
    parser.add_argument("file_path", help="Path to the CSV file")
    
    args = parser.parse_args()
    get_csv_summary(args.file_path)

if __name__ == "__main__":
    main()