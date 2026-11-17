# Changelog

## Unreleased

- Reuse parsed workspace manifests and release lookups, including failures, throughout each scan; retry failed lookups on the next scan.
- Limit crates.io traffic to six concurrent HTTP requests while preserving shared lookups and successful response caching.
- Preserve inherited dependency sources and aliases in table declarations; skip crates.io lookups for Git and alternate-registry dependencies.
- Hide stale inlay hints while manifests have unsaved changes.
- Report unavailable audits in dependency hovers and preserve Cargo errors instead of accepting interrupted or failed command output.
- Avoid rescanning when opening a manifest already covered by an active scan, and report refresh errors accurately.

## 0.2.0

- Fix Windows test snapshot keys to match URI-normalized paths and isolate extension activation from temporary provider fixtures.
- Add clickable release versions in dependency hovers, per-crate quick fixes and commands to update open manifests or all workspace manifests, preserving other dependency options.
- Add cross-platform CI, production VSIX artifacts and version-checked GitHub releases with dated changelog notes and source comparisons.
- Add a status bar progress indicator with current manifest and analysis stage.
- Show parallel Cargo tasks, active dependency traces, crate lookups, HTTP progress, cache hits and partial failures in the status tooltip.
- Refresh the workspace by clicking the status item, or open the output log when errors occur.
- Add a Cargo Deps Output channel with complete errors, manifest context, HTTP response details and network causes, accessible from the command palette and status tooltip.
- Treat audited packages absent from an individual workspace member as not applicable instead of failed dependency traces; reuse traces per package/version and match crate names exactly.

## 0.1.0

- Automatic dependency analysis across Cargo workspaces.
- Inlay hints and Information diagnostics for available updates.
- Warning diagnostics for direct and transitive RustSec advisories.
- Dependency hovers with recent releases and compact dependency paths.
- Support for workspace-inherited dependencies and local path dependencies.
- Manual refresh with cached crates.io responses.
