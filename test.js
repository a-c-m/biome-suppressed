#!/usr/bin/env node
const assert = require("node:assert/strict");
const { parseGitHubErrors, createErrorFingerprint } = require("./index.js");

// DELIBERATE ERRORS: The template literals below (lines 30 and 72) are intentionally
// used instead of regular strings to demonstrate biome-suppressed's error suppression.
// Biome's linter will flag these as style/noUnusedTemplateLiteral, allowing us to
// test baseline suppression functionality.

// Test counter
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    failed++;
  }
}

// Test parseGitHubErrors
test("parseGitHubErrors: parses valid GitHub error format", () => {
  const input =
    "::error title=lint/style/useNamingConvention,file=src/test.js,line=42,endLine=42,col=10,endColumn=20::Variable name should be camelCase";
  const result = parseGitHubErrors(input);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].rule, "lint/style/useNamingConvention");
  assert.strictEqual(result[0].file, "src/test.js");
  assert.strictEqual(result[0].line, 42);
  assert.strictEqual(result[0].message, "Variable name should be camelCase");
});

test("parseGitHubErrors: handles empty input", () => {
  const result = parseGitHubErrors("");
  assert.strictEqual(result.length, 0);
});

test("parseGitHubErrors: filters out non-error lines", () => {
  const input = `Some random output
::error title=rule1,file=file1.js,line=1,endLine=1,col=1,endColumn=1::message1
More random output
::error title=rule2,file=file2.js,line=2,endLine=2,col=1,endColumn=1::message2`;
  const result = parseGitHubErrors(input);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].rule, "rule1");
  assert.strictEqual(result[1].rule, "rule2");
});

test("parseGitHubErrors: sorts errors deterministically", () => {
  const input = `::error title=ruleB,file=b.js,line=2,endLine=2,col=1,endColumn=1::message
::error title=ruleA,file=a.js,line=1,endLine=1,col=1,endColumn=1::message
::error title=ruleC,file=a.js,line=2,endLine=2,col=1,endColumn=1::message`;
  const result = parseGitHubErrors(input);

  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].file, "a.js");
  assert.strictEqual(result[0].line, 1);
  assert.strictEqual(result[1].file, "a.js");
  assert.strictEqual(result[1].line, 2);
  assert.strictEqual(result[2].file, "b.js");
});

test("parseGitHubErrors: normalizes file paths with forward slashes", () => {
  const input =
    "::error title=rule1,file=src\\test\\file.js,line=1,endLine=1,col=1,endColumn=1::message";
  const result = parseGitHubErrors(input);

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].file, "src/test/file.js");
});

// Test createErrorFingerprint
test("createErrorFingerprint: creates consistent fingerprints", () => {
  const error1 = {
    file: "src/test.js",
    rule: "lint/style/useNamingConvention",
    line: 42,
    message: "Variable name should be camelCase",
  };
  const error2 = {
    file: "src/test.js",
    rule: "lint/style/useNamingConvention",
    line: 42,
    message: "Different message", // Message should not affect fingerprint
  };

  const fp1 = createErrorFingerprint(error1);
  const fp2 = createErrorFingerprint(error2);

  assert.strictEqual(fp1, fp2, "Fingerprints should match for same location");
  assert.strictEqual(fp1.length, 32, "MD5 hash should be 32 characters");
});

test("createErrorFingerprint: different errors have different fingerprints", () => {
  const error1 = {
    file: "src/test.js",
    rule: "lint/style/useNamingConvention",
    line: 42,
    message: "message",
  };
  const error2 = {
    file: "src/test.js",
    rule: "lint/style/useNamingConvention",
    line: 43, // Different line
    message: "message",
  };

  const fp1 = createErrorFingerprint(error1);
  const fp2 = createErrorFingerprint(error2);

  assert.notStrictEqual(
    fp1,
    fp2,
    "Different lines should have different fingerprints"
  );
});

test("createErrorFingerprint: normalizes backslashes in paths", () => {
  const error1 = {
    file: "src/test/file.js",
    rule: "rule1",
    line: 1,
    message: "msg",
  };
  const error2 = {
    file: "src\\test\\file.js",
    rule: "rule1",
    line: 1,
    message: "msg",
  };

  const fp1 = createErrorFingerprint(error1);
  const fp2 = createErrorFingerprint(error2);

  assert.strictEqual(
    fp1,
    fp2,
    "Paths with different separators should produce same fingerprint"
  );
});

// Integration test
test("Integration: parse and fingerprint multiple errors", () => {
  const githubOutput = `::error title=lint/suspicious/noExplicitAny,file=src/api.ts,line=10,endLine=10,col=20,endColumn=23::Avoid using any type
::error title=lint/style/useNamingConvention,file=src/utils.ts,line=5,endLine=5,col=10,endColumn=20::Use camelCase
::error title=lint/suspicious/noExplicitAny,file=src/types.ts,line=15,endLine=15,col=5,endColumn=8::Avoid using any type`;

  const errors = parseGitHubErrors(githubOutput);
  assert.strictEqual(errors.length, 3);

  const fingerprints = errors.map(createErrorFingerprint);
  assert.strictEqual(fingerprints.length, 3);
  assert.strictEqual(
    new Set(fingerprints).size,
    3,
    "All fingerprints should be unique"
  );
});

// Summary
console.log("");
console.log(`Test Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
