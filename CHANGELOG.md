# Changelog

## Unreleased

## 0.4.0

- Add a dedicated Cargo Deps activity-bar panel with native Dependencies, Updates
  and Security views, reusing cached analysis without additional Cargo or HTTP work.
- Group shared updates by their editable declaration, show every affected crate
  and retain alternative crate grouping and scoped update batches.
- Reflect unsaved manifest edits across workspace members, including root-package
  inheritance, while keeping installed versions and security results tied to the
  last scan. Keep remaining updates available and explicitly report invalid TOML
  or dependency sources awaiting analysis.
- Offer stable panel updates by default, with explicit compatible-release and
  prerelease modes. Classify Cargo version requirements, confirm potentially
  breaking updates and reject stale edits or confirmations.
- Deduplicate transitive security alerts while retaining affected routes, show
  readable titles and known severity, prioritize serious alerts and distinguish
  maintenance warnings and unavailable audits.
- Add compact documentation, repository and crates.io links to dependency hovers,
  respecting aliases and source types and allowing only safe HTTP(S) destinations.
- Keep shared workspace edits atomic and deduplicated, preserve comments and
  dependency options, and leave manifests unsaved without modifying Cargo.lock.

## 0.3.0

- Restart an active workspace scan immediately when refreshing, cancelling Cargo
  and HTTP work, restoring previous results and ignoring late completions.

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
