# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2024-10-14

### Added
- **Unit tests**: Added comprehensive test suite (9 tests) covering core functionality
  - Tests for `parseGitHubErrors()` - parsing, filtering, sorting, path normalization
  - Tests for `createErrorFingerprint()` - consistent hashing and path handling
  - Integration tests for full parse-to-fingerprint workflow
- **Package metadata improvements**:
  - Added explicit `files` array in package.json for controlled publishing
  - Added `.npmignore` to exclude development files from package
  - Added `.gitignore` for proper version control hygiene
- **Biome configuration**: Added biome.json for code quality and formatting standards
- **Self-demonstration**: Package now uses itself to suppress 2 deliberate lint errors

### Changed
- **Removed `version` field from baseline**: Simplified `.biome-suppressed.json` structure
  - Removed redundant `version: "1.0.0"` field
  - Keeps only `biomeVersion`, `fingerprints`, and `errors`
- **Code formatting**: Applied Ultracite tab-based formatting for consistency
- **Repository URLs**: Updated from placeholders to actual GitHub repository

### Fixed
- Fixed CHANGELOG dates (corrected 2025 → 2024)
- Fixed test script in package.json to run actual tests instead of placeholder

### Documentation
- Updated README installation instructions (removed "Coming Soon" messaging)
- Fixed incorrect "Ultracite" references to "Biome" where appropriate

## [1.1.0] - 2024-10-01

### Changed
- **Reduced merge conflicts in baseline file**: Removed `timestamp` and `errorCount` fields from `.biome-suppressed.json`
  - `timestamp` removed: File system modification time is used instead (shown in `bs status`)
  - `errorCount` removed: Derived from `fingerprints.length` instead of storing redundantly
  - These fields were causing frequent merge conflicts in team environments where multiple branches would update the baseline

### Why
In real-world usage, teams experienced merge conflicts when multiple branches updated the baseline file. The `timestamp` would always differ, and `errorCount` would change even when the actual errors (fingerprints) were identical. Since the file system already tracks modification time and the error count can be calculated from the fingerprints array, storing these values was redundant and problematic for version control.

## [1.0.0] - 2024-09-23

### Added
- Initial release
- Drop-in wrapper for `biome check` with error baseline tracking
- Auto-improvement detection and baseline updates
- Support for `--write`, `--skip-suppression-update`, and `--suppression-fail-on-improvement` flags
- Commands: `check`, `init`, `update`, `clear`, `status`
- Deterministic error fingerprinting using MD5 hashes
- Token-efficient error display grouped by rule type
