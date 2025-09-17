# Jules Grabber

This repository provides a userscript that captures the visible chat transcript and the hidden "thought"/reasoning traces from [jules.google.com](https://jules.google.com). The script adds a compact export panel to the interface, watches both the DOM and underlying network calls, and lets you export everything as JSON, Markdown, or a quick clipboard summary.

## Features

- Captures chat messages and model thought fragments by observing network responses and the live DOM.
- Automatically expands collapsible "thought" sections (when present) before scanning the page.
- Floating export panel with quick actions for JSON, Markdown, clipboard copy, and manual DOM rescans.
- Optional inclusion of raw network packets in JSON exports for deeper analysis.
- Keyboard-free installation via Tampermonkey/Violentmonkey menu commands.

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Create a new userscript and paste the contents of [`jules-grabber.user.js`](./jules-grabber.user.js).
3. Save the script and visit `https://jules.google.com/` – the exporter panel should appear automatically once the page loads.

## Usage

- Interact with Jules as usual. The script automatically captures new messages and thought traces.
- Use the floating **Jules Exporter** panel to:
  - **Export JSON** – structured transcript with optional raw packets.
  - **Export MD** – Markdown transcript with inline thought sections and citations.
  - **Copy** – lightweight summary copied to your clipboard.
  - **Rescan** – force a DOM rescan if content was loaded before the script started.
- Additional commands (JSON/Markdown export, summary copy, DOM rescan, debug toggle) are also exposed through the Tampermonkey/Violentmonkey menu.

## Configuration

The top of the script exposes a `CONFIG` object with selectors and limits. Adjust these values if Google changes the DOM structure or if you want to disable raw packet collection.

## Development

If you modify the script:

1. Update the metadata header version as appropriate.
2. Run `node -e "const vm=require('vm');const fs=require('fs');const code=fs.readFileSync('jules-grabber.user.js','utf8');vm.createScript(code);"` to ensure the script parses.
3. Reinstall or reload the userscript in your manager of choice to test the updates.

