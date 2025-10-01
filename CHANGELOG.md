# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-10-01

### Changed
- **Reduced merge conflicts in baseline file**: Removed `timestamp` and `errorCount` fields from `.biome-suppressed.json`
  - `timestamp` removed: File system modification time is used instead (shown in `bs status`)
  - `errorCount` removed: Derived from `fingerprints.length` instead of storing redundantly
  - These fields were causing frequent merge conflicts in team environments where multiple branches would update the baseline

### Why
In real-world usage, teams experienced merge conflicts when multiple branches updated the baseline file. The `timestamp` would always differ, and `errorCount` would change even when the actual errors (fingerprints) were identical. Since the file system already tracks modification time and the error count can be calculated from the fingerprints array, storing these values was redundant and problematic for version control.

## [1.0.0] - 2025-10-01

### Added
- Initial release
- Drop-in wrapper for `biome check` with error baseline tracking
- Auto-improvement detection and baseline updates
- Support for `--write`, `--skip-suppression-update`, and `--suppression-fail-on-improvement` flags
- Commands: `check`, `init`, `update`, `clear`, `status`
- Deterministic error fingerprinting using MD5 hashes
- Token-efficient error display grouped by rule type
