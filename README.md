# Ad Creative Studio

广告素材 AI 桌面工具，面向图片广告素材分析、提示词反推、创意裂变、图片匹配文案/标题生成，以及图片批量处理工作流。

## 功能概览

- AI 广告分析：爆点分析、素材结构分析、反推提示词、提示词示例。
- AI 创意裂变：基于图片生成多组裂变提示词。
- 文案与标题生成：基于图片生成广告文案、CTA、标题和投放角度。
- AI 结果库：分析结果、文案库、裂变提示词库，支持复制、收藏、标星、删除、重生成。
- 批量图片工具：重命名、改尺寸、压缩、格式转换、切分、拼接、文件夹整理。
- 任务中心：任务记录、重提、打开输出目录、取消进行中任务。
- OpenAI API 协议层：支持 OpenAI 兼容接口、代理、Text/Vision/Image 联通测试。

## 技术栈

- Tauri 2
- React + TypeScript + Vite
- Rust command layer
- SQLite via `rusqlite`
- Local secret storage via OS keychain / local fallback

## 首次使用

1. 安装依赖并启动桌面应用。
2. 进入「设置」或「AI 协议层」填写 OpenAI 兼容配置。
3. 保存 API Key。
4. 如需代理，填写 `http://127.0.0.1:7890`。
5. 点击「测试 Text」「测试 Vision」「测试 Image」确认模型联通。
6. 回到「AI 协议层」或「批量工具」选择图片后提交任务。

## macOS 构建方法

### 1. 安装基础环境

安装 Node.js 18+，建议使用官网安装包或 Homebrew：

```bash
brew install node
```

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

### 2. 安装项目依赖

```bash
npm install
```

如果 npm 需要代理，可以在项目根目录创建本地 `.npmrc`：

```ini
proxy=http://127.0.0.1:7890
https-proxy=http://127.0.0.1:7890
```

### 3. 开发运行

```bash
npm run tauri:dev
```

### 4. 生产构建

```bash
npm run tauri:build
```

构建产物通常在：

```text
src-tauri/target/release/bundle/
```

## Windows 构建方法

### 1. 安装基础环境

安装 Node.js 18+：

```text
https://nodejs.org/
```

安装 Rust：

```text
https://rustup.rs/
```

安装 Microsoft C++ Build Tools：

```text
https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

安装时勾选：

- Desktop development with C++
- Windows 10/11 SDK
- MSVC build tools

### 2. 安装项目依赖

在项目根目录执行：

```powershell
npm install
```

如需 npm 代理，可创建 `.npmrc`：

```ini
proxy=http://127.0.0.1:7890
https-proxy=http://127.0.0.1:7890
```

### 3. 开发运行

```powershell
npm run tauri:dev
```

### 4. 生产构建

```powershell
npm run tauri:build
```

构建产物通常在：

```text
src-tauri\target\release\bundle\
```

## 常用命令

只运行前端开发服务器：

```bash
npm run dev
```

构建前端：

```bash
npm run build
```

运行 Rust 测试：

```bash
cd src-tauri
cargo test
```

运行 Tauri 桌面开发环境：

```bash
npm run tauri:dev
```

打包桌面应用：

```bash
npm run tauri:build
```

## API 配置说明

当前 AI 协议层按 OpenAI 兼容协议设计，常用字段如下：

- Base URL：例如 `https://api.openai.com/v1` 或兼容服务的 `/v1` 地址。
- Text Model：用于文本任务和文案生成测试。
- Vision Model：用于图片分析、文案生成、标题生成、裂变提示词生成。
- Image Model：用于图片生成能力测试。
- Proxy URL：如本机代理 `http://127.0.0.1:7890`，留空则不使用显式代理。
- Timeout Seconds：AI 请求超时时间。
- Max Retries：失败重试次数。

API Key 会保存到本机密钥存储；如果系统密钥存储不可用，会退回本地应用数据目录。

## 输出目录

默认输出位于项目根目录的 `outputs/`。每个任务会按项目名、任务类型和时间生成独立目录，并包含：

- `success/`：处理成功的图片或原图副本。
- `failed/`：处理失败的输入副本。
- `report/`：JSON/CSV 报告和 AI 结果文件。

## 注意事项

- AI 任务必须先选择图片。
- 取消任务是协作式取消：正在处理的单张图片或正在请求中的 AI 调用会先完成，随后停止后续文件。
- `.npmrc`、本地 API Key、输出目录和临时配置不会提交到 Git。
