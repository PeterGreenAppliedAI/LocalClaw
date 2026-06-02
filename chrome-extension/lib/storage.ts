import type { Settings, ChatMessage } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

const KEYS = {
  settings: 'localclaw_settings',
  messages: 'localclaw_messages',
  senderId: 'localclaw_sender_id',
} as const;

const MAX_MESSAGES = 100;

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(KEYS.settings);
  return result[KEYS.settings] ?? { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.settings]: settings });
}

export async function getMessages(): Promise<ChatMessage[]> {
  const result = await chrome.storage.local.get(KEYS.messages);
  return result[KEYS.messages] ?? [];
}

export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await chrome.storage.local.set({ [KEYS.messages]: trimmed });
}

export async function clearMessages(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.messages]: [] });
}

export async function getSenderId(): Promise<string> {
  const result = await chrome.storage.local.get(KEYS.senderId);
  if (result[KEYS.senderId]) return result[KEYS.senderId];
  const id = `chrome-${Date.now().toString(36)}`;
  await chrome.storage.local.set({ [KEYS.senderId]: id });
  return id;
}
