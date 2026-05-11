import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Images, Play, Trash2 } from "lucide-react";
import type { BatchParams, TaskResult, TaskType } from "../lib/types";

interface BatchToolPanelProps {
  projectName: string;
  outputDir: string;
  taskType: TaskType;
  inputs: string[];
  params: BatchParams;
  isRunning: boolean;
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
  onProjectNameChange,
  onOutputDirChange,
  onTaskTypeChange,
  onInputsChange,
  onParamsChange,
  onRun,
}: BatchToolPanelProps) {
  async function pickImages() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (Array.isArray(selected)) {
      onInputsChange([...inputs, ...selected]);
    } else if (typeof selected === "string") {
      onInputsChange([...inputs, selected]);
    }
  }

  async function pickFolder() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      onInputsChange([...inputs, selected]);
    }
  }

  async function pickOutputDir() {
    const selected = await open({ multiple: false, directory: true });
    if (typeof selected === "string") {
      onOutputDirChange(selected);
    }
  }

  const updateParams = (patch: Partial<BatchParams>) => onParamsChange({ ...params, ...patch });

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

      <div className="input-list">
        {inputs.length === 0 ? (
          <p className="empty">还没有选择图片或文件夹</p>
        ) : (
          inputs.map((input) => (
            <div className="input-row" key={input}>
              <span>{input}</span>
            </div>
          ))
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
            </>
          )}
        </div>
      )}

      {(taskType === "split" || taskType === "stitch") && (
        <div className="form-grid form-grid--spaced">
          <NumberField label="行数" value={params.rows} onChange={(rows) => updateParams({ rows })} />
          <NumberField label="列数" value={params.cols} onChange={(cols) => updateParams({ cols })} />
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

      <button className="primary-button" type="button" disabled={isRunning || inputs.length === 0} onClick={onRun}>
        <Play size={16} />
        {isRunning ? "处理中..." : "运行批处理"}
      </button>
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
