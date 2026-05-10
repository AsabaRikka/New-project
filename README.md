# Ad Creative Studio

广告素材 AI 桌面工具。当前仓库实现 Phase 0：跨平台桌面应用基础架构、统一任务协议、本地配置、OpenAI API 协议配置层、SQLite 任务记录骨架。

## Stack

- Tauri 2
- React + TypeScript + Vite
- Rust command layer
- SQLite via `rusqlite`
- Local secret storage via OS keychain

## Phase 0 Features

- Desktop app shell for macOS and Windows.
- Local app config with OpenAI-compatible provider settings.
- API key storage through the OS keychain.
- Shared task model: `TaskRequest`, `TaskResult`, `TaskStatus`.
- SQLite task table and commands for creating/listing task records.
- Frontend task protocol preview, settings panel, and task center.

## Development

Install npm dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Build the frontend:

```bash
npm run build
```

Run the Tauri desktop app:

```bash
npm run tauri:dev
```

Tauri requires the Rust toolchain:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Local Proxy

If npm needs a proxy, create a local `.npmrc`:

```ini
proxy=http://127.0.0.1:7890
https-proxy=http://127.0.0.1:7890
```

`.npmrc` is ignored by Git.
