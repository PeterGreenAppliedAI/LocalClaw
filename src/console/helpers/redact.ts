const SECRET_KEYS = new Set([
  'token', 'apiKey', 'secret', 'password', 'credentials',
  'clientSecret', 'tenantId', 'clientId', 'refreshToken',
]);

export function redactConfig(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactConfig);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
      result[key] = '***';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactConfig(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
