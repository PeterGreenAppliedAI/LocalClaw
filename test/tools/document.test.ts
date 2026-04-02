import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDocumentTool } from '../../src/tools/document.js';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// Check if LibreOffice is available
let libreOfficeAvailable = false;
try {
  execSync('/opt/homebrew/bin/soffice --headless --version', { stdio: 'pipe' });
  libreOfficeAvailable = true;
} catch { /* not installed */ }

const tool = createDocumentTool();
const ctx = { agentId: 'test', sessionKey: 'test', workspacePath: 'test/_tmp_doc' };

describe('document tool', () => {
  beforeEach(() => {
    mkdirSync('data/media/documents', { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    for (const f of ['test_doc.pdf', 'test_doc_src.html', 'test_csv.xlsx', 'test_csv_src.csv']) {
      try { rmSync(join('data/media/documents', f)); } catch { /* ignore */ }
    }
  });

  it('has correct tool interface', () => {
    expect(tool.name).toBe('document');
    expect(tool.category).toBe('exec');
    expect(tool.parameters?.properties.action).toBeDefined();
    expect(tool.parameters?.properties.format).toBeDefined();
    expect(tool.parameters?.required).toContain('action');
    expect(tool.parameters?.required).toContain('format');
  });

  it('rejects unsupported formats', async () => {
    const result = await tool.execute({ action: 'create', content: 'test', format: 'zip' }, ctx);
    expect(result).toContain('Unsupported format');
  });

  it('requires content for create action', async () => {
    const result = await tool.execute({ action: 'create', format: 'pdf' }, ctx);
    expect(result).toContain('Missing "content"');
  });

  it('requires inputPath for convert action', async () => {
    const result = await tool.execute({ action: 'convert', format: 'pdf' }, ctx);
    expect(result).toContain('Missing "inputPath"');
  });

  it('reports file not found for convert', async () => {
    const result = await tool.execute({ action: 'convert', inputPath: '/nonexistent/file.html', format: 'pdf' }, ctx);
    expect(result).toContain('File not found');
  });

  it('rejects unknown actions', async () => {
    const result = await tool.execute({ action: 'delete', format: 'pdf' }, ctx);
    expect(result).toContain('Unknown action');
  });

  it.skipIf(!libreOfficeAvailable)('creates HTML → PDF', async () => {
    const result = await tool.execute({
      action: 'create',
      content: '<h1>Test</h1><p>Hello world</p>',
      format: 'pdf',
      filename: 'test_doc',
    }, ctx);

    expect(result).toContain('Document created');
    expect(result).toContain('[FILE:');
    expect(existsSync('data/media/documents/test_doc.pdf')).toBe(true);
  });

  it.skipIf(!libreOfficeAvailable)('creates CSV → XLSX', async () => {
    const result = await tool.execute({
      action: 'create',
      content: 'Name,Value\nAlpha,100\nBeta,200',
      format: 'xlsx',
      filename: 'test_csv',
    }, ctx);

    expect(result).toContain('Document created');
    expect(result).toContain('[FILE:');
    expect(existsSync('data/media/documents/test_csv.xlsx')).toBe(true);
  });

  it('creates same-format file without conversion', async () => {
    const result = await tool.execute({
      action: 'create',
      content: '<h1>Test</h1>',
      format: 'html',
      filename: 'test_html',
    }, ctx);

    expect(result).toContain('Document created');
    expect(existsSync('data/media/documents/test_html.html')).toBe(true);

    // Cleanup
    try { rmSync('data/media/documents/test_html.html'); } catch { /* ignore */ }
  });
});
