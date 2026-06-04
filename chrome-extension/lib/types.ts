export interface Settings {
  host: string;
  token: string;
}

export interface FileAttachment {
  path: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  images?: string[];
  files?: FileAttachment[];
}

export interface PageContext {
  url: string;
  title: string;
  selectedText: string;
  pageContent: string;
}

export interface ChatEvent {
  type: 'chunk' | 'done';
  text?: string;
  answer?: string;
  category?: string;
  images?: string[];
  files?: FileAttachment[];
}

export const DEFAULT_SETTINGS: Settings = {
  host: '',
  token: '',
};
