/**
 * editFile — the text replacement behind the `edit_file` tool.
 *
 * The model names an exact snippet. It must occur once (or the call sets
 * replace_all), so an ambiguous edit fails instead of changing the wrong place.
 * Models often send "\n" line endings for a "\r\n" file: a snippet that is not
 * found verbatim is retried with "\r\n".
 */

export type EditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; error: string };

function occurrences(text: string, snippet: string): number {
  let count = 0;
  for (let i = text.indexOf(snippet); i !== -1; i = text.indexOf(snippet, i + snippet.length)) count++;
  return count;
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): EditResult {
  if (oldString === "") return { ok: false, error: "old_string is empty. Use fs.write to create or overwrite a file." };
  if (oldString === newString) {
    return { ok: false, error: "old_string and new_string are the same, so there is nothing to change." };
  }
  let find = oldString;
  let replace = newString;
  let count = occurrences(content, find);
  if (count === 0 && content.includes("\r\n")) {
    find = find.replace(/\r?\n/g, "\r\n");
    replace = replace.replace(/\r?\n/g, "\r\n");
    count = occurrences(content, find);
  }
  if (count === 0) {
    return { ok: false, error: "old_string was not found. Read the file and copy the exact text, including whitespace and indentation." };
  }
  if (count > 1 && !replaceAll) {
    return { ok: false, error: `old_string occurs ${count} times. Include more surrounding lines so it is unique, or set replace_all to true.` };
  }
  // split/join instead of String.replace: "$&" and friends stay literal.
  return { ok: true, content: content.split(find).join(replace), replacements: count };
}
