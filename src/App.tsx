import { useEffect, useMemo, useState } from "react";
import { Bot, FolderKanban, Image, Layers3, Settings, WandSparkles } from "lucide-react";
import { createTask, getAppConfig, listTasks, saveAppConfig } from "./lib/api";
import type { AppConfig, TaskRecord, TaskType } from "./lib/types";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskCenter } from "./components/TaskCenter";

const taskTypes: Array<{ type: TaskType; label: string; description: string }> = [
  { type: "rename", label: "图片重命名", description: "按项目规则生成批量命名任务" },
  { type: "resize", label: "图片改尺寸", description: "宽高、比例和适配模式将在 Phase 1 实现" },
  { type: "compress", label: "图片压缩", description: "质量、目标大小和格式转换将在 Phase 1 实现" },
  { type: "split", label: "图片切分", description: "2x2、2x3、3x3 等网格将在 Phase 1 实现" },
  { type: "stitch", label: "图片拼接", description: "网格拼接与留白策略将在 Phase 1 实现" },
  { type: "ai_analyze", label: "AI 广告分析", description: "OpenAI 协议层已预留，Phase 2 接入" },
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskType, setSelectedTaskType] = useState<TaskType>("rename");
  const [projectName, setProjectName] = useState("default-project");
  const [statusMessage, setStatusMessage] = useState("正在加载本地配置...");

  useEffect(() => {
    void Promise.all([getAppConfig(), listTasks()]).then(([nextConfig, nextTasks]) => {
      setConfig(nextConfig);
      setTasks(nextTasks);
      setStatusMessage("Phase 0 就绪");
    });
  }, []);

  const selectedTask = useMemo(
    () => taskTypes.find((task) => task.type === selectedTaskType) ?? taskTypes[0],
    [selectedTaskType],
  );

  async function handleSaveConfig() {
    if (!config) {
      return;
    }

    const saved = await saveAppConfig(config);
    setConfig(saved);
    setStatusMessage("配置已保存");
  }

  async function handleCreatePreviewTask() {
    const result = await createTask({
      task_type: selectedTaskType,
      inputs: [],
      params: {},
      output_rule: {
        project_name: projectName,
        output_dir: config?.default_output_dir ?? null,
        keep_originals: true,
      },
    });

    setStatusMessage(`已创建任务 ${result.task_id}`);
    setTasks(await listTasks());
  }

  if (!config) {
    return <main className="loading">加载中...</main>;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Image size={22} />
          </div>
          <div>
            <strong>Ad Creative Studio</strong>
            <span>广告素材 AI 工作台</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="功能导航">
          <button className="nav-item nav-item--active" type="button">
            <FolderKanban size={18} />
            项目骨架
          </button>
          <button className="nav-item" type="button">
            <Layers3 size={18} />
            批量工具
          </button>
          <button className="nav-item" type="button">
            <WandSparkles size={18} />
            AI 协议层
          </button>
          <button className="nav-item" type="button">
            <Bot size={18} />
            对话模式
          </button>
          <button className="nav-item" type="button">
            <Settings size={18} />
            设置
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Desktop App Foundation</p>
            <h1>Phase 0 基础架构</h1>
          </div>
          <span className="pill">{statusMessage}</span>
        </header>

        <section className="grid-layout">
          <section className="panel panel--primary">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Task Protocol</p>
                <h2>统一任务模型</h2>
              </div>
            </div>

            <div className="form-grid">
              <label>
                <span>项目名</span>
                <input value={projectName} onChange={(event) => setProjectName(event.target.value)} />
              </label>

              <label>
                <span>任务类型</span>
                <select
                  value={selectedTaskType}
                  onChange={(event) => setSelectedTaskType(event.target.value as TaskType)}
                >
                  {taskTypes.map((task) => (
                    <option key={task.type} value={task.type}>
                      {task.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="task-preview">
              <h3>{selectedTask.label}</h3>
              <p>{selectedTask.description}</p>
              <code>
                TaskRequest(type="{selectedTask.type}", inputs=[], outputRule.project="
                {projectName}")
              </code>
            </div>

            <button className="primary-button" type="button" onClick={handleCreatePreviewTask}>
              创建预览任务
            </button>
          </section>

          <SettingsPanel config={config} onChange={setConfig} onSave={handleSaveConfig} />
          <TaskCenter tasks={tasks} />
        </section>
      </section>
    </main>
  );
}
