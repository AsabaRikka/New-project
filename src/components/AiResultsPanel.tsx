import { convertFileSrc } from "@tauri-apps/api/core";
import {
  CheckSquare,
  Copy,
  FileJson,
  LayoutGrid,
  List,
  PencilLine,
  RefreshCcw,
  Square,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AiResultRecord } from "../lib/types";

type AiResultSort = "newest" | "score" | "starred" | "favorite";
type LibrarySort = "newest" | "starred" | "source";
type ResultTab = "results" | "copy" | "prompt";
type ResultViewMode = "tile" | "detail";
type ManualCopyMode = "single" | "split";

interface CopyLibraryItem {
  id: string;
  source_result_id: string | null;
  source_path: string | null;
  text: string;
  kind: string;
  starred: boolean;
  created_at: string;
  generated?: boolean;
  multiline?: boolean;
}

interface PromptLibraryItem {
  id: string;
  source_result_id: string | null;
  source_path: string | null;
  prompt: string;
  negative_prompt: string;
  size: string;
  changes: string[];
  starred: boolean;
  created_at: string;
  generated?: boolean;
}

interface PromptLibraryEntry {
  id: string;
  source_result_id: string | null;
  source_path: string | null;
  prompts: PromptLibraryItem[];
  starred: boolean;
  created_at: string;
  generated: boolean;
}

interface AiResultState {
  favorites: string[];
  starred: string[];
  deleted: string[];
  copyLibrary: CopyLibraryItem[];
  promptLibrary: PromptLibraryItem[];
  groups: Record<string, string>;
  labels: Record<string, string>;
}

interface AiResultsPanelProps {
  results: AiResultRecord[];
  onRegenerateFromResult: (result: AiResultRecord, mode: "reverse_prompt") => void;
}

const storageKey = "ad-creative-studio.ai-result-state";

export function AiResultsPanel({ results, onRegenerateFromResult }: AiResultsPanelProps) {
  const [activeTab, setActiveTab] = useState<ResultTab>("results");
  const [resultSort, setResultSort] = useState<AiResultSort>("newest");
  const [librarySort, setLibrarySort] = useState<LibrarySort>("newest");
  const [resultViewMode, setResultViewMode] = useState<ResultViewMode>("tile");
  const [manualCopyMode, setManualCopyMode] = useState<ManualCopyMode>("single");
  const [manualCopy, setManualCopy] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [state, setState] = useState<AiResultState>({
    favorites: [],
    starred: [],
    deleted: [],
    copyLibrary: [],
    promptLibrary: [],
    groups: {},
    labels: {},
  });

  useEffect(() => {
    setState(loadAiResultState());
  }, []);

  useEffect(() => {
    setSelectedIds([]);
  }, [activeTab]);

  const groupOptions = useMemo(() => {
    return Array.from(new Set(Object.values(state.groups).filter(Boolean))).sort((left, right) => left.localeCompare(right));
  }, [state.groups]);

  const visibleResults = useMemo(() => {
    return sortResults(
      results.filter(
        (result) =>
          !state.deleted.includes(result.id) &&
          isAnalysisResult(result) &&
          matchesGroupFilter(result.id, groupFilter, state.groups),
      ),
      resultSort,
      state,
    );
  }, [groupFilter, results, resultSort, state]);

  const generatedCopyLibrary = useMemo(() => {
    return dedupeCopyLibraryItems(
      results
        .filter((result) => !state.deleted.includes(result.id) && isCopyResult(result))
        .flatMap((result) => extractCopyLibraryItems(result, true)),
    );
  }, [results, state.deleted]);

  const generatedPromptLibrary = useMemo(() => {
    return dedupePromptLibraryItems(
      results
        .filter((result) => !state.deleted.includes(result.id) && isVariationResult(result))
        .flatMap((result) => extractPromptItems(result).map((item) => createPromptLibraryItem(item, result, true))),
    );
  }, [results, state.deleted]);

  const generatedPromptEntries = useMemo(() => groupPromptLibraryItems(generatedPromptLibrary), [generatedPromptLibrary]);

  const manualPromptEntries = useMemo(() => state.promptLibrary.map((item) => promptItemToEntry(item)), [state.promptLibrary]);

  const sortedPromptLibrary = useMemo(() => {
    return sortPromptLibrary(
      [...generatedPromptEntries, ...manualPromptEntries].filter((item) => matchesGroupFilter(item.id, groupFilter, state.groups)),
      librarySort,
    );
  }, [generatedPromptEntries, groupFilter, librarySort, manualPromptEntries, state.groups]);

  const sortedCopyLibrary = useMemo(() => {
    return sortCopyLibrary(
      [...generatedCopyLibrary, ...state.copyLibrary].filter((item) => matchesGroupFilter(item.id, groupFilter, state.groups)),
      librarySort,
    );
  }, [generatedCopyLibrary, groupFilter, librarySort, state.copyLibrary, state.groups]);

  function sortCopyLibrary(items: CopyLibraryItem[], sort: LibrarySort) {
    return items.sort((left, right) => {
      if (sort === "starred") {
        return Number(right.starred) - Number(left.starred) || right.created_at.localeCompare(left.created_at);
      }
      if (sort === "source") {
        return (left.source_path ?? "").localeCompare(right.source_path ?? "") || right.created_at.localeCompare(left.created_at);
      }
      return right.created_at.localeCompare(left.created_at);
    });
  }

  function sortPromptLibrary(items: PromptLibraryEntry[], sort: LibrarySort) {
    return items.sort((left, right) => {
      if (sort === "starred") {
        return Number(right.starred) - Number(left.starred) || right.created_at.localeCompare(left.created_at);
      }
      if (sort === "source") {
        return (left.source_path ?? "").localeCompare(right.source_path ?? "") || right.created_at.localeCompare(left.created_at);
      }
      return right.created_at.localeCompare(left.created_at);
    });
  }

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

  function visibleItemIds() {
    if (activeTab === "results") {
      return visibleResults.map((result) => result.id);
    }
    if (activeTab === "copy") {
      return sortedCopyLibrary.map((item) => item.id);
    }
    return sortedPromptLibrary.map((item) => item.id);
  }

  function toggleSelected(itemId: string) {
    setSelectedIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [itemId, ...current],
    );
  }

  function selectVisible() {
    setSelectedIds(visibleItemIds());
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  function renameEntry(entryId: string, currentName: string) {
    const nextName = window.prompt("请输入新的名称，留空可清除", currentName);
    if (nextName === null) {
      return;
    }
    const trimmed = nextName.trim();
    updateState((current) => {
      const labels = { ...current.labels };
      if (trimmed) {
        labels[entryId] = trimmed;
      } else {
        delete labels[entryId];
      }
      return { ...current, labels };
    });
  }

  function applyGroupToSelected() {
    const nextGroup = groupName.trim();
    if (!nextGroup || selectedIds.length === 0) {
      return;
    }
    updateState((current) => {
      const groups = { ...current.groups };
      for (const id of selectedIds) {
        groups[id] = nextGroup;
      }
      return { ...current, groups };
    });
    setGroupFilter(nextGroup);
    setGroupName("");
  }

  function clearSelectedGroup() {
    if (selectedIds.length === 0) {
      return;
    }
    updateState((current) => {
      const groups = { ...current.groups };
      for (const id of selectedIds) {
        delete groups[id];
      }
      return { ...current, groups };
    });
  }

  function addManualCopy() {
    const text = manualCopy.trim();
    if (!text) {
      return;
    }
    const lines = manualCopyMode === "split" ? splitManualCopyLines(text) : [text];
    if (lines.length === 0) {
      return;
    }
    const created = lines.map((line, index) =>
      createCopyLibraryItem(line, manualCopyMode === "split" ? `手动文案 ${index + 1}` : "手动文案", null, false, text.includes("\n")),
    );
    updateState((current) => ({
      ...current,
      copyLibrary: [...created, ...current.copyLibrary].slice(0, 300),
    }));
    setManualCopy("");
    setManualCopyMode("single");
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

  function togglePromptStar(itemId: string) {
    updateState((current) => ({
      ...current,
      promptLibrary: current.promptLibrary.map((item) => (item.id === itemId ? { ...item, starred: !item.starred } : item)),
    }));
  }

  function deletePrompt(itemId: string) {
    updateState((current) => ({
      ...current,
      promptLibrary: current.promptLibrary.filter((item) => item.id !== itemId),
    }));
  }

  function copySelectedCopyItems() {
    const selected = sortedCopyLibrary.filter((item) => selectedIds.includes(item.id));
    if (selected.length === 0) {
      return;
    }
    const copied = new Set<string>();
    const segments: string[] = [];
    for (const item of selected) {
      const segmentKey = item.generated && item.source_result_id ? `group:${item.source_result_id}` : item.id;
      if (copied.has(segmentKey)) {
        continue;
      }
      copied.add(segmentKey);
      segments.push(copyCopyLibrarySegment(item, sortedCopyLibrary));
    }
    copyText(segments.join("\n\n"));
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
          className={activeTab === "prompt" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
          type="button"
          onClick={() => setActiveTab("prompt")}
        >
          裂变提示词库
        </button>
        <button
          className={activeTab === "copy" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
          type="button"
          onClick={() => setActiveTab("copy")}
        >
          文案库
        </button>
      </div>

      <div className="library-bulkbar">
        <div className="library-bulkbar__actions">
          <button className="tiny-button" type="button" onClick={selectVisible} disabled={visibleItemIds().length === 0}>
            <CheckSquare size={14} />
            全选当前
          </button>
          <button className="tiny-button" type="button" onClick={clearSelection} disabled={selectedIds.length === 0}>
            <Square size={14} />
            取消选择
          </button>
          {activeTab === "copy" && (
            <button className="tiny-button" type="button" onClick={copySelectedCopyItems} disabled={selectedIds.length === 0}>
              <Copy size={14} />
              复制选中
            </button>
          )}
          <span>{selectedIds.length} 项已选</span>
        </div>
        <div className="library-groupbar">
          <label>
            <span>分组筛选</span>
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="all">全部</option>
              <option value="ungrouped">未分组</option>
              {groupOptions.map((group) => (
                <option value={group} key={group}>
                  {group}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>分组名</span>
            <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：小游戏爆图" />
          </label>
          <button className="secondary-button" type="button" onClick={applyGroupToSelected} disabled={selectedIds.length === 0 || !groupName.trim()}>
            归入分组
          </button>
          <button className="ghost-button" type="button" onClick={clearSelectedGroup} disabled={selectedIds.length === 0}>
            移出分组
          </button>
        </div>
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
            <div className="segmented-control segmented-control--compact segmented-control--results" aria-label="结果展示方式">
              <button
                className={resultViewMode === "tile" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                type="button"
                onClick={() => setResultViewMode("tile")}
              >
                <LayoutGrid size={14} />
                平铺
              </button>
              <button
                className={resultViewMode === "detail" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                type="button"
                onClick={() => setResultViewMode("detail")}
              >
                <List size={14} />
                详细列表
              </button>
            </div>
            <span className="library-count">{visibleResults.length} 条结果</span>
          </div>

          <div className={resultViewMode === "tile" ? "ai-result-grid ai-result-grid--tile" : "ai-result-grid ai-result-grid--detail"}>
            {visibleResults.length === 0 ? (
              <p className="empty">暂无 AI 分析结果</p>
            ) : (
              visibleResults.map((result) => (
                <ResultCard
                  key={result.id}
                  result={result}
                  layout={resultViewMode}
                  isFavorite={state.favorites.includes(result.id)}
                  isStarred={state.starred.includes(result.id)}
                  isSelected={selectedIds.includes(result.id)}
                  displayName={state.labels[result.id] ?? ""}
                  onToggleSelected={() => toggleSelected(result.id)}
                  onToggleFavorite={() => toggleResultCollection(result.id, "favorites")}
                  onToggleStar={() => toggleResultCollection(result.id, "starred")}
                  onDelete={() => deleteResult(result.id)}
                  onRename={() => renameEntry(result.id, state.labels[result.id] ?? fileName(result.input_path))}
                  onRegenerate={onRegenerateFromResult}
                />
              ))
            )}
          </div>
        </>
      ) : activeTab === "prompt" ? (
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
            <span className="library-count">{sortedPromptLibrary.length} 组裂变提示词</span>
          </div>

          <div className="prompt-library-list">
            {sortedPromptLibrary.length === 0 ? (
              <p className="empty">裂变提示词库为空，可从 AI 分析结果一键入库</p>
            ) : (
              sortedPromptLibrary.map((entry) => (
                <PromptLibraryCard
                  key={entry.id}
                  entry={entry}
                  displayName={state.labels[entry.id] ?? ""}
                  isSelected={selectedIds.includes(entry.id)}
                  onToggleSelected={() => toggleSelected(entry.id)}
                  onRename={() => renameEntry(entry.id, state.labels[entry.id] ?? promptEntryFallbackName(entry))}
                  onToggleStar={() => togglePromptStar(entry.id)}
                  onDelete={() => deletePrompt(entry.id)}
                  onCopy={() => copyPromptEntry(entry)}
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
              <FileJson size={16} />
              入库
            </button>
          </div>

          {manualCopy.trim().includes("\n") && (
            <div className="segmented-control segmented-control--compact segmented-control--copy-mode" aria-label="文案录入方式">
              <button
                className={manualCopyMode === "single" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                type="button"
                onClick={() => setManualCopyMode("single")}
              >
                整体录入
              </button>
              <button
                className={manualCopyMode === "split" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                type="button"
                onClick={() => setManualCopyMode("split")}
              >
                多条录入
              </button>
            </div>
          )}

          <div className="copy-library-list">
            {sortedCopyLibrary.length === 0 ? (
              <p className="empty">文案库为空，可从 AI 分析结果一键入库</p>
            ) : (
              sortedCopyLibrary.map((item) => (
                <article className={item.starred ? "copy-library-card copy-library-card--starred" : "copy-library-card"} key={item.id}>
                  <label className="library-select">
                    <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`选择 ${item.kind}`} />
                  </label>
                  <div>
                    <strong>{item.kind}</strong>
                    <p className={item.multiline || item.text.includes("\n") ? "copy-library-card__text copy-library-card__text--multiline" : "copy-library-card__text"}>{item.text}</p>
                    <span>{item.generated ? "AI 生成" : item.source_path ? fileName(item.source_path) : "手动录入"}</span>
                    {state.groups[item.id] && <span className="library-group-chip">{state.groups[item.id]}</span>}
                  </div>
                  <div className="copy-library-card__actions">
                    <button className="tiny-button" type="button" onClick={() => copyCopyLibraryItem(item, sortedCopyLibrary)}>
                      <Copy size={14} />
                      {item.generated ? "复制全部" : "复制"}
                    </button>
                    {!item.generated && (
                      <>
                        <button className="tiny-button" type="button" onClick={() => toggleCopyStar(item.id)}>
                          <Star size={14} fill={item.starred ? "currentColor" : "none"} />
                          {item.starred ? "已标星" : "标星"}
                        </button>
                        <button className="tiny-button tiny-button--danger" type="button" onClick={() => deleteCopy(item.id)}>
                          <Trash2 size={14} />
                          删除
                        </button>
                      </>
                    )}
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
  layout,
  isFavorite,
  isStarred,
  isSelected,
  displayName,
  onToggleSelected,
  onToggleFavorite,
  onToggleStar,
  onDelete,
  onRename,
  onRegenerate,
}: {
  result: AiResultRecord;
  layout: ResultViewMode;
  isFavorite: boolean;
  isStarred: boolean;
  isSelected: boolean;
  displayName: string;
  onToggleSelected: () => void;
  onToggleFavorite: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onRename: () => void;
  onRegenerate: (result: AiResultRecord, mode: "reverse_prompt") => void;
}) {
  const primaryText = resultPrimaryText(result);
  const title = displayName.trim() || fileName(result.input_path);
  const subtitle = displayName.trim() ? `${fileName(result.input_path)} · ${resultSubtitle(result)}` : resultSubtitle(result);
  return (
    <article className={isStarred ? `ai-result-card ai-result-card--starred ai-result-card--${layout}` : `ai-result-card ai-result-card--${layout}`}>
      {layout === "tile" ? (
        <>
          <div className="ai-result-card__tile-head">
            <label className="library-select">
              <input type="checkbox" checked={isSelected} onChange={onToggleSelected} aria-label={`选择 ${title}`} />
            </label>
            <span className="library-group-chip">{resultScore(result) === "-" ? "未评分" : `评分 ${resultScore(result)}`}</span>
          </div>
          <div className="ai-result-card__thumb ai-result-card__thumb--tile">
            {isImagePath(result.input_path) ? <img src={toAssetUrl(result.input_path)} alt="" loading="lazy" /> : <Sparkles size={30} />}
          </div>
          <div className="ai-result-card__body">
            <div className="ai-result-card__header">
              <Sparkles size={18} />
              <div>
                <strong>{title}</strong>
                <span>{subtitle}</span>
              </div>
            </div>
            <p>{String(result.analysis_json.summary ?? "结果已保存到报告文件")}</p>
            {renderResultItems(result)}
            <div className="ai-result-card__meta">
              <button className="tiny-button" type="button" onClick={() => copyText(primaryText)} disabled={!primaryText}>
                <Copy size={14} />
                复制
              </button>
              <button className="tiny-button" type="button" onClick={onRename}>
                <PencilLine size={14} />
                重命名
              </button>
              <button className="tiny-button" type="button" onClick={onToggleFavorite}>
                <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
                {isFavorite ? "已收藏" : "收藏"}
              </button>
              <button className="tiny-button" type="button" onClick={onToggleStar}>
                <Star size={14} fill={isStarred ? "currentColor" : "none"} />
                {isStarred ? "已标星" : "标星"}
              </button>
              <button className="tiny-button" type="button" onClick={() => onRegenerate(result, "reverse_prompt")}>
                <RefreshCcw size={14} />
                反推重生成
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
        </>
      ) : (
        <>
          <label className="library-select">
            <input type="checkbox" checked={isSelected} onChange={onToggleSelected} aria-label={`选择 ${title}`} />
          </label>
          <div className="ai-result-card__thumb">
            {isImagePath(result.input_path) ? <img src={toAssetUrl(result.input_path)} alt="" loading="lazy" /> : <Sparkles size={30} />}
          </div>
          <div className="ai-result-card__body">
            <div className="ai-result-card__header">
              <Sparkles size={18} />
              <div>
                <strong>{title}</strong>
                <span>{subtitle}</span>
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
              <button className="tiny-button" type="button" onClick={onRename}>
                <PencilLine size={14} />
                重命名
              </button>
              <button className="tiny-button" type="button" onClick={onToggleFavorite}>
                <Star size={14} fill={isFavorite ? "currentColor" : "none"} />
                {isFavorite ? "已收藏" : "收藏"}
              </button>
              <button className="tiny-button" type="button" onClick={onToggleStar}>
                <Star size={14} fill={isStarred ? "currentColor" : "none"} />
                {isStarred ? "已标星" : "标星"}
              </button>
              <button className="tiny-button" type="button" onClick={() => onRegenerate(result, "reverse_prompt")}>
                <RefreshCcw size={14} />
                反推重生成
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
        </>
      )}
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

function createCopyLibraryItem(text: string, kind: string, result: AiResultRecord | null, generated = false, multiline = false): CopyLibraryItem {
  return {
    id: generated && result ? `${result.id}:${kind}:${text}` : crypto.randomUUID(),
    source_result_id: result?.id ?? null,
    source_path: result?.input_path ?? null,
    text,
    kind,
    starred: false,
    created_at: generated && result ? result.created_at : new Date().toISOString(),
    generated,
    multiline,
  };
}

function createPromptLibraryItem(item: Omit<PromptLibraryItem, "id" | "source_result_id" | "source_path" | "starred" | "created_at" | "generated">, result: AiResultRecord | null, generated = false): PromptLibraryItem {
  return {
    id: generated && result ? `${result.id}:prompt:${item.prompt}` : crypto.randomUUID(),
    source_result_id: result?.id ?? null,
    source_path: result?.input_path ?? null,
    prompt: item.prompt,
    negative_prompt: item.negative_prompt,
    size: item.size,
    changes: item.changes,
    starred: false,
    created_at: generated && result ? result.created_at : new Date().toISOString(),
    generated,
  };
}

function extractCopyLibraryItems(result: AiResultRecord, generated = false) {
  const items: CopyLibraryItem[] = [];
  for (const item of result.analysis_json.items ?? []) {
    if (typeof item.main_copy === "string" && item.main_copy.trim()) {
      items.push(createCopyLibraryItem(item.main_copy.trim(), "主文案", result, generated));
    }
    if (typeof item.short_copy === "string" && item.short_copy.trim()) {
      items.push(createCopyLibraryItem(item.short_copy.trim(), "短文案", result, generated));
    }
    if (typeof item.title === "string" && item.title.trim()) {
      items.push(createCopyLibraryItem(item.title.trim(), "广告标题", result, generated));
    }
    if (typeof item.cta === "string" && item.cta.trim()) {
      items.push(createCopyLibraryItem(item.cta.trim(), "CTA", result, generated));
    }
  }
  return dedupeCopyLibraryItems(items);
}

function dedupeCopyLibraryItems(items: CopyLibraryItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source_result_id ?? "manual"}:${item.kind}:${item.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupePromptLibraryItems(items: PromptLibraryItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.source_result_id ?? "manual"}:${item.prompt}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function groupPromptLibraryItems(items: PromptLibraryItem[]): PromptLibraryEntry[] {
  const entries = new Map<string, PromptLibraryEntry>();
  for (const item of items) {
    const key = item.source_result_id ?? item.id;
    const existing = entries.get(key);
    if (existing) {
      existing.prompts.push(item);
      existing.starred = existing.starred || item.starred;
      if (item.created_at > existing.created_at) {
        existing.created_at = item.created_at;
      }
      existing.generated = existing.generated || Boolean(item.generated);
      continue;
    }
    entries.set(key, {
      id: key,
      source_result_id: item.source_result_id,
      source_path: item.source_path,
      prompts: [item],
      starred: item.starred,
      created_at: item.created_at,
      generated: Boolean(item.generated),
    });
  }
  return Array.from(entries.values());
}

function promptItemToEntry(item: PromptLibraryItem): PromptLibraryEntry {
  return {
    id: item.source_result_id ?? item.id,
    source_result_id: item.source_result_id,
    source_path: item.source_path,
    prompts: [item],
    starred: item.starred,
    created_at: item.created_at,
    generated: Boolean(item.generated),
  };
}

function extractPromptItems(result: AiResultRecord) {
  const items: Array<Omit<PromptLibraryItem, "id" | "source_result_id" | "source_path" | "starred" | "created_at">> = [];
  for (const item of result.analysis_json.items ?? []) {
    if (typeof item.prompt !== "string" || !item.prompt.trim()) {
      continue;
    }
    items.push({
      prompt: item.prompt.trim(),
      negative_prompt: typeof item.negative_prompt === "string" ? item.negative_prompt.trim() : "",
      size: typeof item.size === "string" ? item.size.trim() : "",
      changes: Array.isArray(item.changes) ? item.changes.filter((change): change is string => typeof change === "string") : [],
    });
  }
  if (typeof result.analysis_json.extracted_prompt === "string" && result.analysis_json.extracted_prompt.trim()) {
    items.push({
      prompt: result.analysis_json.extracted_prompt.trim(),
      negative_prompt: "",
      size: "",
      changes: ["从素材分析结果提取"],
    });
  }
  for (const prompt of result.analysis_json.prompt_examples ?? []) {
    if (prompt.trim()) {
      items.push({
        prompt: prompt.trim(),
        negative_prompt: "",
        size: "",
        changes: ["提示词示例"],
      });
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.prompt)) {
      return false;
    }
    seen.add(item.prompt);
    return true;
  });
}

function isAnalysisResult(result: AiResultRecord) {
  const type = result.analysis_json.result_type;
  return type !== "ad_copy_generation" && type !== "ad_title_generation" && type !== "creative_variation_prompts";
}

function isCopyResult(result: AiResultRecord) {
  return result.analysis_json.result_type === "ad_copy_generation" || result.analysis_json.result_type === "ad_title_generation";
}

function isVariationResult(result: AiResultRecord) {
  return result.analysis_json.result_type === "creative_variation_prompts";
}

function matchesGroupFilter(itemId: string, filter: string, groups: Record<string, string>) {
  if (filter === "all") {
    return true;
  }
  const group = groups[itemId] ?? "";
  if (filter === "ungrouped") {
    return !group;
  }
  return group === filter;
}

function splitManualCopyLines(text: string) {
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function copyCopyLibrarySegment(item: CopyLibraryItem, items: CopyLibraryItem[]) {
  if (!item.generated || !item.source_result_id) {
    return formatCopyLibraryItemForClipboard(item, 1);
  }
  const group = items.filter((candidate) => candidate.generated && candidate.source_result_id === item.source_result_id);
  return group.map((candidate, index) => formatCopyLibraryItemForClipboard(candidate, index + 1)).join("\n");
}

function formatCopyLibraryItemForClipboard(item: CopyLibraryItem, index: number) {
  return `${index}. [${item.kind}] ${item.text}`;
}

function copyPromptEntry(entry: PromptLibraryEntry) {
  copyText(entry.prompts.map((prompt, index) => formatPromptLibraryItemForClipboard(prompt, index + 1)).join("\n\n"));
}

function formatPromptLibraryItemForClipboard(item: PromptLibraryItem, index: number) {
  const lines = [`${index}. ${item.prompt}`];
  if (item.negative_prompt) {
    lines.push(`Negative: ${item.negative_prompt}`);
  }
  if (item.size) {
    lines.push(`Size: ${item.size}`);
  }
  if (item.changes.length > 0) {
    lines.push(`变化点: ${item.changes.join(" / ")}`);
  }
  return lines.join("\n");
}

function promptEntryFallbackName(entry: PromptLibraryEntry) {
  return entry.source_path ? fileName(entry.source_path) : "裂变提示词";
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

function copyCopyLibraryItem(item: CopyLibraryItem, items: CopyLibraryItem[]) {
  if (!item.generated || !item.source_result_id) {
    copyText(item.text);
    return;
  }
  const group = items.filter((candidate) => candidate.generated && candidate.source_result_id === item.source_result_id);
  copyText(group.map((candidate, index) => formatCopyLibraryItemForClipboard(candidate, index + 1)).join("\n"));
}

function copyPromptLibraryItem(item: PromptLibraryItem, items: PromptLibraryItem[]) {
  if (!item.generated || !item.source_result_id) {
    copyText(item.prompt);
    return;
  }
  const group = items.filter((candidate) => candidate.generated && candidate.source_result_id === item.source_result_id);
  copyText(
    group
      .map((candidate, index) => formatPromptLibraryItemForClipboard(candidate, index + 1))
      .join("\n\n"),
  );
}

function PromptLibraryCard({
  entry,
  displayName,
  isSelected,
  onToggleSelected,
  onRename,
  onToggleStar,
  onDelete,
  onCopy,
}: {
  entry: PromptLibraryEntry;
  displayName: string;
  isSelected: boolean;
  onToggleSelected: () => void;
  onRename: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const title = displayName.trim() || promptEntryFallbackName(entry);
  const subtitle = entry.source_path ? fileName(entry.source_path) : entry.generated ? "AI 裂变生成" : "手动录入";
  return (
    <article className={entry.starred ? "prompt-library-card prompt-library-card--starred" : "prompt-library-card"}>
      <label className="library-select">
        <input type="checkbox" checked={isSelected} onChange={onToggleSelected} aria-label={`选择 ${title}`} />
      </label>
      {entry.source_path && isImagePath(entry.source_path) ? (
        <div className="prompt-library-card__thumb">
          <img src={toAssetUrl(entry.source_path)} alt="" loading="lazy" />
        </div>
      ) : (
        <div className="prompt-library-card__thumb prompt-library-card__thumb--empty">
          <Sparkles size={24} />
        </div>
      )}
      <div className="prompt-library-card__main">
        <div className="prompt-library-card__header">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="prompt-library-card__summary">
          <span className="library-group-chip">{entry.prompts.length} 条</span>
          {entry.generated && <span className="library-group-chip">AI 裂变生成</span>}
        </div>
        <div className="prompt-library-card__group">
          {entry.prompts.map((prompt, index) => (
            <div className="prompt-library-card__entry" key={prompt.id}>
              <strong>
                {index + 1}. {prompt.prompt}
              </strong>
              {prompt.negative_prompt && <span>Negative: {prompt.negative_prompt}</span>}
              {prompt.size && <span>Size: {prompt.size}</span>}
              {prompt.changes.length > 0 && <span>变化点: {prompt.changes.join(" / ")}</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="copy-library-card__actions">
        <button className="tiny-button" type="button" onClick={onCopy}>
          <Copy size={14} />
          复制全部
        </button>
        <button className="tiny-button" type="button" onClick={onRename}>
          <PencilLine size={14} />
          重命名
        </button>
        {!entry.generated && (
          <>
            <button className="tiny-button" type="button" onClick={onToggleStar}>
              <Star size={14} fill={entry.starred ? "currentColor" : "none"} />
              {entry.starred ? "已标星" : "标星"}
            </button>
            <button className="tiny-button tiny-button--danger" type="button" onClick={onDelete}>
              <Trash2 size={14} />
              删除
            </button>
          </>
        )}
      </div>
    </article>
  );
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
  if (value.result_type === "creative_variation_prompts") {
    const prompts = extractPromptItems(result).map((item, index) => {
      const lines = [`${index + 1}. ${item.prompt}`];
      if (item.negative_prompt) {
        lines.push(`Negative: ${item.negative_prompt}`);
      }
      if (item.size) {
        lines.push(`Size: ${item.size}`);
      }
      if (item.changes.length > 0) {
        lines.push(`变化点: ${item.changes.join(" / ")}`);
      }
      return lines.join("\n");
    });
    return prompts.join("\n\n");
  }
  if (value.result_type === "ad_copy_generation" || value.result_type === "ad_title_generation") {
    return extractCopyLibraryItems(result)
      .map((item, index) => `${index + 1}. [${item.kind}] ${item.text}`)
      .join("\n");
  }

  const parts: string[] = [];
  if (typeof value.extracted_prompt === "string" && value.extracted_prompt.trim()) {
    parts.push(`反推提示词\n${value.extracted_prompt.trim()}`);
  }
  const examples = value.prompt_examples?.filter((prompt) => prompt.trim()) ?? [];
  if (examples.length > 0) {
    parts.push(`提示词示例\n${examples.map((prompt, index) => `${index + 1}. ${prompt.trim()}`).join("\n")}`);
  }
  if (parts.length === 0 && typeof value.summary === "string") {
    parts.push(value.summary);
  }
  return parts.join("\n\n");
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
      promptLibrary: Array.isArray(parsed.promptLibrary) ? parsed.promptLibrary.filter(isPromptLibraryItem) : [],
      groups: stringRecord(parsed.groups),
      labels: stringRecord(parsed.labels),
    };
  } catch {
    return {
      favorites: [],
      starred: [],
      deleted: [],
      copyLibrary: [],
      promptLibrary: [],
      groups: {},
      labels: {},
    };
  }
}

function saveAiResultState(state: AiResultState) {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isCopyLibraryItem(value: unknown): value is CopyLibraryItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CopyLibraryItem>;
  return Boolean(candidate.id && candidate.text && candidate.kind && candidate.created_at);
}

function isPromptLibraryItem(value: unknown): value is PromptLibraryItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PromptLibraryItem>;
  return Boolean(candidate.id && candidate.prompt && candidate.created_at);
}
