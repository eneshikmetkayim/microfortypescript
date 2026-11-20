#!/usr/bin/env node
/**
 * Conformance audit.
 *
 * Verifies the port matrix against the worktree, runs the whole test suite and
 * writes a report the CI workflow uploads as an artifact. Exits non-zero when
 * a "ported" module lacks source/test evidence or when tests fail.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

interface MatrixEntry {
  id: string;
  microsip: string;
  module: string | null;
  tests: string[];
  status: "ported" | "adapted" | "not-portable" | "pending";
  notes?: string;
}

interface Matrix {
  microsipVersion: string;
  entries: MatrixEntry[];
}

const root = process.cwd();
const matrixPath = resolve(root, "docs/port-matrix.json");
if (!existsSync(matrixPath)) {
  console.error(`missing ${matrixPath}`);
  process.exit(2);
}
const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Matrix;

const problems: string[] = [];
const rows: Array<MatrixEntry & { sourceLines: number; testCount: number }> = [];

function countTests(file: string): number {
  const text = readFileSync(resolve(root, file), "utf8");
  return (text.match(/^test\(/gm) ?? []).length;
}

for (const entry of matrix.entries) {
  let sourceLines = 0;
  let testCount = 0;

  if (entry.status === "ported" || entry.status === "adapted") {
    if (entry.module) {
      const modulePath = resolve(root, entry.module);
      if (!existsSync(modulePath)) {
        problems.push(`${entry.id}: module missing (${entry.module})`);
      } else {
        sourceLines = readFileSync(modulePath, "utf8").split("\n").length;
      }
    } else if (entry.status === "ported") {
      problems.push(`${entry.id}: ported entry without a module`);
    }

    if (entry.status === "ported" && entry.tests.length === 0) {
      problems.push(`${entry.id}: ported entry without tests`);
    }
    for (const testFile of entry.tests) {
      const path = resolve(root, testFile);
      if (!existsSync(path) || !statSync(path).isFile()) {
        problems.push(`${entry.id}: test file missing (${testFile})`);
        continue;
      }
      testCount += countTests(testFile);
      if (countTests(testFile) === 0) problems.push(`${entry.id}: ${testFile} has no test() calls`);
    }
  }

  rows.push({ ...entry, sourceLines, testCount });
}

// ------------------------------------------------------------------ test run

const run = spawnSync(
  process.execPath,
  ["--test", "tests/**/*.test.ts", "--test-reporter=tap"],
  { cwd: root, encoding: "utf8", timeout: 10 * 60 * 1000 },
);
const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const pass = Number(/# pass (\d+)/.exec(output)?.[1] ?? 0);
const fail = Number(/# fail (\d+)/.exec(output)?.[1] ?? 0);
const testsTotal = Number(/# tests (\d+)/.exec(output)?.[1] ?? pass + fail);

if (run.status !== 0 || fail > 0) {
  problems.push(`test suite failed (${fail} failing of ${testsTotal})`);
}

// -------------------------------------------------------------------- report

const ported = rows.filter((row) => row.status === "ported");
const adapted = rows.filter((row) => row.status === "adapted");
const notPortable = rows.filter((row) => row.status === "not-portable");
const pending = rows.filter((row) => row.status === "pending");
const covered = rows.filter((row) => row.testCount > 0);
const totalTests = rows.reduce((sum, row) => sum + row.testCount, 0);

const report = [
  `# ${matrix.entries.length ? "MicroSIP → TypeScript" : ""} conformance audit`,
  "",
  `- MicroSIP reference: **${matrix.microsipVersion}**`,
  `- Generated: ${new Date().toISOString()}`,
  `- Node: ${process.version}`,
  "",
  "## Summary",
  "",
  `| Metric | Value |`,
  `| --- | --- |`,
  `| Matrix entries | ${rows.length} |`,
  `| Ported | ${ported.length} |`,
  `| Adapted | ${adapted.length} |`,
  `| Not portable (documented) | ${notPortable.length} |`,
  `| Pending | ${pending.length} |`,
  `| Entries with tests | ${covered.length} |`,
  `| test() declarations in matrix files | ${totalTests} |`,
  `| Executed tests | ${testsTotal} (${pass} pass, ${fail} fail) |`,
  "",
  "## Matrix",
  "",
  "| ID | Status | Source lines | Tests | MicroSIP origin |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| \`${row.id}\` | ${row.status} | ${row.sourceLines || "-"} | ${row.testCount || "-"} | ${row.microsip.replace(/\|/g, "\\|")} |`,
  ),
  "",
  "## Gaps",
  "",
  ...(problems.length
    ? problems.map((problem) => `- ❌ ${problem}`)
    : ["- ✅ No gaps: every ported entry has source and test evidence, suite green."]),
  "",
  "## Not portable (accepted)",
  "",
  ...notPortable.map((row) => `- \`${row.id}\` — ${row.notes ?? row.microsip}`),
  "",
];

const markdown = report.join("\n");
writeFileSync(resolve(root, "audit-report.md"), markdown, "utf8");
writeFileSync(
  resolve(root, "audit-report.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      microsipVersion: matrix.microsipVersion,
      node: process.version,
      totals: {
        entries: rows.length,
        ported: ported.length,
        adapted: adapted.length,
        notPortable: notPortable.length,
        pending: pending.length,
        tests: testsTotal,
        pass,
        fail,
      },
      rows,
      problems,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(markdown);
if (problems.length) {
  console.error(`audit failed with ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("audit passed");
