import { Copy, FileJson, Sparkles } from "lucide-react";
import type { AiResultRecord } from "../lib/types";

interface AiResultsPanelProps {
  results: AiResultRecord[];
}

export function AiResultsPanel({ results }: AiResultsPanelProps) {
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
          results.slice(0, 5).map((result) => (
            <article className="ai-result-card" key={result.id}>
              <div className="ai-result-card__header">
                <Sparkles size={18} />
                <div>
                  <strong>{fileName(result.input_path)}</strong>
                  <span>
                    {result.analysis_json.hook_analysis?.core_hook ?? "已生成广告素材分析"}
                  </span>
                </div>
              </div>
              <p>{result.analysis_json.summary ?? "分析结果已保存到报告文件"}</p>
              <div className="ai-result-card__meta">
                <span>评分 {result.analysis_json.hook_analysis?.score ?? "-"}</span>
                <button
                  className="tiny-button"
                  type="button"
                  onClick={() => copyText(result.analysis_json.extracted_prompt ?? "")}
                  disabled={!result.analysis_json.extracted_prompt}
                >
                  <Copy size={14} />
                  复制提示词
                </button>
                {result.output_path && (
                  <span className="ai-result-card__path">
                    <FileJson size={14} />
                    {fileName(result.output_path)}
                  </span>
                )}
              </div>
            </article>
          ))
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
