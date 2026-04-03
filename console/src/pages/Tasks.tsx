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

function EditTaskModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const updateTask = useUpdateTask();
  const [title, setTitle] = useState(task.title);
  const [details, setDetails] = useState(task.details ?? '');
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');

  const handleSave = () => {
    updateTask.mutate(
      {
        id: task.id,
        title,
        details: details || undefined,
        priority,
        status,
        dueDate: dueDate || undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-800 border border-zinc-600 rounded-lg p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">Edit Task</h3>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Title</label>
          <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={title} onChange={e => setTitle(e.target.value)} />
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Details</label>
          <textarea className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm resize-none" rows={3} value={details} onChange={e => setDetails(e.target.value)} />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Priority</label>
            <select className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={priority} onChange={e => setPriority(e.target.value as Task['priority'])}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Status</label>
            <select className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={status} onChange={e => setStatus(e.target.value as Task['status'])}>
              <option value="todo">To Do</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Due Date</label>
            <input type="date" className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button className="text-sm text-zinc-400 hover:text-zinc-300 px-4 py-2" onClick={onClose}>Cancel</button>
          <button className="text-sm bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-medium" onClick={handleSave} disabled={updateTask.isPending}>
            {updateTask.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Tasks() {
  const { data: tasks = [], isLoading } = useTasks();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const [showAdd, setShowAdd] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
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
                    {task.dueDate && (
                      <p className="text-xs text-zinc-500 mb-1">Due: {task.dueDate}</p>
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
                        <button
                          className="text-blue-400 hover:text-blue-300"
                          onClick={() => setEditingTask(task)}
                        >
                          Edit
                        </button>
                        {NEXT_STATUS[task.status] && (
                          <button
                            className="text-green-400 hover:text-green-300"
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

      {editingTask && <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} />}
    </div>
  );
}
