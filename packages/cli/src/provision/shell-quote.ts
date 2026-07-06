/** Quote one value as a single shell word for generated bash scripts. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
