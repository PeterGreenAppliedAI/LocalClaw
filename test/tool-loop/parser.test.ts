import { describe, it, expect } from 'vitest';
import { parseReActResponse } from '../../src/tool-loop/parser.js';

describe('parseReActResponse', () => {
  it('parses Action with bracket syntax', () => {
    const text = 'Thought: I need to search for news\nAction: web_search[{"query": "AI news"}]';
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.tool).toBe('web_search');
      expect(result.params).toEqual({ query: 'AI news' });
      expect(result.thought).toBe('I need to search for news');
    }
  });

  it('parses Action with paren syntax (react-loop.js compat)', () => {
    const text = 'Thought: searching\nAction: web_fetch({"url": "https://example.com"})';
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.tool).toBe('web_fetch');
      expect(result.params).toEqual({ url: 'https://example.com' });
    }
  });

  it('parses Final Answer', () => {
    const text = 'Thought: I have the info\nFinal Answer: Here are the results...';
    const result = parseReActResponse(text);
    expect(result.type).toBe('final_answer');
    if (result.type === 'final_answer') {
      expect(result.answer).toBe('Here are the results...');
      expect(result.thought).toBe('I have the info');
    }
  });

  it('parses multiline Final Answer', () => {
    const text = 'Thought: done\nFinal Answer: Line 1\nLine 2\nLine 3';
    const result = parseReActResponse(text);
    expect(result.type).toBe('final_answer');
    if (result.type === 'final_answer') {
      expect(result.answer).toBe('Line 1\nLine 2\nLine 3');
    }
  });

  it('handles empty input as fallback', () => {
    expect(parseReActResponse('').type).toBe('fallback');
    expect(parseReActResponse('  ').type).toBe('fallback');
  });

  it('treats unrecognized format as fallback', () => {
    const text = 'I would be happy to help you with that.';
    const result = parseReActResponse(text);
    expect(result.type).toBe('fallback');
    if (result.type === 'fallback') {
      expect(result.content).toBe('I would be happy to help you with that.');
    }
  });

  it('strips Thought: prefix in fallback', () => {
    const text = 'Thought: The user just wants to chat about their day.';
    const result = parseReActResponse(text);
    expect(result.type).toBe('fallback');
    if (result.type === 'fallback') {
      expect(result.content).toBe('The user just wants to chat about their day.');
    }
  });

  // JSON5 repair layer tests (ChatGPT feedback §2)
  it('parses Action with single quotes (JSON5 repair)', () => {
    const text = "Thought: searching\nAction: web_search[{'query': 'AI news'}]";
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.params).toEqual({ query: 'AI news' });
    }
  });

  it('parses Action with trailing comma (JSON5 repair)', () => {
    const text = 'Thought: searching\nAction: web_search[{"query": "AI news",}]';
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.params).toEqual({ query: 'AI news' });
    }
  });

  it('parses Action with unquoted keys (JSON5 repair)', () => {
    const text = 'Thought: searching\nAction: web_search[{query: "AI news", count: 5}]';
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.params).toEqual({ query: 'AI news', count: 5 });
    }
  });

  it('handles nested JSON in Action', () => {
    const text = 'Thought: need to run\nAction: exec[{"command": "echo", "args": {"verbose": true}}]';
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.params).toEqual({ command: 'echo', args: { verbose: true } });
    }
  });

  it('returns empty params when no JSON found after Action', () => {
    const text = 'Thought: doing something\nAction: web_search[no json here]';
    const result = parseReActResponse(text);
    expect(result.type).toBe('action');
    if (result.type === 'action') {
      expect(result.tool).toBe('web_search');
      expect(result.params).toEqual({});
    }
  });
});
