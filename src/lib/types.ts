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

export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  success_count: number;
  failed_count: number;
  output_dir: string | null;
  errors: string[];
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
