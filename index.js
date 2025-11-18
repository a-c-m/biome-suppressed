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
    if (
      error.signal === "SIGPIPE" ||
      (error.stderr && error.stderr.includes("Broken pipe"))
    ) {
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
      normalizedFile = normalizedFile.replace(/\\/g, "/");

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
    if (a.message !== b.message) return a.message.localeCompare(b.message);
    return 0;
  });
}

// Create stable fingerprint for error
function createErrorFingerprint(error) {
  // Ensure deterministic fingerprints by normalizing path separators
  const normalizedFile = error.file.replace(/\\/g, "/");
  const fingerprintData = `${normalizedFile}:${error.rule}:${error.line}`;
  return crypto.createHash("md5").update(fingerprintData).digest("hex");
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
    if (a.message !== b.message) return a.message.localeCompare(b.message);
    return 0;
  });

  const baseline = {
    biomeVersion: getBiomeVersion(),
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
    .map((file) => {
      // Quote paths with spaces
      if (file.includes(" ") && !file.startsWith('"')) {
        return `"${file}"`;
      }
      return file;
    })
    .filter((file) => {
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
  console.error(`Fix the issues then run: npx biome check --write ${files.join(" ")}`);
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
  if (currentErrors.length < baseline.fingerprints.length) {
    console.log(
      `🎉 Improvement detected! ${baseline.fingerprints.length} → ${currentErrors.length} error${currentErrors.length === 1 ? "" : "s"} (-${baseline.fingerprints.length - currentErrors.length})`
    );

    if (suppressionFailOnImprovement) {
      console.error(
        "❌ Unexpected improvement detected in CI mode (--suppression-fail-on-improvement)"
      );
      console.error("   Fix the errors, then update the suppression with `yarn bs --write`");
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
    `Baseline: ${baseline.fingerprints.length} error${baseline.fingerprints.length === 1 ? "" : "s"}, Current: ${currentErrors.length} error${currentErrors.length === 1 ? "" : "s"}`
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
          `📊 Baseline: ${baseline.fingerprints.length} error${baseline.fingerprints.length === 1 ? "" : "s"}`
        );
        console.log(`🔧 Biome version: ${baseline.biomeVersion}`);
        // Show file timestamp instead
        try {
          const stats = fs.statSync(".biome-suppressed.json");
          console.log(`📅 Last updated: ${stats.mtime.toISOString()}`);
        } catch {}
      } else {
        console.log("ℹ️  No baseline found");
      }
      process.exit(0);
    }

    case "chart": {
      const outputFile = args[0] || "biome-suppressions-chart.html";
      console.log("📊 Generating Biome Suppressions Chart...");

      try {
        // Check for required commands
        try {
          execSync("which git", { stdio: "ignore" });
          execSync("which jq", { stdio: "ignore" });
        } catch {
          console.error("❌ Error: This command requires 'git' and 'jq' to be installed.");
          console.error("   Install jq: brew install jq (macOS) or apt-get install jq (Ubuntu)");
          process.exit(1);
        }

        console.log("📖 Reading git history of .biome-suppressed.json...");

        // Get git commits for .biome-suppressed.json
        const commitsOutput = execSync(
          'git log --all --pretty=format:"%H|%ci|%an" --follow -- .biome-suppressed.json',
          { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
        ).trim();

        if (!commitsOutput) {
          console.error("❌ No git history found for .biome-suppressed.json");
          console.error("   Make sure you're in a git repository with .biome-suppressed.json committed.");
          process.exit(1);
        }

        const commits = commitsOutput.split("\n");
        const data = [];
        let prevErrors = 0;

        for (const line of commits) {
          if (!line.trim()) continue;
          const [commit, date, author] = line.split("|");

          try {
            const errorCount = parseInt(
              execSync(
                `git show ${commit}:.biome-suppressed.json | jq '.fingerprints | length'`,
                { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
              ).trim(),
              10
            );

            if (errorCount > 0) {
              const change = prevErrors !== 0 ? errorCount - prevErrors : 0;
              data.push({ date, commit, author, errors: errorCount, change });
              prevErrors = errorCount;
            }
          } catch {
            // Skip commits where file doesn't exist or is invalid
          }
        }

        data.reverse(); // Chronological order
        console.log(`✅ Extracted ${data.length} data points from git history`);

        if (data.length === 0) {
          console.error("❌ No valid data found in git history");
          process.exit(1);
        }

        // Calculate leaderboards
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

        function aggregateByAuthor(dataset) {
          const stats = {};
          dataset.forEach((item) => {
            if (!item.change) return;
            if (!stats[item.author]) {
              stats[item.author] = { added: 0, removed: 0, net: 0, commits: 0 };
            }
            if (item.change > 0) {
              stats[item.author].added += item.change;
            } else {
              stats[item.author].removed += Math.abs(item.change);
            }
            stats[item.author].net += item.change;
            stats[item.author].commits++;
          });
          return Object.entries(stats).map(([author, data]) => ({ author, ...data }));
        }

        const allTimeStats = aggregateByAuthor(data);
        const recentData = data.filter((d) => new Date(d.date) >= oneMonthAgo);
        const lastMonthStats = aggregateByAuthor(recentData);

        const leaderboards = {
          allTime: {
            heroes: allTimeStats.sort((a, b) => b.removed - a.removed).slice(0, 10),
            villains: allTimeStats.sort((a, b) => b.added - a.added).slice(0, 10),
          },
          lastMonth: {
            heroes: lastMonthStats.sort((a, b) => b.removed - a.removed).slice(0, 10),
            villains: lastMonthStats.sort((a, b) => b.added - a.added).slice(0, 10),
          },
        };

        console.log("✅ Calculated leaderboards");

        // Generate HTML (minified template)
        const chartData = data.map((d) => `${d.date},${d.errors},${d.author},${d.change}`).join("\\n");
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Biome Suppressions Over Time</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script><script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px}.container{max-width:1600px;margin:0 auto;background:white;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);padding:40px}h1{color:#333;margin-bottom:10px;font-size:2.5em;text-align:center}h2{color:#555;margin:40px 0 20px 0;font-size:1.8em;border-bottom:3px solid #667eea;padding-bottom:10px}.subtitle{text-align:center;color:#666;margin-bottom:30px;font-size:1.1em}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:40px}.stat-card{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:25px;border-radius:12px;box-shadow:0 4px 15px rgba(0,0,0,0.1)}.stat-card h3{font-size:0.9em;opacity:0.9;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}.stat-card .value{font-size:2.5em;font-weight:bold}.stat-card .change{font-size:0.9em;margin-top:8px;opacity:0.9}.chart-container{position:relative;height:400px;margin-bottom:40px}.leaderboards{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:30px;margin-bottom:40px}.leaderboard{background:#f8f9fa;border-radius:12px;padding:25px;box-shadow:0 2px 10px rgba(0,0,0,0.05)}.leaderboard h3{color:#333;margin-bottom:20px;font-size:1.3em;display:flex;align-items:center;gap:10px}.leaderboard-table{width:100%;border-collapse:collapse}.leaderboard-table th{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:12px 8px;text-align:left;font-size:0.85em;text-transform:uppercase;letter-spacing:0.5px}.leaderboard-table td{padding:12px 8px;border-bottom:1px solid #e0e0e0}.leaderboard-table tr:hover{background:#f0f0f0}.leaderboard-table tr:last-child td{border-bottom:none}.rank{font-weight:bold;color:#667eea;font-size:1.1em}.author{font-weight:500}.number{text-align:right;font-family:'Courier New',monospace}.positive{color:#10b981}.negative{color:#ef4444}.neutral{color:#6b7280}.section{margin-bottom:60px}.footer{text-align:center;color:#999;font-size:0.9em;margin-top:30px;padding-top:20px;border-top:1px solid #eee}.trend{display:inline-flex;align-items:center;gap:5px}.medal{font-size:1.5em}</style></head><body><div class="container"><h1>📊 Biome Suppressions Tracker</h1><p class="subtitle">Tracking suppressed linting errors in .biome-suppressed.json</p><div class="stats"><div class="stat-card"><h3>Current Count</h3><div class="value" id="current-count">-</div><div class="change">As of <span id="current-date">-</span></div></div><div class="stat-card"><h3>Peak Count</h3><div class="value" id="peak-count">-</div><div class="change">On <span id="peak-date">-</span></div></div><div class="stat-card"><h3>Total Reduction</h3><div class="value trend" id="total-change">-</div><div class="change">Since tracking started</div></div><div class="stat-card"><h3>Commits Tracked</h3><div class="value" id="commit-count">-</div><div class="change">Historical data points</div></div></div><div class="section"><h2>📅 Last 4 Weeks</h2><div class="chart-container"><canvas id="lastMonthChart"></canvas></div><div class="leaderboards"><div class="leaderboard"><h3><span class="medal">🏆</span> Top Error Removers</h3><table class="leaderboard-table"><thead><tr><th style="width:40px">#</th><th>Author</th><th class="number">Removed</th><th class="number">Net</th></tr></thead><tbody id="lastMonthHeroes"></tbody></table></div><div class="leaderboard"><h3><span class="medal">⚠️</span> Top Error Adders</h3><table class="leaderboard-table"><thead><tr><th style="width:40px">#</th><th>Author</th><th class="number">Added</th><th class="number">Net</th></tr></thead><tbody id="lastMonthVillains"></tbody></table></div></div></div><div class="section"><h2>📈 All Time</h2><div class="chart-container"><canvas id="allTimeChart"></canvas></div><div class="leaderboards"><div class="leaderboard"><h3><span class="medal">🏆</span> All-Time Top Error Removers</h3><table class="leaderboard-table"><thead><tr><th style="width:40px">#</th><th>Author</th><th class="number">Removed</th><th class="number">Net</th></tr></thead><tbody id="allTimeHeroes"></tbody></table></div><div class="leaderboard"><h3><span class="medal">⚠️</span> All-Time Top Error Adders</h3><table class="leaderboard-table"><thead><tr><th style="width:40px">#</th><th>Author</th><th class="number">Added</th><th class="number">Net</th></tr></thead><tbody id="allTimeVillains"></tbody></table></div></div></div><div class="footer">Generated from git history of .biome-suppressed.json | Last updated: <span id="generated-time"></span></div></div><script>const embeddedData=\`${chartData}\`;function parseData(){const lines=embeddedData.trim().split('\\n');return lines.map(line=>{const parts=line.split(',');return{date:new Date(parts[0]),errors:parseInt(parts[1]),author:parts[2],change:parseInt(parts[3])||0}}).filter(d=>d.errors>0)}const data=parseData();const fourWeeksAgo=new Date();fourWeeksAgo.setDate(fourWeeksAgo.getDate()-28);const recentData=data.filter(d=>d.date>=fourWeeksAgo);const leaderboardData=${JSON.stringify(leaderboards)};const currentCount=data[data.length-1].errors;const currentDate=data[data.length-1].date.toLocaleDateString();const peakData=data.reduce((max,d)=>d.errors>max.errors?d:max,data[0]);const oldestCount=data[0].errors;const totalChange=currentCount-oldestCount;document.getElementById('current-count').textContent=currentCount.toLocaleString();document.getElementById('current-date').textContent=currentDate;document.getElementById('peak-count').textContent=peakData.errors.toLocaleString();document.getElementById('peak-date').textContent=peakData.date.toLocaleDateString();const changeElement=document.getElementById('total-change');const changeText=Math.abs(totalChange).toLocaleString();const changeIcon=totalChange<0?'↓':'↑';const changeClass=totalChange<0?'negative':'positive';changeElement.innerHTML=\`<span class="\${changeClass}">\${changeIcon} \${changeText}</span>\`;document.getElementById('commit-count').textContent=data.length.toLocaleString();document.getElementById('generated-time').textContent=new Date().toLocaleString();function createChart(canvasId,chartData,title){const ctx=document.getElementById(canvasId).getContext('2d');return new Chart(ctx,{type:'line',data:{labels:chartData.map(d=>d.date),datasets:[{label:'Suppressed Errors',data:chartData.map(d=>d.errors),borderColor:'rgb(102, 126, 234)',backgroundColor:'rgba(102, 126, 234, 0.1)',borderWidth:2,fill:true,tension:0.4,pointRadius:2,pointHoverRadius:6,pointBackgroundColor:'rgb(102, 126, 234)',pointBorderColor:'#fff',pointBorderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},plugins:{legend:{display:false},title:{display:false},tooltip:{backgroundColor:'rgba(0, 0, 0, 0.8)',padding:12,callbacks:{label:function(context){const idx=context.dataIndex;const d=chartData[idx];const changeText=d.change===0?'No change':d.change>0?\`+\${d.change.toLocaleString()}\`:\`\${d.change.toLocaleString()}\`;const changeIcon=d.change<0?'✅':d.change>0?'⚠️':'➖';return[\`Errors: \${context.parsed.y.toLocaleString()}\`,\`Change: \${changeIcon} \${changeText}\`,\`Author: \${d.author}\`]}}}},scales:{x:{type:'time',time:{unit:'day',displayFormats:{day:'MMM d'}},grid:{display:false},ticks:{maxRotation:0,autoSkipPadding:20}},y:{beginAtZero:false,grid:{color:'rgba(0, 0, 0, 0.05)'},ticks:{callback:function(value){return value.toLocaleString()}}}}}})}createChart('lastMonthChart',recentData,'Last 4 Weeks');createChart('allTimeChart',data,'All Time');function populateLeaderboard(tableId,leaders,isHeroes){const tbody=document.getElementById(tableId);tbody.innerHTML=leaders.map((leader,i)=>{const netClass=leader.net<0?'negative':leader.net>0?'positive':'neutral';const netSign=leader.net>0?'+':'';const mainStat=isHeroes?leader.removed:leader.added;return\`<tr><td class="rank">\${i+1}</td><td class="author">\${leader.author}</td><td class="number">\${mainStat.toLocaleString()}</td><td class="number \${netClass}">\${netSign}\${leader.net.toLocaleString()}</td></tr>\`}).join('')}populateLeaderboard('lastMonthHeroes',leaderboardData.lastMonth.heroes,true);populateLeaderboard('lastMonthVillains',leaderboardData.lastMonth.villains,false);populateLeaderboard('allTimeHeroes',leaderboardData.allTime.heroes,true);populateLeaderboard('allTimeVillains',leaderboardData.allTime.villains,false)</script></body></html>`;

        fs.writeFileSync(outputFile, html, "utf8");
        console.log(`✅ Generated chart: ${outputFile}`);
        console.log("\n🎉 Done! Open the file in your browser to view.");

        // Print summary
        const current = data[data.length - 1];
        const peak = data.reduce((max, d) => (d.errors > max.errors ? d : max), data[0]);
        console.log("\n📊 Summary:");
        console.log(`   Current: ${current.errors.toLocaleString()} suppressions`);
        console.log(`   Peak: ${peak.errors.toLocaleString()} suppressions`);
        console.log(`   Reduction: ${((1 - current.errors / peak.errors) * 100).toFixed(1)}%`);

        process.exit(0);
      } catch (error) {
        console.error(`❌ Error generating chart: ${error.message}`);
        process.exit(1);
      }
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
  chart [output-file]          Generate HTML chart from git history (requires git and jq)

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
  bs chart                       # Generate chart as biome-suppressions-chart.html
  bs chart my-chart.html         # Generate chart with custom filename
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
