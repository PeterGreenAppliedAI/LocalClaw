import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchApi } from './client';
import type { SystemStatus, OllamaModel, ChannelInfo, SessionMeta, ConversationTurn, Task, CronJob, FactEntry, ToolInfo, ResearchDeck } from '../types';

// --- System ---
export function useStatus() {
  return useQuery<SystemStatus>({ queryKey: ['status'], queryFn: () => fetchApi('/status'), refetchInterval: 30_000 });
}
export function useModels() {
  return useQuery<OllamaModel[]>({ queryKey: ['models'], queryFn: () => fetchApi('/models') });
}

// --- Channels ---
export function useChannels() {
  return useQuery<ChannelInfo[]>({ queryKey: ['channels'], queryFn: () => fetchApi('/channels'), refetchInterval: 15_000 });
}

// --- Sessions ---
export function useSessions(agentId?: string) {
  const params = agentId ? `?agentId=${agentId}` : '';
  return useQuery<SessionMeta[]>({ queryKey: ['sessions', agentId], queryFn: () => fetchApi(`/sessions${params}`) });
}
export function useTranscript(agentId: string, sessionKey: string) {
  return useQuery<ConversationTurn[]>({
    queryKey: ['transcript', agentId, sessionKey],
    queryFn: () => fetchApi(`/sessions/${agentId}/${encodeURIComponent(sessionKey)}`),
    enabled: !!agentId && !!sessionKey,
  });
}

// --- Tasks ---
export function useTasks(status?: string) {
  const params = status ? `?status=${status}` : '';
  return useQuery<Task[]>({ queryKey: ['tasks', status], queryFn: () => fetchApi(`/tasks${params}`) });
}
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task: Partial<Task>) => fetchApi<Task>('/tasks', { method: 'POST', body: JSON.stringify(task) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...changes }: { id: string } & Partial<Task>) =>
      fetchApi<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetchApi(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
}

// --- Cron ---
export function useCronJobs() {
  return useQuery<CronJob[]>({ queryKey: ['cron'], queryFn: () => fetchApi('/cron') });
}
export function useRunCronJob() {
  return useMutation({
    mutationFn: (id: string) => fetchApi<{ result: string }>(`/cron/${id}/run`, { method: 'POST' }),
  });
}
export function useToggleCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      fetchApi(`/cron/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}
export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetchApi(`/cron/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cron'] }),
  });
}

// --- Channels ---
export function useReconnectChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fetchApi(`/channels/${id}/reconnect`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channels'] }),
  });
}

// --- Facts ---
export function useFacts(senderId?: string, query?: string) {
  const params = new URLSearchParams();
  if (senderId) params.set('senderId', senderId);
  if (query) params.set('query', query);
  const qs = params.toString() ? `?${params}` : '';
  return useQuery<FactEntry[]>({ queryKey: ['facts', senderId, query], queryFn: () => fetchApi(`/facts/all${qs}`) });
}
export function useMemorySenders() {
  return useQuery<string[]>({ queryKey: ['memory-senders'], queryFn: () => fetchApi('/memory/senders') });
}
export function useConsolidateFacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (senderId?: string) => {
      const body = senderId ? JSON.stringify({ senderId }) : undefined;
      return fetchApi('/facts/consolidate', { method: 'POST', body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['facts'] }),
  });
}
export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, sessionKey }: { agentId: string; sessionKey: string }) =>
      fetchApi(`/sessions/${agentId}/${encodeURIComponent(sessionKey)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

// --- Tools ---
export function useTools() {
  return useQuery<ToolInfo[]>({ queryKey: ['tools'], queryFn: () => fetchApi('/tools') });
}

// --- Research ---
export function useResearchDecks() {
  return useQuery<ResearchDeck[]>({ queryKey: ['research'], queryFn: () => fetchApi('/research'), refetchInterval: 30_000 });
}
export function useDeleteResearchDeck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => fetchApi(`/research/${slug}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['research'] }),
  });
}

// --- Config ---
export function useConfig() {
  return useQuery<Record<string, unknown>>({ queryKey: ['config'], queryFn: () => fetchApi('/config') });
}
