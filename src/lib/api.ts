import { invoke } from "@tauri-apps/api/core";
import type { AiConnectionTestResult, AiConnectionTestTarget, AiResultRecord, AppConfig, TaskRecord, TaskRequest, TaskResult } from "./types";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

const demoConfig: AppConfig = {
  default_output_dir: null,
  max_concurrency: 4,
  image_quality: 82,
  ai_provider: {
    provider: "openai",
    base_url: "https://api.openai.com/v1",
    api_key_set: false,
    text_model: "gpt-4.1-mini",
    vision_model: "gpt-4.1-mini",
    image_model: "gpt-image-1",
    timeout_seconds: 60,
    max_retries: 2,
  },
};

const demoTasks: TaskRecord[] = [
  {
    id: "demo-task-1",
    task_type: "rename",
    status: "pending",
    input_count: 24,
    success_count: 0,
    failed_count: 0,
    output_dir: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

export async function getAppConfig(): Promise<AppConfig> {
  if (!isTauriRuntime) {
    return demoConfig;
  }

  return invoke<AppConfig>("get_app_config");
}

export async function saveAppConfig(config: AppConfig): Promise<AppConfig> {
  if (!isTauriRuntime) {
    return config;
  }

  return invoke<AppConfig>("save_app_config", { config });
}

export async function saveApiKey(apiKey: string): Promise<boolean> {
  if (!isTauriRuntime) {
    return apiKey.trim().length > 0;
  }

  return invoke<boolean>("save_api_key", { apiKey });
}

export async function clearApiKey(): Promise<boolean> {
  if (!isTauriRuntime) {
    return true;
  }

  return invoke<boolean>("clear_api_key");
}

export async function testAiConnection(target: AiConnectionTestTarget): Promise<AiConnectionTestResult[]> {
  if (!isTauriRuntime) {
    return [
      {
        target,
        model: "demo-model",
        ok: true,
        status: 200,
        message: "浏览器预览模式：模拟联通成功",
      },
    ];
  }

  return invoke<AiConnectionTestResult[]>("test_ai_connection", { request: { target } });
}

export async function listTasks(): Promise<TaskRecord[]> {
  if (!isTauriRuntime) {
    return demoTasks;
  }

  return invoke<TaskRecord[]>("list_tasks");
}

export async function listAiResults(): Promise<AiResultRecord[]> {
  if (!isTauriRuntime) {
    return [];
  }

  return invoke<AiResultRecord[]>("list_ai_results");
}

export async function createTask(request: TaskRequest): Promise<TaskResult> {
  return invoke<TaskResult>("create_task", { request });
}
