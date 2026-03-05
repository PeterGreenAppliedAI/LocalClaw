import { useState } from 'react';
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask } from '../api/hooks';
import type { Task } from '../types';

const COLUMNS: { status: Task['status']; label: string; color: string }[] = [
  { status: 'todo', label: 'To Do', color: 'border-zinc-500' },
  { status: 'in_progress', label: 'In Progress', color: 'border-yellow-500' },
  { status: 'done', label: 'Done', color: 'border-green-500' },
  { status: 'cancelled', label: 'Cancelled', color: 'border-red-500' },
];

const NEXT_STATUS: Partial<Record<Task['status'], Task['status']>> = {
  todo: 'in_progress',
  in_progress: 'done',
};

const PRIORITY_COLORS: Record<string, string> = {
  high: 'text-red-400',
  medium: 'text-yellow-400',
  low: 'text-zinc-400',
};

export default function Tasks() {
  const { data: tasks = [], isLoading } = useTasks();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');

  const handleAdd = () => {
    if (!title.trim()) return;
    createTask.mutate(
      { title: title.trim(), details: details.trim() || undefined, priority, status: 'todo', createdBy: 'user' },
      { onSuccess: () => { setTitle(''); setDetails(''); setPriority('medium'); setShowAdd(false); } },
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Tasks</h2>
        <button
          className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-medium"
          onClick={() => setShowAdd(!showAdd)}
        >
          {showAdd ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {showAdd && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 mb-6 space-y-3">
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
            placeholder="Task title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <textarea
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm resize-none"
            placeholder="Details (optional)"
            rows={2}
            value={details}
            onChange={e => setDetails(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <select
              className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm"
              value={priority}
              onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <button
              className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-medium"
              onClick={handleAdd}
            >
              Add Task
            </button>
          </div>
        </div>
      )}

      {isLoading && <p className="text-zinc-500">Loading...</p>}

      <div className="grid grid-cols-4 gap-4">
        {COLUMNS.map(col => {
          const colTasks = tasks.filter(t => t.status === col.status);
          return (
            <div key={col.status} className={`border-t-2 ${col.color} pt-3`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-sm text-zinc-300">{col.label}</h3>
                <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full">
                  {colTasks.length}
                </span>
              </div>
              <div className="space-y-2">
                {colTasks.map(task => (
                  <div
                    key={task.id}
                    className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 group hover:border-zinc-500 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-1">
                      <h4 className="text-sm font-medium leading-tight">{task.title}</h4>
                      <span className={`text-xs ${PRIORITY_COLORS[task.priority]}`}>
                        {task.priority}
                      </span>
                    </div>
                    {task.details && (
                      <p className="text-xs text-zinc-400 mb-2 line-clamp-2">{task.details}</p>
                    )}
                    {task.tags && task.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {task.tags.map(tag => (
                          <span key={tag} className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between text-xs text-zinc-500">
                      <span>{task.assignee || task.createdBy}</span>
                      <div className="opacity-0 group-hover:opacity-100 flex gap-2 transition-opacity">
                        {NEXT_STATUS[task.status] && (
                          <button
                            className="text-blue-400 hover:text-blue-300"
                            onClick={() => updateTask.mutate({ id: task.id, status: NEXT_STATUS[task.status]! })}
                          >
                            Advance
                          </button>
                        )}
                        <button
                          className="text-red-400 hover:text-red-300"
                          onClick={() => {
                            if (confirm('Delete this task?')) deleteTask.mutate(task.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
