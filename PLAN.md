# 广告素材 AI 桌面工具 Phase 规划

## Summary
产品做成 **macOS + Windows 跨平台桌面端**，V1 不做账号系统，云端 AI 暂定使用 **OpenAI API 协议兼容层**。默认接入 OpenAI 官方接口，同时保留 `baseURL + apiKey + model` 配置，后续可切换到其他兼容 OpenAI 协议的服务。

技术主线：**Tauri 2 + React/TypeScript + Rust + SQLite + OpenAI API 协议 + ONNX Runtime 本地模型**。

## Phase 0: 基础架构与 API 协议层
- 搭建 Tauri 2 桌面项目，支持 macOS + Windows。
- 建立 React/TypeScript 前端、Rust 本地命令层、SQLite 本地数据库。
- 定义统一任务协议：`TaskRequest`、`TaskResult`、`TaskStatus`。
- 建立 AI Provider 适配层，默认使用 OpenAI API 协议。
- 本地配置支持：
  - `provider`
  - `baseURL`
  - `apiKey`
  - `textModel`
  - `visionModel`
  - `imageModel`
  - `timeout`
  - `maxRetries`
- API Key 只在本机加密保存。
- 默认 `baseURL` 为 `https://api.openai.com/v1`。
- 文本、视觉分析、对话任务优先使用 Responses API。
- 图片生成、Logo、图片编辑优先使用 Images API。
- 保留 `chat.completions` fallback adapter，用于兼容第三方 OpenAI-compatible 服务。

## Phase 1: 图片批量基础工具
- 实现图片重命名、改尺寸、压缩、格式转换。
- 实现图片切分：支持 `3x3`、`2x2`、`2x3` 等网格。
- 实现图片拼接：支持 `3x3`、`2x2`、`2x3` 等网格。
- 实现处理后图片文件夹整理。
- 建立任务中心，展示进度、成功数、失败数、输出路径、错误原因。
- 所有批量工具先通过参数模式运行，不依赖 AI。

## Phase 2: OpenAI 协议广告素材分析
- 接入视觉模型，用于图片广告素材分析。
- 实现 AI 爆点分析，包括视觉主体、卖点、情绪、场景、受众、转化点。
- 实现图片提示词提取。
- 实现提示词示例生成。
- AI 输出统一使用 JSON Schema，保证结果能保存、编辑、导出和复用。
- 结果保存到 SQLite，并同步生成可读报告文件。

## Phase 3: OpenAI 协议文案与标题生成
- 基于图片分析结果生成匹配文案。
- 基于图片分析结果生成广告标题。
- 支持不同平台风格预设，例如电商、信息流、社媒、短视频封面。
- 支持批量图片生成多组标题和文案。
- 支持用户选择语气、长度、卖点方向、目标人群。
- 输出结果可复制、收藏、导出 CSV/JSON。

## Phase 4: 图片创意裂变与提示词工程
- 从原图和分析结果中提取裂变变量：主体、场景、风格、构图、色彩、促销角度、目标人群。
- 生成多组图片创意裂变提示词。
- 生成裂变提示词示例，例如换场景、换人群、换风格、换平台尺寸、换促销利益点。
- 支持批量生成裂变方案。
- 支持对裂变提示词进行评分、收藏、复用。
- 后续图片生成统一走 OpenAI Images API 或兼容图片生成服务。

## Phase 5: Logo 与图片生成能力
- 接入 OpenAI Images API。
- 实现图片匹配广告 Logo 生成。
- 实现广告素材变体生成。
- 支持基于参考图生成新视觉方向。
- 支持生成结果预览、保存、重命名、整理到项目文件夹。
- 图片生成任务进入统一任务中心，支持失败重试和成本提示。
- 如果第三方 OpenAI-compatible 服务不支持 Images API，则通过图片生成 adapter 单独兼容。

## Phase 6: 本地 AI 图片增强
- 建立本地模型管理器，首次使用时下载模型。
- 使用 ONNX Runtime 运行本地模型。
- 实现图片变清晰。
- 实现本地算力去水印。
- 支持 CPU fallback；有可用硬件加速时优先使用。
- 增加长任务队列、暂停、继续、失败重试。
- 增加显存、内存、模型缺失、模型损坏等错误提示。

## Phase 7: AI 去水印与高级修复
- 接入 OpenAI 协议兼容的云端图像编辑能力。
- 实现图片 AI 去水印。
- 提供自动检测、手动选择区域、蒙版编辑、前后对比预览。
- 本地去水印和云端 AI 去水印使用统一 UI。
- 输出修复报告，记录原图、参数、模型、结果路径。
- 提供功能开关，方便未来根据发布渠道或商业风险控制是否启用。

## Phase 8: AI 对话模式
- 建立对话式任务编排层。
- 使用 OpenAI Responses API 将用户自然语言解析为内部 `TaskRequest`。
- 支持用户通过对话触发批量图片处理、素材分析、标题文案生成、创意裂变、图片增强。
- 执行前展示任务预览，包括输入图片、参数、输出目录、预计成本、预计耗时。
- 用户确认后再进入任务中心执行。
- 如果第三方兼容服务不支持 Responses API，则使用 `chat.completions` fallback adapter。

## Phase 9: 稳定性、打包与发布
- 完成 macOS 和 Windows 安装包。
- 增加崩溃日志、任务日志、错误报告导出。
- 做大批量图片压力测试。
- 测试中文路径、长文件名、空格路径、断网、API 超时、模型下载失败。
- 优化缩略图缓存、任务恢复、并发控制、内存占用。
- 完成版本升级、模型升级和 SQLite 数据迁移策略。

## Phase 10: 商业化与团队能力
- 可选增加账号系统、云端同步、团队素材库。
- 可选增加平台 API Key 托管、额度管理、计费和风控。
- 可选增加后端 API 代理，保护平台 Key。
- 可选增加模板市场：广告标题模板、文案模板、裂变提示词模板。
- 可选增加企业版权限、审计、功能开关和私有化部署。

## 推荐实施顺序
1. **MVP**：Phase 0 + Phase 1 + Phase 2 + Phase 3。
2. **创意生成版**：Phase 4 + Phase 5。
3. **本地增强版**：Phase 6。
4. **高级修复版**：Phase 7。
5. **完整智能工作台**：Phase 8 + Phase 9。
6. **商业化版本**：Phase 10。

## Assumptions
- V1 使用用户自己的 API Key，不内置平台 Key。
- V1 不做账号、团队协作、云同步和平台计费。
- API 协议按 OpenAI 官方接口优先，同时保留第三方 OpenAI-compatible endpoint 能力。
- OpenAI 官方接口默认使用 Responses API、Images API 和 Structured Outputs。
- 本地模型按需下载，不随安装包内置。
