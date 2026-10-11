/**
 * JSON Lines files, the format of the history and the attribution: one JSON value per line, appended as the run goes. With
 * `History` (history.ts), this is the only code of src/evolve that touches the disk.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** The values of a JSONL file, one per non-empty line; `[]` when the file does not exist. A line that is not JSON throws, naming
 *  the file and the line (counted from 1). */
export function readJsonl(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const values: unknown[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${file} line ${i + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return values;
}

/** Appends one line per record, in one write, making the file's folder if it is missing. No record writes no file. */
export function appendJsonl(file: string, records: readonly object[]): void {
  mkdirSync(dirname(file), { recursive: true });
  if (records.length > 0) appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}
