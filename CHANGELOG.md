# Changelog

## Unreleased

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
