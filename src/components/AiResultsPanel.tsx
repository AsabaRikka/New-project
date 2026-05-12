import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Copy,
  FileJson,
  ImagePlus,
  RefreshCcw,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AiResultRecord } from "../lib/types";

type AiResultSort = "newest" | "score" | "starred" | "favorite";
type LibrarySort = "newest" | "starred" | "source";
type ResultTab = "results" | "copy";

interface CopyLibraryItem {
  id: string;
  source_result_id: string | null;
  source_path: string | null;
  text: string;
  kind: string;
  starred: boolean;
  created_at: string;
}

interface AiResultState {
  favorites: string[];
  starred: string[];
  deleted: string[];
  copyLibrary: CopyLibraryItem[];
}

interface AiResultsPanelProps {
  results: AiResultRecord[];
  onRegenerateFromResult: (result: AiResultRecord, mode: "reverse_prompt" | "prompt_template") => void;
}

const storageKey = "ad-creative-studio.ai-result-state";

export function AiResultsPanel({ results, onRegenerateFromResult }: AiResultsPanelProps) {
  const [activeTab, setActiveTab] = useState<ResultTab>("results");
  const [resultSort, setResultSort] = useState<AiResultSort>("newest");
  const [librarySort, setLibrarySort] = useState<LibrarySort>("newest");
  const [manualCopy, setManualCopy] = useState("");
  const [state, setState] = useState<AiResultState>({
    favorites: [],
    starred: [],
    deleted: [],
    copyLibrary: [],
  });

  useEffect(() => {
    setState(loadAiResultState());
  }, []);

  const visibleResults = useMemo(() => {
    return sortResults(
      results.filter((result) => !state.deleted.includes(result.id)),
      resultSort,
      state,
    );
  }, [results, resultSort, state]);

  const sortedCopyLibrary = useMemo(() => {
    return [...state.copyLibrary].sort((left, right) => {
      if (librarySort === "starred") {
        return Number(right.starred) - Number(left.starred) || right.created_at.localeCompare(left.created_at);
      }
      if (librarySort === "source") {
        return (left.source_path ?? "").localeCompare(right.source_path ?? "") || right.created_at.localeCompare(left.created_at);
      }
      return right.created_at.localeCompare(left.created_at);
    });
  }, [librarySort, state.copyLibrary]);

  function updateState(updater: (current: AiResultState) => AiResultState) {
    setState((current) => {
      const next = updater(current);
      saveAiResultState(next);
      return next;
    });
  }

  function toggleResultCollection(resultId: string, field: "favorites" | "starred") {
    updateState((current) => ({
      ...current,
      [field]: current[field].includes(resultId)
        ? current[field].filter((id) => id !== resultId)
        : [resultId, ...current[field]],
    }));
  }

  function deleteResult(resultId: string) {
    updateState((current) => ({
      ...current,
      deleted: current.deleted.includes(resultId) ? current.deleted : [resultId, ...current.deleted],
    }));
  }

  function addResultToCopyLibrary(result: AiResultRecord) {
    const texts = extractCopyTexts(result);
    if (texts.length === 0) {
      return;
    }

    updateState((current) => {
      const existingTexts = new Set(current.copyLibrary.map((item) => `${item.source_result_id ?? "manual"}:${item.text}`));
      const nextItems = texts
        .filter((text) => !existingTexts.has(`${result.id}:${text}`))
        .map((text) => createCopyLibraryItem(text, result));
      return {
        ...current,
        copyLibrary: [...nextItems, ...current.copyLibrary].slice(0, 300),
      };
    });
  }

  function addManualCopy() {
    const text = manualCopy.trim();
    if (!text) {
      return;
    }
    updateState((current) => ({
      ...current,
      copyLibrary: [createCopyLibraryItem(text, null), ...current.copyLibrary].slice(0, 300),
    }));
    setManualCopy("");
  }

  function toggleCopyStar(itemId: string) {
    updateState((current) => ({
      ...current,
      copyLibrary: current.copyLibrary.map((item) => (item.id === itemId ? { ...item, starred: !item.starred } : item)),
    }));
  }

  function deleteCopy(itemId: string) {
    updateState((current) => ({
      ...current,
      copyLibrary: current.copyLibrary.filter((item) => item.id !== itemId),
    }));
  }

  return (
    <section className="panel panel--wide">
      <div className="panel__header">
        <div>
          <p className="eyebrow">AI Library</p>
          <h2>AI 分析结果 / 文案库</h2>
        </div>
      </div>

      <div className="segmented-control segmented-control--compact" aria-label="AI 结果库">
        <button
          className={activeTab === "results" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
          type="button"
          onClick={() => setActiveTab("results")}
        >
          分析结果
        </button>
        <button
          className={activeTab === "copy" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
          type="button"
          onClick={() => setActiveTab("copy")}
        >
          文案库
        </button>
      </div>

      {activeTab === "results" ? (
        <>
          <div className="library-toolbar">
            <label>
              <span>排序</span>
              <select value={resultSort} onChange={(event) => setResultSort(event.target.value as AiResultSort)}>
                <option value="newest">最新生成</option>
                <option value="score">评分最高</option>
                <option value="starred">标星优先</option>
                <option value="favorite">收藏优先</option>
              </select>
            </label>
            <span className="library-count">{visibleResults.length} 条结果</span>
          </div>

          <div className="ai-result-grid">
            {visibleResults.length === 0 ? (
              <p className="empty">暂无 AI 分析结果</p>
            ) : (
              visibleResults.map((result) => (
                <ResultCard
                  key={result.id}
                  result={result}
                  isFavorite={state.favorites.includes(result.id)}
                  isStarred={state.starred.includes(result.id)}
                  onToggleFavorite={() => toggleResultCollection(result.id, "favorites")}
                  onToggleStar={() => toggleResultCollection(result.id, "starred")}
                  onDelete={() => deleteResult(result.id)}
                  onCopyToLibrary={() => addResultToCopyLibrary(result)}
                  onRegenerate={onRegenerateFromResult}
                />
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="library-toolbar">
            <label>
              <span>排序</span>
              <select value={librarySort} onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}>
                <option value="newest">最新入库</option>
                <option value="starred">标星优先</option>
                <option value="source">来源图片</option>
              </select>
            </label>
            <span className="library-count">{sortedCopyLibrary.length} 条文案</span>
          </div>

          <div className="copy-library-add">
            <textarea value={manualCopy} onChange={(event) => setManualCopy(event.target.value)} placeholder="手动录入一条文案、标题或 CTA" />
            <button className="secondary-button" type="button" onClick={addManualCopy}>
              <ImagePlus size={16} />
              入库
            </button>
          </div>

          <div className="copy-library-list">
            {sortedCopyLibrary.length === 0 ? (
              <p className="empty">文案库为空，可从 AI 分析结果一键入库</p>
            ) : (
              sortedCopyLibrary.map((item) => (
                <article className={item.starred ? "copy-library-card copy-library-card--starred" : "copy-library-card"} key={item.id}>
                  <div>
                    <strong>{item.kind}</strong>
                    <p>{item.text}</p>
                    <span>{item.source_path ? fileName(item.source_path) : "手动录入"}</span>
                  </div>
                  <div className="copy-library-card__actions">
                    <button className="tiny-button" type="button" onClick={() => copyText(item.text)}>
                      <Copy size={14} />
                      复制
                    </button>
                    <button className="tiny-button" type="button" onClick={() => toggleCopyStar(item.id)}>
                      <Star size={14} fill={item.starred ? "currentColor" : "none"} />
                      {item.starred ? "已标星" : "标星"}
                    </button>
                    <button className="tiny-button tiny-button--danger" type="button" onClick={() => deleteCopy(item.id)}>
                      <Trash2 size={14} />
                      删除
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ResultCard({
  result,
  isFavorite,
  isStarred,
  onToggleFavorite,
  onToggleStar,
  onDelete,
  onCopyToLibrary,
  onRegenerate,
}: {
  result: AiResultRecord;
  isFavorite: boolean;
  isStarred: boolean;
  onToggleFavorite: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onCopyToLibrary: () => void;
  onRegenerate: (result: AiResultRecord, mode: "reverse_prompt" | "prompt_template") => void;
}) {
  const primaryText = resultPrimaryText(result);
  const copyTexts = extractCopyTexts(result);
  return (
    <article className={isStarred ? "ai-result-card ai-result-card--starred" : "ai-result-card"}>
      <div className="ai-result-card__thumb">
        {isImagePath(result.input_path) ? <img src={toAssetUrl(result.input_path)} alt="" loading="lazy" /> : <Sparkles size={30} />}
      </div>
      <div className="ai-result-card__body">
        <div className="ai-result-card__header">
          <Sparkles size={18} />
          <div>
            <strong>{fileName(result.input_path)}</strong>
            <span>{resultSubtitle(result)}</span>
          </div>
        </div>
        <p>{String(result.analysis_json.summary ?? "结果已保存到报告文件")}</p>
        {renderResultItems(result)}
        <div className="ai-result-card__meta">
          <span>评分 {resultScore(result)}</span>
          <button className="tiny-button" type="button" onClick={() => copyText(primaryText)} disabled={!primaryText}>
            <Copy size={14} />
            复制
          </button>
          <button className="tiny-button" type="button" onClick={onToggleFavorite}>
            <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
            {isFavorite ? "已收藏" : "收藏"}
          </button>
          <button className="tiny-button" type="button" onClick={onToggleStar}>
            <Star size={14} fill={isStarred ? "currentColor" : "none"} />
            {isStarred ? "已标星" : "标星"}
          </button>
          <button className="tiny-button" type="button" onClick={onCopyToLibrary} disabled={copyTexts.length === 0}>
            <ImagePlus size={14} />
            入文案库
          </button>
          <button className="tiny-button" type="button" onClick={() => onRegenerate(result, "reverse_prompt")}>
            <RefreshCcw size={14} />
            反推重生成
          </button>
          <button className="tiny-button" type="button" onClick={() => onRegenerate(result, "prompt_template")}>
            <RefreshCcw size={14} />
            模板重生成
          </button>
          <button className="tiny-button tiny-button--danger" type="button" onClick={onDelete}>
            <Trash2 size={14} />
            删除
          </button>
          {result.output_path && (
            <span className="ai-result-card__path">
              <FileJson size={14} />
              {fileName(result.output_path)}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function sortResults(results: AiResultRecord[], sort: AiResultSort, state: AiResultState) {
  return [...results].sort((left, right) => {
    if (sort === "score") {
      return numericScore(right) - numericScore(left) || right.created_at.localeCompare(left.created_at);
    }
    if (sort === "starred") {
      return Number(state.starred.includes(right.id)) - Number(state.starred.includes(left.id)) || right.created_at.localeCompare(left.created_at);
    }
    if (sort === "favorite") {
      return Number(state.favorites.includes(right.id)) - Number(state.favorites.includes(left.id)) || right.created_at.localeCompare(left.created_at);
    }
    return right.created_at.localeCompare(left.created_at);
  });
}

function createCopyLibraryItem(text: string, result: AiResultRecord | null): CopyLibraryItem {
  return {
    id: crypto.randomUUID(),
    source_result_id: result?.id ?? null,
    source_path: result?.input_path ?? null,
    text,
    kind: result ? copyKind(result) : "手动文案",
    starred: false,
    created_at: new Date().toISOString(),
  };
}

function extractCopyTexts(result: AiResultRecord) {
  const texts = new Set<string>();
  for (const item of result.analysis_json.items ?? []) {
    for (const key of ["main_copy", "short_copy", "title", "cta", "angle", "prompt"]) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) {
        texts.add(value.trim());
      }
    }
  }
  if (typeof result.analysis_json.extracted_prompt === "string") {
    texts.add(result.analysis_json.extracted_prompt.trim());
  }
  for (const prompt of result.analysis_json.prompt_examples ?? []) {
    if (prompt.trim()) {
      texts.add(prompt.trim());
    }
  }
  return [...texts].filter(Boolean);
}

function copyKind(result: AiResultRecord) {
  if (result.analysis_json.result_type === "ad_copy_generation") {
    return "广告文案";
  }
  if (result.analysis_json.result_type === "ad_title_generation") {
    return "广告标题";
  }
  if (result.analysis_json.result_type === "creative_variation_prompts") {
    return "裂变提示词";
  }
  return "分析提示词";
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function copyText(text: string) {
  if (!text) {
    return;
  }
  void navigator.clipboard.writeText(text);
}

function resultSubtitle(result: AiResultRecord) {
  const value = result.analysis_json;
  if (value.result_type === "creative_variation_prompts") {
    return "创意裂变提示词已生成";
  }
  if (value.result_type === "ad_copy_generation") {
    return "广告文案已生成";
  }
  if (value.result_type === "ad_title_generation") {
    return "广告标题已生成";
  }
  return value.hook_analysis?.core_hook ?? "已生成广告素材分析";
}

function resultScore(result: AiResultRecord) {
  const score = numericScore(result);
  return Number.isFinite(score) && score > 0 ? score : "-";
}

function numericScore(result: AiResultRecord) {
  const first = result.analysis_json.items?.[0];
  if (typeof first?.score === "number") {
    return first.score;
  }
  return result.analysis_json.hook_analysis?.score ?? 0;
}

function resultPrimaryText(result: AiResultRecord) {
  const value = result.analysis_json;
  const first = value.items?.[0];
  if (typeof first?.prompt === "string") {
    return first.prompt;
  }
  if (typeof first?.main_copy === "string") {
    return first.main_copy;
  }
  if (typeof first?.title === "string") {
    return first.title;
  }
  return value.extracted_prompt ?? "";
}

function renderResultItems(result: AiResultRecord) {
  const items = result.analysis_json.items?.slice(0, 4) ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="ai-result-items">
      {items.map((item, index) => (
        <div className="ai-result-item" key={index}>
          <strong>{itemTitle(item, index)}</strong>
          <span>{itemBody(item)}</span>
        </div>
      ))}
    </div>
  );
}

function itemTitle(item: Record<string, unknown>, index: number) {
  if (typeof item.title === "string") {
    return item.title;
  }
  if (typeof item.variation_type === "string") {
    return item.variation_type;
  }
  if (typeof item.cta === "string") {
    return item.cta;
  }
  return `方案 ${index + 1}`;
}

function itemBody(item: Record<string, unknown>) {
  if (typeof item.prompt === "string") {
    return item.prompt;
  }
  if (typeof item.main_copy === "string") {
    return item.main_copy;
  }
  if (typeof item.angle === "string") {
    return item.angle;
  }
  if (typeof item.short_copy === "string") {
    return item.short_copy;
  }
  return "";
}

function isImagePath(path: string) {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(path);
}

function toAssetUrl(path: string) {
  if ("__TAURI_INTERNALS__" in window) {
    return convertFileSrc(path);
  }

  return `file://${path}`;
}

function loadAiResultState(): AiResultState {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      favorites: stringArray(parsed.favorites),
      starred: stringArray(parsed.starred),
      deleted: stringArray(parsed.deleted),
      copyLibrary: Array.isArray(parsed.copyLibrary) ? parsed.copyLibrary.filter(isCopyLibraryItem) : [],
    };
  } catch {
    return {
      favorites: [],
      starred: [],
      deleted: [],
      copyLibrary: [],
    };
  }
}

function saveAiResultState(state: AiResultState) {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isCopyLibraryItem(value: unknown): value is CopyLibraryItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CopyLibraryItem>;
  return Boolean(candidate.id && candidate.text && candidate.kind && candidate.created_at);
}
