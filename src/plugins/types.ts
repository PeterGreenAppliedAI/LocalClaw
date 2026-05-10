import type { LocalClawTool } from '../tools/types.js';

export interface PluginManifest {
  name: string;
  version: string;
  type: 'tool' | 'channel' | 'pipeline';
  main: string;
  description?: string;
}

export interface PluginExport {
  tool?: LocalClawTool;
  tools?: LocalClawTool[];
}
