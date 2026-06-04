import type { Settings, ChatEvent } from './types.js';

function headers(token: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export async function healthCheck(settings: Settings): Promise<boolean> {
  try {
    const res = await fetch(`${settings.host}/health`, {
      headers: headers(settings.token),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function* streamChat(
  settings: Settings,
  message: string,
  senderId: string,
): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${settings.host}/console/api/chat`, {
    method: 'POST',
    headers: headers(settings.token),
    body: JSON.stringify({ message, senderId }),
  });

  if (!res.ok) {
    yield { type: 'done', answer: `Error: ${res.status} ${res.statusText}` };
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    yield { type: 'done', answer: 'Error: No response stream' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === ':keepalive') continue;

      try {
        const data = JSON.parse(raw);
        if (data.type === 'done') {
          yield {
            type: 'done',
            answer: data.answer ?? '',
            category: data.category,
            images: data.images,
          };
        }
      } catch {
        // Not JSON — treat as text chunk
        yield { type: 'chunk', text: raw };
      }
    }
  }
}

export function fileUrl(settings: Settings, path: string): string {
  return `${settings.host}/console/api/files/${encodeURIComponent(path)}`;
}

/** Register extension as remote browser backend */
export async function connectBrowser(settings: Settings): Promise<boolean> {
  try {
    const res = await fetch(`${settings.host}/console/api/browser/connect`, {
      method: 'POST',
      headers: headers(settings.token),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Unregister extension as remote browser backend */
export async function disconnectBrowser(settings: Settings): Promise<void> {
  try {
    await fetch(`${settings.host}/console/api/browser/disconnect`, {
      method: 'POST',
      headers: headers(settings.token),
    });
  } catch { /* best-effort */ }
}

/** Poll for pending browser action from LocalClaw */
export async function pollBrowserAction(settings: Settings): Promise<any | null> {
  try {
    const res = await fetch(`${settings.host}/console/api/browser/action`, {
      headers: headers(settings.token),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.none) return null;
    return data;
  } catch {
    return null;
  }
}

/** Post browser action result back to LocalClaw */
export async function postBrowserResult(
  settings: Settings,
  result: { id: string; success: boolean; result: string },
): Promise<void> {
  await fetch(`${settings.host}/console/api/browser/action`, {
    method: 'POST',
    headers: headers(settings.token),
    body: JSON.stringify(result),
  });
}
