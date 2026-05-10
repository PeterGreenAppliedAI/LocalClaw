/**
 * Plugin loader — discovers and loads plugins from filesystem directories.
 *
 * Plugin structure:
 *   plugins/my-tool/
 *     plugin.json    — { name, version, type, main, description }
 *     index.js       — exports { tool } or { tools }
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolRegistry } from '../tools/registry.js';
import type { PluginManifest, PluginExport } from './types.js';

const PLUGIN_DIRS = [
  'plugins',                              // project-level
  join(process.env.HOME ?? '', '.localclaw', 'plugins'),  // user-level
];

export async function loadPlugins(toolRegistry: ToolRegistry): Promise<number> {
  let loaded = 0;

  for (const dir of PLUGIN_DIRS) {
    if (!existsSync(dir)) continue;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(dir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        if (manifest.type === 'tool') {
          const mainPath = resolve(dir, entry.name, manifest.main);
          if (!existsSync(mainPath)) {
            console.warn(`[Plugins] ${manifest.name}: main file not found at ${mainPath}`);
            continue;
          }

          const mod = await import(mainPath) as PluginExport;

          if (mod.tool) {
            toolRegistry.register(mod.tool);
            loaded++;
            console.log(`[Plugins] Loaded tool: ${manifest.name} (${manifest.version})`);
          } else if (mod.tools) {
            for (const tool of mod.tools) {
              toolRegistry.register(tool);
              loaded++;
            }
            console.log(`[Plugins] Loaded ${mod.tools.length} tools from: ${manifest.name} (${manifest.version})`);
          } else {
            console.warn(`[Plugins] ${manifest.name}: no 'tool' or 'tools' export found`);
          }
        }
        // Channel and pipeline plugin loading can be added later
      } catch (err) {
        console.warn(`[Plugins] Failed to load ${entry.name}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return loaded;
}
