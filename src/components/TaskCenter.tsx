import { Activity, CheckCircle2, Clock3, FolderOpen, RefreshCcw, Square, XCircle } from "lucide-react";
import type { TaskRecord } from "../lib/types";

interface TaskCenterProps {
  tasks: TaskRecord[];
  onResubmitTask: (task: TaskRecord) => void;
  onOpenTaskFolder: (task: TaskRecord) => void;
  onCancelTask: (task: TaskRecord) => void;
}

const statusIcon = {
  pending: Clock3,
  running: Activity,
  paused: Clock3,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
};

const visibleTaskCount = 5;

export function TaskCenter({ tasks, onResubmitTask, onOpenTaskFolder, onCancelTask }: TaskCenterProps) {
  const recentTasks = tasks.slice(0, visibleTaskCount);
  const hiddenCount = Math.max(tasks.length - recentTasks.length, 0);

  return (
    <section className="panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">Task Center</p>
          <h2>任务中心</h2>
        </div>
      </div>

      <div className="task-list">
        {tasks.length === 0 ? (
          <p className="empty">暂无任务记录</p>
        ) : (
          recentTasks.map((task) => {
            const Icon = statusIcon[task.status];
            return (
              <article className="task-row" key={task.id}>
                <Icon size={18} />
                <div>
                  <strong>{task.task_type}</strong>
                  <span>
                    {task.status} · 输入 {task.input_count} · 成功 {task.success_count} · 失败{" "}
                    {task.failed_count}
                  </span>
                  {task.last_error && <p className="task-row__error">{task.last_error}</p>}
                </div>
                <div className="task-row__actions">
                  {(task.status === "pending" || task.status === "running") && (
                    <button className="tiny-button tiny-button--danger" type="button" onClick={() => onCancelTask(task)} title="取消正在进行的任务">
                      <Square size={14} />
                      取消
                    </button>
                  )}
                  <button className="tiny-button" type="button" onClick={() => onResubmitTask(task)} title="把该任务参数重新填入当前面板">
                    <RefreshCcw size={14} />
                    重提
                  </button>
                  <button
                    className="tiny-button"
                    type="button"
                    onClick={() => onOpenTaskFolder(task)}
                    disabled={!task.output_dir}
                    title={task.output_dir ? "打开该任务的输出文件夹" : "该任务没有输出文件夹"}
                  >
                    <FolderOpen size={14} />
                    打开
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
      {hiddenCount > 0 && <p className="task-list__more">仅显示最近 {visibleTaskCount} 条，已隐藏 {hiddenCount} 条历史任务</p>}
    </section>
  );
}
