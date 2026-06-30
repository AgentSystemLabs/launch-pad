export function confirmSubmit(message: string): string {
  return `return confirm(${JSON.stringify(message)})`;
}
