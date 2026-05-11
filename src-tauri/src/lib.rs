use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
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
    created_at: String,
    updated_at: String,
}

struct AppState {
    db: Mutex<Connection>,
    config_path: PathBuf,
}

const KEYRING_SERVICE: &str = "com.adcreativestudio.desktop";
const KEYRING_USER: &str = "openai-api-key";
const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

#[tauri::command]
fn get_app_config(state: tauri::State<'_, AppState>) -> AppResult<AppConfig> {
    read_config(&state.config_path)
}

#[tauri::command]
fn save_app_config(config: AppConfig, state: tauri::State<'_, AppState>) -> AppResult<AppConfig> {
    fs::write(&state.config_path, serde_json::to_string_pretty(&config)?)?;
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
        Ok(()) | Err(keyring::Error::NoEntry) => {}
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
    let input_paths = expand_input_paths(&request.inputs, read_bool(&request.params, "recursive", true))?;
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
                output_dir, params_json, created_at, updated_at
            ) values (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, ?7, ?8)",
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
        &state,
        &id,
        &TaskStatus::Running,
        0,
        0,
        Some(&output_dir_string),
    )?;

    match execute_task(&id, &request, &input_paths, &output_dir) {
        Ok(mut report) => {
            report.status = if report.failed_count > 0 {
                TaskStatus::Failed
            } else {
                TaskStatus::Completed
            };
            write_reports(&output_dir, &report)?;
            update_task_status(
                &state,
                &id,
                &report.status,
                report.success_count,
                report.failed_count,
                Some(&report.output_dir),
            )?;

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
                &state,
                &id,
                &TaskStatus::Failed,
                0,
                input_count,
                Some(&output_dir_string),
            )?;

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

fn update_task_status(
    state: &tauri::State<'_, AppState>,
    task_id: &str,
    status: &TaskStatus,
    success_count: u32,
    failed_count: u32,
    output_dir: Option<&str>,
) -> AppResult<()> {
    let status_json = serde_json::to_string(status)?;
    let now = Utc::now().to_rfc3339();
    let db = state.db.lock().expect("database mutex poisoned");
    db.execute(
        "update tasks
        set status = ?1, success_count = ?2, failed_count = ?3, output_dir = ?4, updated_at = ?5
        where id = ?6",
        params![status_json, success_count, failed_count, output_dir, now, task_id],
    )?;

    Ok(())
}

fn execute_task(
    task_id: &str,
    request: &TaskRequest,
    input_paths: &[PathBuf],
    output_dir: &Path,
) -> AppResult<TaskReport> {
    let success_dir = output_dir.join("success");
    let failed_dir = output_dir.join("failed");
    let report_dir = output_dir.join("report");
    fs::create_dir_all(&success_dir)?;
    fs::create_dir_all(&failed_dir)?;
    fs::create_dir_all(&report_dir)?;

    let mut files = match request.task_type {
        TaskType::Rename => process_rename(input_paths, &success_dir, &request.params)?,
        TaskType::Resize => process_resize(input_paths, &success_dir, &request.params)?,
        TaskType::Compress | TaskType::Convert => {
            process_compress_convert(input_paths, &success_dir, &request.params)?
        }
        TaskType::Split => process_split(input_paths, &success_dir, &request.params)?,
        TaskType::Stitch => process_stitch(input_paths, &success_dir, &request.params)?,
        TaskType::Organize => process_organize(input_paths, &success_dir)?,
        _ => {
            return Err(AppError::InvalidParams(
                "Phase 1 only supports local image batch tasks".to_string(),
            ));
        }
    };

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

fn process_rename(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
) -> AppResult<Vec<FileResult>> {
    let prefix = read_string(params, "prefix", "image");
    let suffix = read_string(params, "suffix", "");
    let start_index = read_u32(params, "startIndex", 1);
    let padding = read_usize(params, "padding", 3);
    let sorted = sort_paths(input_paths, &read_string(params, "sortBy", "input"));

    Ok(sorted
        .iter()
        .enumerate()
        .map(|(position, input)| {
            let extension = normalized_extension(input).unwrap_or_else(|| "jpg".to_string());
            let index = start_index + position as u32;
            let filename = format!("{prefix}_{index:0padding$}{suffix}.{extension}");
            let output_path = unique_path(&output_dir.join(filename));
            copy_file(input, &output_path)
        })
        .collect())
}

fn process_resize(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
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
        let result = (|| -> AppResult<FileResult> {
            let image = image::open(input)?;
            let resized = resize_image(&image, &mode, &fit, width, height, percent, allow_upscale);
            let format = resolve_output_format(input, &output_format)?;
            let output_path = unique_path(&output_dir.join(format_output_name(input, None, &format)));
            save_image(&resized, &output_path, &format, quality)?;
            Ok(success_result(input, &output_path))
        })();
        results.push(result.unwrap_or_else(|error| failed_result(input, error)));
    }

    Ok(results)
}

fn process_compress_convert(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
) -> AppResult<Vec<FileResult>> {
    let output_format = read_string(params, "outputFormat", "original");
    let quality = read_u8(params, "quality", 82);
    let target_kb = read_optional_u64(params, "targetKb");
    let min_quality = read_u8(params, "minQuality", 45);
    let mut results = Vec::new();

    for input in input_paths {
        let result = (|| -> AppResult<FileResult> {
            let image = image::open(input)?;
            let format = resolve_output_format(input, &output_format)?;
            let output_path = unique_path(&output_dir.join(format_output_name(input, None, &format)));
            if let Some(target_kb) = target_kb {
                save_image_to_target_size(&image, &output_path, &format, quality, min_quality, target_kb)?;
            } else {
                save_image(&image, &output_path, &format, quality)?;
            }
            Ok(success_result(input, &output_path))
        })();
        results.push(result.unwrap_or_else(|error| failed_result(input, error)));
    }

    Ok(results)
}

fn process_split(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
) -> AppResult<Vec<FileResult>> {
    let rows = read_u32(params, "rows", 3).max(1);
    let cols = read_u32(params, "cols", 3).max(1);
    let output_format = read_string(params, "outputFormat", "original");
    let quality = read_u8(params, "quality", 82);
    let mut results = Vec::new();

    for input in input_paths {
        let result = (|| -> AppResult<Vec<FileResult>> {
            let image = image::open(input)?;
            let format = resolve_output_format(input, &output_format)?;
            let stem = file_stem(input);
            let image_dir = output_dir.join(&stem);
            fs::create_dir_all(&image_dir)?;
            let (width, height) = image.dimensions();
            let mut file_results = Vec::new();

            for row in 0..rows {
                for col in 0..cols {
                    let x = col * width / cols;
                    let y = row * height / rows;
                    let next_x = if col + 1 == cols { width } else { (col + 1) * width / cols };
                    let next_y = if row + 1 == rows { height } else { (row + 1) * height / rows };
                    let cropped = image.crop_imm(x, y, next_x - x, next_y - y);
                    let filename = format!(
                        "{}_r{}_c{}.{}",
                        stem,
                        row + 1,
                        col + 1,
                        extension_for_format(&format)
                    );
                    let output_path = unique_path(&image_dir.join(filename));
                    save_image(&cropped, &output_path, &format, quality)?;
                    file_results.push(success_result(input, &output_path));
                }
            }

            Ok(file_results)
        })();
        match result {
            Ok(mut file_results) => results.append(&mut file_results),
            Err(error) => results.push(failed_result(input, error)),
        }
    }

    Ok(results)
}

fn process_stitch(
    input_paths: &[PathBuf],
    output_dir: &Path,
    params: &serde_json::Value,
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
        results.push(result.unwrap_or_else(|error| FileResult {
            input_path: chunk
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(";"),
            output_path: None,
            status: "failed".to_string(),
            error: Some(error.to_string()),
        }));
    }

    Ok(results)
}

fn process_organize(input_paths: &[PathBuf], output_dir: &Path) -> AppResult<Vec<FileResult>> {
    Ok(input_paths
        .iter()
        .map(|input| {
            let extension = normalized_extension(input).unwrap_or_else(|| "unknown".to_string());
            let target_dir = output_dir.join(extension);
            if let Err(error) = fs::create_dir_all(&target_dir) {
                return failed_result(input, error.into());
            }
            let output_path = unique_path(&target_dir.join(file_name(input)));
            copy_file(input, &output_path)
        })
        .collect())
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
        _ => std::env::current_dir()?.join("outputs"),
    };
    let timestamp = Utc::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let project_name = sanitize_segment(&request.output_rule.project_name);
    let task_type = format!("{:?}", request.task_type).to_lowercase();
    Ok(base_dir.join(project_name).join(task_type).join(timestamp))
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
            ((original_width as f32 * ratio).round().max(1.0) as u32, height.max(1))
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
            (width.max(1), (original_height as f32 * ratio).round().max(1.0) as u32)
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
) -> AppResult<()> {
    let mut current_quality = quality;
    loop {
        save_image(image, output_path, format, current_quality)?;
        let size_kb = fs::metadata(output_path)?.len() / 1024;
        if size_kb <= target_kb
            || current_quality <= min_quality
            || !matches!(format, ImageFormat::Jpeg)
        {
            break;
        }
        current_quality = current_quality.saturating_sub(8).max(min_quality);
    }

    Ok(())
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
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("file");
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
    sanitize_segment(path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("image"))
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
    params.get(key).and_then(|value| value.as_bool()).unwrap_or(default)
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
        fs::write(&config_path, serde_json::to_string_pretty(&AppConfig::default())?)?;
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
            created_at text not null,
            updated_at text not null
        );

        create index if not exists idx_tasks_created_at on tasks(created_at);
        ",
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
        assert!(Path::new(&rename.output_dir).join("success").join("ad_03.png").exists());

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
        assert!(Path::new(&convert.output_dir).join("success").join("one.jpg").exists());

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
        assert!(
            Path::new(&split.output_dir)
                .join("success")
                .join("one")
                .join("one_r2_c3.png")
                .exists()
        );

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
        assert!(Path::new(&organize.output_dir).join("success").join("png").join("one.png").exists());
        assert!(Path::new(&organize.output_dir).join("report").join("report.json").exists());
        assert!(Path::new(&organize.output_dir).join("report").join("report.csv").exists());
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
        let input_paths =
            expand_input_paths(&request.inputs, read_bool(&request.params, "recursive", true))
                .expect("inputs");
        let output_dir = resolve_task_output_dir(&request).expect("output dir");
        let report = execute_task("test-task", &request, &input_paths, &output_dir).expect("task");
        write_reports(&output_dir, &report).expect("reports");
        report
    }

    fn create_sample_image(path: &Path, width: u32, height: u32, color: [u8; 4]) {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(width, height, Rgba(color)));
        let format = resolve_output_format(path, "original").expect("format");
        save_image(&image, path, &format, 82).expect("save sample");
    }
}
