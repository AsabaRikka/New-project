import { KeyRound, Save } from "lucide-react";
import { useState } from "react";
import { clearApiKey, saveApiKey } from "../lib/api";
import type { AppConfig } from "../lib/types";

interface SettingsPanelProps {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  onSave: () => void;
}

export function SettingsPanel({ config, onChange, onSave }: SettingsPanelProps) {
  const ai = config.ai_provider;
  const [apiKey, setApiKey] = useState("");
  const [secretStatus, setSecretStatus] = useState("");

  async function handleSaveApiKey() {
    const saved = await saveApiKey(apiKey);
    onChange({
      ...config,
      ai_provider: { ...ai, api_key_set: saved },
    });
    setApiKey("");
    setSecretStatus(saved ? "API Key 已保存" : "请输入有效的 API Key");
  }

  async function handleClearApiKey() {
    await clearApiKey();
    onChange({
      ...config,
      ai_provider: { ...ai, api_key_set: false },
    });
    setSecretStatus("API Key 已清除");
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">Phase 0</p>
          <h2>OpenAI API 协议配置</h2>
        </div>
        <button className="icon-button" type="button" onClick={onSave} aria-label="保存配置">
          <Save size={18} />
        </button>
      </div>

      <div className="form-grid">
        <label className="form-grid__full">
          <span>API Key</span>
          <div className="inline-field">
            <input
              type="password"
              value={apiKey}
              placeholder={ai.api_key_set ? "已保存，输入新 Key 可覆盖" : "sk-..."}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <button className="secondary-button" type="button" onClick={handleSaveApiKey}>
              保存 Key
            </button>
            <button className="ghost-button" type="button" onClick={handleClearApiKey}>
              清除
            </button>
          </div>
        </label>

        <label>
          <span>Base URL</span>
          <input
            value={ai.base_url}
            onChange={(event) =>
              onChange({
                ...config,
                ai_provider: { ...ai, base_url: event.target.value },
              })
            }
          />
        </label>

        <label>
          <span>Text Model</span>
          <input
            value={ai.text_model}
            onChange={(event) =>
              onChange({
                ...config,
                ai_provider: { ...ai, text_model: event.target.value },
              })
            }
          />
        </label>

        <label>
          <span>Vision Model</span>
          <input
            value={ai.vision_model}
            onChange={(event) =>
              onChange({
                ...config,
                ai_provider: { ...ai, vision_model: event.target.value },
              })
            }
          />
        </label>

        <label>
          <span>Image Model</span>
          <input
            value={ai.image_model}
            onChange={(event) =>
              onChange({
                ...config,
                ai_provider: { ...ai, image_model: event.target.value },
              })
            }
          />
        </label>

        <label>
          <span>超时秒数</span>
          <input
            type="number"
            min={5}
            value={ai.timeout_seconds}
            onChange={(event) =>
              onChange({
                ...config,
                ai_provider: { ...ai, timeout_seconds: Number(event.target.value) },
              })
            }
          />
        </label>

        <label>
          <span>最大重试</span>
          <input
            type="number"
            min={0}
            max={5}
            value={ai.max_retries}
            onChange={(event) =>
              onChange({
                ...config,
                ai_provider: { ...ai, max_retries: Number(event.target.value) },
              })
            }
          />
        </label>
      </div>

      <div className="status-line">
        <KeyRound size={16} />
        <span>{secretStatus || (ai.api_key_set ? "API Key 已保存到本机密钥存储" : "API Key 尚未配置")}</span>
      </div>
    </section>
  );
}
