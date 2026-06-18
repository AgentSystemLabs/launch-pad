import { SECRET_KEY_REGEX } from "@agentsystemlabs/launch-pad-shared";

/** One `KEY=VALUE` assignment parsed from a dotenv-style file. */
export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line where the assignment began (for error messages). */
  line: number;
}

export interface ParsedDotenv {
  entries: DotenvEntry[];
  /** 1-based line numbers of non-blank, non-comment lines that aren't `KEY=VALUE`. */
  malformed: number[];
}

const EXPORT_PREFIX = /^export\s+/;

/**
 * Parse a `.env`-style file. Deliberately faithful to secret values rather than
 * clever about comments: an UNQUOTED value is taken verbatim to end-of-line
 * (only outer whitespace trimmed) so a `#` inside a password or URL is preserved
 * — there is no inline-comment stripping for unquoted values. Wrap a value in
 * single or double quotes to keep leading/trailing spaces or span multiple lines
 * (private keys, certs). Double quotes expand `\n` `\r` `\t` `\\` `\"`; single
 * quotes are literal. `export ` prefixes and `#` full-line comments are ignored.
 */
export function parseDotenv(content: string): ParsedDotenv {
  const entries: DotenvEntry[] = [];
  const malformed: number[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const start = (lines[i] ?? "").trimStart();
    if (start === "" || start.startsWith("#")) continue;

    const assignment = start.replace(EXPORT_PREFIX, "");
    const eq = assignment.indexOf("=");
    // `eq <= 0` rejects both a missing `=` and a leading `=` (empty key).
    if (eq <= 0) {
      malformed.push(lineNo);
      continue;
    }

    const key = assignment.slice(0, eq).trim();
    const valuePart = assignment.slice(eq + 1).trimStart();
    const quote = valuePart[0];

    if (quote === '"' || quote === "'") {
      // Gather until the matching closing quote, consuming further lines if the
      // value is multi-line. `i` is advanced past the closing line.
      const collected: string[] = [];
      let segment = valuePart.slice(1);
      let cursor = i;
      let closed = false;
      for (;;) {
        const close = findClosingQuote(segment, quote);
        if (close !== -1) {
          collected.push(segment.slice(0, close));
          closed = true;
          break;
        }
        collected.push(segment);
        cursor++;
        if (cursor >= lines.length) break;
        segment = lines[cursor] ?? "";
      }
      i = cursor;
      if (!closed) {
        // Unterminated quote: flag the opening line rather than swallowing the
        // rest of the file (and any later KEY=VALUE pairs) into one secret value.
        malformed.push(lineNo);
        continue;
      }
      const body = collected.join("\n");
      entries.push({ key, value: quote === '"' ? unescapeDouble(body) : body, line: lineNo });
    } else {
      entries.push({ key, value: valuePart.trimEnd(), line: lineNo });
    }
  }

  return { entries, malformed };
}

/** Index of the next unescaped closing quote in `s`, or -1 if none on this line. */
function findClosingQuote(s: string, quote: string): number {
  if (quote === "'") return s.indexOf("'");
  for (let j = 0; j < s.length; j++) {
    if (s[j] === "\\") {
      j++; // skip the escaped character
      continue;
    }
    if (s[j] === '"') return j;
  }
  return -1;
}

function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_match, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c; // `"` or `\`
    }
  });
}

export interface SecretImportPlan {
  /** Importable pairs, deduped by key (last occurrence wins), in first-seen order. */
  valid: Array<{ key: string; value: string }>;
  /** Keys that aren't valid env-var identifiers. */
  invalidKeys: Array<{ key: string; line: number }>;
  /** Valid keys whose value is empty (SSM can't store an empty SecureString). */
  emptyValues: Array<{ key: string; line: number }>;
  /** Non-blank, non-comment lines that weren't `KEY=VALUE`. */
  malformed: number[];
  /** Keys that appeared more than once (last value won). */
  duplicates: string[];
}

/**
 * Classify parsed entries for a secret import. Pure — does no IO. The caller
 * decides policy (reject-all when any of malformed/invalidKeys/emptyValues is
 * non-empty); duplicates are tolerated (last value wins) and only reported.
 */
export function partitionSecretImportEntries(parsed: ParsedDotenv): SecretImportPlan {
  const invalidKeys: SecretImportPlan["invalidKeys"] = [];
  const emptyValues: SecretImportPlan["emptyValues"] = [];
  const byKey = new Map<string, string>();
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const e of parsed.entries) {
    if (!SECRET_KEY_REGEX.test(e.key)) {
      invalidKeys.push({ key: e.key, line: e.line });
      continue;
    }
    if (e.value.length === 0) {
      emptyValues.push({ key: e.key, line: e.line });
      continue;
    }
    if (seen.has(e.key)) duplicates.add(e.key);
    seen.add(e.key);
    byKey.set(e.key, e.value); // last write wins, original position retained
  }

  return {
    valid: [...byKey.entries()].map(([key, value]) => ({ key, value })),
    invalidKeys,
    emptyValues,
    malformed: parsed.malformed,
    duplicates: [...duplicates],
  };
}
