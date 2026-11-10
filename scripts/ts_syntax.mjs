#!/usr/bin/env node
/**
 * Syntax-check TypeScript/TSX files using the project's typescript package.
 *
 * Usage: node scripts/ts_syntax.mjs FILE...
 *
 * Requires at least one FILE argument.
 * Exits 1 if any file has parse diagnostics, 0 otherwise.
 * Does NOT emit or execute code.
 */

import { createRequire } from "module";
import { resolve } from "path";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const files = process.argv.slice(2);

if (files.length === 0) {
  process.stderr.write("Usage: node scripts/ts_syntax.mjs FILE...\n");
  process.exit(1);
}

let hasErrors = false;

for (const file of files) {
  const absPath = resolve(file);
  let sourceText;
  try {
    sourceText = readFileSync(absPath, "utf-8");
  } catch (e) {
    process.stderr.write(`${file}: cannot read file: ${e.message}\n`);
    hasErrors = true;
    continue;
  }

  const ext = absPath.substring(absPath.lastIndexOf("."));
  const scriptKind =
    ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    absPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const diagnostics = sourceFile.parseDiagnostics;

  if (diagnostics && diagnostics.length > 0) {
    hasErrors = true;
    for (const diag of diagnostics) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        diag.start
      );
      const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
      process.stdout.write(
        `${file}:${line + 1}:${character + 1}: ${message}\n`
      );
    }
  }
}

process.exit(hasErrors ? 1 : 0);
