#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const crypto = require("node:crypto");

// Run biome check and capture structured output
function runBiome(files, withWrite = false) {
  const writeFlag = withWrite ? "--write" : "";
  const command =
    `npx biome check ${writeFlag} --reporter=github ${files.join(" ")}`
      .replace(/\s+/g, " ")
      .trim();
  try {
    // Use maxBuffer to handle large outputs and ignore SIGPIPE errors
    const stdout = execSync(command, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
    return { stdout, stderr: "", code: 0 }; // No errors
  } catch (error) {
    // Handle broken pipe errors gracefully
    if (error.signal === 'SIGPIPE' || (error.stderr && error.stderr.includes('Broken pipe'))) {
      return {
        stdout: error.stdout || "",
        stderr: "",
        code: 0, // Treat broken pipe as success if we got output
      };
    }
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      code: error.status || 1,
    };
  }
}

// Parse GitHub Actions reporter format
function parseGitHubErrors(output) {
  const errors = output
    .split("\n")
    .filter((errorLine) => errorLine.startsWith("::error"))
    .map((errorLine) => {
      // Parse: ::error title=rule,file=path,line=N,endLine=N,col=N,endColumn=N::message
      const match = errorLine.match(
        /::error title=([^,]+),file=([^,]+),line=(\d+).*?::(.+)/
      );
      if (!match) return null;

      const [, rule, file, lineNum, message] = match;
      // Normalize file path consistently
      let normalizedFile = file;
      if (path.isAbsolute(file)) {
        normalizedFile = path.relative(process.cwd(), file);
      }
      // Ensure forward slashes for cross-platform consistency
      normalizedFile = normalizedFile.replace(/\\/g, '/');

      return {
        rule,
        file: normalizedFile,
        line: Number.parseInt(lineNum),
        message: message.trim(),
      };
    })
    .filter(Boolean);

  // Sort for deterministic results
  return errors.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
    return 0;
  });
}

// Create stable fingerprint for error
function createErrorFingerprint(error) {
  // Ensure deterministic fingerprints by normalizing path separators
  const normalizedFile = error.file.replace(/\\/g, '/');
  const fingerprintData = `${normalizedFile}:${error.rule}:${error.line}`;
  return crypto
    .createHash("md5")
    .update(fingerprintData)
    .digest("hex");
}

// Load baseline from cache file
function loadBaseline() {
  const cacheFile = ".biome-suppressed.json";
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    }
  } catch (error) {
    console.warn(`Warning: Could not load baseline: ${error.message}`);
  }
  return null;
}

// Save baseline to cache file
function saveBaseline(errors) {
  // Sort errors for consistent baselines
  const sortedErrors = [...errors].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
    return 0;
  });

  const baseline = {
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    biomeVersion: getBiomeVersion(),
    errorCount: sortedErrors.length,
    fingerprints: sortedErrors.map(createErrorFingerprint).sort(),
    errors: sortedErrors, // Keep for debugging/reporting
  };

  fs.writeFileSync(".biome-suppressed.json", JSON.stringify(baseline, null, 2));
  return baseline;
}

// Get biome version for cache validation
function getBiomeVersion() {
  try {
    const output = execSync("npx biome --version", { encoding: "utf8" });
    return output.trim();
  } catch {
    return "unknown";
  }
}

// Group array by key
function groupBy(array, key) {
  return array.reduce((groups, item) => {
    const value = item[key];
    groups[value] = groups[value] || [];
    groups[value].push(item);
    return groups;
  }, {});
}

// Sanitize and validate file paths
function sanitizeFilePaths(files) {
  return files
    .map(file => {
      // Quote paths with spaces
      if (file.includes(" ") && !file.startsWith('"')) {
        return `"${file}"`;
      }
      return file;
    })
    .filter(file => {
      // Remove quotes for existence check
      const cleanFile = file.replace(/^"|"$/g, "");
      if (cleanFile === "." || fs.existsSync(cleanFile)) {
        return true;
      }
      console.warn(`⚠️  File/directory not found: ${cleanFile}`);
      return false;
    });
}

// Parse command line arguments
function parseArgs(args) {
  const options = {
    files: [],
    write: false, // Default to check-only mode (like biome check)
    skipSuppressionUpdate: false,
    suppressionFailOnImprovement: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--skip-suppression-update") {
      options.skipSuppressionUpdate = true;
    } else if (arg === "--suppression-fail-on-improvement") {
      options.suppressionFailOnImprovement = true;
    } else if (!arg.startsWith("--")) {
      options.files.push(arg);
    }
  }

  // Default to current directory if no files specified
  if (options.files.length === 0) {
    options.files = ["."];
  }

  // Sanitize file paths
  options.files = sanitizeFilePaths(options.files);

  if (options.files.length === 0) {
    console.error("❌ No valid files or directories found");
    process.exit(1);
  }

  return options;
}

// Token-efficient error display
function displayNewErrors(newErrors) {
  console.error(
    `❌ Found ${newErrors.length} new error${newErrors.length > 1 ? "s" : ""}:`
  );
  console.error("");

  // Group by rule for better UX
  const byRule = groupBy(newErrors, "rule");

  Object.entries(byRule).forEach(([rule, errors]) => {
    console.error(
      `  ${rule} (${errors.length} error${errors.length > 1 ? "s" : ""}):`
    );
    errors.forEach((error) => {
      console.error(`    ${error.file}:${error.line}`);
    });
    console.error("");
  });

  // Actionable next steps
  const files = [...new Set(newErrors.map((e) => e.file))];
  console.error("Fix strategies:");
  console.error(`• Run: npx biome check --write ${files.join(" ")}`);
  console.error("• Or accept: bs update");
}

// Main check command logic
function checkCommand(args) {
  const options = parseArgs(args);
  const { files, write, skipSuppressionUpdate, suppressionFailOnImprovement } =
    options;

  console.log(`🔍 Running biome check${write ? " with --write" : ""}...`);

  // Run biome check
  const result = runBiome(files, write);
  const currentErrors = parseGitHubErrors(result.stdout);

  console.log(
    `Found ${currentErrors.length} error${currentErrors.length === 1 ? "" : "s"}${write ? " (after fixes applied)" : ""}`
  );

  // Load baseline
  const baseline = loadBaseline();

  if (!baseline) {
    console.log("📊 No baseline found, creating initial baseline...");
    saveBaseline(currentErrors);
    console.log(
      `✅ Baseline created with ${currentErrors.length} error${currentErrors.length === 1 ? "" : "s"}`
    );
    return currentErrors.length > 0 ? 1 : 0;
  }

  // Compare with baseline
  const currentFingerprints = new Set(
    currentErrors.map(createErrorFingerprint)
  );
  const baselineFingerprints = new Set(baseline.fingerprints);

  // Find new errors (not in baseline)
  const newErrors = currentErrors.filter(
    (error) => !baselineFingerprints.has(createErrorFingerprint(error))
  );

  // Find fixed errors (in baseline but not current)
  const fixedCount = baseline.fingerprints.filter(
    (fp) => !currentFingerprints.has(fp)
  ).length;

  // Auto-improvement: update baseline if fewer errors (unless skipped)
  if (currentErrors.length < baseline.errorCount) {
    console.log(
      `🎉 Improvement detected! ${baseline.errorCount} → ${currentErrors.length} error${currentErrors.length === 1 ? "" : "s"} (-${baseline.errorCount - currentErrors.length})`
    );

    if (suppressionFailOnImprovement) {
      console.error(
        "❌ Unexpected improvement detected in CI mode (--suppression-fail-on-improvement)"
      );
      console.error(
        "   Update the baseline with: bs update"
      );
      return 1; // Failure - baseline needs updating
    }

    if (skipSuppressionUpdate) {
      console.log("📊 Baseline update skipped (--skip-suppression-update)");
    } else {
      saveBaseline(currentErrors);
      console.log("📊 Baseline updated automatically");
    }
    return 0; // Success on improvement
  }

  // Same or fewer errors: success
  if (newErrors.length === 0) {
    if (fixedCount > 0) {
      console.log(
        `✅ No new errors. Fixed ${fixedCount} existing error${fixedCount === 1 ? "" : "s"}!`
      );
    } else {
      console.log(
        `✅ No new errors (${currentErrors.length} existing error${currentErrors.length === 1 ? "" : "s"} suppressed)`
      );
    }
    return 0;
  }

  // New errors found: failure
  displayNewErrors(newErrors);
  console.error(
    `Baseline: ${baseline.errorCount} error${baseline.errorCount === 1 ? "" : "s"}, Current: ${currentErrors.length} error${currentErrors.length === 1 ? "" : "s"}`
  );

  return 1; // Failure
}

// CLI command dispatcher
function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "check":
      process.exit(checkCommand(args));

    case "init": {
      const options = parseArgs(args);
      console.log("🔍 Running initial biome check...");
      const result = runBiome(options.files, false); // Never use --write for init
      const errors = parseGitHubErrors(result.stdout);
      saveBaseline(errors);
      console.log(
        `✅ Baseline created with ${errors.length} error${errors.length === 1 ? "" : "s"}`
      );
      process.exit(0);
    }

    case "update": {
      const options = parseArgs(args);
      console.log("🔍 Running biome check to update baseline...");
      const updateResult = runBiome(options.files, false); // Never use --write for update
      const updateErrors = parseGitHubErrors(updateResult.stdout);
      saveBaseline(updateErrors);
      console.log(
        `📊 Baseline updated with ${updateErrors.length} error${updateErrors.length === 1 ? "" : "s"}`
      );
      process.exit(0);
    }

    case "clear":
      if (fs.existsSync(".biome-suppressed.json")) {
        fs.unlinkSync(".biome-suppressed.json");
        console.log("🗑️  Baseline cleared");
      } else {
        console.log("ℹ️  No baseline to clear");
      }
      process.exit(0);

    case "status": {
      const baseline = loadBaseline();
      if (baseline) {
        console.log(
          `📊 Baseline: ${baseline.errorCount} error${baseline.errorCount === 1 ? "" : "s"}`
        );
        console.log(`📅 Created: ${baseline.timestamp}`);
        console.log(`🔧 Biome version: ${baseline.biomeVersion}`);
      } else {
        console.log("ℹ️  No baseline found");
      }
      process.exit(0);
    }

    default:
      console.log(`
Usage: bs <command> [options] [files...]

Commands:
  check [options] [files...]   Check for new errors (default: .)
  init [files...]              Create initial baseline (default: .)
  update [files...]            Update baseline with current errors (default: .)
  clear                        Remove baseline file
  status                       Show baseline information

Options for check:
  --write                        Apply fixes (like biome check --write)
  --skip-suppression-update      Don't update baseline on improvement
  --suppression-fail-on-improvement  Fail if fewer errors than baseline (CI mode)

Examples:
  bs check                       # Check only (default, like biome check)
  bs check --write               # Check and fix (like biome check --write)
  bs check --skip-suppression-update src/
  bs init
  bs update
      `);
      process.exit(1);
  }
}

// Error handling wrapper
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { checkCommand, parseGitHubErrors, createErrorFingerprint };
