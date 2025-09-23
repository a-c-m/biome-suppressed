# Biome Suppressed

A fast, lightweight drop-in replacement for `biome check` that maintains an error baseline and only fails on new errors. Automatically improves the baseline when fewer errors are found.

Available as both `biome-suppressed` and `bs` commands for convenience.

## Installation

### NPM Package (Recommended)
```bash
# Install globally
npm install -g biome-suppressed

# Or install as dev dependency
npm install --save-dev biome-suppressed
```

### From Source
```bash
# Clone and link
git clone https://github.com/yourusername/biome-suppressed.git
cd biome-suppressed
npm link
```

## Key Features

- **Drop-in replacement**: Use `bs check` instead of `biome check`
- **Auto-fix by default**: Runs with `--write` flag by default (use `--no-write` to disable)
- **Auto-improvement**: Updates baseline automatically when errors decrease
- **Performance**: <50ms overhead on top of biome execution
- **Fail on regression**: Exit 1 only when new errors are introduced
- **CI-friendly**: `--suppression-fail-on-improvement` for strict CI environments
- **Token efficient**: Minimal output for error resolution

## Usage

### Initial Setup
```bash
# Initialize with current error state (run once)
bs init
# Output: ✅ Baseline created with 18649 errors
```

### Normal Development
```bash
# Check for new errors with auto-fix (default behavior)
bs check
# Output: ✅ No new errors (18649 existing errors suppressed)

# Check only mode (no fixes applied)
bs check --no-write
# Output: ✅ No new errors (18649 existing errors suppressed)
```

### After Fixing Errors
```bash
bs check
# Output: 🎉 Improvement detected! 18649 → 18500 errors (-149)
#         📊 Baseline updated automatically
```

### When New Errors Are Introduced
```bash
bs check
# Output: ❌ Found 3 new errors:
#
#           lint/style/useNamingConvention (2 errors):
#             src/components/Button.tsx:42
#             src/utils/helpers.ts:15
#
#           lint/suspicious/noExplicitAny (1 error):
#             src/types/api.ts:8
#
#         Fix strategies:
#         • Run: npx biome check --write src/components/Button.tsx src/utils/helpers.ts src/types/api.ts
#         • Or accept: bs update
# Exit code: 1
```

## Commands

- `check [options] [files...]` - Check for new errors with auto-fix (default: .)
- `init [files...]` - Create initial baseline (default: .)
- `update [files...]` - Update baseline with current errors (default: .)
- `clear` - Remove baseline file
- `status` - Show baseline information

### Options for check:
- `--no-write` - Don't apply fixes (check only mode)
- `--skip-suppression-update` - Don't update baseline on improvement
- `--suppression-fail-on-improvement` - Fail if fewer errors than baseline (CI mode)

## Integration

### Package.json Scripts
```json
{
  "scripts": {
    "lint": "bs check",
    "lint:check": "bs check --no-write",
    "lint:ci": "bs check --suppression-fail-on-improvement",
    "lint:init": "bs init",
    "lint:update": "bs update",
    "lint:status": "bs status",
    "lint:clear": "bs clear",
    "lint:strict": "biome check --write ."
  }
}
```

### CI/CD Integration
```yaml
# .github/workflows/lint.yml
- name: Lint check
  run: npm run lint:ci
  # Fails on new errors OR unexpected improvements (strict mode)

# Alternative: Auto-updating mode
- name: Lint check (auto-update)
  run: npm run lint
  # Fails only on new errors, auto-updates on improvements
```

## Benefits

1. **Legacy Codebase Friendly**: Adopt Ultracite without fixing thousands of existing errors first
2. **Always Improving**: Automatic baseline updates reward code quality improvements
3. **Fast & Lightweight**: <50ms overhead, single file implementation
4. **CI/CD Ready**: Proper exit codes, clear error reporting
5. **Zero Config**: Works with existing biome.jsonc configuration
6. **Drop-in Replacement**: Minimal changes to existing workflows

## How It Works

1. Runs `biome check --write --reporter=github` to fix what can be fixed
2. Parses GitHub Actions format output for structured error data
3. Compares current errors against stored baseline using MD5 fingerprints
4. Updates baseline automatically when errors decrease
5. Fails only when new errors are introduced (not in baseline)
6. Provides actionable next steps for error resolution

## File Structure

```
biome-suppressed/
├── index.js                 # ~280 lines, zero dependencies
├── package.json             # CLI metadata with bin commands
└── README.md                # This documentation
```

## Architecture

- **Single file**: Zero dependencies except biome itself
- **GitHub reporter**: Token-efficient error parsing vs JSON format
- **MD5 fingerprinting**: Fast error identification and comparison
- **Auto-improvement**: Ratcheting system that always moves toward better code quality
- **Error grouping**: Token-efficient display grouped by rule type

This tool enables adopting Ultracite on legacy codebases while maintaining development velocity and encouraging continuous improvement.