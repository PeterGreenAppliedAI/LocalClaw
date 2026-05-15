from setuptools import setup, find_packages

setup(
    name="csv_summary",
    version="0.1.0",
    py_modules=["csv_summary"],
    entry_points={
        "console_scripts": [
            "csv_summary=csv_summary:main",
        ],
    },
    install_requires=[
        "pandas>=1.3.0",
        "numpy>=1.21.0",
    ],
    author="Your Name",
    author_email="your.email@example.com",
    description="A simple CLI tool to summarize CSV files",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    url="https://github.com/yourusername/csv_summary",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.6",
)