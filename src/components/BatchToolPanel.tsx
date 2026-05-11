import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  FolderOpen,
  Grid2X2,
  Images,
  List,
  Play,
  Save,
  Shuffle,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { BatchParams, FavoriteTask, TaskExecutionMode, TaskPipelineStep, TaskProgress, TaskResult, TaskType } from "../lib/types";

interface BatchToolPanelProps {
  projectName: string;
  outputDir: string;
  taskType: TaskType;
  executionMode: TaskExecutionMode;
  pipelineSteps: TaskPipelineStep[];
  favoriteTasks: FavoriteTask[];
  inputs: string[];
  params: BatchParams;
  isRunning: boolean;
  progress: TaskProgress | null;
  onProjectNameChange: (value: string) => void;
  onOutputDirChange: (value: string) => void;
  onTaskTypeChange: (value: TaskType) => void;
  onExecutionModeChange: (value: TaskExecutionMode) => void;
  onPipelineStepsChange: (value: TaskPipelineStep[]) => void;
  onSaveFavoriteTask: (name: string) => void;
  onApplyFavoriteTask: (id: string) => void;
  onDeleteFavoriteTask: (id: string) => void;
  onInputsChange: (inputs: string[]) => void;
  onParamsChange: (params: BatchParams) => void;
  onRun: () => Promise<TaskResult | null>;
  title?: string;
  eyebrow?: string;
  taskTypes?: Array<{ value: TaskType; label: string }>;
  hideFavorites?: boolean;
  hideExecutionMode?: boolean;
  runLabel?: string;
  runningLabel?: string;
}

export const batchTaskTypes: Array<{ value: TaskType; label: string }> = [
  { value: "rename", label: "图片重命名" },
  { value: "resize", label: "图片改尺寸" },
  { value: "compress", label: "图片压缩" },
  { value: "convert", label: "格式转换" },
  { value: "split", label: "图片切分" },
  { value: "stitch", label: "图片拼接" },
  { value: "organize", label: "文件夹整理" },
];

export const aiTaskTypes: Array<{ value: TaskType; label: string }> = [
  { value: "ai_analyze", label: "AI 广告分析" },
  { value: "ai_generate_copy", label: "图片匹配文案" },
  { value: "ai_generate_title", label: "图片匹配标题" },
  { value: "ai_generate_image", label: "创意裂变提示词" },
];

const allTaskTypes = [...batchTaskTypes, ...aiTaskTypes];

export function BatchToolPanel({
  projectName,
  outputDir,
  taskType,
  executionMode,
  pipelineSteps,
  favoriteTasks,
  inputs,
  params,
  isRunning,
  progress,
  onProjectNameChange,
  onOutputDirChange,
  onTaskTypeChange,
  onExecutionModeChange,
  onPipelineStepsChange,
  onSaveFavoriteTask,
  onApplyFavoriteTask,
  onDeleteFavoriteTask,
  onInputsChange,
  onParamsChange,
  onRun,
  title = "图片批量工具",
  eyebrow = "Phase 1",
  taskTypes = batchTaskTypes,
  hideFavorites = false,
  hideExecutionMode = false,
  runLabel,
  runningLabel = "处理中...",
}: BatchToolPanelProps) {
  const [selectedInputs, setSelectedInputs] = useState<Set<string>>(new Set());
  const [isQueueExpanded, setIsQueueExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<"list" | "thumb">("list");
  const [favoriteName, setFavoriteName] = useState("");
  const [selectedFavoriteId, setSelectedFavoriteId] = useState("");
  const selectedCount = selectedInputs.size;
  const imageExtensions = useMemo(() => new Set(["jpg", "jpeg", "png", "webp"]), []);

  async function pickImages() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (Array.isArray(selected)) {
      onInputsChange(dedupeInputs([...inputs, ...selected]));
    } else if (typeof selected === "string") {
      onInputsChange(dedupeInputs([...inputs, selected]));
    }
  }

  async function pickFolder() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      onInputsChange(dedupeInputs([...inputs, selected]));
    }
  }

  async function pickOutputDir() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      onOutputDirChange(selected);
    }
  }

  const updateParams = (patch: Partial<BatchParams>) => onParamsChange({ ...params, ...patch });
  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  function toggleSelected(input: string) {
    const next = new Set(selectedInputs);
    if (next.has(input)) {
      next.delete(input);
    } else {
      next.add(input);
    }
    setSelectedInputs(next);
  }

  function selectAll() {
    setSelectedInputs(new Set(inputs));
  }

  function invertSelection() {
    setSelectedInputs(new Set(inputs.filter((input) => !selectedInputs.has(input))));
  }

  function removeSelected() {
    if (selectedInputs.size === 0) {
      return;
    }
    onInputsChange(inputs.filter((input) => !selectedInputs.has(input)));
    setSelectedInputs(new Set());
  }

  function removeOne(input: string) {
    onInputsChange(inputs.filter((item) => item !== input));
    const next = new Set(selectedInputs);
    next.delete(input);
    setSelectedInputs(next);
  }

  function isImagePath(input: string) {
    const extension = input.split(".").pop()?.toLowerCase() ?? "";
    return imageExtensions.has(extension);
  }

  function addPipelineStep() {
    onPipelineStepsChange([
      ...pipelineSteps,
      {
        id: `${Date.now()}-${taskType}`,
        task_type: taskType,
        params: sanitizeParams(params),
      },
    ]);
  }

  function removePipelineStep(id: string) {
    onPipelineStepsChange(pipelineSteps.filter((step) => step.id !== id));
  }

  function movePipelineStep(id: string, direction: -1 | 1) {
    const index = pipelineSteps.findIndex((step) => step.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= pipelineSteps.length) {
      return;
    }
    const next = [...pipelineSteps];
    const [step] = next.splice(index, 1);
    next.splice(nextIndex, 0, step);
    onPipelineStepsChange(next);
  }

  function saveFavorite() {
    onSaveFavoriteTask(favoriteName);
  }

  function applyFavorite(id: string) {
    setSelectedFavoriteId(id);
    onApplyFavoriteTask(id);
  }

  function deleteFavorite() {
    if (!selectedFavoriteId) {
      return;
    }
    onDeleteFavoriteTask(selectedFavoriteId);
    setSelectedFavoriteId("");
  }

  return (
    <section className="panel panel--primary">
      <div className="panel__header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
      </div>

      <div className="form-grid">
        <label>
          <span>项目名</span>
          <input value={projectName} onChange={(event) => onProjectNameChange(event.target.value)} />
        </label>
        <label>
          <span>任务类型</span>
          <select value={taskType} onChange={(event) => onTaskTypeChange(event.target.value as TaskType)}>
            {taskTypes.map((task) => (
              <option key={task.value} value={task.value}>
                {task.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!hideFavorites && (
      <div className="favorite-panel">
        <div className="favorite-panel__save">
          <label>
            <span>常用任务名称</span>
            <input value={favoriteName} onChange={(event) => setFavoriteName(event.target.value)} placeholder="例如：九宫格切分后转 JPG" />
          </label>
          <button className="secondary-button" type="button" onClick={saveFavorite}>
            <Save size={16} />
            保存当前任务为常用任务
          </button>
        </div>
        <div className="favorite-panel__load">
          <label>
            <span>调用常用任务</span>
            <select value={selectedFavoriteId} onChange={(event) => applyFavorite(event.target.value)}>
              <option value="">选择常用任务</option>
              {favoriteTasks.map((favorite) => (
                <option key={favorite.id} value={favorite.id}>
                  {favorite.name} · {favorite.execution_mode === "single" ? "单任务" : favorite.execution_mode === "serial" ? "串联" : "并联"}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost-button" type="button" onClick={deleteFavorite} disabled={!selectedFavoriteId}>
            <Trash2 size={16} />
            删除
          </button>
        </div>
      </div>
      )}

      {!hideExecutionMode && (
      <div className="run-mode-panel">
        <div className="segmented-control" aria-label="任务运行方式">
          <button
            className={executionMode === "single" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
            type="button"
            onClick={() => onExecutionModeChange("single")}
          >
            单任务
          </button>
          <button
            className={executionMode === "serial" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
            type="button"
            onClick={() => onExecutionModeChange("serial")}
          >
            串联
          </button>
          <button
            className={executionMode === "parallel" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
            type="button"
            onClick={() => onExecutionModeChange("parallel")}
          >
            并联
          </button>
        </div>

        {executionMode !== "single" && (
          <div className="pipeline-panel">
            <div className="pipeline-toolbar">
              <button className="secondary-button" type="button" onClick={addPipelineStep}>
                <CopyPlus size={16} />
                添加当前任务
              </button>
              <span>{executionMode === "serial" ? "按列表顺序依次处理" : "同一批输入同时处理"}</span>
            </div>
            <div className="pipeline-list">
              {pipelineSteps.length === 0 ? (
                <p className="empty">先选择任务类型和参数，再添加到任务流</p>
              ) : (
                pipelineSteps.map((step, index) => (
                  <div className="pipeline-step" key={step.id}>
                    <span className="pipeline-step__index">{index + 1}</span>
                    <strong>{taskLabel(step.task_type)}</strong>
                    <span>{summarizeStepParams(step)}</span>
                    <div className="pipeline-step__actions">
                      <button className="icon-button icon-button--small" type="button" onClick={() => movePipelineStep(step.id, -1)} disabled={index === 0} aria-label="上移任务">
                        <ChevronDown size={14} className="rotate-up" />
                      </button>
                      <button className="icon-button icon-button--small" type="button" onClick={() => movePipelineStep(step.id, 1)} disabled={index === pipelineSteps.length - 1} aria-label="下移任务">
                        <ChevronDown size={14} />
                      </button>
                      <button className="icon-button icon-button--small" type="button" onClick={() => removePipelineStep(step.id)} aria-label="移除任务">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      )}

      <div className="toolbar">
        <button className="secondary-button" type="button" onClick={pickImages}>
          <Images size={16} />
          选择图片
        </button>
        <button className="secondary-button" type="button" onClick={pickFolder}>
          <FolderOpen size={16} />
          选择文件夹
        </button>
        <button className="ghost-button" type="button" onClick={() => onInputsChange([])}>
          <Trash2 size={16} />
          清空
        </button>
      </div>

      <label className="form-grid__full">
        <span>输出目录</span>
        <div className="inline-field inline-field--two">
          <input value={outputDir} onChange={(event) => onOutputDirChange(event.target.value)} />
          <button className="secondary-button" type="button" onClick={pickOutputDir}>
            <FolderOpen size={16} />
            选择
          </button>
        </div>
      </label>

      <div className="queue-panel">
        <div className="queue-toolbar">
          <button className="queue-toggle" type="button" onClick={() => setIsQueueExpanded(!isQueueExpanded)}>
            {isQueueExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            已选队列 ({inputs.length})
          </button>
          <div className="queue-actions">
            <button className="tiny-button" type="button" onClick={() => setViewMode(viewMode === "list" ? "thumb" : "list")}>
              {viewMode === "list" ? <Grid2X2 size={15} /> : <List size={15} />}
              {viewMode === "list" ? "缩略图" : "列表"}
            </button>
            <button className="tiny-button" type="button" onClick={selectAll} disabled={inputs.length === 0}>
              <CheckSquare size={15} />
              全选
            </button>
            <button className="tiny-button" type="button" onClick={invertSelection} disabled={inputs.length === 0}>
              <Shuffle size={15} />
              反选
            </button>
            <button className="tiny-button tiny-button--danger" type="button" onClick={removeSelected} disabled={selectedCount === 0}>
              <Trash2 size={15} />
              删除所选
            </button>
          </div>
        </div>

        {isQueueExpanded && (
          <div className={viewMode === "list" ? "input-list" : "thumb-grid"}>
            {inputs.length === 0 ? (
              <p className="empty">还没有选择图片或文件夹</p>
            ) : (
              inputs.map((input) =>
                viewMode === "list" ? (
                  <div className="input-row" key={input}>
                    <input
                      type="checkbox"
                      checked={selectedInputs.has(input)}
                      onChange={() => toggleSelected(input)}
                      aria-label={`选择 ${input}`}
                    />
                    <span>{input}</span>
                    <button className="icon-button icon-button--small" type="button" onClick={() => removeOne(input)} aria-label="从队列移除">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : (
                  <article className="thumb-card" key={input}>
                    <label className="thumb-card__check">
                      <input
                        type="checkbox"
                        checked={selectedInputs.has(input)}
                        onChange={() => toggleSelected(input)}
                        aria-label={`选择 ${input}`}
                      />
                    </label>
                    <div className="thumb-card__preview">
                      {isImagePath(input) ? (
                        <img
                          src={toAssetUrl(input)}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.dataset.failed = "true";
                          }}
                        />
                      ) : (
                        <FolderOpen size={32} />
                      )}
                    </div>
                    <div className="thumb-card__footer">
                      <span title={input}>{fileName(input)}</span>
                      <button className="icon-button icon-button--small" type="button" onClick={() => removeOne(input)} aria-label="从队列移除">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ),
              )
            )}
          </div>
        )}
      </div>

      <div className="form-grid form-grid--spaced">
        <label>
          <span>递归读取文件夹</span>
          <select
            value={params.recursive ? "true" : "false"}
            onChange={(event) => updateParams({ recursive: event.target.value === "true" })}
          >
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        </label>
        <label>
          <span>排序方式</span>
          <select value={params.sortBy} onChange={(event) => updateParams({ sortBy: event.target.value as BatchParams["sortBy"] })}>
            <option value="input">输入顺序</option>
            <option value="filename">文件名</option>
            <option value="modified">修改时间</option>
            <option value="created">创建时间</option>
          </select>
        </label>
      </div>

      {taskType === "rename" && (
        <div className="form-grid form-grid--spaced">
          <NumberField label="起始序号" value={params.startIndex} onChange={(startIndex) => updateParams({ startIndex })} />
          <NumberField label="序号位数" value={params.padding} onChange={(padding) => updateParams({ padding })} />
          <label>
            <span>前缀</span>
            <input value={params.prefix} onChange={(event) => updateParams({ prefix: event.target.value })} />
          </label>
          <label>
            <span>后缀</span>
            <input value={params.suffix} onChange={(event) => updateParams({ suffix: event.target.value })} />
          </label>
        </div>
      )}

      {taskType === "resize" && (
        <div className="form-grid form-grid--spaced">
          <label>
            <span>缩放模式</span>
            <select value={params.resizeMode} onChange={(event) => updateParams({ resizeMode: event.target.value as BatchParams["resizeMode"] })}>
              <option value="width">按宽度等比</option>
              <option value="height">按高度等比</option>
              <option value="fixed">固定宽高</option>
              <option value="percent">百分比</option>
            </select>
          </label>
          <label>
            <span>适配模式</span>
            <select value={params.fit} onChange={(event) => updateParams({ fit: event.target.value as BatchParams["fit"] })}>
              <option value="contain">Contain</option>
              <option value="cover">Cover</option>
              <option value="stretch">Stretch</option>
            </select>
          </label>
          <NumberField label="宽度" value={params.width} onChange={(width) => updateParams({ width })} />
          <NumberField label="高度" value={params.height} onChange={(height) => updateParams({ height })} />
          <NumberField label="百分比" value={params.percent} onChange={(percent) => updateParams({ percent })} />
          <label>
            <span>允许放大小图</span>
            <select
              value={params.allowUpscale ? "true" : "false"}
              onChange={(event) => updateParams({ allowUpscale: event.target.value === "true" })}
            >
              <option value="false">关闭</option>
              <option value="true">开启</option>
            </select>
          </label>
        </div>
      )}

      {(taskType === "compress" || taskType === "convert" || taskType === "resize" || taskType === "split") && (
        <div className="form-grid form-grid--spaced">
          <label>
            <span>输出格式</span>
            <select value={params.outputFormat} onChange={(event) => updateParams({ outputFormat: event.target.value as BatchParams["outputFormat"] })}>
              <option value="original">保持原格式</option>
              <option value="jpg">JPEG</option>
              <option value="png">PNG</option>
              <option value="webp">WebP</option>
            </select>
          </label>
          <NumberField label="质量" value={params.quality} onChange={(quality) => updateParams({ quality })} />
          {(taskType === "compress" || taskType === "convert") && (
            <>
              <NumberField
                label="目标大小 KB"
                value={params.targetKb ?? 0}
                onChange={(targetKb) => updateParams({ targetKb: targetKb > 0 ? targetKb : null })}
              />
              <NumberField label="最低质量" value={params.minQuality} onChange={(minQuality) => updateParams({ minQuality })} />
              <label>
                <span>超标时改尺寸</span>
                <select
                  value={params.allowResizeToTarget ? "true" : "false"}
                  onChange={(event) => updateParams({ allowResizeToTarget: event.target.value === "true" })}
                >
                  <option value="false">不允许</option>
                  <option value="true">允许</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}

      {(taskType === "split" || taskType === "stitch") && (
        <div className="form-grid form-grid--spaced">
          <NumberField label="行数" value={params.rows} onChange={(rows) => updateParams({ rows })} />
          <NumberField label="列数" value={params.cols} onChange={(cols) => updateParams({ cols })} />
          {taskType === "split" && (
            <>
              <label>
                <span>边框识别</span>
                <select
                  value={params.splitDetectionMode}
                  onChange={(event) => updateParams({ splitDetectionMode: event.target.value as BatchParams["splitDetectionMode"] })}
                >
                  <option value="auto">智能识别</option>
                  <option value="manual">手动线宽</option>
                </select>
              </label>
              <label>
                <span>处理分隔线</span>
                <select
                  value={params.splitLineMode}
                  disabled={params.splitDetectionMode === "auto"}
                  onChange={(event) => updateParams({ splitLineMode: event.target.value as BatchParams["splitLineMode"] })}
                >
                  <option value="none">不处理</option>
                  <option value="black">黑线</option>
                  <option value="white">白线</option>
                  <option value="black_white">黑线和白线</option>
                </select>
              </label>
              <NumberField label="分隔线宽 px" value={params.splitLineWidth} disabled={params.splitDetectionMode === "auto"} onChange={(splitLineWidth) => updateParams({ splitLineWidth })} />
              <NumberField label="外边框宽 px" value={params.splitOuterBorder} disabled={params.splitDetectionMode === "auto"} onChange={(splitOuterBorder) => updateParams({ splitOuterBorder })} />
              <label>
                <span>输出方形单元</span>
                <select
                  value={params.splitForceSquare ? "true" : "false"}
                  onChange={(event) => updateParams({ splitForceSquare: event.target.value === "true" })}
                >
                  <option value="true">开启</option>
                  <option value="false">关闭</option>
                </select>
              </label>
            </>
          )}
          {taskType === "stitch" && (
            <>
              <NumberField label="单元宽度" value={params.cellWidth} onChange={(cellWidth) => updateParams({ cellWidth })} />
              <NumberField label="单元高度" value={params.cellHeight} onChange={(cellHeight) => updateParams({ cellHeight })} />
              <label>
                <span>背景色</span>
                <input value={params.background} onChange={(event) => updateParams({ background: event.target.value })} />
              </label>
              <label>
                <span>单元适配</span>
                <select value={params.fit} onChange={(event) => updateParams({ fit: event.target.value as BatchParams["fit"] })}>
                  <option value="contain">Contain</option>
                  <option value="cover">Cover</option>
                  <option value="stretch">Stretch</option>
                </select>
              </label>
            </>
          )}
        </div>
      )}

      {(taskType === "ai_analyze" || taskType === "ai_generate_copy" || taskType === "ai_generate_title" || taskType === "ai_generate_image") && (
        <div className="form-grid form-grid--spaced">
          <label>
            <span>输出语言</span>
            <select value={params.aiLanguage} onChange={(event) => updateParams({ aiLanguage: event.target.value })}>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          <label>
            <span>投放场景</span>
            <select value={params.aiPlatform} onChange={(event) => updateParams({ aiPlatform: event.target.value })}>
              <option value="通用广告">通用广告</option>
              <option value="电商详情/主图">电商详情/主图</option>
              <option value="信息流广告">信息流广告</option>
              <option value="社媒帖子">社媒帖子</option>
              <option value="短视频封面">短视频封面</option>
            </select>
          </label>
          {taskType === "ai_analyze" ? (
            <NumberField label="提示词示例数" value={params.aiPromptExampleCount} onChange={(aiPromptExampleCount) => updateParams({ aiPromptExampleCount })} />
          ) : (
            <>
              <NumberField label={taskType === "ai_generate_image" ? "裂变提示词数量" : "生成数量"} value={params.aiGenerateCount} onChange={(aiGenerateCount) => updateParams({ aiGenerateCount })} />
              <label>
                <span>语气/风格</span>
                <select value={params.aiCopyTone} onChange={(event) => updateParams({ aiCopyTone: event.target.value })}>
                  <option value="高转化">高转化</option>
                  <option value="年轻活泼">年轻活泼</option>
                  <option value="专业可信">专业可信</option>
                  <option value="强促销">强促销</option>
                  <option value="轻奢质感">轻奢质感</option>
                </select>
              </label>
              <label>
                <span>目标人群</span>
                <input value={params.aiTargetAudience} onChange={(event) => updateParams({ aiTargetAudience: event.target.value })} placeholder="例如：新手妈妈、二次元玩家、通勤白领" />
              </label>
            </>
          )}
          <label className="form-grid__full">
            <span>产品/业务补充</span>
            <textarea
              value={params.aiProductContext}
              onChange={(event) => updateParams({ aiProductContext: event.target.value })}
              placeholder="例如：夏季女装、价格优势、目标人群、投放渠道限制、品牌禁用词"
            />
          </label>
        </div>
      )}

      <div className="task-preview">
        <h3>任务预览</h3>
        <p>
          {executionMode === "single"
            ? taskLabel(taskType)
            : `${executionMode === "serial" ? "串联" : "并联"} ${pipelineSteps.length} 个步骤`}{" "}
          · 输入 {inputs.length} 项 · 输出到 {outputDir || "默认 outputs 目录"}
        </p>
      </div>

      {(isRunning || progress) && (
        <div className="progress-box">
          <div className="progress-box__header">
            <strong>{progress?.message ?? "准备处理..."}</strong>
            <span>{progressPercent}%</span>
          </div>
          <div className="progress-track" aria-label="批处理进度">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="progress-meta">
            <span>
              {progress?.current ?? 0}/{progress?.total ?? inputs.length}
            </span>
            <span>
              成功 {progress?.success_count ?? 0} · 失败 {progress?.failed_count ?? 0}
            </span>
          </div>
          {progress?.current_file && <p className="progress-file">{progress.current_file}</p>}
        </div>
      )}

      <button className="primary-button" type="button" disabled={isRunning || inputs.length === 0 || (executionMode !== "single" && pipelineSteps.length === 0)} onClick={onRun}>
        <Play size={16} />
        {isRunning ? runningLabel : runLabel ?? (executionMode === "serial" ? "运行串联任务" : executionMode === "parallel" ? "运行并联任务" : "运行批处理")}
      </button>
    </section>
  );
}

function dedupeInputs(inputs: string[]) {
  return Array.from(new Set(inputs));
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function toAssetUrl(path: string) {
  if ("__TAURI_INTERNALS__" in window) {
    return convertFileSrc(path);
  }

  return `file://${path}`;
}

function sanitizeParams(params: BatchParams) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== ""),
  );
}

function taskLabel(taskType: TaskType) {
  return allTaskTypes.find((task) => task.value === taskType)?.label ?? taskType;
}

function summarizeStepParams(step: TaskPipelineStep) {
  if (step.task_type === "resize") {
    return `${step.params.resizeMode ?? "width"} ${step.params.width ?? ""}x${step.params.height ?? ""}`;
  }
  if (step.task_type === "compress" || step.task_type === "convert") {
    return `${step.params.outputFormat ?? "original"} · 质量 ${step.params.quality ?? 82}`;
  }
  if (step.task_type === "split" || step.task_type === "stitch") {
    return `${step.params.rows ?? 3}x${step.params.cols ?? 3}`;
  }
  if (step.task_type === "rename") {
    return `${step.params.prefix ?? "image"} · ${step.params.padding ?? 3} 位`;
  }
  if (step.task_type === "ai_analyze") {
    return `${step.params.aiPlatform ?? "通用广告"} · ${step.params.aiPromptExampleCount ?? 5} 示例`;
  }
  return "默认参数";
}

function NumberField({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
