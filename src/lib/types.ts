export type TaskType =
  | "rename"
  | "resize"
  | "compress"
  | "convert"
  | "split"
  | "stitch"
  | "organize"
  | "ai_analyze"
  | "ai_generate_copy"
  | "ai_generate_title"
  | "ai_generate_image";

export type TaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface AiProviderConfig {
  provider: "openai";
  base_url: string;
  api_key_set: boolean;
  text_model: string;
  vision_model: string;
  image_model: string;
  timeout_seconds: number;
  max_retries: number;
}

export interface AppConfig {
  default_output_dir: string | null;
  max_concurrency: number;
  image_quality: number;
  ai_provider: AiProviderConfig;
}

export interface TaskRequest<TParams = Record<string, unknown>> {
  task_type: TaskType;
  inputs: string[];
  params: TParams;
  output_rule: {
    project_name: string;
    output_dir: string | null;
    keep_originals: boolean;
  };
}

export type TaskExecutionMode = "single" | "serial" | "parallel";

export interface TaskPipelineStep {
  id: string;
  task_type: TaskType;
  params: Record<string, unknown>;
}

export interface FavoriteTask {
  id: string;
  name: string;
  execution_mode: TaskExecutionMode;
  task_type: TaskType;
  params: Record<string, unknown>;
  pipeline_steps: TaskPipelineStep[];
  created_at: string;
  updated_at: string;
}

export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  success_count: number;
  failed_count: number;
  output_dir: string | null;
  errors: string[];
}

export interface TaskProgress {
  task_id: string;
  task_type: TaskType;
  status: TaskStatus;
  current: number;
  total: number;
  success_count: number;
  failed_count: number;
  current_file: string | null;
  output_dir: string | null;
  message: string;
}

export type SortBy = "input" | "filename" | "modified" | "created";
export type FitMode = "contain" | "cover" | "stretch";
export type OutputFormat = "original" | "jpg" | "png" | "webp";

export interface BatchParams {
  recursive: boolean;
  sortBy: SortBy;
  prefix: string;
  suffix: string;
  startIndex: number;
  padding: number;
  resizeMode: "width" | "height" | "fixed" | "percent";
  width: number;
  height: number;
  percent: number;
  fit: FitMode;
  allowUpscale: boolean;
  allowResizeToTarget: boolean;
  quality: number;
  minQuality: number;
  targetKb: number | null;
  outputFormat: OutputFormat;
  rows: number;
  cols: number;
  splitDetectionMode: "auto" | "manual";
  splitLineMode: "none" | "black" | "white" | "black_white";
  splitLineWidth: number;
  splitOuterBorder: number;
  splitForceSquare: boolean;
  cellWidth: number;
  cellHeight: number;
  background: string;
  aiLanguage: string;
  aiPlatform: string;
  aiProductContext: string;
  aiPromptExampleCount: number;
}

export interface TaskRecord {
  id: string;
  task_type: TaskType;
  status: TaskStatus;
  input_count: number;
  success_count: number;
  failed_count: number;
  output_dir: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiResultRecord {
  id: string;
  task_id: string;
  input_path: string;
  output_path: string | null;
  model: string;
  analysis_json: {
    summary?: string;
    hook_analysis?: {
      core_hook?: string;
      score?: number;
    };
    extracted_prompt?: string;
    prompt_examples?: string[];
    [key: string]: unknown;
  };
  created_at: string;
}
