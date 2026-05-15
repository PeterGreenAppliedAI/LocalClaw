#!/usr/bin/env python3
"""
Unit tests for csv_summary tool.
"""

import unittest
import pandas as pd
import sys
import os
from io import StringIO
from unittest.mock import patch

# Add the current directory to Python path to import csv_summary
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import csv_summary

class TestCSVSummary(unittest.TestCase):
    
    def setUp(self):
        """Set up test data."""
        # Create a sample CSV data
        self.sample_data = """name,age,salary,department
John,25,50000,IT
Jane,30,60000,HR
Bob,35,70000,IT
Alice,28,55000,Finance
Charlie,32,65000,HR"""
        
        # Create another CSV with numeric columns only
        self.numeric_only_data = """a,b,c
1,2,3
4,5,6
7,8,9"""
        
        # Create CSV with missing values
        self.missing_data = """x,y,z
1,2,
4,,
7,8,9
,5,6"""

    def test_get_csv_summary(self):
        """Test basic functionality."""
        # Create a temporary CSV file
        with open('test_file.csv', 'w') as f:
            f.write(self.sample_data)
        
        # Capture stdout
        with patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            csv_summary.get_csv_summary('test_file.csv')
            output = mock_stdout.getvalue()
            
        # Check that output contains expected elements
        self.assertIn("Row count: 5", output)
        self.assertIn("name", output)
        self.assertIn("age", output)
        self.assertIn("salary", output)
        self.assertIn("department", output)
        
        # Clean up
        os.remove('test_file.csv')
    
    def test_get_csv_summary_numeric_only(self):
        """Test summary with numeric columns only."""
        # Create a temporary CSV file
        with open('test_numeric.csv', 'w') as f:
            f.write(self.numeric_only_data)
        
        # Capture stdout
        with patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            csv_summary.get_csv_summary('test_numeric.csv')
            output = mock_stdout.getvalue()
            
        # Check that output contains expected elements
        self.assertIn("Row count: 3", output)
        self.assertIn("a", output)
        self.assertIn("b", output)
        self.assertIn("c", output)
        self.assertIn("Mean:", output)
        self.assertIn("Median:", output)
        self.assertIn("Std Dev:", output)
        self.assertIn("Min:", output)
        self.assertIn("Max:", output)
        
        # Clean up
        os.remove('test_numeric.csv')
    
    def test_get_csv_summary_with_missing_values(self):
        """Test summary with missing values."""
        # Create a temporary CSV file
        with open('test_missing.csv', 'w') as f:
            f.write(self.missing_data)
        
        # Capture stdout
        with patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            csv_summary.get_csv_summary('test_missing.csv')
            output = mock_stdout.getvalue()
            
        # Check that output contains expected elements
        self.assertIn("Row count: 4", output)
        self.assertIn("x", output)
        self.assertIn("y", output)
        self.assertIn("z", output)
        
        # Clean up
        os.remove('test_missing.csv')

    def test_get_csv_summary_empty_file(self):
        """Test handling of empty file."""
        # Create an empty CSV file
        with open('empty_file.csv', 'w') as f:
            f.write("")
        
        # Test that it raises an error
        with self.assertRaises(SystemExit):
            csv_summary.get_csv_summary('empty_file.csv')
        
        # Clean up
        os.remove('empty_file.csv')

    def test_get_csv_summary_nonexistent_file(self):
        """Test handling of nonexistent file."""
        # Test that it raises an error for nonexistent file
        with self.assertRaises(SystemExit):
            csv_summary.get_csv_summary('nonexistent.csv')

if __name__ == '__main__':
    unittest.main()