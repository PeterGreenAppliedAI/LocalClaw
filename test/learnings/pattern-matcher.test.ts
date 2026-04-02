import { describe, it, expect } from 'vitest';
import { detectErrorPattern, enrichObservation } from '../../src/learnings/pattern-matcher.js';

describe('detectErrorPattern', () => {
  it('detects permission denied', () => {
    const result = detectErrorPattern('Error: EACCES: permission denied, open "/etc/hosts"');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('permission_denied');
  });

  it('detects module not found', () => {
    const result = detectErrorPattern('Error: Cannot find module "nonexistent"');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('module_not_found');
  });

  it('detects connection refused', () => {
    const result = detectErrorPattern('FetchError: request to http://localhost:9999 failed, reason: connect ECONNREFUSED');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('connection_refused');
  });

  it('detects timeout', () => {
    const result = detectErrorPattern('Error: Operation timed out after 30000ms');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('timeout');
  });

  it('detects HTTP 404', () => {
    const result = detectErrorPattern('Error: HTTP 404 Not Found');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('http_error');
  });

  it('detects rate limiting', () => {
    const result = detectErrorPattern('Error: 429 Too Many Requests');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit');
  });

  it('detects stack traces', () => {
    // Inline format: "Error: at ..."
    const result = detectErrorPattern('Error: at Object.<anonymous> (/app/index.js:5:10)');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stack_trace');

    // Python format
    const pyResult = detectErrorPattern('Traceback (most recent call last):\n  File "app.py", line 5');
    expect(pyResult).not.toBeNull();
    expect(pyResult!.type).toBe('stack_trace');
  });

  it('detects out of memory', () => {
    const result = detectErrorPattern('FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('out_of_memory');
  });

  it('returns null for clean output', () => {
    expect(detectErrorPattern('Search results: 5 items found')).toBeNull();
    expect(detectErrorPattern('File written successfully to output.txt')).toBeNull();
    expect(detectErrorPattern('The weather in NYC is 72°F and sunny')).toBeNull();
  });

  it('does not false-positive on "not found" in prose', () => {
    // Plain "not found" in conversational text should NOT trigger
    expect(detectErrorPattern('I could not find any results for that query')).toBeNull();
    expect(detectErrorPattern('The information was not found in the database')).toBeNull();
  });
});

describe('enrichObservation', () => {
  it('enriches when pattern detected', () => {
    const result = enrichObservation('ECONNREFUSED: connection refused', undefined, 'web_fetch');
    expect(result).toContain('[Error pattern: connection_refused');
    expect(result).toContain('ECONNREFUSED');
  });

  it('returns unchanged when no pattern', () => {
    const input = 'Search returned 5 results successfully';
    expect(enrichObservation(input, undefined, 'web_search')).toBe(input);
  });
});
