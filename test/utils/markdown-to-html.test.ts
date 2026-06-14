import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../../src/utils/markdown-to-html.js';

describe('markdownToHtml', () => {
  it('renders headings, paragraphs, and lists', () => {
    const html = markdownToHtml('# Title\n\nA paragraph.\n\n- one\n- two');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>A paragraph.</p>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders GFM tables', () => {
    const html = markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders an image (chart embed) as <img>', () => {
    // This is the exact shape render_report produces for a chart placeholder
    const html = markdownToHtml('![adoption](data/workspaces/main/research/x/adoption.png)');
    expect(html).toContain('<img');
    expect(html).toContain('src="data/workspaces/main/research/x/adoption.png"');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('   \n  ')).toBe('');
  });
});
