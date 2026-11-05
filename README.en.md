<div align="center">
  <h1>Noltri · Notes 3.0</h1>
  <p>Write and read local Markdown while keeping collected originals on your computer.</p>
</div>

[简体中文](README.md)

## Current version

The current source version is **3.0.0**, built around Markdown Notes. The formal Release is the source for installers, signed update artifacts and the production update manifest. Historical versions stay available in [Releases](https://github.com/wyzh0117/noltri/releases) as history.

The former course product line is no longer maintained. There is no course-workspace migration or compatibility commitment. Historical versions, verified artifacts and existing data are retained; this version change does not delete them.

## Run from source

Use Node.js 24 (verified with 24.18.0), pnpm 11, Rust and Xcode Command Line Tools. The desktop target is Apple Silicon running macOS 13.5 or later.

```bash
pnpm install
cp -n .env.example .env.local
```

Set `NOLTRI_DEV_TOKEN` and `NOLTRI_ACCESS_TOKEN` in `.env.local` to the same nonempty local token, and explicitly export that same `NOLTRI_ACCESS_TOKEN` in the terminal launching desktop. Rust does not parse dotenv; Core/MCP load the selected file without overriding process settings. Then run:

```bash
NOLTRI_ENV_FILE="$PWD/.env.local" pnpm dev
```

Notes uses a local Markdown Vault for its body text, with editing, reading, heading mindmaps, search, properties and history. The relationships tab shows graphs and links. Translation, explanation and source questions send the current snapshot only after an explicit action; results are temporary and do not replace the original.

Quick Collect accepts text, images and the desktop screenshot entry. The review inbox preserves originals and separates processing from human review. Editing organized text leaves the original untouched. Confirmed sources separately display the saved human text and destination at confirmation time. Missing manual confirmation records are identified explicitly, with the original still available. Image recognition requires an explicitly configured image-capable model; saving offline does not mean recognition or classification has completed. Rules and processing records have a separate window, and saving a rule draft does not apply it. See the [module guide](docs/modules.md).


The default Core port is **18887**, and MCP is **18890**. Without `NOLTRI_ENV_FILE`, loaders probe only `.env.local`/`.env` under `~/.noltri-notes` and an explicitly selected `NOLTRI_DATA_DIR`; they do not search parent project directories. A selected file is exclusive, including when missing. Desktop does not reuse an external runtime by default; connecting requires explicit `NOLTRI_USE_EXTERNAL_RUNTIME=1`, a matching token and service verification.

## Independent Notes profile

All 3.x versions retain the same Notes namespace and profile:

| Runtime | Default location |
| --- | --- |
| Packaged macOS desktop | `~/Library/Application Support/com.noltri.notes/`, including `settings.json` and local data |
| Core run from source | `~/.noltri-notes/data/`, with `noltri.sqlite` and the default `vault/` |

These defaults are separate from the retired product line and do not import its database. Explicit `NOLTRI_DATA_DIR`, `NOLTRI_SQLITE_FILE`, `NOLTRI_NOTES_DIR` and desktop `NOLTRI_SETTINGS_DIR` settings remain supported. Check ownership before selecting a path; incompatible databases are refused without automatic modification. Verify the service and profile when connecting to an external Core: an independent desktop directory does not establish the identity of an external service.

## Models and collection

Provider management supports OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. Explicitly save a provider/model configuration, then select **Use this model**. Keys stay in local settings. Missing configuration or failed calls preserve the original for retry or manual review.

The packaged app restarts services it manages when applying model settings. External/development services require matching environment configuration and a manual restart. `.env.example` is a blank template; never commit real keys.

Desktop settings provide configurable screenshot and collection shortcuts, preserving the previous bindings if registration or saving fails. One host may start services per configuration directory; explicit isolated profiles can run independently. The rules window can refresh metadata for this app and the Core/MCP children it owns. See the [module guide](docs/modules.md).

Build the browser extension from current source:

```bash
pnpm --filter @noltri/extension build
```

Enable Developer mode at `chrome://extensions` and load `apps/extension/.output`. The context menu collects selected text, a page or an image. Agents can connect to the local MCP endpoint shown in application settings; its default development address is `http://127.0.0.1:18890/mcp`. The local service continues to enforce authorization scopes.

## Updates and first launch

Updates require explicit checks, download verification, installation and restart. Save drafts, finish pending work and close the rules window first; see the [update workflow](docs/application-updates.md). Isolated test packages have covered a successful upgrade and manual recovery after an installation failure. Isolated 3.0.0 candidates have verified physical text/screenshot collection, original preservation and normal reopen with synthetic material. The current release candidate has also verified the saved human text, destination and confirmed Inbox display after a full restart. No model was configured, so AI processing and OCR were not verified. The production artifact has a verified project update signature and signed version. Downloads and the update manifest are provided by the formal Release. Screen permission evidence from an earlier build does not establish authorization for the current candidate.

For release downloads, verify the source, checksums and signing information. If macOS blocks first launch, follow [Apple's official safe-opening guidance](https://support.apple.com/en-us/102445). Update signatures, Apple Developer ID signing, notarization and OS permissions are separate mechanisms.

## Development checks

Install the Rust `wasm32-unknown-unknown` target. Browser tests require local Chrome/Chromium; `CHROME_BIN` can select its executable. Generate the ignored WASM output before running checks.

```bash
rustup target add wasm32-unknown-unknown
pnpm --filter @noltri/desktop build:graph-wasm
pnpm typecheck
pnpm test
```

Build, project update signing and scoped platform verification are recorded. See the [3.0.0 version notes](docs/releases/3.0.0.md) for current checks and remaining limits; historical test counts are not a current-version success claim. The bundled Node runtime stays pinned and checksum-verified. Internal plans, test material and user configuration are not distributed.

## License

This repository does not include a LICENSE file, so usage, modification and redistribution terms remain undeclared. See the [third-party notices](THIRD_PARTY_NOTICES.md) for dependency information.
