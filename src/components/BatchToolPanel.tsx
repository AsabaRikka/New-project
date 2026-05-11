import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Grid2X2,
  Images,
  List,
  Play,
  Shuffle,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { BatchParams, TaskProgress, TaskResult, TaskType } from "../lib/types";

interface BatchToolPanelProps {
  projectName: string;
  outputDir: string;
  taskType: TaskType;
  inputs: string[];
  params: BatchParams;
  isRunning: boolean;
  progress: TaskProgress | null;
  onProjectNameChange: (value: string) => void;
  onOutputDirChange: (value: string) => void;
  onTaskTypeChange: (value: TaskType) => void;
  onInputsChange: (inputs: string[]) => void;
  onParamsChange: (params: BatchParams) => void;
  onRun: () => Promise<TaskResult | null>;
}

const localTaskTypes: Array<{ value: TaskType; label: string }> = [
  { value: "rename", label: "图片重命名" },
  { value: "resize", label: "图片改尺寸" },
  { value: "compress", label: "图片压缩" },
  { value: "convert", label: "格式转换" },
  { value: "split", label: "图片切分" },
  { value: "stitch", label: "图片拼接" },
  { value: "organize", label: "文件夹整理" },
];

export function BatchToolPanel({
  projectName,
  outputDir,
  taskType,
  inputs,
  params,
  isRunning,
  progress,
  onProjectNameChange,
  onOutputDirChange,
  onTaskTypeChange,
  onInputsChange,
  onParamsChange,
  onRun,
}: BatchToolPanelProps) {
  const [selectedInputs, setSelectedInputs] = useState<Set<string>>(new Set());
  const [isQueueExpanded, setIsQueueExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<"list" | "thumb">("list");
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

  return (
    <section className="panel panel--primary">
      <div className="panel__header">
        <div>
          <p className="eyebrow">Phase 1</p>
          <h2>图片批量工具</h2>
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
            {localTaskTypes.map((task) => (
              <option key={task.value} value={task.value}>
                {task.label}
              </option>
            ))}
          </select>
        </label>
      </div>

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

      <div className="task-preview">
        <h3>任务预览</h3>
        <p>
          {localTaskTypes.find((task) => task.value === taskType)?.label} · 输入 {inputs.length} 项 · 输出到{" "}
          {outputDir || "默认 outputs 目录"}
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

      <button className="primary-button" type="button" disabled={isRunning || inputs.length === 0} onClick={onRun}>
        <Play size={16} />
        {isRunning ? "处理中..." : "运行批处理"}
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
