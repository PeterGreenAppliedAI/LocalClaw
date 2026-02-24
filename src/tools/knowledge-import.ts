import { existsSync, statSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { KnowledgeConfig } from '../config/types.js';
import { EmbeddingStore, generateMemoryId } from '../memory/embeddings.js';
import { readDocument, chunkDocument } from '../knowledge/chunker.js';

const DEFAULT_ALLOWED_EXTENSIONS = ['.pdf', '.csv', '.md', '.txt', '.html', '.htm'];

export function createKnowledgeImportTool(
  workspacePath: string,
  ollamaClient: OllamaClient,
  config?: KnowledgeConfig,
): LocalClawTool {
  const embeddingStore = new EmbeddingStore();
  const allowedExtensions = new Set(config?.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS);
  const maxChunkSize = config?.maxChunkSize ?? 800;
  const overlapSize = config?.overlapSize ?? 100;

  return {
    name: 'knowledge_import',
    description: 'Import a document into the knowledge base. Supports: PDF, CSV, markdown, text, HTML. Documents are chunked, embedded, and indexed for semantic search.',
    parameterDescription: 'path (required): File path to import. description (optional): Brief description of the document.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to import' },
        description: { type: 'string', description: 'Brief description of the document' },
      },
      required: ['path'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>): Promise<string> {
      const filePath = params.path as string;
      const description = (params.description as string) || '';

      if (!filePath) return 'Error: path parameter is required';

      // Resolve and validate path
      const fullPath = resolve(filePath);
      const workspaceRoot = resolve(workspacePath);

      // Security: only allow files within the workspace or absolute paths the user provides
      // but block obvious traversal attempts
      if (fullPath.includes('..')) {
        return 'Error: Path traversal not allowed';
      }

      if (!existsSync(fullPath)) {
        return `Error: File not found: ${filePath}`;
      }

      const stat = statSync(fullPath);
      if (!stat.isFile()) {
        return `Error: Not a file: ${filePath}`;
      }

      const ext = extname(fullPath).toLowerCase();
      if (!allowedExtensions.has(ext)) {
        return `Error: Unsupported file type "${ext}". Supported: ${[...allowedExtensions].join(', ')}`;
      }

      try {
        // Read document content
        const text = await readDocument(fullPath);
        if (!text.trim()) {
          return `Error: File is empty or could not be read: ${filePath}`;
        }

        // Chunk the document
        const chunks = chunkDocument(text, fullPath, { maxChunkSize, overlapSize });
        if (chunks.length === 0) {
          return `Error: No chunks generated from ${filePath}`;
        }

        // Batch embed all chunks
        const chunkTexts = chunks.map(c => c.text);
        const embeddings = await ollamaClient.embed(chunkTexts);

        // Store each chunk with source: 'knowledge'
        const timestamp = new Date().toISOString();
        const filename = basename(fullPath);
        const sectionPrefix = description ? `${description} - ` : '';

        for (let i = 0; i < chunks.length; i++) {
          embeddingStore.add({
            id: generateMemoryId(),
            text: chunks[i].text.slice(0, 500),
            file: filename,
            section: `${sectionPrefix}chunk-${i + 1}`,
            embedding: embeddings[i],
            savedAt: timestamp,
            source: 'knowledge',
          });
        }

        return `Imported ${filename}: ${chunks.length} chunks indexed into knowledge base`;
      } catch (err) {
        return `Error importing document: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
