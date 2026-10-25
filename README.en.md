# Noltri

[中文](README.md)

Noltri is a local personal knowledge library. Capture web pages, Agent answers and paper excerpts with their original text and sources, then organize them into disciplines and courses.

## Version 2.0.0

Read and edit a continuous course document in live preview, source or reading mode. Connect content with headings, stable block references, links, embeds, tags and structured properties. Navigation, search and graphs open the same course workspace. Outline, backlinks, outgoing links, tags and source properties follow the selection.

Import and export Markdown, manage attachments, and compare or restore snapshots. Failed saves retain a local draft. Browser capture, MCP, model configuration and research comparison remain available.

## Install

[Download the macOS release](https://github.com/wyzh0117/noltri/releases/tag/v2.0.0). The package supports Apple Silicon (arm64) and macOS 13.5 or later. Open the DMG and drag Noltri to Applications.

This release is ad-hoc signed and is not Apple Developer ID signed or notarized. Verify the download against `SHA256SUMS.txt` in the release. macOS may require confirmation in Privacy & Security; see [Apple's instructions](https://support.apple.com/en-us/102445).

Before upgrading, back up `~/Library/Application Support/com.noltri.companion/`. Version 2.0.0 migrates legacy courses and notes while retaining original sources. Restore the complete backup before returning to an older version.

## Use

Use Quick Capture to collect material. You can organize it manually while offline, or configure a provider and choose an active model for automatic classification. API keys stay in local settings.

Open a course to edit. Source Properties shows sources for the selected course, chapter or entry. The course menu provides import, export and snapshot recovery; conflicts preserve both versions.

The release also includes `noltri-extension.zip`. Extract it and use Chrome's Load unpacked option to enable contextual capture. The application settings show the local MCP endpoint and credentials. The default Streamable HTTP endpoint is `http://127.0.0.1:8790/mcp`.

## License

No LICENSE file has been provided in this repository.
