# Repository layout and platform assumptions

What lives where in a source checkout, and what Bearing needs from the host.

## Repository layout

- `src/`: application source.
- `test/`: automated tests.
- `plugin-skills/`: guarded, host-discoverable entrypoints for Bearing, Explorer, Navigator, and Crewmate.
- `skills/`: Bearing's editable internal workflow skills; the plugin does not expose them directly.
- `hooks/`: optional Codex and Claude reminders that activate only inside a Bearing Focus process.
- `examples/fictional-b2b/`: deterministic public-safe examples, showcase, and QA data.
- `assets/`: interface artwork.
- `guide/`: these documentation pages, shipped in the npm package.

Bearing writes generated planning artifacts into the repository selected by the user at runtime. Generated customer plans are not maintained in Bearing's public source tree.

## Platform assumptions and limitations

- Node.js 22+ and a writable local filesystem are required. `package.json` pins pnpm 10.33.0.
- Browser opening uses `open` on macOS, `cmd /c start` on Windows, and `xdg-open` on other platforms; use `--no-open` when that integration is unavailable. Publishing the npm package does not require Windows or macOS code signing. Native Windows, macOS, Linux, and WSL smoke tests remain release certification work.
- The server is single-user and loopback-only. Bearing provides no hosted account or service, remote telemetry, production deployment, support SLA, or multi-user authorization boundary. Selected agent CLI and provider account requirements remain external to Bearing.
- The native UI is intentionally small. The real staged journey launches the selected harness, but it does not provide a general-purpose terminal, arbitrary workflow editor, full-state export, or delete controls.
- Example and showcase providers are intentionally disabled; they remain deterministic fixtures. Real journey readiness and effective isolation depend on the selected local harness and its attestation, and may be unavailable.
- Optional RAG-assisted context, external config discovery, OAuth/setup flows, alias migrations, and skill lifecycle changes are not enabled by this package's browser flow.

[Back to the README](../README.md)
