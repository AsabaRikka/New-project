use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::{
    ColorType, DynamicImage, GenericImage, GenericImageView, ImageBuffer, ImageEncoder,
    ImageFormat, Rgba,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
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
    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unsupported image format: {0}")]
    UnsupportedFormat(String),
    #[error("invalid task params: {0}")]
    InvalidParams(String),
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
    #[serde(default = "default_proxy_url")]
    proxy_url: Option<String>,
    timeout_seconds: u64,
    max_retries: u8,
}

fn default_proxy_url() -> Option<String> {
    Some("http://127.0.0.1:7890".to_string())
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
                proxy_url: Some("http://127.0.0.1:7890".to_string()),
                timeout_seconds: 60,
                max_retries: 2,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "snake_case")]
enum AiTestTarget {
    Text,
    Vision,
    Image,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiConnectionTestRequest {
    target: AiTestTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiConnectionTestResult {
    target: String,
    model: String,
    ok: bool,
    status: Option<u16>,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileResult {
    input_path: String,
    output_path: Option<String>,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskReport {
    task_id: String,
    task_type: TaskType,
    status: TaskStatus,
    input_count: u32,
    success_count: u32,
    failed_count: u32,
    output_dir: String,
    params: serde_json::Value,
    files: Vec<FileResult>,
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
    last_error: Option<String>,
    params: serde_json::Value,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiResultRecord {
    id: String,
    task_id: String,
    input_path: String,
    output_path: Option<String>,
    model: String,
    analysis_json: serde_json::Value,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskProgress {
    task_id: String,
    task_type: TaskType,
    status: TaskStatus,
    current: u32,
    total: u32,
    success_count: u32,
    failed_count: u32,
    current_file: Option<String>,
    output_dir: Option<String>,
    message: String,
}

struct AppState {
    db: Mutex<Connection>,
    config_path: PathBuf,
    api_key_path: PathBuf,
}

const KEYRING_SERVICE: &str = "com.adcreativestudio.desktop";
const KEYRING_USER: &str = "openai-api-key";
const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];
const DEFAULT_AI_PERSONA: &str = "你是一位资深的小游戏 IAA 广告投放专家，非常熟悉腾讯广告平台及其机制，熟悉腾讯广告 3.0，熟悉腾讯广告 3.0 如何让朋友圈的图片素材起量，熟悉腾讯妙思平台对于爆图的判断标准。";

#[tauri::command]
fn get_app_config(state: tauri::State<'_, AppState>) -> AppResult<AppConfig> {
    sync_api_key_state(&state)
}

#[tauri::command]
fn save_app_config(
    mut config: AppConfig,
    state: tauri::State<'_, AppState>,
) -> AppResult<AppConfig> {
    config.ai_provider.api_key_set = read_saved_api_key(&state.api_key_path)?.is_some();
    fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;
    Ok(config)
}

#[tauri::command]
fn save_api_key(api_key: String, state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    fs::write(&state.api_key_path, trimmed)?;
    let keyring_saved = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|entry| entry.set_password(trimmed))
        .is_ok();

    let mut config = read_config(&state.config_path)?;
    config.ai_provider.api_key_set = keyring_saved || local_api_key_exists(&state.api_key_path);
    fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;

    Ok(true)
}

#[tauri::command]
fn clear_api_key(state: tauri::State<'_, AppState>) -> AppResult<bool> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(error.into()),
    }
    match fs::remove_file(&state.api_key_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let mut config = read_config(&state.config_path)?;
    config.ai_provider.api_key_set = false;
    fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;

    Ok(true)
}

fn sync_api_key_state(state: &tauri::State<'_, AppState>) -> AppResult<AppConfig> {
    let mut config = read_config(&state.config_path)?;
    let api_key_set = read_saved_api_key(&state.api_key_path)?.is_some();
    if config.ai_provider.api_key_set != api_key_set {
        config.ai_provider.api_key_set = api_key_set;
        fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;
    }
    Ok(config)
}

fn read_saved_api_key(api_key_path: &Path) -> AppResult<Option<String>> {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        Ok(entry) => match entry.get_password() {
            Ok(api_key) if !api_key.trim().is_empty() => {
                return Ok(Some(api_key.trim().to_string()));
            }
            Ok(_) | Err(keyring::Error::NoEntry) | Err(keyring::Error::NoStorageAccess(_)) => {}
            Err(error) => return Err(error.into()),
        },
        Err(keyring::Error::NoStorageAccess(_)) => {}
        Err(error) => return Err(error.into()),
    }

    if !api_key_path.exists() {
        return Ok(None);
    }
    let api_key = fs::read_to_string(api_key_path)?;
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn local_api_key_exists(api_key_path: &Path) -> bool {
    fs::read_to_string(api_key_path)
        .map(|api_key| !api_key.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
fn test_ai_connection(
    request: AiConnectionTestRequest,
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<AiConnectionTestResult>> {
    let context = AiTaskContext::from_state(&state)?
        .ok_or_else(|| AppError::InvalidParams("请先保存 API Key".to_string()))?;
    let targets = match request.target {
        AiTestTarget::All => vec![
            AiTestTarget::Text,
            AiTestTarget::Vision,
            AiTestTarget::Image,
        ],
        target => vec![target],
    };
    let client = build_ai_http_client(&context.config)?;

    Ok(targets
        .into_iter()
        .map(|target| run_ai_connection_test(&client, &context, target))
        .collect())
}

#[tauri::command]
fn create_task(
    request: TaskRequest,
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<TaskResult> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let input_paths = expand_input_paths(
        &request.inputs,
        read_bool(&request.params, "recursive", true),
    )?;
    let input_count = input_paths.len() as u32;
    let params_json = serde_json::to_string(&request.params)?;
    let task_type_json = serde_json::to_string(&request.task_type)?;
    let pending_status_json = serde_json::to_string(&TaskStatus::Pending)?;
    let output_dir = resolve_task_output_dir(&request)?;
    let output_dir_string = output_dir.to_string_lossy().to_string();

    {
        let db = state.db.lock().expect("database mutex poisoned");
        db.execute(
            "insert into tasks (
                id, task_type, status, input_count, success_count, failed_count,
                output_dir, params_json, last_error, created_at, updated_at
            ) values (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, null, ?7, ?8)",
            params![
                id,
                task_type_json,
                pending_status_json,
                input_count,
                output_dir_string,
                params_json,
                now,
                now
            ],
        )?;
    }

    update_task_status(
        state.inner(),
        &id,
        &TaskStatus::Running,
        0,
        0,
        Some(&output_dir_string),
        None,
    )?;
    emit_progress(
        Some(&app_handle),
        TaskProgress {
            task_id: id.clone(),
            task_type: request.task_type.clone(),
            status: TaskStatus::Running,
            current: 0,
            total: input_count,
            success_count: 0,
            failed_count: 0,
            current_file: None,
            output_dir: Some(output_dir_string.clone()),
            message: "开始处理图片...".to_string(),
        },
    );

    if is_ai_protocol_task(&request.task_type) {
        let app_handle = app_handle.clone();
        let background_id = id.clone();
        let background_request = request.clone();
        let background_input_paths = input_paths.clone();
        let background_output_dir = output_dir.clone();
        let background_output_dir_string = output_dir_string.clone();
        std::thread::spawn(move || {
            run_background_task(
                app_handle,
                background_id,
                background_request,
                background_input_paths,
                background_output_dir,
                background_output_dir_string,
            );
        });

        return Ok(TaskResult {
            task_id: id,
            status: TaskStatus::Running,
            success_count: 0,
            failed_count: 0,
            output_dir: Some(output_dir_string),
            errors: Vec::new(),
        });
    }

    let ai_context = AiTaskContext::from_state(&state)?;
    match execute_task(
        Some(&app_handle),
        Some(state.inner()),
        &id,
        &request,
        &input_paths,
        &output_dir,
        ai_context.as_ref(),
    ) {
        Ok(mut report) => {
            report.status = if report.failed_count > 0 {
                TaskStatus::Failed
            } else {
                TaskStatus::Completed
            };
            write_reports(&output_dir, &report)?;
            update_task_status(
                state.inner(),
                &id,
                &report.status,
                report.success_count,
                report.failed_count,
                Some(&report.output_dir),
                first_error(&report.files),
            )?;
            emit_progress(
                Some(&app_handle),
                TaskProgress {
                    task_id: id.clone(),
                    task_type: request.task_type.clone(),
                    status: report.status.clone(),
                    current: input_count,
                    total: input_count,
                    success_count: report.success_count,
                    failed_count: report.failed_count,
                    current_file: None,
                    output_dir: Some(report.output_dir.clone()),
                    message: format!(
                        "处理完成：成功 {}，失败 {}",
                        report.success_count, report.failed_count
                    ),
                },
            );

            Ok(TaskResult {
                task_id: id,
                status: report.status,
                success_count: report.success_count,
                failed_count: report.failed_count,
                output_dir: Some(report.output_dir),
                errors: report
                    .files
                    .iter()
                    .filter_map(|file| file.error.clone())
                    .collect(),
            })
        }
        Err(error) => {
            update_task_status(
                state.inner(),
                &id,
                &TaskStatus::Failed,
                0,
                input_count,
                Some(&output_dir_string),
                Some(&error.to_string()),
            )?;
            emit_progress(
                Some(&app_handle),
                TaskProgress {
                    task_id: id.clone(),
                    task_type: request.task_type.clone(),
                    status: TaskStatus::Failed,
                    current: input_count,
                    total: input_count,
                    success_count: 0,
                    failed_count: input_count,
                    current_file: None,
                    output_dir: Some(output_dir_string.clone()),
                    message: error.to_string(),
                },
            );

            Ok(TaskResult {
                task_id: id,
                status: TaskStatus::Failed,
                success_count: 0,
                failed_count: input_count,
                output_dir: Some(output_dir_string),
                errors: vec![error.to_string()],
            })
        }
    }
}

fn run_background_task(
    app_handle: AppHandle,
    id: String,
    request: TaskRequest,
    input_paths: Vec<PathBuf>,
    output_dir: PathBuf,
    output_dir_string: String,
) {
    let state = app_handle.state::<AppState>();
    let input_count = input_paths.len() as u32;
    let ai_context = match AiTaskContext::from_state(&state) {
        Ok(context) => context,
        Err(error) => {
            let _ = mark_background_task_failed(
                &app_handle,
                &state,
                &id,
                &request,
                input_count,
                &output_dir_string,
                &error.to_string(),
            );
            return;
        }
    };

    let Some(ai_context) = ai_context else {
        let _ = mark_background_task_failed(
            &app_handle,
            &state,
            &id,
            &request,
            input_count,
            &output_dir_string,
            "请先配置 API Key",
        );
        return;
    };

    match execute_task(
        Some(&app_handle),
        Some(&state),
        &id,
        &request,
        &input_paths,
        &output_dir,
        Some(&ai_context),
    ) {
        Ok(mut report) => {
            report.status = if report.failed_count > 0 {
                TaskStatus::Failed
            } else {
                TaskStatus::Completed
            };
            if let Err(error) = write_reports(&output_dir, &report).and_then(|_| {
                update_task_status(
                    &state,
                    &id,
                    &report.status,
                    report.success_count,
                    report.failed_count,
                    Some(&report.output_dir),
                    first_error(&report.files),
                )
            }) {
                let _ = mark_background_task_failed(
                    &app_handle,
                    &state,
                    &id,
                    &request,
                    input_count,
                    &output_dir_string,
                    &error.to_string(),
                );
                return;
            }

            emit_progress(
                Some(&app_handle),
                TaskProgress {
                    task_id: id,
                    task_type: request.task_type,
                    status: report.status.clone(),
                    current: input_count,
                    total: input_count,
                    success_count: report.success_count,
                    failed_count: report.failed_count,
                    current_file: None,
                    output_dir: Some(report.output_dir.clone()),
                    message: format!(
                        "后台 AI 任务完成：成功 {}，失败 {}",
                        report.success_count, report.failed_count
                    ),
                },
            );
        }
        Err(error) => {
            let _ = mark_background_task_failed(
                &app_handle,
                &state,
                &id,
                &request,
                input_count,
                &output_dir_string,
                &error.to_string(),
            );
        }
    }
}

fn mark_background_task_failed(
    app_handle: &AppHandle,
    state: &AppState,
    id: &str,
    request: &TaskRequest,
    input_count: u32,
    output_dir_string: &str,
    message: &str,
) -> AppResult<()> {
    update_task_status(
        state,
        id,
        &TaskStatus::Failed,
        0,
        input_count,
        Some(output_dir_string),
        Some(message),
    )?;
    emit_progress(
        Some(app_handle),
        TaskProgress {
            task_id: id.to_string(),
            task_type: request.task_type.clone(),
            status: TaskStatus::Failed,
            current: input_count,
            total: input_count,
            success_count: 0,
            failed_count: input_count,
            current_file: None,
            output_dir: Some(output_dir_string.to_string()),
            message: message.to_string(),
        },
    );
    Ok(())
}

fn is_ai_protocol_task(task_type: &TaskType) -> bool {
    matches!(
        task_type,
        TaskType::AiAnalyze
            | TaskType::AiGenerateCopy
            | TaskType::AiGenerateTitle
            | TaskType::AiGenerateImage
    )
}

#[tauri::command]
fn list_tasks(state: tauri::State<'_, AppState>) -> AppResult<Vec<TaskRecord>> {
    let db = state.db.lock().expect("database mutex poisoned");
    let mut statement = db.prepare(
        "select
            id, task_type, status, input_count, success_count, failed_count,
            output_dir, last_error, params_json, created_at, updated_at
        from tasks
        order by datetime(created_at) desc",
    )?;

    let rows = statement.query_map([], |row| {
        let task_type_json: String = row.get(1)?;
        let status_json: String = row.get(2)?;
        let params_json: String = row.get(8)?;

        let output_dir: Option<String> = row.get(6)?;
        let last_error: Option<String> = row.get(7)?;
        Ok(TaskRecord {
            id: row.get(0)?,
            task_type: serde_json::from_str(&task_type_json).unwrap_or(TaskType::Organize),
            status: serde_json::from_str(&status_json).unwrap_or(TaskStatus::Failed),
            input_count: row.get(3)?,
            success_count: row.get(4)?,
            failed_count: row.get(5)?,
            last_error: last_error
                .or_else(|| output_dir.as_deref().and_then(read_report_first_error)),
            output_dir,
            params: serde_json::from_str(&params_json).unwrap_or_else(|_| serde_json::json!({})),
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    })?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }

    Ok(records)
}

#[tauri::command]
fn open_task_folder(path: String) -> AppResult<bool> {
    let folder_path = PathBuf::from(path);
    if !folder_path.exists() {
        return Err(AppError::InvalidParams("任务文件夹不存在".to_string()));
    }
    if !folder_path.is_dir() {
        return Err(AppError::InvalidParams("任务路径不是文件夹".to_string()));
    }

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");

    command.arg(&folder_path);
    command.spawn()?;
    Ok(true)
}

fn read_report_first_error(output_dir: &str) -> Option<String> {
    let report_path = Path::new(output_dir).join("report").join("report.json");
    let report: TaskReport = serde_json::from_str(&fs::read_to_string(report_path).ok()?).ok()?;
    report
        .files
        .iter()
        .find(|file| file.status == "failed")
        .and_then(|file| file.error.clone())
}

#[tauri::command]
fn list_ai_results(state: tauri::State<'_, AppState>) -> AppResult<Vec<AiResultRecord>> {
    let db = state.db.lock().expect("database mutex poisoned");
    let mut statement = db.prepare(
        "select id, task_id, input_path, output_path, model, analysis_json, created_at
        from ai_results
        order by datetime(created_at) desc
        limit 50",
    )?;

    let rows = statement.query_map([], |row| {
        let analysis_json: String = row.get(5)?;
        Ok(AiResultRecord {
            id: row.get(0)?,
            task_id: row.get(1)?,
            input_path: row.get(2)?,
            output_path: row.get(3)?,
            model: row.get(4)?,
            analysis_json: serde_json::from_str(&analysis_json).unwrap_or_else(|_| json!({})),
            created_at: row.get(6)?,
        })
    })?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }

    Ok(records)
}

fn update_task_status(
    state: &AppState,
    task_id: &str,
    status: &TaskStatus,
    success_count: u32,
    failed_count: u32,
    output_dir: Option<&str>,
    last_error: Option<&str>,
) -> AppResult<()> {
    let status_json = serde_json::to_string(status)?;
    let now = Utc::now().to_rfc3339();
    let db = state.db.lock().expect("database mutex poisoned");
    db.execute(
        "update tasks
        set status = ?1, success_count = ?2, failed_count = ?3, output_dir = ?4, last_error = ?5, updated_at = ?6
        where id = ?7",
        params![
            status_json,
            success_count,
            failed_count,
            output_dir,
            last_error,
            now,
            task_id
        ],
    )?;

    Ok(())
}

fn execute_task(
    app_handle: Option<&AppHandle>,
    state: Option<&AppState>,
    task_id: &str,
    request: &TaskRequest,
    input_paths: &[PathBuf],
    output_dir: &Path,
    ai_context: Option<&AiTaskContext>,
) -> AppResult<TaskReport> {
    let success_dir = output_dir.join("success");
    let failed_dir = output_dir.join("failed");
    let report_dir = output_dir.join("report");
    fs::create_dir_all(&success_dir)?;
    fs::create_dir_all(&failed_dir)?;
    fs::create_dir_all(&report_dir)?;

    let mut tracker = ProgressTracker::new(
        app_handle,
        task_id,
        request.task_type.clone(),
        input_paths.len() as u32,
        output_dir.to_string_lossy().to_string(),
    );

    let mut files = match request.task_type {
        TaskType::Rename => {
            process_rename(input_paths, &success_dir, &request.params, &mut tracker)?
        }
        TaskType::Resize => {
            process_resize(input_paths, &success_dir, &request.params, &mut tracker)?
        }
        TaskType::Compress | TaskType::Convert => {
            process_compress_convert(input_paths, &success_dir, &request.params, &mut tracker)?
        }
        TaskType::Split => process_split(input_paths, &success_dir, &request.params, &mut tracker)?,
        TaskType::Stitch => {
            process_stitch(input_paths, &success_dir, &request.params, &mut tracker)?
        }
        TaskType::Organize => process_organize(input_paths, &success_dir, &mut tracker)?,
        TaskType::AiAnalyze => process_ai_analyze(
            input_paths,
            &success_dir,
            &report_dir,
            &request.params,
            &mut tracker,
            ai_context.ok_or_else(|| AppError::InvalidParams("请先配置 API Key".to_string()))?,
        )?,
        TaskType::AiGenerateCopy | TaskType::AiGenerateTitle | TaskType::AiGenerateImage => {
            process_ai_generation_task(
                input_paths,
                &success_dir,
                &report_dir,
                &request.params,
                &mut tracker,
                ai_context
                    .ok_or_else(|| AppError::InvalidParams("请先配置 API Key".to_string()))?,
                &request.task_type,
            )?
        }
    };

    if is_ai_protocol_task(&request.task_type) {
        let state =
            state.ok_or_else(|| AppError::InvalidParams("AI 结果需要数据库状态".to_string()))?;
        let model = ai_context
            .map(|context| match request.task_type {
                TaskType::AiAnalyze | TaskType::AiGenerateImage => {
                    context.config.vision_model.as_str()
                }
                TaskType::AiGenerateCopy | TaskType::AiGenerateTitle => {
                    context.config.text_model.as_str()
                }
                _ => "ai",
            })
            .unwrap_or("ai");
        persist_ai_results(state, task_id, model, &files)?;
    }

    for file in files.iter_mut().filter(|file| file.status == "failed") {
        if let Some(input_path) = Path::new(&file.input_path).file_name() {
            let failed_path = unique_path(&failed_dir.join(input_path));
            let _ = fs::copy(&file.input_path, &failed_path);
        }
    }

    let success_count = files.iter().filter(|file| file.status == "success").count() as u32;
    let failed_count = files.iter().filter(|file| file.status == "failed").count() as u32;

    Ok(TaskReport {
        task_id: task_id.to_string(),
        task_type: request.task_type.clone(),
        status: TaskStatus::Completed,
        input_count: input_paths.len() as u32,
        success_count,
        failed_count,
        output_dir: output_dir.to_string_lossy().to_string(),
        params: request.params.clone(),
        files,
    })
}

struct ProgressTracker<'a> {
    app_handle: Option<&'a AppHandle>,
    task_id: String,
    task_type: TaskType,
    total: u32,
    current: u32,
    success_count: u32,
    failed_count: u32,
    output_dir: String,
}

impl<'a> ProgressTracker<'a> {
    fn new(
        app_handle: Option<&'a AppHandle>,
        task_id: &str,
        task_type: TaskType,
        total: u32,
        output_dir: String,
    ) -> Self {
        Self {
            app_handle,
            task_id: task_id.to_string(),
            task_type,
            total,
            current: 0,
            success_count: 0,
            failed_count: 0,
            output_dir,
        }
    }

    fn start_file(&self, input: &Path) {
        emit_progress(
            self.app_handle,
            TaskProgress {
                task_id: self.task_id.clone(),
                task_type: self.task_type.clone(),
                status: TaskStatus::Running,
                current: self.current,
                total: self.total,
                success_count: self.success_count,
                failed_count: self.failed_count,
                current_file: Some(input.to_string_lossy().to_string()),
                output_dir: Some(self.output_dir.clone()),
                message: format!("正在处理 {}", file_name(input)),
            },
        );
    }

    fn finish_file(&mut self, result: &FileResult) {
        self.current += 1;
        if result.status == "success" {
            self.success_count += 1;
        } else {
            self.failed_count += 1;
        }
        emit_progress(
            self.app_handle,
            TaskProgress {
                task_id: self.task_id.clone(),
                task_type: self.task_type.clone(),
                status: TaskStatus::Running,
                current: self.current,
                total: self.total,
                success_count: self.success_count,
                failed_count: self.failed_count,
                current_file: Some(result.input_path.clone()),
                output_dir: Some(self.output_dir.clone()),
                message: format!("已处理 {}/{}", self.current, self.total),
            },
        );
    }
}

fn emit_progress(app_handle: Option<&AppHandle>, progress: TaskProgress) {
    if let Some(app_handle) = app_handle {
        let _ = app_handle.emit("task-progress", progress);
    }
}

fn first_error(files: &[FileResult]) -> Option<&str> {
    files
        .iter()
        .find(|file| file.status == "failed")
        .and_then(|file| file.error.as_deref())
}

fn process_rename(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
) -> AppResult<Vec<FileResult>> {
    let prefix = read_string(params, "prefix", "image");
    let suffix = read_string(params, "suffix", "");
    let start_index = read_u32(params, "startIndex", 1);
    let padding = read_usize(params, "padding", 3);
    let sorted = sort_paths(input_paths, &read_string(params, "sortBy", "input"));

    let mut results = Vec::new();
    for (position, input) in sorted.iter().enumerate() {
        tracker.start_file(input);
        let extension = normalized_extension(input).unwrap_or_else(|| "jpg".to_string());
        let index = start_index + position as u32;
        let filename = format!("{prefix}_{index:0padding$}{suffix}.{extension}");
        let output_path = unique_path(&output_dir.join(filename));
        let result = copy_file(input, &output_path);
        tracker.finish_file(&result);
        results.push(result);
    }
    Ok(results)
}

fn process_resize(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
) -> AppResult<Vec<FileResult>> {
    let mode = read_string(params, "resizeMode", "width");
    let fit = read_string(params, "fit", "contain");
    let width = read_u32(params, "width", 1080);
    let height = read_u32(params, "height", 1080);
    let percent = read_f32(params, "percent", 100.0);
    let allow_upscale = read_bool(params, "allowUpscale", false);
    let output_format = read_string(params, "outputFormat", "original");
    let quality = read_u8(params, "quality", 82);
    let mut results = Vec::new();

    for input in input_paths {
        tracker.start_file(input);
        let result = (|| -> AppResult<FileResult> {
            let image = image::open(input)?;
            let resized = resize_image(&image, &mode, &fit, width, height, percent, allow_upscale);
            let format = resolve_output_format(input, &output_format)?;
            let output_path =
                unique_path(&output_dir.join(format_output_name(input, None, &format)));
            save_image(&resized, &output_path, &format, quality)?;
            Ok(success_result(input, &output_path))
        })();
        let result = result.unwrap_or_else(|error| failed_result(input, error));
        tracker.finish_file(&result);
        results.push(result);
    }

    Ok(results)
}

fn process_compress_convert(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
) -> AppResult<Vec<FileResult>> {
    let output_format = read_string(params, "outputFormat", "original");
    let quality = read_u8(params, "quality", 82);
    let target_kb = read_optional_u64(params, "targetKb");
    let min_quality = read_u8(params, "minQuality", 45);
    let allow_resize_to_target = read_bool(params, "allowResizeToTarget", false);
    let mut results = Vec::new();

    for input in input_paths {
        tracker.start_file(input);
        let result = (|| -> AppResult<FileResult> {
            let image = image::open(input)?;
            let format = resolve_compress_output_format(input, &output_format, target_kb)?;
            let output_path =
                unique_path(&output_dir.join(format_output_name(input, None, &format)));
            if let Some(target_kb) = target_kb {
                save_image_to_target_size(
                    &image,
                    &output_path,
                    &format,
                    quality,
                    min_quality,
                    target_kb,
                    allow_resize_to_target,
                )?;
            } else {
                save_image(&image, &output_path, &format, quality)?;
            }
            Ok(success_result(input, &output_path))
        })();
        let result = result.unwrap_or_else(|error| failed_result(input, error));
        tracker.finish_file(&result);
        results.push(result);
    }

    Ok(results)
}

fn process_split(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
) -> AppResult<Vec<FileResult>> {
    let rows = read_u32(params, "rows", 3).max(1);
    let cols = read_u32(params, "cols", 3).max(1);
    let output_format = read_string(params, "outputFormat", "original");
    let quality = read_u8(params, "quality", 82);
    let detection_mode = read_string(params, "splitDetectionMode", "auto");
    let line_mode = read_string(params, "splitLineMode", "none");
    let remove_lines = line_mode != "none";
    let line_width = if remove_lines {
        read_u32(params, "splitLineWidth", 0)
    } else {
        0
    };
    let outer_border = if remove_lines {
        read_u32(params, "splitOuterBorder", 0)
    } else {
        0
    };
    let force_square = read_bool(params, "splitForceSquare", true);
    let mut results = Vec::new();

    for input in input_paths {
        tracker.start_file(input);
        let result = (|| -> AppResult<Vec<FileResult>> {
            let image = image::open(input)?;
            let format = resolve_output_format(input, &output_format)?;
            let stem = file_stem(input);
            let image_dir = output_dir.join(&stem);
            fs::create_dir_all(&image_dir)?;
            let (width, height) = image.dimensions();
            let mut file_results = Vec::new();
            let cells = if detection_mode == "auto" {
                compute_smart_split_cells(&image, rows, cols, force_square).unwrap_or_else(|| {
                    compute_split_cells(
                        width,
                        height,
                        rows,
                        cols,
                        line_width,
                        outer_border,
                        force_square,
                    )
                })
            } else {
                compute_split_cells(
                    width,
                    height,
                    rows,
                    cols,
                    line_width,
                    outer_border,
                    force_square,
                )
            };

            for cell in cells {
                let cropped = image.crop_imm(cell.x, cell.y, cell.width, cell.height);
                let filename = format!(
                    "{}_r{}_c{}.{}",
                    stem,
                    cell.row + 1,
                    cell.col + 1,
                    extension_for_format(&format)
                );
                let output_path = unique_path(&image_dir.join(filename));
                save_image(&cropped, &output_path, &format, quality)?;
                file_results.push(success_result(input, &output_path));
            }

            Ok(file_results)
        })();
        match result {
            Ok(mut file_results) => {
                let aggregate = success_result(
                    input,
                    Path::new(
                        file_results
                            .last()
                            .and_then(|file| file.output_path.as_deref())
                            .unwrap_or(""),
                    ),
                );
                tracker.finish_file(&aggregate);
                results.append(&mut file_results);
            }
            Err(error) => {
                let result = failed_result(input, error);
                tracker.finish_file(&result);
                results.push(result);
            }
        }
    }

    Ok(results)
}

fn compute_smart_split_cells(
    image: &DynamicImage,
    rows: u32,
    cols: u32,
    force_square: bool,
) -> Option<Vec<SplitCell>> {
    let (width, height) = image.dimensions();
    let x_segments = uniform_grid_content_segments(image, true, cols)?;
    let y_segments = uniform_grid_content_segments(image, false, rows)?;
    let mut cells = Vec::new();

    for (row, y_segment) in y_segments.iter().enumerate() {
        for (col, x_segment) in x_segments.iter().enumerate() {
            let raw = SplitCell {
                row: row as u32,
                col: col as u32,
                x: x_segment.start,
                y: y_segment.start,
                width: x_segment.size(),
                height: y_segment.size(),
            };
            let trimmed = trim_split_cell(image, raw, force_square);
            if trimmed.x >= width
                || trimmed.y >= height
                || trimmed.width == 0
                || trimmed.height == 0
            {
                return None;
            }
            cells.push(trimmed);
        }
    }

    Some(cells)
}

#[derive(Debug, Clone, Copy)]
struct SegmentRange {
    start: u32,
    end: u32,
}

impl SegmentRange {
    fn size(self) -> u32 {
        self.end.saturating_sub(self.start)
    }
}

fn uniform_grid_content_segments(
    image: &DynamicImage,
    vertical: bool,
    parts: u32,
) -> Option<Vec<SegmentRange>> {
    let n = if vertical {
        image.width()
    } else {
        image.height()
    };
    if n < parts * 16 {
        return None;
    }

    let profile = line_std_profile(image, vertical);
    let p10 = percentile(&profile, 10.0);
    let p25 = percentile(&profile, 25.0);
    let p50 = percentile(&profile, 50.0);
    let max_std = f32::min(
        f32::max(4.0, f32::max(p10 * 2.8, p25 * 1.8)),
        f32::max(8.0, p50 * 0.7),
    );
    let min_band = ((n as f32) * 0.002).round().max(1.0) as u32;
    let bands = low_variation_segments(&profile, max_std, min_band);
    if bands.is_empty() {
        return None;
    }

    let edge_tol = f32::max(10.0, n as f32 * 0.06);
    let inner_tol = f32::max(14.0, n as f32 * 0.09);
    let start_band = pick_segment_near(&bands, 0.0, edge_tol, Some("start"));
    let end_band = pick_segment_near(&bands, n as f32, edge_tol, Some("end"));
    let mut inner_bands = Vec::new();
    for index in 1..parts {
        inner_bands.push(pick_segment_near(
            &bands,
            n as f32 * index as f32 / parts as f32,
            inner_tol,
            None,
        )?);
    }
    inner_bands.sort_by_key(|segment| segment.start);

    let start_edge = start_band
        .filter(|segment| segment.start as f32 <= edge_tol)
        .map(|segment| segment.end)
        .unwrap_or(0);
    let end_edge = end_band
        .filter(|segment| segment.end as f32 >= n as f32 - edge_tol)
        .map(|segment| segment.start)
        .unwrap_or(n);

    let mut bounds = vec![start_edge];
    for band in inner_bands {
        bounds.push(band.start);
        bounds.push(band.end);
    }
    bounds.push(end_edge);

    let mut segments = Vec::new();
    let mut index = 0;
    while index + 1 < bounds.len() {
        let segment = SegmentRange {
            start: bounds[index],
            end: bounds[index + 1],
        };
        if segment.size() == 0 {
            return None;
        }
        segments.push(segment);
        index += 2;
    }

    if segments.len() != parts as usize {
        return None;
    }
    let min_tile = u32::max(16, ((n as f32) * 0.18) as u32);
    if segments.iter().any(|segment| segment.size() < min_tile) {
        return None;
    }

    Some(segments)
}

fn line_std_profile(image: &DynamicImage, vertical: bool) -> Vec<f32> {
    let rgb = image.to_rgb8();
    let (width, height) = rgb.dimensions();
    let len = if vertical { width } else { height };
    let span = if vertical { height } else { width };
    let mut profile = Vec::with_capacity(len as usize);

    for index in 0..len {
        let mut sum = [0.0_f32; 3];
        let mut sum_sq = [0.0_f32; 3];
        for offset in 0..span {
            let pixel = if vertical {
                rgb.get_pixel(index, offset)
            } else {
                rgb.get_pixel(offset, index)
            };
            for channel in 0..3 {
                let value = pixel[channel] as f32;
                sum[channel] += value;
                sum_sq[channel] += value * value;
            }
        }
        let mut std_sum = 0.0;
        for channel in 0..3 {
            let mean = sum[channel] / span as f32;
            let variance = (sum_sq[channel] / span as f32 - mean * mean).max(0.0);
            std_sum += variance.sqrt();
        }
        profile.push(std_sum / 3.0);
    }

    profile
}

fn low_variation_segments(profile: &[f32], max_std: f32, min_seg: u32) -> Vec<SegmentRange> {
    let mut segments = Vec::new();
    let mut index = 0usize;
    while index < profile.len() {
        while index < profile.len() && profile[index] > max_std {
            index += 1;
        }
        if index >= profile.len() {
            break;
        }
        let start = index;
        while index < profile.len() && profile[index] <= max_std {
            index += 1;
        }
        let segment = SegmentRange {
            start: start as u32,
            end: index as u32,
        };
        if segment.size() >= min_seg {
            segments.push(segment);
        }
    }
    segments
}

fn pick_segment_near(
    segments: &[SegmentRange],
    target: f32,
    tolerance: f32,
    prefer_edge: Option<&str>,
) -> Option<SegmentRange> {
    segments
        .iter()
        .copied()
        .filter_map(|segment| {
            let distance = match prefer_edge {
                Some("start") => segment.start as f32,
                Some("end") => (segment.end as f32 - target).abs(),
                _ => ((segment.start + segment.end) as f32 / 2.0 - target).abs(),
            };
            if distance <= tolerance {
                Some((distance, segment))
            } else {
                None
            }
        })
        .min_by(|left, right| {
            left.0
                .partial_cmp(&right.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(_, segment)| segment)
}

fn trim_split_cell(image: &DynamicImage, cell: SplitCell, force_square: bool) -> SplitCell {
    let mut current = cell;
    current = trim_cell_edges(image, current, BorderTrimKind::White);
    current = trim_cell_edges(image, current, BorderTrimKind::Dark);
    current = trim_low_variation_cell_edges(image, current);
    if force_square {
        current = make_square_cell(current);
        current = trim_cell_edges(image, current, BorderTrimKind::White);
        current = trim_cell_edges(image, current, BorderTrimKind::Dark);
        current = trim_low_variation_cell_edges(image, current);
        current = make_square_cell(current);
    }
    current
}

#[derive(Clone, Copy)]
enum BorderTrimKind {
    White,
    Dark,
}

fn trim_cell_edges(image: &DynamicImage, cell: SplitCell, kind: BorderTrimKind) -> SplitCell {
    let rgb = image.to_rgb8();
    let mut left = cell.x;
    let mut top = cell.y;
    let mut right = cell.x + cell.width;
    let mut bottom = cell.y + cell.height;

    while top < bottom && edge_ratio(&rgb, left, right, top, true, kind) >= threshold_for(kind) {
        top += 1;
    }
    while bottom > top
        && edge_ratio(&rgb, left, right, bottom - 1, true, kind) >= threshold_for(kind)
    {
        bottom -= 1;
    }
    while left < right && edge_ratio(&rgb, top, bottom, left, false, kind) >= threshold_for(kind) {
        left += 1;
    }
    while right > left
        && edge_ratio(&rgb, top, bottom, right - 1, false, kind) >= threshold_for(kind)
    {
        right -= 1;
    }

    cell_from_bounds(cell.row, cell.col, left, top, right, bottom)
}

fn edge_ratio(
    rgb: &image::RgbImage,
    start: u32,
    end: u32,
    fixed: u32,
    horizontal: bool,
    kind: BorderTrimKind,
) -> f32 {
    let mut matched = 0u32;
    let total = end.saturating_sub(start).max(1);
    for position in start..end {
        let pixel = if horizontal {
            rgb.get_pixel(position, fixed)
        } else {
            rgb.get_pixel(fixed, position)
        };
        let is_match = match kind {
            BorderTrimKind::White => pixel[0] >= 245 && pixel[1] >= 245 && pixel[2] >= 245,
            BorderTrimKind::Dark => pixel[0].max(pixel[1]).max(pixel[2]) <= 35,
        };
        if is_match {
            matched += 1;
        }
    }
    matched as f32 / total as f32
}

fn threshold_for(kind: BorderTrimKind) -> f32 {
    match kind {
        BorderTrimKind::White => 0.995,
        BorderTrimKind::Dark => 0.985,
    }
}

fn trim_low_variation_cell_edges(image: &DynamicImage, cell: SplitCell) -> SplitCell {
    let rgb = image.to_rgb8();
    let max_trim_x = ((cell.width as f32) * 0.08).round().max(1.0) as u32;
    let max_trim_y = ((cell.height as f32) * 0.08).round().max(1.0) as u32;
    let mut left = cell.x;
    let mut top = cell.y;
    let mut right = cell.x + cell.width;
    let mut bottom = cell.y + cell.height;

    let row_threshold = low_variation_edge_threshold(&rgb, left, right, top, bottom, true);
    let col_threshold = low_variation_edge_threshold(&rgb, left, right, top, bottom, false);
    let center_color = average_region_color(
        &rgb,
        left + (right - left) / 4,
        top + (bottom - top) / 4,
        right - (right - left) / 4,
        bottom - (bottom - top) / 4,
    );

    let mut trimmed = 0;
    while trimmed < max_trim_y
        && top < bottom
        && line_std(&rgb, left, right, top, true) <= row_threshold
        && color_distance(
            line_average_color(&rgb, left, right, top, true),
            center_color,
        ) > 18.0
    {
        top += 1;
        trimmed += 1;
    }
    trimmed = 0;
    while trimmed < max_trim_y
        && bottom > top
        && line_std(&rgb, left, right, bottom - 1, true) <= row_threshold
        && color_distance(
            line_average_color(&rgb, left, right, bottom - 1, true),
            center_color,
        ) > 18.0
    {
        bottom -= 1;
        trimmed += 1;
    }
    trimmed = 0;
    while trimmed < max_trim_x
        && left < right
        && line_std(&rgb, top, bottom, left, false) <= col_threshold
        && color_distance(
            line_average_color(&rgb, top, bottom, left, false),
            center_color,
        ) > 18.0
    {
        left += 1;
        trimmed += 1;
    }
    trimmed = 0;
    while trimmed < max_trim_x
        && right > left
        && line_std(&rgb, top, bottom, right - 1, false) <= col_threshold
        && color_distance(
            line_average_color(&rgb, top, bottom, right - 1, false),
            center_color,
        ) > 18.0
    {
        right -= 1;
        trimmed += 1;
    }

    if right - left < u32::max(8, (cell.width as f32 * 0.65) as u32)
        || bottom - top < u32::max(8, (cell.height as f32 * 0.65) as u32)
    {
        cell
    } else {
        cell_from_bounds(cell.row, cell.col, left, top, right, bottom)
    }
}

fn average_region_color(
    rgb: &image::RgbImage,
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
) -> [f32; 3] {
    let mut sum = [0.0_f32; 3];
    let mut count = 0.0_f32;
    for y in top.min(rgb.height())..bottom.min(rgb.height()).max(top.min(rgb.height()) + 1) {
        for x in left.min(rgb.width())..right.min(rgb.width()).max(left.min(rgb.width()) + 1) {
            let pixel = rgb.get_pixel(x.min(rgb.width() - 1), y.min(rgb.height() - 1));
            for channel in 0..3 {
                sum[channel] += pixel[channel] as f32;
            }
            count += 1.0;
        }
    }
    if count == 0.0 {
        return [0.0, 0.0, 0.0];
    }
    [sum[0] / count, sum[1] / count, sum[2] / count]
}

fn line_average_color(
    rgb: &image::RgbImage,
    start: u32,
    end: u32,
    fixed: u32,
    horizontal: bool,
) -> [f32; 3] {
    let mut sum = [0.0_f32; 3];
    let total = end.saturating_sub(start).max(1) as f32;
    for position in start..end {
        let pixel = if horizontal {
            rgb.get_pixel(position.min(rgb.width() - 1), fixed.min(rgb.height() - 1))
        } else {
            rgb.get_pixel(fixed.min(rgb.width() - 1), position.min(rgb.height() - 1))
        };
        for channel in 0..3 {
            sum[channel] += pixel[channel] as f32;
        }
    }
    [sum[0] / total, sum[1] / total, sum[2] / total]
}

fn color_distance(left: [f32; 3], right: [f32; 3]) -> f32 {
    let dr = left[0] - right[0];
    let dg = left[1] - right[1];
    let db = left[2] - right[2];
    (dr * dr + dg * dg + db * db).sqrt()
}

fn low_variation_edge_threshold(
    rgb: &image::RgbImage,
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
    horizontal: bool,
) -> f32 {
    let mut values = Vec::new();
    if horizontal {
        for y in top..bottom {
            values.push(line_std(rgb, left, right, y, true));
        }
    } else {
        for x in left..right {
            values.push(line_std(rgb, top, bottom, x, false));
        }
    }
    let p12 = percentile(&values, 12.0);
    let p45 = percentile(&values, 45.0);
    f32::min(f32::max(3.5, p12 * 2.3), f32::max(7.5, p45 * 0.55))
}

fn line_std(rgb: &image::RgbImage, start: u32, end: u32, fixed: u32, horizontal: bool) -> f32 {
    let total = end.saturating_sub(start).max(1);
    let mut sum = [0.0_f32; 3];
    let mut sum_sq = [0.0_f32; 3];
    for position in start..end {
        let pixel = if horizontal {
            rgb.get_pixel(position, fixed)
        } else {
            rgb.get_pixel(fixed, position)
        };
        for channel in 0..3 {
            let value = pixel[channel] as f32;
            sum[channel] += value;
            sum_sq[channel] += value * value;
        }
    }
    let mut std_sum = 0.0;
    for channel in 0..3 {
        let mean = sum[channel] / total as f32;
        let variance = (sum_sq[channel] / total as f32 - mean * mean).max(0.0);
        std_sum += variance.sqrt();
    }
    std_sum / 3.0
}

fn make_square_cell(cell: SplitCell) -> SplitCell {
    let side = cell.width.min(cell.height).max(1);
    SplitCell {
        x: cell.x + (cell.width - side) / 2,
        y: cell.y + (cell.height - side) / 2,
        width: side,
        height: side,
        ..cell
    }
}

fn cell_from_bounds(row: u32, col: u32, left: u32, top: u32, right: u32, bottom: u32) -> SplitCell {
    SplitCell {
        row,
        col,
        x: left,
        y: top,
        width: right.saturating_sub(left).max(1),
        height: bottom.saturating_sub(top).max(1),
    }
}

fn percentile(values: &[f32], percentile: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let rank = ((percentile / 100.0) * (sorted.len().saturating_sub(1)) as f32).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

#[derive(Debug, Clone, Copy)]
struct SplitCell {
    row: u32,
    col: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

fn compute_split_cells(
    image_width: u32,
    image_height: u32,
    rows: u32,
    cols: u32,
    line_width: u32,
    outer_border: u32,
    force_square: bool,
) -> Vec<SplitCell> {
    let content_width = image_width.saturating_sub(outer_border.saturating_mul(2));
    let content_height = image_height.saturating_sub(outer_border.saturating_mul(2));
    let total_vertical_lines = line_width.saturating_mul(cols.saturating_sub(1));
    let total_horizontal_lines = line_width.saturating_mul(rows.saturating_sub(1));
    let cell_area_width = content_width.saturating_sub(total_vertical_lines);
    let cell_area_height = content_height.saturating_sub(total_horizontal_lines);
    let mut cells = Vec::new();

    for row in 0..rows {
        for col in 0..cols {
            let x = outer_border
                + col.saturating_mul(line_width)
                + col.saturating_mul(cell_area_width) / cols;
            let y = outer_border
                + row.saturating_mul(line_width)
                + row.saturating_mul(cell_area_height) / rows;
            let next_x = outer_border
                + col.saturating_mul(line_width)
                + (col + 1).saturating_mul(cell_area_width) / cols;
            let next_y = outer_border
                + row.saturating_mul(line_width)
                + (row + 1).saturating_mul(cell_area_height) / rows;
            let mut cell_x = x.min(image_width.saturating_sub(1));
            let mut cell_y = y.min(image_height.saturating_sub(1));
            let mut cell_width = next_x.saturating_sub(x).max(1);
            let mut cell_height = next_y.saturating_sub(y).max(1);

            if col + 1 == cols {
                cell_width = image_width
                    .saturating_sub(outer_border)
                    .saturating_sub(cell_x)
                    .max(1);
            }
            if row + 1 == rows {
                cell_height = image_height
                    .saturating_sub(outer_border)
                    .saturating_sub(cell_y)
                    .max(1);
            }

            if force_square {
                let side = cell_width.min(cell_height).max(1);
                cell_x += (cell_width - side) / 2;
                cell_y += (cell_height - side) / 2;
                cell_width = side;
                cell_height = side;
            }

            if cell_x + cell_width > image_width {
                cell_width = image_width.saturating_sub(cell_x).max(1);
            }
            if cell_y + cell_height > image_height {
                cell_height = image_height.saturating_sub(cell_y).max(1);
            }

            cells.push(SplitCell {
                row,
                col,
                x: cell_x,
                y: cell_y,
                width: cell_width,
                height: cell_height,
            });
        }
    }

    cells
}

fn process_stitch(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
) -> AppResult<Vec<FileResult>> {
    let rows = read_u32(params, "rows", 3).max(1);
    let cols = read_u32(params, "cols", 3).max(1);
    let cell_width = read_u32(params, "cellWidth", 512).max(1);
    let cell_height = read_u32(params, "cellHeight", 512).max(1);
    let fit = read_string(params, "fit", "contain");
    let background = parse_hex_color(&read_string(params, "background", "#ffffff"));
    let output_format = read_string(params, "outputFormat", "png");
    let quality = read_u8(params, "quality", 82);
    let sorted = sort_paths(input_paths, &read_string(params, "sortBy", "filename"));
    let format = resolve_format_name(&output_format)?;
    let batch_size = (rows * cols) as usize;
    let mut results = Vec::new();

    for (batch_index, chunk) in sorted.chunks(batch_size).enumerate() {
        if let Some(first_input) = chunk.first() {
            tracker.start_file(first_input);
        }
        let result = (|| -> AppResult<FileResult> {
            let mut canvas = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
                cols * cell_width,
                rows * cell_height,
                background,
            ));

            for (index, input) in chunk.iter().enumerate() {
                let image = image::open(input)?;
                let cell = fit_image_to_cell(&image, cell_width, cell_height, &fit, background);
                let row = index as u32 / cols;
                let col = index as u32 % cols;
                canvas.copy_from(&cell, col * cell_width, row * cell_height)?;
            }

            let filename = format!(
                "stitched_{:03}.{}",
                batch_index + 1,
                extension_for_format(&format)
            );
            let output_path = unique_path(&output_dir.join(filename));
            save_image(&canvas, &output_path, &format, quality)?;
            Ok(FileResult {
                input_path: chunk
                    .iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(";"),
                output_path: Some(output_path.to_string_lossy().to_string()),
                status: "success".to_string(),
                error: None,
            })
        })();
        let result = result.unwrap_or_else(|error| FileResult {
            input_path: chunk
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(";"),
            output_path: None,
            status: "failed".to_string(),
            error: Some(error.to_string()),
        });
        tracker.finish_file(&result);
        results.push(result);
    }

    Ok(results)
}

fn process_organize(
    input_paths: &[PathBuf],
    output_dir: &Path,
    tracker: &mut ProgressTracker<'_>,
) -> AppResult<Vec<FileResult>> {
    let mut results = Vec::new();
    for input in input_paths {
        tracker.start_file(input);
        let extension = normalized_extension(input).unwrap_or_else(|| "unknown".to_string());
        let target_dir = output_dir.join(extension);
        let result = if let Err(error) = fs::create_dir_all(&target_dir) {
            failed_result(input, error.into())
        } else {
            let output_path = unique_path(&target_dir.join(file_name(input)));
            copy_file(input, &output_path)
        };
        tracker.finish_file(&result);
        results.push(result);
    }
    Ok(results)
}

#[derive(Clone)]
struct AiTaskContext {
    config: AiProviderConfig,
    api_key: String,
}

impl AiTaskContext {
    fn from_state(state: &tauri::State<'_, AppState>) -> AppResult<Option<Self>> {
        let config = read_config(&state.config_path)?.ai_provider;

        match read_saved_api_key(&state.api_key_path)? {
            Some(api_key) => Ok(Some(Self { config, api_key })),
            None => Ok(None),
        }
    }
}

fn build_ai_http_client(config: &AiProviderConfig) -> AppResult<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(
        config.timeout_seconds.max(10),
    ));
    if let Some(proxy_url) = config.proxy_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url)?);
    }
    Ok(builder.build()?)
}

#[derive(Clone, Copy)]
enum AiGenerationKind {
    Copy,
    Title,
    Variation,
}

fn process_ai_analyze(
    input_paths: &[PathBuf],
    output_dir: &Path,
    report_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
    ai_context: &AiTaskContext,
) -> AppResult<Vec<FileResult>> {
    let sorted = sort_paths(input_paths, &read_string(params, "sortBy", "input"));
    let language = read_string(params, "aiLanguage", "zh-CN");
    let platform = read_string(params, "aiPlatform", "通用广告");
    let persona = read_ai_persona(params);
    let product_context = read_string(params, "aiProductContext", "");
    let prompt_examples = read_u32(params, "aiPromptExampleCount", 5).clamp(1, 12);
    let reverse_prompt_mode = read_string(params, "aiReversePromptMode", "极致还原");
    let mut results = Vec::new();

    fs::create_dir_all(output_dir)?;
    fs::create_dir_all(report_dir)?;

    for input in sorted {
        tracker.start_file(&input);
        let result = (|| -> AppResult<FileResult> {
            let analysis = analyze_ad_creative_image(
                &input,
                ai_context,
                &language,
                &platform,
                &persona,
                &product_context,
                &reverse_prompt_mode,
                prompt_examples,
            )?;
            let original_output = unique_path(&output_dir.join(file_name(&input)));
            fs::copy(&input, &original_output)?;

            let analysis_path =
                unique_path(&report_dir.join(format!("{}_analysis.json", file_stem(&input))));
            fs::write(&analysis_path, serde_json::to_string_pretty(&analysis)?)?;

            Ok(success_result(&input, &analysis_path))
        })();
        let result = result.unwrap_or_else(|error| failed_result(&input, error));
        tracker.finish_file(&result);
        results.push(result);
    }

    write_ai_summary_files(report_dir, &results)?;
    Ok(results)
}

fn process_ai_generation_task(
    input_paths: &[PathBuf],
    output_dir: &Path,
    report_dir: &Path,
    params: &serde_json::Value,
    tracker: &mut ProgressTracker<'_>,
    ai_context: &AiTaskContext,
    task_type: &TaskType,
) -> AppResult<Vec<FileResult>> {
    let kind = match task_type {
        TaskType::AiGenerateCopy => AiGenerationKind::Copy,
        TaskType::AiGenerateTitle => AiGenerationKind::Title,
        TaskType::AiGenerateImage => AiGenerationKind::Variation,
        _ => {
            return Err(AppError::InvalidParams(
                "不支持的 AI 生成任务类型".to_string(),
            ));
        }
    };
    let sorted = sort_paths(input_paths, &read_string(params, "sortBy", "input"));
    let language = read_string(params, "aiLanguage", "zh-CN");
    let platform = read_string(params, "aiPlatform", "通用广告");
    let persona = read_ai_persona(params);
    let product_context = read_string(params, "aiProductContext", "");
    let count = read_u32(params, "aiGenerateCount", 5).clamp(1, 20);
    let tone = read_string(params, "aiCopyTone", "高转化");
    let audience = read_string(params, "aiTargetAudience", "泛广告受众");
    let variation_direction = read_string(params, "aiVariationDirection", "参考我的小游戏风格裂变");
    let mut results = Vec::new();

    fs::create_dir_all(output_dir)?;
    fs::create_dir_all(report_dir)?;

    for input in sorted {
        tracker.start_file(&input);
        let result = (|| -> AppResult<FileResult> {
            let generated = generate_ai_protocol_asset(
                &input,
                ai_context,
                kind,
                &language,
                &platform,
                &persona,
                &product_context,
                &tone,
                &audience,
                &variation_direction,
                count,
            )?;
            let original_output = unique_path(&output_dir.join(file_name(&input)));
            fs::copy(&input, &original_output)?;

            let suffix = match kind {
                AiGenerationKind::Copy => "copy",
                AiGenerationKind::Title => "titles",
                AiGenerationKind::Variation => "variations",
            };
            let output_path =
                unique_path(&report_dir.join(format!("{}_{}.json", file_stem(&input), suffix)));
            fs::write(&output_path, serde_json::to_string_pretty(&generated)?)?;

            Ok(success_result(&input, &output_path))
        })();
        let result = result.unwrap_or_else(|error| failed_result(&input, error));
        tracker.finish_file(&result);
        results.push(result);
    }

    write_ai_summary_files(report_dir, &results)?;
    Ok(results)
}

fn analyze_ad_creative_image(
    input: &Path,
    ai_context: &AiTaskContext,
    language: &str,
    platform: &str,
    persona: &str,
    product_context: &str,
    reverse_prompt_mode: &str,
    prompt_examples: u32,
) -> AppResult<serde_json::Value> {
    let image_data_url = image_data_url(input)?;
    let prompt = build_ad_analysis_prompt(
        input,
        language,
        platform,
        product_context,
        reverse_prompt_mode,
        prompt_examples,
    );
    let client = build_ai_http_client(&ai_context.config)?;

    let system_prompt = build_system_prompt(
        persona,
        "你是资深广告素材策略师。只输出符合 schema 的 JSON，不要输出 Markdown。",
    );

    match request_responses_analysis(
        &client,
        ai_context,
        &prompt,
        &image_data_url,
        &system_prompt,
    ) {
        Ok(value) => Ok(value),
        Err(_) => request_chat_analysis(
            &client,
            ai_context,
            &prompt,
            &image_data_url,
            &system_prompt,
        ),
    }
}

fn generate_ai_protocol_asset(
    input: &Path,
    ai_context: &AiTaskContext,
    kind: AiGenerationKind,
    language: &str,
    platform: &str,
    persona: &str,
    product_context: &str,
    tone: &str,
    audience: &str,
    variation_direction: &str,
    count: u32,
) -> AppResult<serde_json::Value> {
    let image_data_url = image_data_url(input)?;
    let prompt = build_ai_generation_prompt(
        input,
        kind,
        language,
        platform,
        product_context,
        tone,
        audience,
        variation_direction,
        count,
    );
    let client = build_ai_http_client(&ai_context.config)?;
    let schema = ai_generation_schema(kind);
    let schema_name = match kind {
        AiGenerationKind::Copy => "ad_copy_generation",
        AiGenerationKind::Title => "ad_title_generation",
        AiGenerationKind::Variation => "creative_variation_prompts",
    };
    let role_prompt = match kind {
        AiGenerationKind::Copy => {
            "你是资深广告文案策略师。只输出符合 schema 的 JSON，不要输出 Markdown。"
        }
        AiGenerationKind::Title => {
            "你是高转化广告标题专家。只输出符合 schema 的 JSON，不要输出 Markdown。"
        }
        AiGenerationKind::Variation => {
            "你是图片创意裂变与提示词工程专家。只输出符合 schema 的 JSON，不要输出 Markdown。"
        }
    };
    let system_prompt = build_system_prompt(persona, role_prompt);

    let generated = match request_responses_json(
        &client,
        ai_context,
        &prompt,
        &image_data_url,
        &system_prompt,
        schema_name,
        schema.clone(),
    ) {
        Ok(value) => Ok(value),
        Err(_) => request_chat_json(
            &client,
            ai_context,
            &prompt,
            &image_data_url,
            &system_prompt,
        ),
    }?;
    Ok(normalize_ai_generation_result(generated, kind))
}

fn normalize_ai_generation_result(
    mut value: serde_json::Value,
    kind: AiGenerationKind,
) -> serde_json::Value {
    let expected_type = match kind {
        AiGenerationKind::Copy => "ad_copy_generation",
        AiGenerationKind::Title => "ad_title_generation",
        AiGenerationKind::Variation => "creative_variation_prompts",
    };
    if let Some(object) = value.as_object_mut() {
        object.insert("result_type".to_string(), json!(expected_type));
    }
    value
}

fn read_ai_persona(params: &serde_json::Value) -> String {
    let persona = read_string(params, "aiPersona", DEFAULT_AI_PERSONA);
    if persona.trim().is_empty() {
        DEFAULT_AI_PERSONA.to_string()
    } else {
        persona
    }
}

fn build_system_prompt(persona: &str, role_instruction: &str) -> String {
    format!(
        "{persona}\n\n{role_instruction}\n\n请始终基于上述人设、平台机制、素材起量经验和爆图判断标准进行判断。"
    )
}

fn request_responses_analysis(
    client: &reqwest::blocking::Client,
    ai_context: &AiTaskContext,
    prompt: &str,
    image_data_url: &str,
    system_prompt: &str,
) -> AppResult<serde_json::Value> {
    request_responses_json(
        client,
        ai_context,
        prompt,
        image_data_url,
        system_prompt,
        "ad_creative_analysis",
        ad_analysis_schema(),
    )
}

fn request_responses_json(
    client: &reqwest::blocking::Client,
    ai_context: &AiTaskContext,
    prompt: &str,
    image_data_url: &str,
    system_prompt: &str,
    schema_name: &str,
    schema: serde_json::Value,
) -> AppResult<serde_json::Value> {
    let body = json!({
        "model": ai_context.config.vision_model,
        "input": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": system_prompt
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": prompt },
                    { "type": "input_image", "image_url": image_data_url, "detail": "low" }
                ]
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": schema_name,
                "strict": true,
                "schema": schema
            }
        }
    });
    let mut last_error: Option<AppError> = None;
    for base_url in candidate_api_base_urls(&ai_context.config.base_url) {
        let url = join_api_endpoint(&base_url, "responses");
        match send_ai_json_request(
            client
            .post(url)
            .bearer_auth(&ai_context.api_key)
            .json(&body),
        )
        {
            Ok(response) => {
                return parse_model_json_output(&response);
            }
            Err(error) => last_error = Some(error.into()),
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::InvalidParams("API Base URL 不能为空".to_string())))
}

fn request_chat_analysis(
    client: &reqwest::blocking::Client,
    ai_context: &AiTaskContext,
    prompt: &str,
    image_data_url: &str,
    system_prompt: &str,
) -> AppResult<serde_json::Value> {
    request_chat_json(client, ai_context, prompt, image_data_url, system_prompt)
}

fn request_chat_json(
    client: &reqwest::blocking::Client,
    ai_context: &AiTaskContext,
    prompt: &str,
    image_data_url: &str,
    system_prompt: &str,
) -> AppResult<serde_json::Value> {
    let body = json!({
        "model": ai_context.config.vision_model,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": image_data_url } }
                ]
            }
        ],
        "response_format": { "type": "json_object" }
    });
    let mut last_error: Option<AppError> = None;
    for base_url in candidate_api_base_urls(&ai_context.config.base_url) {
        let url = join_api_endpoint(&base_url, "chat/completions");
        match send_ai_json_request(
            client
            .post(url)
            .bearer_auth(&ai_context.api_key)
            .json(&body),
        )
        {
            Ok(response) => {
                return parse_model_json_output(&response);
            }
            Err(error) => last_error = Some(error.into()),
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::InvalidParams("API Base URL 不能为空".to_string())))
}

fn send_ai_json_request(
    request: reqwest::blocking::RequestBuilder,
) -> AppResult<serde_json::Value> {
    let response = request.send()?;
    let status = response.status();
    let text = response
        .text()
        .unwrap_or_else(|_| "无法读取错误响应".to_string());
    if !status.is_success() {
        return Err(AppError::InvalidParams(format!(
            "HTTP {} {}",
            status.as_u16(),
            summarize_error_message(&text)
        )));
    }
    Ok(serde_json::from_str(&text)?)
}

fn run_ai_connection_test(
    client: &reqwest::blocking::Client,
    context: &AiTaskContext,
    target: AiTestTarget,
) -> AiConnectionTestResult {
    match target {
        AiTestTarget::Text => test_text_model(client, context),
        AiTestTarget::Vision => test_vision_model(client, context),
        AiTestTarget::Image => test_image_model(client, context),
        AiTestTarget::All => AiConnectionTestResult {
            target: "all".to_string(),
            model: "".to_string(),
            ok: false,
            status: None,
            message: "内部错误：all 应在调用前展开".to_string(),
        },
    }
}

fn test_text_model(
    client: &reqwest::blocking::Client,
    context: &AiTaskContext,
) -> AiConnectionTestResult {
    let responses_body = json!({
        "model": context.config.text_model,
        "input": "Return exactly: ok"
    });
    let chat_body = json!({
        "model": context.config.text_model,
        "messages": [
            { "role": "user", "content": "Return exactly: ok" }
        ],
        "max_tokens": 8
    });
    let mut attempts = Vec::new();
    for base_url in candidate_api_base_urls(&context.config.base_url) {
        attempts.push((
            "responses".to_string(),
            join_api_endpoint(&base_url, "responses"),
            responses_body.clone(),
        ));
    }
    for base_url in candidate_api_base_urls(&context.config.base_url) {
        attempts.push((
            "chat.completions".to_string(),
            join_api_endpoint(&base_url, "chat/completions"),
            chat_body.clone(),
        ));
    }
    run_test_attempts(
        "text",
        &context.config.text_model,
        client,
        &context.api_key,
        attempts,
    )
}

fn test_vision_model(
    client: &reqwest::blocking::Client,
    context: &AiTaskContext,
) -> AiConnectionTestResult {
    let test_image = test_jpeg_data_url();
    let responses_body = json!({
        "model": context.config.vision_model,
        "input": [
            {
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "Reply with one short word describing the image color." },
                    { "type": "input_image", "image_url": test_image, "detail": "low" }
                ]
            }
        ]
    });
    let chat_body = json!({
        "model": context.config.vision_model,
        "messages": [
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": "Reply with one short word describing the image color." },
                    { "type": "image_url", "image_url": { "url": test_image } }
                ]
            }
        ],
        "max_tokens": 8
    });
    let mut attempts = Vec::new();
    for base_url in candidate_api_base_urls(&context.config.base_url) {
        attempts.push((
            "responses".to_string(),
            join_api_endpoint(&base_url, "responses"),
            responses_body.clone(),
        ));
    }
    for base_url in candidate_api_base_urls(&context.config.base_url) {
        attempts.push((
            "chat.completions".to_string(),
            join_api_endpoint(&base_url, "chat/completions"),
            chat_body.clone(),
        ));
    }
    run_test_attempts(
        "vision",
        &context.config.vision_model,
        client,
        &context.api_key,
        attempts,
    )
}

fn test_image_model(
    client: &reqwest::blocking::Client,
    context: &AiTaskContext,
) -> AiConnectionTestResult {
    let body = json!({
        "model": context.config.image_model,
        "prompt": "A tiny plain green square icon",
        "size": "1024x1024",
        "n": 1
    });
    let attempts = candidate_api_base_urls(&context.config.base_url)
        .into_iter()
        .map(|base_url| {
            (
                "images.generations".to_string(),
                join_api_endpoint(&base_url, "images/generations"),
                body.clone(),
            )
        })
        .collect();
    run_test_attempts(
        "image",
        &context.config.image_model,
        client,
        &context.api_key,
        attempts,
    )
}

fn run_test_attempts(
    target: &str,
    model: &str,
    client: &reqwest::blocking::Client,
    api_key: &str,
    attempts: Vec<(String, String, serde_json::Value)>,
) -> AiConnectionTestResult {
    if attempts.is_empty() {
        return AiConnectionTestResult {
            target: target.to_string(),
            model: model.to_string(),
            ok: false,
            status: None,
            message: "API Base URL 不能为空".to_string(),
        };
    }

    let mut failures = Vec::new();
    let mut last_status = None;
    for (label, url, body) in attempts {
        let result = parse_test_response(
            target,
            model,
            &label,
            &url,
            client.post(&url).bearer_auth(api_key).json(&body).send(),
        );
        if result.ok {
            return result;
        }
        last_status = result.status;
        failures.push(format!("{} {}: {}", label, url, result.message));
    }

    AiConnectionTestResult {
        target: target.to_string(),
        model: model.to_string(),
        ok: false,
        status: last_status,
        message: failures
            .into_iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("；"),
    }
}

fn parse_test_response(
    target: &str,
    model: &str,
    endpoint_label: &str,
    url: &str,
    response: Result<reqwest::blocking::Response, reqwest::Error>,
) -> AiConnectionTestResult {
    match response {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                AiConnectionTestResult {
                    target: target.to_string(),
                    model: model.to_string(),
                    ok: true,
                    status: Some(status.as_u16()),
                    message: format!("联通成功：{} {}", endpoint_label, url),
                }
            } else {
                let message = response
                    .text()
                    .unwrap_or_else(|_| "无法读取错误响应".to_string());
                AiConnectionTestResult {
                    target: target.to_string(),
                    model: model.to_string(),
                    ok: false,
                    status: Some(status.as_u16()),
                    message: format!(
                        "HTTP {} {}",
                        status.as_u16(),
                        summarize_error_message(&message)
                    ),
                }
            }
        }
        Err(error) => AiConnectionTestResult {
            target: target.to_string(),
            model: model.to_string(),
            ok: false,
            status: error.status().map(|status| status.as_u16()),
            message: request_error_message(&error),
        },
    }
}

fn request_error_message(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(error_source) = source {
        message.push_str(": ");
        message.push_str(&error_source.to_string());
        source = error_source.source();
    }
    message
}

fn candidate_api_base_urls(base_url: &str) -> Vec<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut urls = vec![trimmed.to_string()];
    if !trimmed.ends_with("/v1") {
        urls.push(format!("{}/v1", trimmed));
    }
    urls
}

fn join_api_endpoint(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn summarize_error_message(message: &str) -> String {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(message);
    if let Ok(value) = parsed {
        if let Some(error_message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|value| value.as_str())
        {
            return error_message.to_string();
        }
        if let Some(error_message) = value.get("message").and_then(|value| value.as_str()) {
            return error_message.to_string();
        }
    }
    message.chars().take(500).collect()
}

fn test_jpeg_data_url() -> String {
    let image = DynamicImage::ImageRgb8(ImageBuffer::from_pixel(
        32,
        32,
        image::Rgb([42, 178, 108]),
    ));
    jpeg_data_url(&image, 85).unwrap_or_else(|_| {
        "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AV//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AV//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAARD/2gAIAQEAAT8QH//Z".to_string()
    })
}

fn build_ad_analysis_prompt(
    input: &Path,
    language: &str,
    platform: &str,
    product_context: &str,
    reverse_prompt_mode: &str,
    prompt_examples: u32,
) -> String {
    format!(
        "请分析这张广告图片素材，并反推它可能使用的图片生成提示词。输出语言：{language}。平台/投放场景：{platform}。反推提示词生成强度/适配目标：{reverse_prompt_mode}。产品或业务补充：{product_context}。文件名：{}。请给出视觉主体、卖点、情绪、场景、受众、转化点、爆点分析、可复用提示词、{} 个提示词示例、风险提示和优化建议。反推提示词部分必须按“{reverse_prompt_mode}”控制还原重点、细节密度和目标模型语法偏好。",
        file_name(input),
        prompt_examples
    )
}

fn build_ai_generation_prompt(
    input: &Path,
    kind: AiGenerationKind,
    language: &str,
    platform: &str,
    product_context: &str,
    tone: &str,
    audience: &str,
    variation_direction: &str,
    count: u32,
) -> String {
    let file = file_name(input);
    match kind {
        AiGenerationKind::Copy => format!(
            "请基于这张广告图片生成匹配广告文案。输出语言：{language}。平台/投放场景：{platform}。语气：{tone}。目标人群：{audience}。产品或业务补充：{product_context}。文件名：{file}。请生成 {count} 组文案，每组包含主文案、短文案、CTA、卖点、适用场景、风险提示和评分。"
        ),
        AiGenerationKind::Title => format!(
            "请基于这张广告图片生成匹配广告标题。输出语言：{language}。平台/投放场景：{platform}。语气：{tone}。目标人群：{audience}。产品或业务补充：{product_context}。文件名：{file}。请生成 {count} 个广告标题，包含标题、角度、适用平台、字符数、CTA 倾向、风险提示和评分。"
        ),
        AiGenerationKind::Variation => format!(
            "请基于这张广告图片进行创意裂变与提示词工程。输出语言：{language}。平台/投放场景：{platform}。目标人群：{audience}。裂变方向：{variation_direction}。产品或业务补充：{product_context}。文件名：{file}。请按“{variation_direction}”控制裂变变量的取舍，提取主体、场景、风格、构图、色彩、促销角度、目标人群等裂变变量，并生成 {count} 组可复用图片裂变提示词。每组需要包含裂变类型、提示词、负向提示词、推荐尺寸、变化点、复用建议和评分。"
        ),
    }
}

fn ai_generation_schema(kind: AiGenerationKind) -> serde_json::Value {
    match kind {
        AiGenerationKind::Copy => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["result_type", "summary", "items"],
            "properties": {
                "result_type": { "type": "string" },
                "summary": { "type": "string" },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["main_copy", "short_copy", "cta", "selling_points", "scenario", "risk_notes", "score"],
                        "properties": {
                            "main_copy": { "type": "string" },
                            "short_copy": { "type": "string" },
                            "cta": { "type": "string" },
                            "selling_points": { "type": "array", "items": { "type": "string" } },
                            "scenario": { "type": "string" },
                            "risk_notes": { "type": "array", "items": { "type": "string" } },
                            "score": { "type": "number" }
                        }
                    }
                }
            }
        }),
        AiGenerationKind::Title => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["result_type", "summary", "items"],
            "properties": {
                "result_type": { "type": "string" },
                "summary": { "type": "string" },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["title", "angle", "platform_fit", "character_count", "cta_intent", "risk_notes", "score"],
                        "properties": {
                            "title": { "type": "string" },
                            "angle": { "type": "string" },
                            "platform_fit": { "type": "string" },
                            "character_count": { "type": "number" },
                            "cta_intent": { "type": "string" },
                            "risk_notes": { "type": "array", "items": { "type": "string" } },
                            "score": { "type": "number" }
                        }
                    }
                }
            }
        }),
        AiGenerationKind::Variation => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["result_type", "summary", "variation_variables", "items"],
            "properties": {
                "result_type": { "type": "string" },
                "summary": { "type": "string" },
                "variation_variables": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["subjects", "scenes", "styles", "compositions", "colors", "promotion_angles", "audiences"],
                    "properties": {
                        "subjects": { "type": "array", "items": { "type": "string" } },
                        "scenes": { "type": "array", "items": { "type": "string" } },
                        "styles": { "type": "array", "items": { "type": "string" } },
                        "compositions": { "type": "array", "items": { "type": "string" } },
                        "colors": { "type": "array", "items": { "type": "string" } },
                        "promotion_angles": { "type": "array", "items": { "type": "string" } },
                        "audiences": { "type": "array", "items": { "type": "string" } }
                    }
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["variation_type", "prompt", "negative_prompt", "size", "changes", "reuse_notes", "score", "favorite"],
                        "properties": {
                            "variation_type": { "type": "string" },
                            "prompt": { "type": "string" },
                            "negative_prompt": { "type": "string" },
                            "size": { "type": "string" },
                            "changes": { "type": "array", "items": { "type": "string" } },
                            "reuse_notes": { "type": "string" },
                            "score": { "type": "number" },
                            "favorite": { "type": "boolean" }
                        }
                    }
                }
            }
        }),
    }
}

fn ad_analysis_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "summary",
            "visual_subjects",
            "selling_points",
            "emotions",
            "scene",
            "target_audience",
            "conversion_points",
            "hook_analysis",
            "extracted_prompt",
            "prompt_examples",
            "risks",
            "optimization_suggestions"
        ],
        "properties": {
            "summary": { "type": "string" },
            "visual_subjects": { "type": "array", "items": { "type": "string" } },
            "selling_points": { "type": "array", "items": { "type": "string" } },
            "emotions": { "type": "array", "items": { "type": "string" } },
            "scene": { "type": "string" },
            "target_audience": { "type": "array", "items": { "type": "string" } },
            "conversion_points": { "type": "array", "items": { "type": "string" } },
            "hook_analysis": {
                "type": "object",
                "additionalProperties": false,
                "required": ["core_hook", "why_it_works", "evidence", "score"],
                "properties": {
                    "core_hook": { "type": "string" },
                    "why_it_works": { "type": "string" },
                    "evidence": { "type": "array", "items": { "type": "string" } },
                    "score": { "type": "number" }
                }
            },
            "extracted_prompt": { "type": "string" },
            "prompt_examples": { "type": "array", "items": { "type": "string" } },
            "risks": { "type": "array", "items": { "type": "string" } },
            "optimization_suggestions": { "type": "array", "items": { "type": "string" } }
        }
    })
}

fn parse_model_json_output(response: &serde_json::Value) -> AppResult<serde_json::Value> {
    if let Some(text) = response.get("output_text").and_then(|value| value.as_str()) {
        return parse_json_text(text);
    }

    if let Some(content) = response
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
    {
        return parse_json_text(content);
    }

    if let Some(outputs) = response.get("output").and_then(|value| value.as_array()) {
        for output in outputs {
            if let Some(contents) = output.get("content").and_then(|value| value.as_array()) {
                for content in contents {
                    if let Some(text) = content.get("text").and_then(|value| value.as_str()) {
                        return parse_json_text(text);
                    }
                }
            }
        }
    }

    Err(AppError::InvalidParams(
        "AI 响应中没有可解析的 JSON".to_string(),
    ))
}

fn parse_json_text(text: &str) -> AppResult<serde_json::Value> {
    let trimmed = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    Ok(serde_json::from_str(trimmed)?)
}

fn image_data_url(input: &Path) -> AppResult<String> {
    let image = image::open(input)?;
    let image = resize_image_for_vision(image);
    jpeg_data_url(&image, 86)
}

fn resize_image_for_vision(image: DynamicImage) -> DynamicImage {
    let (width, height) = image.dimensions();
    let longest_edge = width.max(height);
    if longest_edge <= 1280 {
        return image;
    }

    let scale = 1280.0 / longest_edge as f32;
    let next_width = ((width as f32) * scale).round().max(1.0) as u32;
    let next_height = ((height as f32) * scale).round().max(1.0) as u32;
    image.resize(next_width, next_height, FilterType::Lanczos3)
}

fn jpeg_data_url(image: &DynamicImage, quality: u8) -> AppResult<String> {
    let mut bytes = Vec::new();
    let rgb = image.to_rgb8();
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality.clamp(1, 100));
    encoder.encode(&rgb, rgb.width(), rgb.height(), ColorType::Rgb8.into())?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

fn write_ai_summary_files(report_dir: &Path, files: &[FileResult]) -> AppResult<()> {
    let mut analyses = Vec::new();
    for file in files.iter().filter(|file| file.status == "success") {
        if let Some(output_path) = &file.output_path {
            let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(output_path)?)?;
            analyses.push(json!({
                "input_path": file.input_path,
                "analysis": value
            }));
        }
    }
    fs::write(
        report_dir.join("ai_analysis_summary.json"),
        serde_json::to_string_pretty(&analyses)?,
    )?;

    let mut writer = csv::Writer::from_path(report_dir.join("ai_analysis_summary.csv"))?;
    writer.write_record([
        "input_path",
        "summary",
        "core_hook",
        "score",
        "extracted_prompt",
    ])?;
    for item in analyses {
        let analysis = &item["analysis"];
        writer.write_record([
            item["input_path"].as_str().unwrap_or(""),
            analysis["summary"].as_str().unwrap_or(""),
            analysis["hook_analysis"]["core_hook"]
                .as_str()
                .unwrap_or(""),
            &analysis["hook_analysis"]["score"].to_string(),
            analysis["extracted_prompt"].as_str().unwrap_or(""),
        ])?;
    }
    writer.flush()?;
    Ok(())
}

fn persist_ai_results(
    state: &AppState,
    task_id: &str,
    model: &str,
    files: &[FileResult],
) -> AppResult<()> {
    let db = state.db.lock().expect("database mutex poisoned");
    let now = Utc::now().to_rfc3339();
    for file in files.iter().filter(|file| file.status == "success") {
        let Some(output_path) = &file.output_path else {
            continue;
        };
        let analysis_json = fs::read_to_string(output_path)?;
        let id = Uuid::new_v4().to_string();
        db.execute(
            "insert into ai_results (
                id, task_id, input_path, output_path, model, analysis_json, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                task_id,
                file.input_path,
                output_path,
                model,
                analysis_json,
                now
            ],
        )?;
    }
    Ok(())
}

fn expand_input_paths(inputs: &[String], recursive: bool) -> AppResult<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    for input in inputs {
        let path = PathBuf::from(input);
        if path.is_dir() {
            collect_images_from_dir(&path, recursive, &mut paths, &mut seen)?;
        } else if is_supported_image(&path) && seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    Ok(paths)
}

fn collect_images_from_dir(
    dir: &Path,
    recursive: bool,
    paths: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) -> AppResult<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() && recursive {
            collect_images_from_dir(&path, recursive, paths, seen)?;
        } else if path.is_file() && is_supported_image(&path) && seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    Ok(())
}

fn resolve_task_output_dir(request: &TaskRequest) -> AppResult<PathBuf> {
    let base_dir = match &request.output_rule.output_dir {
        Some(output_dir) if !output_dir.trim().is_empty() => PathBuf::from(output_dir),
        _ => default_outputs_dir()?,
    };
    let timestamp = Utc::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let project_name = sanitize_segment(&request.output_rule.project_name);
    let task_type = format!("{:?}", request.task_type).to_lowercase();
    Ok(base_dir.join(project_name).join(task_type).join(timestamp))
}

fn default_outputs_dir() -> AppResult<PathBuf> {
    default_outputs_dir_from(std::env::current_dir()?)
}

fn default_outputs_dir_from(current_dir: PathBuf) -> AppResult<PathBuf> {
    let workspace_dir = current_dir
        .parent()
        .filter(|_| current_dir.file_name().and_then(|name| name.to_str()) == Some("src-tauri"))
        .map(Path::to_path_buf)
        .unwrap_or(current_dir);

    Ok(workspace_dir.join("outputs"))
}

fn write_reports(output_dir: &Path, report: &TaskReport) -> AppResult<()> {
    let report_dir = output_dir.join("report");
    fs::create_dir_all(&report_dir)?;
    fs::write(
        report_dir.join("report.json"),
        serde_json::to_string_pretty(report)?,
    )?;

    let mut writer = csv::Writer::from_path(report_dir.join("report.csv"))?;
    writer.write_record(["input_path", "output_path", "status", "error"])?;
    for file in &report.files {
        writer.write_record([
            file.input_path.as_str(),
            file.output_path.as_deref().unwrap_or(""),
            file.status.as_str(),
            file.error.as_deref().unwrap_or(""),
        ])?;
    }
    writer.flush()?;

    Ok(())
}

fn resize_image(
    image: &DynamicImage,
    mode: &str,
    fit: &str,
    width: u32,
    height: u32,
    percent: f32,
    allow_upscale: bool,
) -> DynamicImage {
    let (original_width, original_height) = image.dimensions();
    let (mut target_width, mut target_height) = match mode {
        "fixed" => (width.max(1), height.max(1)),
        "height" => {
            let ratio = height as f32 / original_height as f32;
            (
                (original_width as f32 * ratio).round().max(1.0) as u32,
                height.max(1),
            )
        }
        "percent" => {
            let ratio = (percent / 100.0).max(0.01);
            (
                (original_width as f32 * ratio).round().max(1.0) as u32,
                (original_height as f32 * ratio).round().max(1.0) as u32,
            )
        }
        _ => {
            let ratio = width as f32 / original_width as f32;
            (
                width.max(1),
                (original_height as f32 * ratio).round().max(1.0) as u32,
            )
        }
    };

    if !allow_upscale {
        target_width = target_width.min(original_width);
        target_height = target_height.min(original_height);
    }

    match fit {
        "cover" => image.resize_to_fill(target_width, target_height, FilterType::Lanczos3),
        "stretch" => image.resize_exact(target_width, target_height, FilterType::Lanczos3),
        _ if mode == "fixed" => fit_image_to_cell(
            image,
            target_width,
            target_height,
            "contain",
            Rgba([255, 255, 255, 255]),
        ),
        _ => image.resize(target_width, target_height, FilterType::Lanczos3),
    }
}

fn fit_image_to_cell(
    image: &DynamicImage,
    cell_width: u32,
    cell_height: u32,
    fit: &str,
    background: Rgba<u8>,
) -> DynamicImage {
    match fit {
        "cover" => image.resize_to_fill(cell_width, cell_height, FilterType::Lanczos3),
        "stretch" => image.resize_exact(cell_width, cell_height, FilterType::Lanczos3),
        _ => {
            let resized = image.resize(cell_width, cell_height, FilterType::Lanczos3);
            let mut canvas = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
                cell_width,
                cell_height,
                background,
            ));
            let (width, height) = resized.dimensions();
            let x = (cell_width - width) / 2;
            let y = (cell_height - height) / 2;
            let _ = canvas.copy_from(&resized, x, y);
            canvas
        }
    }
}

fn save_image(
    image: &DynamicImage,
    output_path: &Path,
    format: &ImageFormat,
    quality: u8,
) -> AppResult<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut writer = BufWriter::new(File::create(output_path)?);
    match format {
        ImageFormat::Jpeg => {
            let rgb = image.to_rgb8();
            let mut encoder = JpegEncoder::new_with_quality(&mut writer, quality);
            encoder.encode(&rgb, rgb.width(), rgb.height(), ColorType::Rgb8.into())?;
        }
        ImageFormat::Png => {
            let rgba = image.to_rgba8();
            let encoder = PngEncoder::new(&mut writer);
            encoder.write_image(&rgba, rgba.width(), rgba.height(), ColorType::Rgba8.into())?;
        }
        ImageFormat::WebP => {
            let rgba = image.to_rgba8();
            let encoder = WebPEncoder::new_lossless(&mut writer);
            encoder.encode(&rgba, rgba.width(), rgba.height(), ColorType::Rgba8.into())?;
        }
        _ => return Err(AppError::UnsupportedFormat(format!("{format:?}"))),
    }
    writer.flush()?;

    Ok(())
}

fn save_image_to_target_size(
    image: &DynamicImage,
    output_path: &Path,
    format: &ImageFormat,
    quality: u8,
    min_quality: u8,
    target_kb: u64,
    allow_resize_to_target: bool,
) -> AppResult<()> {
    if !matches!(format, ImageFormat::Jpeg) {
        return Err(AppError::InvalidParams(
            "target size compression currently requires JPEG output".to_string(),
        ));
    }

    let target_bytes = target_kb.saturating_mul(1024).max(1);
    let min_quality = min_quality.clamp(1, quality.max(1));
    let mut working_image = image.clone();
    if try_save_jpeg_under_target(
        &working_image,
        output_path,
        quality,
        min_quality,
        target_bytes,
    )? {
        return Ok(());
    }

    if !allow_resize_to_target {
        let size_kb = fs::metadata(output_path)?.len() / 1024;
        return Err(AppError::InvalidParams(format!(
            "最低质量 {min_quality} 时仍为 {size_kb}KB，无法压缩到 {target_kb}KB。请允许改尺寸后再试。"
        )));
    }

    for _ in 0..32 {
        let (width, height) = working_image.dimensions();
        if width <= 320 || height <= 320 {
            break;
        }
        let next_width = ((width as f32) * 0.88).round().max(1.0) as u32;
        let next_height = ((height as f32) * 0.88).round().max(1.0) as u32;
        working_image = working_image.resize(next_width, next_height, FilterType::Lanczos3);
        if try_save_jpeg_under_target(
            &working_image,
            output_path,
            quality,
            min_quality,
            target_bytes,
        )? {
            return Ok(());
        }
    }

    let size_kb = fs::metadata(output_path)?.len() / 1024;
    Err(AppError::InvalidParams(format!(
        "已允许改尺寸，但压缩结果仍为 {size_kb}KB，无法达到 {target_kb}KB。"
    )))
}

fn try_save_jpeg_under_target(
    image: &DynamicImage,
    output_path: &Path,
    quality: u8,
    min_quality: u8,
    target_bytes: u64,
) -> AppResult<bool> {
    let min_quality = min_quality.clamp(1, 100);
    let max_quality = quality.clamp(min_quality, 100);

    save_image(image, output_path, &ImageFormat::Jpeg, min_quality)?;
    if fs::metadata(output_path)?.len() > target_bytes {
        return Ok(false);
    }

    let mut best_quality = min_quality;
    let mut low = min_quality;
    let mut high = max_quality;
    while low <= high {
        let mid = low + (high - low) / 2;
        save_image(image, output_path, &ImageFormat::Jpeg, mid)?;
        if fs::metadata(output_path)?.len() <= target_bytes {
            best_quality = mid;
            low = mid.saturating_add(1);
        } else {
            if mid == 0 {
                break;
            }
            high = mid.saturating_sub(1);
        }
    }

    save_image(image, output_path, &ImageFormat::Jpeg, best_quality)?;
    Ok(true)
}

fn copy_file(input: &Path, output_path: &Path) -> FileResult {
    match fs::copy(input, output_path) {
        Ok(_) => success_result(input, output_path),
        Err(error) => failed_result(input, error.into()),
    }
}

fn success_result(input: &Path, output_path: &Path) -> FileResult {
    FileResult {
        input_path: input.to_string_lossy().to_string(),
        output_path: Some(output_path.to_string_lossy().to_string()),
        status: "success".to_string(),
        error: None,
    }
}

fn failed_result(input: &Path, error: AppError) -> FileResult {
    FileResult {
        input_path: input.to_string_lossy().to_string(),
        output_path: None,
        status: "failed".to_string(),
        error: Some(error.to_string()),
    }
}

fn sort_paths(paths: &[PathBuf], sort_by: &str) -> Vec<PathBuf> {
    let mut sorted = paths.to_vec();
    match sort_by {
        "filename" => sorted.sort_by_key(|path| file_name(path)),
        "modified" => sorted.sort_by_key(|path| fs::metadata(path).and_then(|m| m.modified()).ok()),
        "created" => sorted.sort_by_key(|path| fs::metadata(path).and_then(|m| m.created()).ok()),
        _ => {}
    }
    sorted
}

fn is_supported_image(path: &Path) -> bool {
    normalized_extension(path)
        .map(|extension| SUPPORTED_EXTENSIONS.contains(&extension.as_str()))
        .unwrap_or(false)
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn resolve_output_format(input: &Path, output_format: &str) -> AppResult<ImageFormat> {
    if output_format == "original" {
        let extension = normalized_extension(input)
            .ok_or_else(|| AppError::UnsupportedFormat(input.to_string_lossy().to_string()))?;
        resolve_format_name(&extension)
    } else {
        resolve_format_name(output_format)
    }
}

fn resolve_compress_output_format(
    input: &Path,
    output_format: &str,
    target_kb: Option<u64>,
) -> AppResult<ImageFormat> {
    if target_kb.is_none() {
        return resolve_output_format(input, output_format);
    }

    match output_format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Ok(ImageFormat::Jpeg),
        // Target-size mode is byte-budgeted lossy compression. PNG and the image crate's
        // WebP path are not quality-controlled here, so use JPEG instead of silently missing
        // the requested size by megabytes.
        "original" | "png" | "webp" => Ok(ImageFormat::Jpeg),
        other => Err(AppError::UnsupportedFormat(other.to_string())),
    }
}

fn resolve_format_name(format: &str) -> AppResult<ImageFormat> {
    match format.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Ok(ImageFormat::Jpeg),
        "png" => Ok(ImageFormat::Png),
        "webp" => Ok(ImageFormat::WebP),
        other => Err(AppError::UnsupportedFormat(other.to_string())),
    }
}

fn extension_for_format(format: &ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::WebP => "webp",
        _ => "img",
    }
}

fn format_output_name(input: &Path, suffix: Option<&str>, format: &ImageFormat) -> String {
    let stem = file_stem(input);
    match suffix {
        Some(suffix) => format!("{}_{suffix}.{}", stem, extension_for_format(format)),
        None => format!("{}.{}", stem, extension_for_format(format)),
    }
}

fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }

    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("file");
    let extension = path.extension().and_then(|extension| extension.to_str());

    for index in 1.. {
        let candidate_name = match extension {
            Some(extension) => format!("{stem}_copy_{index}.{extension}"),
            None => format!("{stem}_copy_{index}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    path.to_path_buf()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string()
}

fn file_stem(path: &Path) -> String {
    sanitize_segment(
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("image"),
    )
}

fn sanitize_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .replace(' ', "_");

    if sanitized.is_empty() {
        "project".to_string()
    } else {
        sanitized
    }
}

fn parse_hex_color(value: &str) -> Rgba<u8> {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return Rgba([255, 255, 255, 255]);
    }

    let red = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
    let green = u8::from_str_radix(&hex[2..4], 16).unwrap_or(255);
    let blue = u8::from_str_radix(&hex[4..6], 16).unwrap_or(255);
    Rgba([red, green, blue, 255])
}

fn read_string(params: &serde_json::Value, key: &str, default: &str) -> String {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or(default)
        .to_string()
}

fn read_bool(params: &serde_json::Value, key: &str, default: bool) -> bool {
    params
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(default)
}

fn read_u32(params: &serde_json::Value, key: &str, default: u32) -> u32 {
    params
        .get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
        .unwrap_or(default)
}

fn read_optional_u64(params: &serde_json::Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|value| value.as_u64())
}

fn read_usize(params: &serde_json::Value, key: &str, default: usize) -> usize {
    params
        .get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value as usize)
        .unwrap_or(default)
}

fn read_u8(params: &serde_json::Value, key: &str, default: u8) -> u8 {
    params
        .get(key)
        .and_then(|value| value.as_u64())
        .map(|value| value.clamp(1, 100) as u8)
        .unwrap_or(default)
}

fn read_f32(params: &serde_json::Value, key: &str, default: f32) -> f32 {
    params
        .get(key)
        .and_then(|value| value.as_f64())
        .map(|value| value as f32)
        .unwrap_or(default)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            test_ai_connection,
            create_task,
            list_tasks,
            open_task_folder,
            list_ai_results
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
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&AppConfig::default())?,
        )?;
    }

    let db_path = data_dir.join("app.db");
    let db = Connection::open(db_path)?;
    migrate_database(&db)?;

    Ok(AppState {
        db: Mutex::new(db),
        config_path,
        api_key_path: data_dir.join("api-key.local"),
    })
}

fn read_config(config_path: &PathBuf) -> AppResult<AppConfig> {
    if !config_path.exists() {
        return Ok(AppConfig::default());
    }

    Ok(serde_json::from_str(&fs::read_to_string(config_path)?)?)
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
            last_error text,
            created_at text not null,
            updated_at text not null
        );

        create index if not exists idx_tasks_created_at on tasks(created_at);

        create table if not exists ai_results (
            id text primary key,
            task_id text not null,
            input_path text not null,
            output_path text,
            model text not null,
            analysis_json text not null,
            created_at text not null
        );

        create index if not exists idx_ai_results_created_at on ai_results(created_at);
        create index if not exists idx_ai_results_task_id on ai_results(task_id);
        ",
    )?;

    ensure_column(db, "tasks", "last_error", "text")?;

    Ok(())
}

fn ensure_column(db: &Connection, table: &str, column: &str, definition: &str) -> AppResult<()> {
    let mut statement = db.prepare(&format!("pragma table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(());
        }
    }
    db.execute(
        &format!("alter table {table} add column {column} {definition}"),
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use tempfile::tempdir;

    #[test]
    fn phase_1_batch_tasks_process_images() {
        let temp = tempdir().expect("temp dir");
        let input_dir = temp.path().join("inputs");
        let output_base = temp.path().join("outputs");
        fs::create_dir_all(&input_dir).expect("input dir");
        create_sample_image(&input_dir.join("one.png"), 101, 83, [230, 40, 40, 255]);
        create_sample_image(&input_dir.join("two.jpg"), 120, 90, [40, 180, 80, 255]);
        create_sample_image(&input_dir.join("three.webp"), 80, 130, [40, 90, 220, 255]);

        let inputs = vec![input_dir.to_string_lossy().to_string()];

        let rename = run_test_task(
            TaskType::Rename,
            &inputs,
            &output_base,
            serde_json::json!({
                "recursive": true,
                "prefix": "ad",
                "startIndex": 3,
                "padding": 2,
                "sortBy": "filename"
            }),
        );
        assert_eq!(rename.success_count, 3);
        assert!(Path::new(&rename.output_dir)
            .join("success")
            .join("ad_03.png")
            .exists());

        let resize = run_test_task(
            TaskType::Resize,
            &inputs,
            &output_base,
            serde_json::json!({
                "recursive": true,
                "resizeMode": "fixed",
                "width": 64,
                "height": 64,
                "fit": "cover",
                "outputFormat": "png"
            }),
        );
        assert_eq!(resize.success_count, 3);
        let resized = image::open(
            Path::new(&resize.output_dir)
                .join("success")
                .join("one.png"),
        )
        .expect("resized image");
        assert_eq!(resized.dimensions(), (64, 64));

        let convert = run_test_task(
            TaskType::Convert,
            &inputs,
            &output_base,
            serde_json::json!({
                "recursive": true,
                "outputFormat": "jpg",
                "quality": 75,
                "targetKb": 300
            }),
        );
        assert_eq!(convert.success_count, 3);
        assert!(Path::new(&convert.output_dir)
            .join("success")
            .join("one.jpg")
            .exists());

        let split = run_test_task(
            TaskType::Split,
            &[input_dir.join("one.png").to_string_lossy().to_string()],
            &output_base,
            serde_json::json!({
                "recursive": true,
                "rows": 2,
                "cols": 3,
                "outputFormat": "png"
            }),
        );
        assert_eq!(split.success_count, 6);
        assert!(Path::new(&split.output_dir)
            .join("success")
            .join("one")
            .join("one_r2_c3.png")
            .exists());

        let stitch = run_test_task(
            TaskType::Stitch,
            &inputs,
            &output_base,
            serde_json::json!({
                "recursive": true,
                "rows": 2,
                "cols": 2,
                "cellWidth": 50,
                "cellHeight": 60,
                "outputFormat": "png"
            }),
        );
        assert_eq!(stitch.success_count, 1);
        let stitched = image::open(
            Path::new(&stitch.output_dir)
                .join("success")
                .join("stitched_001.png"),
        )
        .expect("stitched image");
        assert_eq!(stitched.dimensions(), (100, 120));

        let organize = run_test_task(
            TaskType::Organize,
            &inputs,
            &output_base,
            serde_json::json!({ "recursive": true }),
        );
        assert_eq!(organize.success_count, 3);
        assert!(Path::new(&organize.output_dir)
            .join("success")
            .join("png")
            .join("one.png")
            .exists());
        assert!(Path::new(&organize.output_dir)
            .join("report")
            .join("report.json")
            .exists());
        assert!(Path::new(&organize.output_dir)
            .join("report")
            .join("report.csv")
            .exists());
    }

    #[test]
    fn target_size_compression_fails_without_resize_permission() {
        let temp = tempdir().expect("temp dir");
        let input_dir = temp.path().join("inputs");
        let output_base = temp.path().join("outputs");
        fs::create_dir_all(&input_dir).expect("input dir");
        let large_png = input_dir.join("large.png");
        create_noisy_png(&large_png, 1800, 1400);

        let report = run_test_task(
            TaskType::Compress,
            &[large_png.to_string_lossy().to_string()],
            &output_base,
            serde_json::json!({
                "recursive": true,
                "outputFormat": "original",
                "quality": 82,
                "minQuality": 35,
                "targetKb": 400,
                "allowResizeToTarget": false
            }),
        );

        assert_eq!(report.success_count, 0);
        assert_eq!(report.failed_count, 1);
        assert!(report.files[0]
            .error
            .as_ref()
            .expect("error")
            .contains("请允许改尺寸后再试"));
    }

    #[test]
    fn target_size_compression_resizes_only_when_allowed() {
        let temp = tempdir().expect("temp dir");
        let input_dir = temp.path().join("inputs");
        let output_base = temp.path().join("outputs");
        fs::create_dir_all(&input_dir).expect("input dir");
        let large_png = input_dir.join("large.png");
        create_noisy_png(&large_png, 1800, 1400);

        let report = run_test_task(
            TaskType::Compress,
            &[large_png.to_string_lossy().to_string()],
            &output_base,
            serde_json::json!({
                "recursive": true,
                "outputFormat": "original",
                "quality": 82,
                "minQuality": 35,
                "targetKb": 400,
                "allowResizeToTarget": true
            }),
        );

        assert_eq!(report.success_count, 1);
        let output_path = Path::new(&report.output_dir)
            .join("success")
            .join("large.jpg");
        assert!(output_path.exists());
        let size_kb = fs::metadata(output_path).expect("output metadata").len() / 1024;
        assert!(
            size_kb <= 400,
            "expected <= 400KB compressed output, got {size_kb}KB"
        );
    }

    #[test]
    fn split_removes_grid_lines_and_outputs_square_cells() {
        let temp = tempdir().expect("temp dir");
        let input_dir = temp.path().join("inputs");
        let output_base = temp.path().join("outputs");
        fs::create_dir_all(&input_dir).expect("input dir");
        let grid = input_dir.join("grid.png");
        create_grid_image(&grid, 3, 3, 96, 8, 6);

        let report = run_test_task(
            TaskType::Split,
            &[grid.to_string_lossy().to_string()],
            &output_base,
            serde_json::json!({
                "recursive": true,
                "rows": 3,
                "cols": 3,
                "outputFormat": "png",
                "splitLineMode": "black",
                "splitLineWidth": 8,
                "splitOuterBorder": 6,
                "splitForceSquare": true
            }),
        );

        assert_eq!(report.success_count, 9);
        let first = image::open(
            Path::new(&report.output_dir)
                .join("success")
                .join("grid")
                .join("grid_r1_c1.png"),
        )
        .expect("split image");
        assert_eq!(first.dimensions(), (96, 96));
    }

    #[test]
    fn split_auto_detects_colored_grid_borders() {
        let temp = tempdir().expect("temp dir");
        let input_dir = temp.path().join("inputs");
        let output_base = temp.path().join("outputs");
        fs::create_dir_all(&input_dir).expect("input dir");
        let grid = input_dir.join("colored-grid.png");
        create_grid_image_with_line_color(&grid, 3, 3, 88, 10, 8, [220, 36, 120, 255]);

        let report = run_test_task(
            TaskType::Split,
            &[grid.to_string_lossy().to_string()],
            &output_base,
            serde_json::json!({
                "recursive": true,
                "rows": 3,
                "cols": 3,
                "outputFormat": "png",
                "splitDetectionMode": "auto",
                "splitForceSquare": true
            }),
        );

        assert_eq!(report.success_count, 9);
        let first = image::open(
            Path::new(&report.output_dir)
                .join("success")
                .join("colored-grid")
                .join("colored-grid_r1_c1.png"),
        )
        .expect("split image");
        assert_eq!(first.dimensions(), (88, 88));
    }

    #[test]
    fn default_output_dir_stays_outside_src_tauri() {
        let temp = tempdir().expect("temp dir");
        let workspace_dir = temp.path().join("workspace");
        let src_tauri_dir = workspace_dir.join("src-tauri");
        fs::create_dir_all(&src_tauri_dir).expect("src-tauri dir");

        let output_dir = default_outputs_dir_from(src_tauri_dir).expect("default output dir");

        fs::create_dir_all(&output_dir).expect("output dir");
        assert_eq!(
            output_dir.canonicalize().expect("canonical output"),
            workspace_dir
                .join("outputs")
                .canonicalize()
                .expect("canonical expected output")
        );
    }

    #[test]
    fn ai_results_table_persists_analysis_json() {
        let db = Connection::open_in_memory().expect("db");
        migrate_database(&db).expect("migrate");
        let analysis = serde_json::json!({
            "summary": "素材主体清晰",
            "hook_analysis": { "core_hook": "限时优惠", "score": 8.2 }
        });
        db.execute(
            "insert into ai_results (
                id, task_id, input_path, output_path, model, analysis_json, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                "ai-result-1",
                "task-1",
                "/tmp/input.png",
                "/tmp/report.json",
                "gpt-4.1-mini",
                serde_json::to_string(&analysis).expect("analysis json"),
                Utc::now().to_rfc3339()
            ],
        )
        .expect("insert ai result");

        let stored: String = db
            .query_row(
                "select analysis_json from ai_results where id = ?1",
                params!["ai-result-1"],
                |row| row.get(0),
            )
            .expect("stored analysis");
        let parsed: serde_json::Value = serde_json::from_str(&stored).expect("parse stored");
        assert_eq!(parsed["hook_analysis"]["core_hook"], "限时优惠");
    }

    fn run_test_task(
        task_type: TaskType,
        inputs: &[String],
        output_base: &Path,
        params: serde_json::Value,
    ) -> TaskReport {
        let request = TaskRequest {
            task_type,
            inputs: inputs.to_vec(),
            params,
            output_rule: OutputRule {
                project_name: "phase-1-test".to_string(),
                output_dir: Some(output_base.to_string_lossy().to_string()),
                keep_originals: true,
            },
        };
        let input_paths = expand_input_paths(
            &request.inputs,
            read_bool(&request.params, "recursive", true),
        )
        .expect("inputs");
        let output_dir = resolve_task_output_dir(&request).expect("output dir");
        let report = execute_task(
            None,
            None,
            "test-task",
            &request,
            &input_paths,
            &output_dir,
            None,
        )
        .expect("task");
        write_reports(&output_dir, &report).expect("reports");
        report
    }

    fn create_sample_image(path: &Path, width: u32, height: u32, color: [u8; 4]) {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(width, height, Rgba(color)));
        let format = resolve_output_format(path, "original").expect("format");
        save_image(&image, path, &format, 82).expect("save sample");
    }

    fn create_noisy_png(path: &Path, width: u32, height: u32) {
        let mut image = ImageBuffer::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let red = ((x * 37 + y * 17) % 256) as u8;
            let green = ((x * 11 + y * 53) % 256) as u8;
            let blue = ((x * 91 + y * 7) % 256) as u8;
            *pixel = Rgba([red, green, blue, 255]);
        }
        let image = DynamicImage::ImageRgba8(image);
        save_image(&image, path, &ImageFormat::Png, 82).expect("save noisy png");
    }

    fn create_grid_image(path: &Path, rows: u32, cols: u32, cell: u32, line: u32, border: u32) {
        create_grid_image_with_line_color(path, rows, cols, cell, line, border, [0, 0, 0, 255]);
    }

    fn create_grid_image_with_line_color(
        path: &Path,
        rows: u32,
        cols: u32,
        cell: u32,
        line: u32,
        border: u32,
        line_color: [u8; 4],
    ) {
        let width = cols * cell + (cols - 1) * line + border * 2;
        let height = rows * cell + (rows - 1) * line + border * 2;
        let mut image = ImageBuffer::from_pixel(width, height, Rgba(line_color));

        for row in 0..rows {
            for col in 0..cols {
                let x0 = border + col * (cell + line);
                let y0 = border + row * (cell + line);
                for y in y0..(y0 + cell) {
                    for x in x0..(x0 + cell) {
                        image.put_pixel(
                            x,
                            y,
                            Rgba([(40 + row * 40) as u8, (80 + col * 40) as u8, 180, 255]),
                        );
                    }
                }
            }
        }

        save_image(
            &DynamicImage::ImageRgba8(image),
            path,
            &ImageFormat::Png,
            82,
        )
        .expect("save grid image");
    }
}
