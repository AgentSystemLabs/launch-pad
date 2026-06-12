import { nodeIdError } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../../errors";

const NUMERIC_SUFFIX = /^(.+)-(\d+)$/;

/**
 * Plan the node ids for `node create <name> --amount N`.
 * - `amount === 1`: the exact `baseName`
 * - `amount > 1`: sequential ids — `app` → `app-1`…`app-N`; `app-5` → `app-5`…`app-(5+N-1)`
 */
export function planNodeCreateNames(baseName: string, amount: number): string[] {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new CliError(`invalid --amount "${amount}"`, { hint: "pass a positive integer, e.g. --amount 3" });
  }
  if (amount === 1) return [baseName];

  const match = NUMERIC_SUFFIX.exec(baseName);
  const prefix = match?.[1] ?? baseName;
  const start = match?.[2] !== undefined ? Number.parseInt(match[2], 10) : 1;

  const names: string[] = [];
  for (let i = 0; i < amount; i += 1) {
    const name = `${prefix}-${start + i}`;
    const err = nodeIdError(name);
    if (err) {
      throw new CliError(`generated node name "${name}" is invalid — ${err}`, {
        hint: "pick a shorter base name or a lower --amount",
      });
    }
    names.push(name);
  }
  return names;
}

export function parseCreateAmount(raw: string | number | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`invalid --amount "${raw}"`, { hint: "pass a positive integer, e.g. --amount 3" });
  }
  return n;
}
