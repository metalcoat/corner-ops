import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Inside withTransaction, queries must go through the client getSql() returns there. A `sql` taken
// before the transaction starts runs on its own pool connection: those writes survive a rollback,
// and they can wait on the transaction's own row locks (the pickup/delivery switch hung orders this way).
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

function transactionsUsingOuterClient(source: string): number[] {
  const lines: number[] = [];
  for (let at = source.indexOf("withTransaction("); at !== -1; at = source.indexOf("withTransaction(", at + 1)) {
    const open = source.indexOf("{", at);
    let depth = 0, close = open;
    for (; close < source.length; close++) {
      if (source[close] === "{") depth++;
      else if (source[close] === "}" && --depth === 0) break;
    }
    const body = source.slice(open, close);
    if (/\bsql`/.test(body) && !/\bsql\s*=\s*getSql\(\)/.test(body)) lines.push(source.slice(0, at).split("\n").length);
  }
  return lines;
}

test("every transaction queries through its own client", () => {
  const offenders = sourceFiles("src").flatMap((file) => transactionsUsingOuterClient(readFileSync(file, "utf8")).map((line) => `${file}:${line}`));
  assert.deepEqual(offenders, []);
});

test("the check catches a transaction that uses a client taken before it starts", () => {
  assert.deepEqual(transactionsUsingOuterClient("const sql=getSql();\nawait withTransaction(async()=>{await sql`SELECT 1`});"), [2]);
  assert.deepEqual(transactionsUsingOuterClient("await withTransaction(async()=>{const sql=getSql();await sql`SELECT 1`});"), []);
});
