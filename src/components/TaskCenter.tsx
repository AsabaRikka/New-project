import { Activity, CheckCircle2, Clock3, XCircle } from "lucide-react";
import type { TaskRecord } from "../lib/types";

interface TaskCenterProps {
  tasks: TaskRecord[];
}

const statusIcon = {
  pending: Clock3,
  running: Activity,
  paused: Clock3,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
};

export function TaskCenter({ tasks }: TaskCenterProps) {
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
          tasks.map((task) => {
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
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
