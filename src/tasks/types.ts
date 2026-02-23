export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;              // 8-char UUID prefix
  title: string;
  details?: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: 'user' | 'bot';
  assignee?: string;       // "user" | "bot" | free-form
  dueDate?: string;        // YYYY-MM-DD
  tags?: string[];
  createdAt: string;       // ISO timestamp
  updatedAt: string;
  completedAt?: string;
}

export interface TaskCreate {
  title: string;
  details?: string;
  priority?: TaskPriority;
  assignee?: string;
  dueDate?: string;
  tags?: string[];
}

export interface TaskUpdate {
  title?: string;
  details?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  dueDate?: string;
  tags?: string[];
}

export interface TaskFilter {
  status?: TaskStatus;
  assignee?: string;
  tag?: string;
}
