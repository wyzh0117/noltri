<div align="center">
  <h1>Noltri · 知序</h1>
  <p>Collect webpages, agent conversations, and paper notes into your own knowledge tree.</p>
</div>

[简体中文](README.md)

## About

Noltri is a local personal knowledge library. Save useful passages from webpages, agent conversations, and research papers, then organize, search, and compare them by subject. Your collection stays on your computer by default.

## Quick start

Version 0.1.1 is currently available for Apple Silicon (arm64) Macs running macOS 13.5 or later. Download the [macOS installer](https://github.com/wyzh0117/noltri/releases/latest), open the disk image, and drag Noltri to the Applications folder.

Version 0.1.1 fixes the missing app resource seal and invalid bundled runtime signature in 0.1.0. The app and the copy inside the DMG are now strictly verified. This release uses ad-hoc signing and **has no Developer ID signature or Apple notarization**, so macOS may still block the first launch. Check the download against `SHA256SUMS.txt` in Releases, then follow [Apple's Open Anyway instructions](https://support.apple.com/en-us/102445).

If macOS still reports that the app is damaged, verify the download source and checksum, then remove quarantine for this app only:

```bash
codesign --verify --deep --strict "/Applications/知序.app"
xattr -dr com.apple.quarantine "/Applications/知序.app"
open "/Applications/知序.app"
```

Run the last two commands only after signature verification succeeds. Distribution without this manual approval requires Developer ID signing and Apple notarization; see [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

### Run from source

Running from source requires Node.js 20.19+ or 22.12+, pnpm 11, Rust, and Xcode Command Line Tools.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

The desktop opens with model settings. Choose DeepSeek or an OpenAI-compatible provider, enter the API key, base URL and model, and save. Add multiple profiles and switch between them with a dropdown. The library sidebar opens the same settings page. The layout follows [Cherry Studio provider settings](https://www.cherryai.com/docs/en/pre-basic/settings/providers/) using existing forms and native dropdowns.

Saving restarts services managed by the packaged app. External/development services require a manual restart and matching `.env.local` settings:

```dotenv
AI_PROVIDER=openai
AI_API_KEY=your-own-key
AI_BASE_URL=https://api.deepseek.com
AI_CHAT_MODEL=deepseek-flash
AI_EMBEDDINGS_ENABLED=false
```

Model profiles are stored locally in `~/Library/Application Support/com.noltri.companion/settings.json` on macOS. Automatic classification requires a configured model. Unconfigured or failed requests keep the original text for later retry or manual organization.

### Install the browser extension

Download and extract `noltri-extension.zip` from [0.1.1 Releases](https://github.com/wyzh0117/noltri/releases/latest), or build it from source:

```bash
pnpm --filter @noltri/extension build
```

In Chrome, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the extracted folder (or `apps/extension/.output` when building from source). On a webpage, right-click and choose **Collect selected text to Noltri**, **Collect this page to Noltri**, or **Collect this image to Noltri** to save it with its source.

### Connect Codex or another agent

After opening Noltri or starting it with `pnpm dev`, add the local Streamable HTTP server in Codex MCP settings, or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.zhixu]
url = "http://127.0.0.1:8790/mcp"
```

Save the settings and restart Codex. Other agents can use the endpoint shown in Noltri settings. For clients that only support stdio, add:

```toml
[mcp_servers.zhixu]
command = "pnpm"
args = ["--filter", "@noltri/mcp-server", "exec", "tsx", "src/stdio.ts"]
cwd = "/absolute/path/to/your/noltri/repository"
env = { KNOWLEDGE_API_URL = "http://127.0.0.1:8787" }
```

See the [Codex MCP setup guide](https://developers.openai.com/codex/mcp).

## How it works

Each saved note keeps its original text and source. Noltri prepares summaries and research points, then files them under subjects in your knowledge tree. You can adjust the subject, search the library, and compare related notes side by side.

## What you can do

- Save selected text from a webpage with its title and link.
- Enter a path such as `Social Science / Economics / Causal Inference` while collecting to create a subject tree and file the note in one step.
- Ask Codex and other agents to save answers or research leads through MCP.
- Collect paper passages with their references and research topics.
- Browse, search, organize, and compare notes in the knowledge tree.

## Example

Collect passages from two papers about the same question. Noltri keeps each source with the note and files them under the relevant subject. Open the notes side by side to compare their methods and findings.

## Verification and builds

The 0.1.1 live DeepSeek acceptance covers Python, TypeScript, Rust, Go, SQL and short excerpts from physics, econometrics, molecular biology and psychology papers. See the [test guide](docs/testing/README.md) and [recorded results](docs/testing/0.1.1-deepseek-results.json). The tested local library retains these cards; installers contain no test credentials or user data.

```bash
pnpm typecheck
pnpm test
pnpm --filter @noltri/desktop release:mac
```

The build pins and checksum-verifies Node 24, then verifies app/DMG signature integrity and bundled SQLite/JIT operation. A fully signed and notarized distribution must also pass `pnpm --filter @noltri/desktop verify:mac --require-notarization`.

## License

This repository does not include a LICENSE file, so usage, modification, and redistribution terms have not been declared.
