use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
enum AppError {
    #[error("failed to resolve app data directory")]
    AppDataDir,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("secret storage error: {0}")]
    Keyring(#[from] keyring::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiProviderConfig {
    provider: String,
    base_url: String,
    api_key_set: bool,
    text_model: String,
    vision_model: String,
    image_model: String,
    timeout_seconds: u64,
    max_retries: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppConfig {
    default_output_dir: Option<String>,
    max_concurrency: u8,
    image_quality: u8,
    ai_provider: AiProviderConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            default_output_dir: None,
            max_concurrency: 4,
            image_quality: 82,
            ai_provider: AiProviderConfig {
                provider: "openai".to_string(),
                base_url: "https://api.openai.com/v1".to_string(),
                api_key_set: false,
                text_model: "gpt-4.1-mini".to_string(),
                vision_model: "gpt-4.1-mini".to_string(),
                image_model: "gpt-image-1".to_string(),
                timeout_seconds: 60,
                max_retries: 2,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaskType {
    Rename,
    Resize,
    Compress,
    Convert,
    Split,
    Stitch,
    Organize,
    AiAnalyze,
    AiGenerateCopy,
    AiGenerateTitle,
    AiGenerateImage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaskStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OutputRule {
    project_name: String,
    output_dir: Option<String>,
    keep_originals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskRequest {
    task_type: TaskType,
    inputs: Vec<String>,
    params: serde_json::Value,
    output_rule: OutputRule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskResult {
    task_id: String,
    status: TaskStatus,
    success_count: u32,
    failed_count: u32,
    output_dir: Option<String>,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskRecord {
    id: String,
    task_type: TaskType,
    status: TaskStatus,
    input_count: u32,
    success_count: u32,
    failed_count: u32,
    output_dir: Option<String>,
    created_at: String,
    updated_at: String,
}

struct AppState {
    db: Mutex<Connection>,
    config_path: PathBuf,
}

const KEYRING_SERVICE: &str = "com.adcreativestudio.desktop";
const KEYRING_USER: &str = "openai-api-key";

#[tauri::command]
fn get_app_config(state: tauri::State<'_, AppState>) -> AppResult<AppConfig> {
    read_config(&state.config_path)
}

#[tauri::command]
fn save_app_config(config: AppConfig, state: tauri::State<'_, AppState>) -> AppResult<AppConfig> {
    let contents = serde_json::to_string_pretty(&config)?;
    fs::write(&state.config_path, contents)?;
    Ok(config)
}

#[tauri::command]
fn save_api_key(api_key: String, state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    entry.set_password(trimmed)?;

    let mut config = read_config(&state.config_path)?;
    config.ai_provider.api_key_set = true;
    fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;

    Ok(true)
}

#[tauri::command]
fn clear_api_key(state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    match entry.delete_credential() {
        Ok(()) => {}
        Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(error.into()),
    }

    let mut config = read_config(&state.config_path)?;
    config.ai_provider.api_key_set = false;
    fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;

    Ok(true)
}

#[tauri::command]
fn create_task(request: TaskRequest, state: tauri::State<'_, AppState>) -> AppResult<TaskResult> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let input_count = request.inputs.len() as u32;
    let params_json = serde_json::to_string(&request.params)?;
    let task_type_json = serde_json::to_string(&request.task_type)?;
    let status_json = serde_json::to_string(&TaskStatus::Pending)?;
    let output_dir = request.output_rule.output_dir.clone();

    let db = state.db.lock().expect("database mutex poisoned");
    db.execute(
        "insert into tasks (
            id, task_type, status, input_count, success_count, failed_count,
            output_dir, params_json, created_at, updated_at
        ) values (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, ?7, ?8)",
        params![
            id,
            task_type_json,
            status_json,
            input_count,
            output_dir,
            params_json,
            now,
            now
        ],
    )?;

    Ok(TaskResult {
        task_id: id,
        status: TaskStatus::Pending,
        success_count: 0,
        failed_count: 0,
        output_dir: request.output_rule.output_dir,
        errors: vec![],
    })
}

#[tauri::command]
fn list_tasks(state: tauri::State<'_, AppState>) -> AppResult<Vec<TaskRecord>> {
    let db = state.db.lock().expect("database mutex poisoned");
    let mut statement = db.prepare(
        "select
            id, task_type, status, input_count, success_count, failed_count,
            output_dir, created_at, updated_at
        from tasks
        order by datetime(created_at) desc",
    )?;

    let rows = statement.query_map([], |row| {
        let task_type_json: String = row.get(1)?;
        let status_json: String = row.get(2)?;

        Ok(TaskRecord {
            id: row.get(0)?,
            task_type: serde_json::from_str(&task_type_json).unwrap_or(TaskType::Organize),
            status: serde_json::from_str(&status_json).unwrap_or(TaskStatus::Failed),
            input_count: row.get(3)?,
            success_count: row.get(4)?,
            failed_count: row.get(5)?,
            output_dir: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }

    Ok(records)
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = create_app_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            save_app_config,
            save_api_key,
            clear_api_key,
            create_task,
            list_tasks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn create_app_state(app_handle: &AppHandle) -> AppResult<AppState> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| AppError::AppDataDir)?;
    fs::create_dir_all(&data_dir)?;

    let config_path = data_dir.join("config.json");
    if !config_path.exists() {
        let contents = serde_json::to_string_pretty(&AppConfig::default())?;
        fs::write(&config_path, contents)?;
    }

    let db_path = data_dir.join("app.db");
    let db = Connection::open(db_path)?;
    migrate_database(&db)?;

    Ok(AppState {
        db: Mutex::new(db),
        config_path,
    })
}

fn read_config(config_path: &PathBuf) -> AppResult<AppConfig> {
    if !config_path.exists() {
        return Ok(AppConfig::default());
    }

    let contents = fs::read_to_string(config_path)?;
    Ok(serde_json::from_str(&contents)?)
}

fn migrate_database(db: &Connection) -> AppResult<()> {
    db.execute_batch(
        "
        create table if not exists tasks (
            id text primary key,
            task_type text not null,
            status text not null,
            input_count integer not null,
            success_count integer not null,
            failed_count integer not null,
            output_dir text,
            params_json text not null,
            created_at text not null,
            updated_at text not null
        );

        create index if not exists idx_tasks_created_at on tasks(created_at);
        ",
    )?;

    Ok(())
}
