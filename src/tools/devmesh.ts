import type { LocalClawTool } from './types.js';
import { toolExecutionError } from '../errors.js';

export interface DevMeshConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

const READ_ENDPOINTS = [
  'stats',
  'segments',
  'campaigns',
  'queue',
  'leads',
  'conversion',
  'trends',
] as const;

const ACTION_ENDPOINTS = [
  'discovery/run',
  'enrichment/run',
  'outreach/pause',
  'outreach/resume',
  'outreach/config',
] as const;

const ALL_ENDPOINTS = [...READ_ENDPOINTS, ...ACTION_ENDPOINTS];

export function createDevMeshTool(config: DevMeshConfig): LocalClawTool {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 30_000;

  return {
    name: 'devmesh',
    description:
      'Query or control the DevMesh AI outreach platform. ' +
      'READ endpoints (GET): stats, segments, campaigns, queue, leads, conversion, trends. ' +
      'ACTION endpoints (POST): discovery/run, enrichment/run, outreach/pause, outreach/resume, outreach/config.',
    parameterDescription:
      'endpoint (required): One of: stats, segments, campaigns, queue, leads, conversion, trends, ' +
      'discovery/run, enrichment/run, outreach/pause, outreach/resume, outreach/config. ' +
      'params (optional): JSON object of query params (GET) or request body (POST).',
    parameters: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: 'The DevMesh API endpoint to call',
          enum: [...ALL_ENDPOINTS],
        },
        params: {
          type: 'string',
          description: 'JSON object — query params for GET or request body for POST',
        },
      },
      required: ['endpoint'],
    },
    category: 'devmesh',

    async execute(params: Record<string, unknown>): Promise<string> {
      const endpoint = params.endpoint as string;
      if (!endpoint) return 'Error: endpoint parameter is required';

      if (!ALL_ENDPOINTS.includes(endpoint as typeof ALL_ENDPOINTS[number])) {
        return `Error: Unknown endpoint "${endpoint}". Valid: ${ALL_ENDPOINTS.join(', ')}`;
      }

      const isAction = (ACTION_ENDPOINTS as readonly string[]).includes(endpoint);
      const method = isAction ? 'POST' : 'GET';

      let extraParams: Record<string, unknown> = {};
      if (params.params) {
        try {
          extraParams = typeof params.params === 'string'
            ? JSON.parse(params.params)
            : params.params as Record<string, unknown>;
        } catch {
          return 'Error: params must be valid JSON';
        }
      }

      let url = `${baseUrl}/api/v1/${endpoint}`;

      // For GET requests, append query params
      if (method === 'GET' && Object.keys(extraParams).length > 0) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(extraParams)) {
          qs.set(k, String(v));
        }
        url += `?${qs}`;
      }

      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            'X-API-Key': config.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
        };

        if (method === 'POST' && Object.keys(extraParams).length > 0) {
          fetchOptions.body = JSON.stringify(extraParams);
        }

        const res = await fetch(url, fetchOptions);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          return `Error: DevMesh API returned HTTP ${res.status} — ${body || res.statusText}`;
        }

        const data = await res.json();
        return JSON.stringify(data, null, 2);
      } catch (err) {
        throw toolExecutionError('devmesh', err);
      }
    },
  };
}
