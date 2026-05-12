import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Bot, FolderKanban, Image, Layers3, Library, Settings, WandSparkles } from "lucide-react";
import { createOpenAiCompatibleProvider, getProviderEndpoint } from "./lib/aiProvider";
import type { AiProviderDescriptor } from "./lib/aiProvider";
import { createTask, getAppConfig, listAiResults, listTasks, openTaskFolder, saveAppConfig } from "./lib/api";
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
import { aiTaskTypes, batchTaskTypes, BatchToolPanel } from "./components/BatchToolPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskCenter } from "./components/TaskCenter";
import { AiResultsPanel } from "./components/AiResultsPanel";

const defaultAiPersona =
  "你是一位资深的小游戏 IAA 广告投放专家，非常熟悉腾讯广告平台及其机制，熟悉腾讯广告 3.0，熟悉腾讯广告 3.0 如何让朋友圈的图片素材起量，熟悉腾讯妙思平台对于爆图的判断标准。";

const taskTypes: Array<{ type: TaskType; label: string; description: string }> = [
  { type: "rename", label: "图片重命名", description: "按项目规则生成批量命名任务" },
  { type: "resize", label: "图片改尺寸", description: "宽高、比例和适配模式将在 Phase 1 实现" },
  { type: "compress", label: "图片压缩", description: "质量、目标大小和格式转换将在 Phase 1 实现" },
  { type: "split", label: "图片切分", description: "2x2、2x3、3x3 等网格将在 Phase 1 实现" },
  { type: "stitch", label: "图片拼接", description: "网格拼接与留白策略将在 Phase 1 实现" },
  { type: "organize", label: "文件夹整理", description: "把处理后的图片按任务结果归档整理" },
  { type: "ai_analyze", label: "AI 广告分析", description: "视觉素材分析、爆点提取、提示词提取与示例生成" },
  { type: "ai_generate_copy", label: "图片匹配文案生成", description: "基于图片生成多组匹配广告文案与 CTA" },
  { type: "ai_generate_title", label: "图片匹配标题生成", description: "基于图片生成多组广告标题与投放角度" },
  { type: "ai_generate_image", label: "图片创意裂变", description: "提取裂变变量并生成可复用图片提示词" },
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
  aiPersona: defaultAiPersona,
  aiProductContext: "",
  aiPromptExampleCount: 5,
  aiGenerateCount: 5,
  aiCopyTone: "高转化",
  aiTargetAudience: "泛广告受众",
  aiReversePromptMode: "极致还原",
  aiVariationDirection: "参考我的小游戏风格裂变",
};

const favoriteTasksStorageKey = "ad-creative-studio.favorite-tasks";
type AppView = "project" | "ai" | "library" | "batch" | "chat" | "settings";
const aiTaskTypeSet = new Set<TaskType>(["ai_analyze", "ai_generate_copy", "ai_generate_title", "ai_generate_image"]);

const appViews: Array<{ id: AppView; label: string; icon: typeof FolderKanban }> = [
  { id: "project", label: "项目骨架", icon: FolderKanban },
  { id: "ai", label: "AI 协议层", icon: WandSparkles },
  { id: "library", label: "AI 结果库", icon: Library },
  { id: "batch", label: "批量工具", icon: Layers3 },
  { id: "chat", label: "对话模式", icon: Bot },
  { id: "settings", label: "设置", icon: Settings },
];

const viewMeta: Record<AppView, { eyebrow: string; title: string; icon: typeof FolderKanban }> = {
  project: { eyebrow: "Desktop App Foundation", title: "项目骨架", icon: FolderKanban },
  ai: { eyebrow: "Phase 2", title: "AI 协议层", icon: WandSparkles },
  library: { eyebrow: "AI Library", title: "AI 分析结果与文案库", icon: Library },
  batch: { eyebrow: "Phase 1", title: "图片批量工具", icon: Layers3 },
  chat: { eyebrow: "Phase 3", title: "对话模式", icon: Bot },
  settings: { eyebrow: "Phase 0", title: "设置", icon: Settings },
};

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [aiResults, setAiResults] = useState<AiResultRecord[]>([]);
  const [selectedTaskType, setSelectedTaskType] = useState<TaskType>("rename");
  const [selectedAiTaskType, setSelectedAiTaskType] = useState<TaskType>("ai_analyze");
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
  const [activeView, setActiveView] = useState<AppView>("batch");

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

  const selectedBatchTaskType = batchTaskTypes.some((task) => task.value === selectedTaskType) ? selectedTaskType : "rename";
  const selectedTask = useMemo(
    () => taskTypes.find((task) => task.type === selectedBatchTaskType) ?? taskTypes[0],
    [selectedBatchTaskType],
  );
  const activeViewMeta = viewMeta[activeView];
  const ActiveIcon = activeViewMeta.icon;

  function handleViewChange(view: AppView) {
    setActiveView(view);
    if (view === "batch" && !batchTaskTypes.some((task) => task.value === selectedTaskType)) {
      setSelectedTaskType("rename");
    }
  }

  async function handleSaveConfig() {
    if (!config) {
      return;
    }

    const saved = await saveAppConfig(config);
    setConfig(saved);
    setStatusMessage("配置已保存");
  }

  async function handleRunBatchTask() {
    return runTaskRequest(selectedBatchTaskType, executionMode, pipelineSteps, projectName, "正在处理图片...");
  }

  async function handleRunAiTask() {
    return runTaskRequest(selectedAiTaskType, "single", [], `${projectName}-${selectedAiTaskType}`, "正在提交 AI 任务...");
  }

  async function runTaskRequest(
    taskType: TaskType,
    mode: TaskExecutionMode,
    steps: TaskPipelineStep[],
    baseProjectName: string,
    runningMessage: string,
  ) {
    if (!config) {
      return null;
    }

    const activeSteps =
      mode === "single"
        ? [
            {
              id: "single",
              task_type: taskType,
              params: sanitizeParams(batchParams),
            },
          ]
        : steps;

    if (activeSteps.length === 0) {
      setStatusMessage("请先添加至少一个任务步骤");
      return null;
    }

    setIsRunning(true);
    setProgress(null);
    setStatusMessage(mode === "single" ? runningMessage : mode === "serial" ? "正在串联处理图片..." : "正在并联处理图片...");
    try {
      const result =
        mode === "single"
          ? await runTaskStep(activeSteps[0], inputs, baseProjectName)
          : mode === "serial"
            ? await runSerialSteps(activeSteps, baseProjectName)
            : await runParallelSteps(activeSteps, baseProjectName);
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

  async function runSerialSteps(steps: TaskPipelineStep[], baseProjectName = projectName) {
    let currentInputs = inputs;
    let lastResult = await runTaskStep(steps[0], currentInputs, `${baseProjectName}-01-${steps[0].task_type}`);
    let summary = createTaskSummary(lastResult);
    for (let index = 1; index < steps.length; index += 1) {
      if (!lastResult.output_dir || lastResult.success_count === 0) {
        break;
      }
      currentInputs = [`${lastResult.output_dir}/success`];
      const step = steps[index];
      lastResult = await runTaskStep(step, currentInputs, `${baseProjectName}-${String(index + 1).padStart(2, "0")}-${step.task_type}`);
      summary = mergeTaskSummary(summary, lastResult);
    }
    return { ...summary, task_id: lastResult.task_id, output_dir: lastResult.output_dir ?? summary.output_dir };
  }

  async function runParallelSteps(steps: TaskPipelineStep[], baseProjectName = projectName) {
    const results = await Promise.all(
      steps.map((step, index) =>
        runTaskStep(step, inputs, `${baseProjectName}-${String(index + 1).padStart(2, "0")}-${step.task_type}`),
      ),
    );
    return results.reduce(mergeTaskSummary, createEmptyTaskSummary(results));
  }

  async function handleCreatePreviewTask() {
    const result = await createTask({
      task_type: activeView === "ai" ? selectedAiTaskType : selectedBatchTaskType,
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

  function handleResubmitTask(task: TaskRecord) {
    setBatchParams({ ...defaultBatchParams, ...task.params });
    setExecutionMode("single");
    setPipelineSteps([]);

    if (aiTaskTypeSet.has(task.task_type)) {
      setActiveView("ai");
      setSelectedAiTaskType(task.task_type);
    } else {
      setActiveView("batch");
      setSelectedTaskType(task.task_type);
    }

    setStatusMessage(`已重提 ${task.task_type} 参数，请确认后手动运行`);
  }

  async function handleOpenTaskFolder(task: TaskRecord) {
    if (!task.output_dir) {
      setStatusMessage("该任务没有可打开的输出文件夹");
      return;
    }

    try {
      await openTaskFolder(task.output_dir);
      setStatusMessage("已打开任务所在文件夹");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "打开任务文件夹失败");
    }
  }

  function handleRegenerateFromResult(result: AiResultRecord, mode: "reverse_prompt" | "prompt_template") {
    const extractedText = extractResultPromptText(result);
    setInputs([result.input_path]);
    setExecutionMode("single");
    setPipelineSteps([]);
    setActiveView("ai");
    setSelectedAiTaskType("ai_generate_image");
    setBatchParams({
      ...defaultBatchParams,
      ...batchParams,
      aiProductContext:
        mode === "reverse_prompt"
          ? `基于历史 AI 结果反推并重生成图片提示词。\n来源图片：${result.input_path}\n历史结果：${extractedText}`
          : `基于历史 AI 结果整理为可复用提示词模板并重生成。\n来源图片：${result.input_path}\n模板素材：${extractedText}`,
      aiReversePromptMode: mode === "reverse_prompt" ? "极致还原" : "适用豆包",
      aiVariationDirection: mode === "reverse_prompt" ? "主体还原" : "自由裂变",
      aiGenerateCount: mode === "reverse_prompt" ? 5 : 8,
    });
    setStatusMessage(mode === "reverse_prompt" ? "已填入反推提示词重生成参数，请确认后提交" : "已填入提示词模板重生成参数，请确认后提交");
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
          {appViews.map((view) => {
            const Icon = view.icon;
            return (
              <button
                className={activeView === view.id ? "nav-item nav-item--active" : "nav-item"}
                type="button"
                onClick={() => handleViewChange(view.id)}
                key={view.id}
              >
                <Icon size={18} />
                {view.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeViewMeta.eyebrow}</p>
            <h1>
              <ActiveIcon size={30} />
              {activeViewMeta.title}
            </h1>
          </div>
          <span className="pill">{statusMessage}</span>
        </header>

        {activeView === "batch" && (
        <section className="grid-layout">
          <BatchToolPanel
            projectName={projectName}
            outputDir={outputDir}
            taskType={selectedBatchTaskType}
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
            taskTypes={batchTaskTypes}
          />

          <TaskCenter tasks={tasks} onResubmitTask={handleResubmitTask} onOpenTaskFolder={handleOpenTaskFolder} />
          <ProtocolPanel
            selectedTask={selectedTask}
            executionMode={executionMode}
            pipelineSteps={pipelineSteps}
            inputsCount={inputs.length}
            aiProvider={aiProvider}
            onCreatePreviewTask={handleCreatePreviewTask}
          />
        </section>
        )}

        {activeView === "ai" && (
        <section className="grid-layout">
          <BatchToolPanel
            projectName={projectName}
            outputDir={outputDir}
            taskType={selectedAiTaskType}
            executionMode="single"
            pipelineSteps={[]}
            favoriteTasks={[]}
            inputs={inputs}
            params={batchParams}
            isRunning={isRunning}
            progress={progress}
            onProjectNameChange={setProjectName}
            onOutputDirChange={setOutputDir}
            onTaskTypeChange={setSelectedAiTaskType}
            onExecutionModeChange={() => undefined}
            onPipelineStepsChange={() => undefined}
            onSaveFavoriteTask={() => undefined}
            onApplyFavoriteTask={() => undefined}
            onDeleteFavoriteTask={() => undefined}
            onInputsChange={setInputs}
            onParamsChange={setBatchParams}
            onRun={handleRunAiTask}
            title="AI 创意协议工作台"
            eyebrow="Phase 2-4"
            taskTypes={aiTaskTypes}
            hideFavorites
            hideExecutionMode
            runLabel="提交后台任务"
            runningLabel="提交中..."
          />

          <SettingsPanel config={config} onChange={setConfig} onSave={handleSaveConfig} />
          <TaskCenter tasks={tasks} onResubmitTask={handleResubmitTask} onOpenTaskFolder={handleOpenTaskFolder} />
          <ProtocolPanel
            selectedTask={taskTypes.find((task) => task.type === selectedAiTaskType) ?? selectedTask}
            executionMode="single"
            pipelineSteps={[]}
            inputsCount={inputs.length}
            aiProvider={aiProvider}
            onCreatePreviewTask={handleCreatePreviewTask}
          />
        </section>
        )}

        {activeView === "library" && (
        <section className="grid-layout">
          <AiResultsPanel results={aiResults} onRegenerateFromResult={handleRegenerateFromResult} />
          <TaskCenter tasks={tasks} onResubmitTask={handleResubmitTask} onOpenTaskFolder={handleOpenTaskFolder} />
        </section>
        )}

        {activeView === "settings" && (
        <section className="grid-layout">
          <SettingsPanel config={config} onChange={setConfig} onSave={handleSaveConfig} />
          <TaskCenter tasks={tasks} onResubmitTask={handleResubmitTask} onOpenTaskFolder={handleOpenTaskFolder} />
        </section>
        )}

        {activeView === "project" && (
        <section className="grid-layout">
          <TaskCenter tasks={tasks} onResubmitTask={handleResubmitTask} onOpenTaskFolder={handleOpenTaskFolder} />
          <ProtocolPanel
            selectedTask={selectedTask}
            executionMode={executionMode}
            pipelineSteps={pipelineSteps}
            inputsCount={inputs.length}
            aiProvider={aiProvider}
            onCreatePreviewTask={handleCreatePreviewTask}
          />
        </section>
        )}

        {activeView === "chat" && (
        <section className="grid-layout">
          <section className="panel panel--primary">
            <div className="panel__header">
              <div>
                <p className="eyebrow">Phase 3</p>
                <h2>对话模式</h2>
              </div>
            </div>
            <p className="empty">对话式解决问题会在后续阶段接入。</p>
          </section>
          <TaskCenter tasks={tasks} onResubmitTask={handleResubmitTask} onOpenTaskFolder={handleOpenTaskFolder} />
        </section>
        )}
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

function ProtocolPanel({
  selectedTask,
  executionMode,
  pipelineSteps,
  inputsCount,
  aiProvider,
  onCreatePreviewTask,
}: {
  selectedTask: { label: string; description: string };
  executionMode: TaskExecutionMode;
  pipelineSteps: TaskPipelineStep[];
  inputsCount: number;
  aiProvider: AiProviderDescriptor;
  onCreatePreviewTask: () => void;
}) {
  return (
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
          Run(mode="{executionMode}", steps={executionMode === "single" ? 1 : pipelineSteps.length}, inputs={inputsCount})
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
      <button className="ghost-button" type="button" onClick={onCreatePreviewTask}>
        创建空任务记录
      </button>
    </section>
  );
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

function extractResultPromptText(result: AiResultRecord) {
  const parts = [
    result.analysis_json.summary,
    result.analysis_json.hook_analysis?.core_hook,
    result.analysis_json.extracted_prompt,
    ...(result.analysis_json.prompt_examples ?? []),
    ...(result.analysis_json.items ?? []).flatMap((item) =>
      ["title", "main_copy", "short_copy", "prompt", "angle", "cta"]
        .map((key) => item[key])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    ),
  ];

  return parts
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 12)
    .join("\n");
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
