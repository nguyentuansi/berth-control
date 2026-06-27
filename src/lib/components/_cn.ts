// Minimal cn() — combines class names. Lifted from the same shadcn-svelte
// pattern @berth/ui uses, just inlined here so the vendored DataTable.svelte
// has zero @berth/ui-internal coupling.
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
