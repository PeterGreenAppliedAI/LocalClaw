export interface Settings {
  host: string;
  token: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  images?: string[];
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
}

export const DEFAULT_SETTINGS: Settings = {
  host: '',
  token: '',
};
