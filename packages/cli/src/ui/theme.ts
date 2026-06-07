import { createColors } from "picocolors";

type Colors = ReturnType<typeof createColors>;

// picocolors auto-detects color support (TTY, NO_COLOR, FORCE_COLOR). We keep a
// live instance behind a Proxy so `--no-color` can flip it at runtime and every
// `color.*` call sees the change.
let active: Colors = createColors();

export function configureColor(enabled: boolean): void {
  active = createColors(enabled);
}

export const color: Colors = new Proxy({} as Colors, {
  get(_target, prop: string | symbol) {
    return active[prop as keyof Colors];
  },
});

export const symbols = {
  success: "✔",
  error: "✖",
  warn: "⚠",
  info: "ℹ",
  step: "▸",
} as const;
