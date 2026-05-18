#!/usr/bin/env node
/**
 * extract-ohmyPi.mjs — Extract conversations from Oh My Pi session JSONL logs
 *
 * Log location: ~/.omp/agent/sessions/<project-dir>/*.jsonl
 * Format: JSONL, session header + message entries per line
 *
 * Filters OUT:
 *   - Non-message entries (model_change, thinking_level_change, etc.)
 *   - Entries with empty text content
 *   - Projects that also exist in ~/.claude/projects/ (avoid dedup)
 *
 * Usage:
 *   node extract-ohmyPi.mjs --since <ISO> [--recent N] [--dry-run] [--output json]
 */

import { createReadStream } from "node:fs";
import { readdir, stat, access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const { values: args } = parseArgs({
  options: {
    since:       { type: "string" },
    recent:      { type: "string" },
    "max-turns": { type: "string" },
    "dry-run":   { type: "boolean", default: false },
    output:      { type: "string", default: "text" },
    help:        { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
});

if (args.help) {
  console.log(`Usage: node extract-ohmyPi.mjs [options]
Options:
  --since <ISO>    Only process files modified after this timestamp
  --recent <N>     Process N most recent session files (default: 5)
  --max-turns <n>  Max turns per session (default: 200)
  --output json    Output JSON array`);
  process.exit(0);
}

const maxTurns = args["max-turns"] ? parseInt(args["max-turns"], 10) : 200;
const sinceTime = args.since ? new Date(args.since).getTime() : 0;
const recentN = args.recent ? parseInt(args.recent, 10) : 5;

// ── JSONL Parsing ────────────────────────────────────────────────────────────

async function streamJsonl(filePath, handler) {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (handler(obj) === true) { rl.close(); stream.destroy(); return; }
    } catch { /* skip malformed lines */ }
  }
}

/**
 * Read just the first line of a JSONL file to get the session header.
 */
async function readSessionHeader(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    rl.close();
    stream.destroy();
    if (!line.trim()) break;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "session") return obj;
    } catch { /* skip */ }
    break;
  }
  return null;
}

/**
 * Extract text content from OMP message content array.
 * Skips thinking blocks and other non-text types.
 */
function extractMessageText(content) {
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text);
  return texts.join("\n").trim() || null;
}

async function extractSession(filePath) {
  const turns = [];
  const sessionId = basename(filePath, ".jsonl");

  await streamJsonl(filePath, (obj) => {
    // Only process message entries
    if (obj.type !== "message") return;
    if (maxTurns > 0 && turns.length >= maxTurns) return true;

    const role = obj.message?.role;
    if (role !== "user" && role !== "assistant") return;

    const text = extractMessageText(obj.message?.content);
    if (!text) return;

    turns.push({
      role,
      text,
      timestamp: obj.timestamp,
    });
  });

  return { agent: "ohmyPi", sessionId, filePath, turns };
}

// ── Dedup: skip sessions that overlap with Claude Code ───────────────────
// If the same conversation is recorded by both Oh My Pi and Claude Code (since
// OMP wraps Claude Code binary), only keep one copy. Detection is based on
// actual timestamp overlap, not just project directory existence.

/**
 * Get the time range [start, end] ms from a JSONL session file by reading
 * ALL entry timestamps (header, messages, model changes, etc.).
 */
async function getSessionTimeRange(filePath) {
  let minTs = Infinity, maxTs = -Infinity;
  try {
    const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
        if (ts && !isNaN(ts)) {
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
      } catch {/* skip parse errors */}
    }
  } catch {
    return null;
  }
  if (minTs === Infinity) return null;
  return { start: minTs, end: maxTs };
}

/**
 * Get all session time ranges from Claude Code for a given project directory.
 */
async function getClaudeSessionRanges(claudeDir) {
  const fullPath = join(CLAUDE_PROJECTS_DIR, claudeDir);
  try {
    const files = await readdir(fullPath);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.includes("/"));
    const ranges = [];
    for (const f of jsonlFiles) {
      const range = await getSessionTimeRange(join(fullPath, f));
      if (range) ranges.push(range);
    }
    return ranges;
  } catch {
    return [];
  }
}

/**
 * Check if two time ranges [aStart, aEnd] and [bStart, bEnd] overlap.
 */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}


// ── Session Discovery ────────────────────────────────────────────────────────

async function listProjectDirs() {
  try {
    const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function listSessionFiles(projectDir) {
  const fullDir = join(SESSIONS_DIR, projectDir);
  try {
    const files = await readdir(fullDir);
    const jsonl = files.filter((f) => f.endsWith(".jsonl"));
    const withStats = await Promise.all(jsonl.map(async (f) => {
      const fullPath = join(fullDir, f);
      try {
        const s = await stat(fullPath);
        const header = await readSessionHeader(fullPath);
        return { path: fullPath, mtime: s.mtime.getTime(), size: s.size, cwd: header?.cwd ?? null };
      } catch { return null; }
    }));
    return withStats.filter(Boolean);
  } catch { return []; }
}

async function getRecentSessions(n) {
  const dirs = await listProjectDirs();
  const all = [];
  for (const dir of dirs) {
    const sessions = await listSessionFiles(dir);
    all.push(...sessions);
  }

  // Apply sinceTime filter
  let filtered = sinceTime > 0 ? all.filter((s) => s.mtime > sinceTime) : all;

  // Dedup: skip Oh My Pi sessions whose time range overlaps with Claude Code
  // Only applies in scheduled/batch mode (sinceTime set) to avoid re-scanning
  // all Claude Code sessions on every --recent-only invocation.
  const dedupFiltered = sinceTime > 0 ? [] : filtered;
  if (sinceTime > 0) {
    const claudeCache = new Map();  // claudeDir → array of { start, end }
    for (const s of filtered) {
      if (s.cwd) {
        const claudeDir = s.cwd.replace(/\/+/g, "-");
        if (!claudeCache.has(claudeDir)) {
          claudeCache.set(claudeDir, await getClaudeSessionRanges(claudeDir));
        }
        const cRanges = claudeCache.get(claudeDir);
        if (cRanges.length > 0) {
          const ompRange = await getSessionTimeRange(s.path);
          if (ompRange) {
            let isDuplicate = false;
            for (const cr of cRanges) {
              if (rangesOverlap(ompRange.start, ompRange.end, cr.start, cr.end)) {
                isDuplicate = true;
                break;
              }
            }
            if (isDuplicate) continue;
          }
        }
      }
      dedupFiltered.push(s);
    }
  }
  dedupFiltered.sort((a, b) => b.mtime - a.mtime);
  return dedupFiltered.slice(0, n);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const sessions = await getRecentSessions(recentN);

  if (sessions.length === 0) {
    if (args.output === "json") {
      console.log(JSON.stringify([]));
    } else {
      console.error("No Oh My Pi sessions found.");
    }
    return;
  }

  const results = [];
  for (const session of sessions) {
    const data = await extractSession(session.path);
    if (data.turns.length > 0) results.push(data);
  }

  if (args.output === "json") {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      console.log(`\n[ohmyPi] Session: ${r.sessionId} (${r.turns.length} messages)`);
      for (const t of r.turns) {
        const preview = t.text.slice(0, 100);
        console.log(`  [${t.role}]: ${preview}...`);
      }
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
