import { writable, get } from 'svelte/store';

export type ToastKind = 'info' | 'success' | 'error' | 'loading';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  /** 0 → sticky until dismissed. Otherwise auto-dismiss in this many ms. */
  durationMs: number;
}

const _toasts = writable<Toast[]>([]);
export const toasts = { subscribe: _toasts.subscribe };

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let counter = 0;

function arm(id: string, durationMs: number) {
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  if (durationMs > 0) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), durationMs)
    );
  }
}

function add(t: Omit<Toast, 'id'>): string {
  const id = `t${++counter}`;
  _toasts.update((arr) => [...arr, { ...t, id }]);
  arm(id, t.durationMs);
  return id;
}

export function dismiss(id: string): void {
  const tm = timers.get(id);
  if (tm) clearTimeout(tm);
  timers.delete(id);
  _toasts.update((arr) => arr.filter((x) => x.id !== id));
}

/** Replace a toast in-place — handy for upgrading a `loading` to `success`
 *  or `error`. If no toast with that id exists this is a no-op (the toast
 *  was already dismissed). */
export function update(id: string, patch: Partial<Omit<Toast, 'id'>>): void {
  const list = get(_toasts);
  if (!list.find((x) => x.id === id)) return;
  _toasts.update((arr) =>
    arr.map((x) => (x.id === id ? { ...x, ...patch } : x))
  );
  arm(id, patch.durationMs ?? get(_toasts).find((x) => x.id === id)!.durationMs);
}

export const toast = {
  info: (title: string, description?: string) =>
    add({ kind: 'info', title, description, durationMs: 4000 }),
  success: (title: string, description?: string) =>
    add({ kind: 'success', title, description, durationMs: 4000 }),
  /** Errors stick around longer — you usually want to read the description. */
  error: (title: string, description?: string) =>
    add({ kind: 'error', title, description, durationMs: 8000 }),
  /** A sticky toast for in-flight operations. Call `toast.update(id, ...)`
   *  with `kind: 'success' | 'error'` and a finite durationMs once done. */
  loading: (title: string, description?: string) =>
    add({ kind: 'loading', title, description, durationMs: 0 }),
  update,
  dismiss
};
