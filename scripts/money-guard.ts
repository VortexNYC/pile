import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const MONEY_KEYWORDS = new Set([
  "amount",
  "balance",
  "billing",
  "budget",
  "commission",
  "cost",
  "credit",
  "currency",
  "debit",
  "discount",
  "fee",
  "invoice",
  "money",
  "payment",
  "price",
  "refund",
  "salary",
  "subtotal",
  "tax",
  "tip",
  "total",
  "wallet",
]);

const DINERO_IMPORT_RE =
  /from\s+["'](?:dinero(?:\.js)?(?:\/[^"']*)?|\.{0,2}\/platform\/money)["']|import\s+["'](?:dinero(?:\.js)?(?:\/[^"']*)?|\.{0,2}\/platform\/money)["']/;

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "migrations",
  "drizzle",
]);

const EXCLUDED_FILES = new Set([
  path.join(root, "src", "platform", "money.ts"),
  path.join(root, "scripts", "money-guard.ts"),
  path.join(root, "src", "mcp", "mcp-tools.ts"),
  path.join(root, "packages", "client", "src", "types.ts"),
]);

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !EXCLUDED_FILES.has(full)
    ) {
      files.push(full);
    }
  }
  return files;
}

function stripStringsAndComments(content: string): string {
  return (
    content
      // Single-quoted, double-quoted, and template strings (simple, no nested)
      .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, " ")
      // Single-line comments
      .replace(/\/\/.*$/gm, " ")
      // Multi-line comments
      .replace(/\/\*[\s\S]*?\*\//g, " ")
  );
}

function hasMoneyWord(content: string): boolean {
  const stripped = stripStringsAndComments(content);
  const tokens = stripped.split(/[^a-zA-Z0-9_]+/);
  for (const token of tokens) {
    if (!token) continue;
    // Split snake_case and CamelCase / PascalCase tokens into segments.
    const segments = token
      .split("_")
      .flatMap((part) => part.split(/(?=[A-Z])/));
    for (const segment of segments) {
      if (MONEY_KEYWORDS.has(segment.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function hasDineroImport(content: string): boolean {
  return DINERO_IMPORT_RE.test(content);
}

const sourceDirs = [path.join(root, "src"), path.join(root, "packages")];
const files = sourceDirs.flatMap((dir) => walk(dir));
const violations: string[] = [];

for (const file of files) {
  const rel = path.relative(root, file);
  const content = fs.readFileSync(file, "utf8");
  if (hasMoneyWord(content) && !hasDineroImport(content)) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error(
    "money-guard: files with monetary terms must import dinero.js or src/platform/money.ts:"
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log("money-guard: no raw monetary math detected");
