import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bot, FolderKanban, Image, Layers3, Settings, WandSparkles } from "lucide-react";
import { createOpenAiCompatibleProvider, getProviderEndpoint } from "./lib/aiProvider";
import { createTask, getAppConfig, listTasks, saveAppConfig } from "./lib/api";
import type { AppConfig, BatchParams, TaskProgress, TaskRecord, TaskType } from "./lib/types";
import { BatchToolPanel } from "./components/BatchToolPanel";
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

const defaultBatchParams: BatchParams = {
  recursive: true,
  sortBy: "input",
  prefix: "image",
  suffix: "",
  startIndex: 1,
  padding: 3,
  resizeMode: "width",
  width: 1080,
  height: 1080,
  percent: 100,
  fit: "contain",
  allowUpscale: false,
  allowResizeToTarget: false,
  quality: 82,
  minQuality: 45,
  targetKb: null,
  outputFormat: "original",
  rows: 3,
  cols: 3,
  cellWidth: 512,
  cellHeight: 512,
  background: "#ffffff",
};

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskType, setSelectedTaskType] = useState<TaskType>("rename");
  const [projectName, setProjectName] = useState("default-project");
  const [outputDir, setOutputDir] = useState("");
  const [inputs, setInputs] = useState<string[]>([]);
  const [batchParams, setBatchParams] = useState<BatchParams>(defaultBatchParams);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [statusMessage, setStatusMessage] = useState("正在加载本地配置...");

  useEffect(() => {
    void Promise.all([getAppConfig(), listTasks()]).then(([nextConfig, nextTasks]) => {
      setConfig(nextConfig);
      setTasks(nextTasks);
      setOutputDir(nextConfig.default_output_dir ?? "");
      setStatusMessage("Phase 1 就绪");
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<TaskProgress>("task-progress", (event) => {
      setProgress(event.payload);
      setStatusMessage(event.payload.message);
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    });

    return () => {
      unlisten?.();
    };
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

  async function handleRunBatchTask() {
    if (!config) {
      return null;
    }

    setIsRunning(true);
    setProgress(null);
    setStatusMessage("正在处理图片...");
    try {
      const params = Object.fromEntries(
        Object.entries(batchParams).filter(([, value]) => value !== null && value !== ""),
      );
      const result = await createTask({
        task_type: selectedTaskType,
        inputs,
        params,
        output_rule: {
          project_name: projectName,
          output_dir: outputDir || null,
          keep_originals: true,
        },
      });
      setStatusMessage(
        `处理完成：成功 ${result.success_count}，失败 ${result.failed_count}`,
      );
      setTasks(await listTasks());
      return result;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "任务执行失败");
      return null;
    } finally {
      setIsRunning(false);
    }
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

  const aiProvider = createOpenAiCompatibleProvider(config.ai_provider);

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
          <BatchToolPanel
            projectName={projectName}
            outputDir={outputDir}
            taskType={selectedTaskType}
            inputs={inputs}
            params={batchParams}
            isRunning={isRunning}
            progress={progress}
            onProjectNameChange={setProjectName}
            onOutputDirChange={setOutputDir}
            onTaskTypeChange={setSelectedTaskType}
            onInputsChange={setInputs}
            onParamsChange={setBatchParams}
            onRun={handleRunBatchTask}
          />

          <SettingsPanel config={config} onChange={setConfig} onSave={handleSaveConfig} />
          <TaskCenter tasks={tasks} />
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Protocol</p>
                <h2>任务与 AI 协议</h2>
              </div>
            </div>
            <div className="task-preview">
              <h3>{selectedTask.label}</h3>
              <p>{selectedTask.description}</p>
              <code>
                TaskRequest(type="{selectedTask.type}", inputs={inputs.length}, project="{projectName}")
              </code>
            </div>
            <div className="task-preview">
              <h3>{aiProvider.label}</h3>
              <p>
                Responses: {getProviderEndpoint(aiProvider, "responses")} · Images:{" "}
                {getProviderEndpoint(aiProvider, "images")}
              </p>
              <code>
                text={aiProvider.models.text}; vision={aiProvider.models.vision}; image=
                {aiProvider.models.image}
              </code>
            </div>
            <button className="ghost-button" type="button" onClick={handleCreatePreviewTask}>
              创建空任务记录
            </button>
          </section>
        </section>
      </section>
    </main>
  );
}
