import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bot, FolderKanban, Image, Layers3, Settings, WandSparkles } from "lucide-react";
import { createOpenAiCompatibleProvider, getProviderEndpoint } from "./lib/aiProvider";
import { createTask, getAppConfig, listAiResults, listTasks, saveAppConfig } from "./lib/api";
import type {
  AiResultRecord,
  AppConfig,
  BatchParams,
  FavoriteTask,
  TaskExecutionMode,
  TaskPipelineStep,
  TaskProgress,
  TaskRecord,
  TaskResult,
  TaskStatus,
  TaskType,
} from "./lib/types";
import { BatchToolPanel } from "./components/BatchToolPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskCenter } from "./components/TaskCenter";
import { AiResultsPanel } from "./components/AiResultsPanel";

const taskTypes: Array<{ type: TaskType; label: string; description: string }> = [
  { type: "rename", label: "图片重命名", description: "按项目规则生成批量命名任务" },
  { type: "resize", label: "图片改尺寸", description: "宽高、比例和适配模式将在 Phase 1 实现" },
  { type: "compress", label: "图片压缩", description: "质量、目标大小和格式转换将在 Phase 1 实现" },
  { type: "split", label: "图片切分", description: "2x2、2x3、3x3 等网格将在 Phase 1 实现" },
  { type: "stitch", label: "图片拼接", description: "网格拼接与留白策略将在 Phase 1 实现" },
  { type: "ai_analyze", label: "AI 广告分析", description: "视觉素材分析、爆点提取、提示词提取与示例生成" },
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
  splitDetectionMode: "auto",
  splitLineMode: "none",
  splitLineWidth: 0,
  splitOuterBorder: 0,
  splitForceSquare: true,
  cellWidth: 512,
  cellHeight: 512,
  background: "#ffffff",
  aiLanguage: "zh-CN",
  aiPlatform: "通用广告",
  aiProductContext: "",
  aiPromptExampleCount: 5,
};

const favoriteTasksStorageKey = "ad-creative-studio.favorite-tasks";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [aiResults, setAiResults] = useState<AiResultRecord[]>([]);
  const [selectedTaskType, setSelectedTaskType] = useState<TaskType>("rename");
  const [executionMode, setExecutionMode] = useState<TaskExecutionMode>("single");
  const [pipelineSteps, setPipelineSteps] = useState<TaskPipelineStep[]>([]);
  const [favoriteTasks, setFavoriteTasks] = useState<FavoriteTask[]>([]);
  const [projectName, setProjectName] = useState("default-project");
  const [outputDir, setOutputDir] = useState("");
  const [inputs, setInputs] = useState<string[]>([]);
  const [batchParams, setBatchParams] = useState<BatchParams>(defaultBatchParams);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [statusMessage, setStatusMessage] = useState("正在加载本地配置...");

  useEffect(() => {
    void Promise.all([getAppConfig(), listTasks(), listAiResults()]).then(([nextConfig, nextTasks, nextAiResults]) => {
      setConfig(nextConfig);
      setTasks(nextTasks);
      setAiResults(nextAiResults);
      setFavoriteTasks(loadFavoriteTasks());
      setOutputDir(nextConfig.default_output_dir ?? "");
      setStatusMessage("Phase 1 就绪");
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<TaskProgress>("task-progress", (event) => {
      setProgress(event.payload);
      setStatusMessage(event.payload.message);
      void Promise.all([listTasks(), listAiResults()]).then(([nextTasks, nextAiResults]) => {
        setTasks(nextTasks);
        setAiResults(nextAiResults);
      });
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

    const activeSteps =
      executionMode === "single"
        ? [
            {
              id: "single",
              task_type: selectedTaskType,
              params: sanitizeParams(batchParams),
            },
          ]
        : pipelineSteps;

    if (activeSteps.length === 0) {
      setStatusMessage("请先添加至少一个任务步骤");
      return null;
    }

    setIsRunning(true);
    setProgress(null);
    setStatusMessage(
      executionMode === "serial"
        ? "正在串联处理图片..."
        : executionMode === "parallel"
          ? "正在并联处理图片..."
          : "正在处理图片...",
    );
    try {
      const result =
        executionMode === "single"
          ? await runTaskStep(activeSteps[0], inputs, projectName)
          : executionMode === "serial"
            ? await runSerialSteps(activeSteps)
            : await runParallelSteps(activeSteps);
      setStatusMessage(result.status === "running"
        ? "任务已提交到后台，处理进度会在任务中心更新"
        : `处理完成：成功 ${result.success_count}，失败 ${result.failed_count}`);
      const [nextTasks, nextAiResults] = await Promise.all([listTasks(), listAiResults()]);
      setTasks(nextTasks);
      setAiResults(nextAiResults);
      return result;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "任务执行失败");
      return null;
    } finally {
      setIsRunning(false);
    }
  }

  async function runTaskStep(step: TaskPipelineStep, stepInputs: string[], stepProjectName: string) {
    return createTask({
      task_type: step.task_type,
      inputs: stepInputs,
      params: step.params,
      output_rule: {
        project_name: stepProjectName,
        output_dir: outputDir || null,
        keep_originals: true,
      },
    });
  }

  async function runSerialSteps(steps: TaskPipelineStep[]) {
    let currentInputs = inputs;
    let lastResult = await runTaskStep(steps[0], currentInputs, `${projectName}-01-${steps[0].task_type}`);
    let summary = createTaskSummary(lastResult);
    for (let index = 1; index < steps.length; index += 1) {
      if (!lastResult.output_dir || lastResult.success_count === 0) {
        break;
      }
      currentInputs = [`${lastResult.output_dir}/success`];
      const step = steps[index];
      lastResult = await runTaskStep(step, currentInputs, `${projectName}-${String(index + 1).padStart(2, "0")}-${step.task_type}`);
      summary = mergeTaskSummary(summary, lastResult);
    }
    return { ...summary, task_id: lastResult.task_id, output_dir: lastResult.output_dir ?? summary.output_dir };
  }

  async function runParallelSteps(steps: TaskPipelineStep[]) {
    const results = await Promise.all(
      steps.map((step, index) =>
        runTaskStep(step, inputs, `${projectName}-${String(index + 1).padStart(2, "0")}-${step.task_type}`),
      ),
    );
    return results.reduce(mergeTaskSummary, createEmptyTaskSummary(results));
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

  function handleSaveFavoriteTask(name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatusMessage("请先输入常用任务名称");
      return;
    }

    const now = new Date().toISOString();
    const existing = favoriteTasks.find((task) => task.name === trimmedName);
    const favorite: FavoriteTask = {
      id: existing?.id ?? crypto.randomUUID(),
      name: trimmedName,
      execution_mode: executionMode,
      task_type: selectedTaskType,
      params: sanitizeParams(batchParams),
      pipeline_steps: pipelineSteps.map(clonePipelineStep),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    const nextFavorites = existing
      ? favoriteTasks.map((task) => (task.id === existing.id ? favorite : task))
      : [favorite, ...favoriteTasks];
    saveFavoriteTasks(nextFavorites);
    setFavoriteTasks(nextFavorites);
    setStatusMessage(`已保存常用任务：${trimmedName}`);
  }

  function handleApplyFavoriteTask(favoriteId: string) {
    const favorite = favoriteTasks.find((task) => task.id === favoriteId);
    if (!favorite) {
      return;
    }

    setExecutionMode(favorite.execution_mode);
    setSelectedTaskType(favorite.task_type);
    setBatchParams({ ...defaultBatchParams, ...favorite.params });
    setPipelineSteps(favorite.pipeline_steps.map(clonePipelineStep));
    setStatusMessage(`已调用常用任务：${favorite.name}`);
  }

  function handleDeleteFavoriteTask(favoriteId: string) {
    const nextFavorites = favoriteTasks.filter((task) => task.id !== favoriteId);
    saveFavoriteTasks(nextFavorites);
    setFavoriteTasks(nextFavorites);
    setStatusMessage("已删除常用任务");
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
            executionMode={executionMode}
            pipelineSteps={pipelineSteps}
            favoriteTasks={favoriteTasks}
            inputs={inputs}
            params={batchParams}
            isRunning={isRunning}
            progress={progress}
            onProjectNameChange={setProjectName}
            onOutputDirChange={setOutputDir}
            onTaskTypeChange={setSelectedTaskType}
            onExecutionModeChange={setExecutionMode}
            onPipelineStepsChange={setPipelineSteps}
            onSaveFavoriteTask={handleSaveFavoriteTask}
            onApplyFavoriteTask={handleApplyFavoriteTask}
            onDeleteFavoriteTask={handleDeleteFavoriteTask}
            onInputsChange={setInputs}
            onParamsChange={setBatchParams}
            onRun={handleRunBatchTask}
          />

          <SettingsPanel config={config} onChange={setConfig} onSave={handleSaveConfig} />
          <TaskCenter tasks={tasks} />
          <AiResultsPanel results={aiResults} />
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
                Run(mode="{executionMode}", steps={executionMode === "single" ? 1 : pipelineSteps.length}, inputs={inputs.length})
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

function sanitizeParams(params: BatchParams) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== ""),
  );
}

function loadFavoriteTasks(): FavoriteTask[] {
  try {
    const raw = window.localStorage.getItem(favoriteTasksStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isFavoriteTask) : [];
  } catch {
    return [];
  }
}

function saveFavoriteTasks(favorites: FavoriteTask[]) {
  window.localStorage.setItem(favoriteTasksStorageKey, JSON.stringify(favorites));
}

function isFavoriteTask(value: unknown): value is FavoriteTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<FavoriteTask>;
  return Boolean(candidate.id && candidate.name && candidate.execution_mode && candidate.task_type);
}

function clonePipelineStep(step: TaskPipelineStep): TaskPipelineStep {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}-${step.task_type}`,
    task_type: step.task_type,
    params: { ...step.params },
  };
}

function createEmptyTaskSummary(results: TaskResult[]): TaskResult {
  return {
    task_id: results[0]?.task_id ?? "",
    status: results.some((result) => result.failed_count > 0) ? "failed" : "completed",
    success_count: 0,
    failed_count: 0,
    output_dir: results[0]?.output_dir ?? null,
    errors: [],
  };
}

function createTaskSummary(result: TaskResult): TaskResult {
  return {
    task_id: result.task_id,
    status: result.status,
    success_count: result.success_count,
    failed_count: result.failed_count,
    output_dir: result.output_dir,
    errors: result.errors,
  };
}

function mergeTaskSummary(summary: TaskResult, result: TaskResult): TaskResult {
  return {
    task_id: result.task_id,
    status: mergeTaskStatus(summary.status, result.status),
    success_count: summary.success_count + result.success_count,
    failed_count: summary.failed_count + result.failed_count,
    output_dir: result.output_dir ?? summary.output_dir,
    errors: [...summary.errors, ...result.errors],
  };
}

function mergeTaskStatus(left: TaskStatus, right: TaskStatus): TaskStatus {
  if (left === "failed" || right === "failed") {
    return "failed";
  }
  if (left === "cancelled" || right === "cancelled") {
    return "cancelled";
  }
  if (left === "running" || right === "running") {
    return "running";
  }
  return right;
}
