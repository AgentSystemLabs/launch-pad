export type SecretOutputFormat = "value" | "shell" | "json";

/** Escape a value for POSIX single-quoted shell strings. */
export function shellEscapeSecret(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function formatSecretOutput(
  key: string,
  value: string,
  format: SecretOutputFormat,
): string {
  switch (format) {
    case "value":
      return value;
    case "shell":
      return `export ${key}=${shellEscapeSecret(value)}`;
    case "json":
      return JSON.stringify({ key, value });
  }
}

export function parseSecretFormat(raw: string | undefined): SecretOutputFormat {
  const format = raw ?? "value";
  if (format === "value" || format === "shell" || format === "json") {
    return format;
  }
  throw new Error(`invalid format: ${format}`);
}
