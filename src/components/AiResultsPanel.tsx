import { Copy, FileJson, Sparkles, Star } from "lucide-react";
import { useEffect, useState } from "react";
import type { AiResultRecord } from "../lib/types";

interface AiResultsPanelProps {
  results: AiResultRecord[];
}

export function AiResultsPanel({ results }: AiResultsPanelProps) {
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    setFavorites(loadPromptFavorites());
  }, []);

  function toggleFavorite(prompt: string) {
    if (!prompt) {
      return;
    }
    const next = favorites.includes(prompt)
      ? favorites.filter((item) => item !== prompt)
      : [prompt, ...favorites].slice(0, 80);
    setFavorites(next);
    savePromptFavorites(next);
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">Phase 2</p>
          <h2>AI 分析结果</h2>
        </div>
      </div>

      <div className="ai-result-list">
        {results.length === 0 ? (
          <p className="empty">暂无 AI 分析结果</p>
        ) : (
          results.slice(0, 8).map((result) => {
            const primaryText = resultPrimaryText(result);
            const variationPrompt = firstVariationPrompt(result);
            return (
              <article className="ai-result-card" key={result.id}>
                <div className="ai-result-card__header">
                  <Sparkles size={18} />
                  <div>
                    <strong>{fileName(result.input_path)}</strong>
                    <span>{resultSubtitle(result)}</span>
                  </div>
                </div>
                <p>{result.analysis_json.summary ?? "结果已保存到报告文件"}</p>
                {renderResultItems(result)}
                <div className="ai-result-card__meta">
                  <span>评分 {resultScore(result)}</span>
                  <button className="tiny-button" type="button" onClick={() => copyText(primaryText)} disabled={!primaryText}>
                    <Copy size={14} />
                    复制结果
                  </button>
                  {variationPrompt && (
                    <button className="tiny-button" type="button" onClick={() => toggleFavorite(variationPrompt)}>
                      <Star size={14} />
                      {favorites.includes(variationPrompt) ? "已收藏" : "收藏提示词"}
                    </button>
                  )}
                  {result.output_path && (
                    <span className="ai-result-card__path">
                      <FileJson size={14} />
                      {fileName(result.output_path)}
                    </span>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
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
  const first = result.analysis_json.items?.[0];
  if (typeof first?.score === "number") {
    return first.score;
  }
  return result.analysis_json.hook_analysis?.score ?? "-";
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

function firstVariationPrompt(result: AiResultRecord) {
  const first = result.analysis_json.items?.[0];
  return typeof first?.prompt === "string" ? first.prompt : "";
}

function renderResultItems(result: AiResultRecord) {
  const items = result.analysis_json.items?.slice(0, 3) ?? [];
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
  return "";
}

function loadPromptFavorites() {
  try {
    const raw = window.localStorage.getItem("ad-creative-studio.favorite-prompts");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function savePromptFavorites(favorites: string[]) {
  window.localStorage.setItem("ad-creative-studio.favorite-prompts", JSON.stringify(favorites));
}
