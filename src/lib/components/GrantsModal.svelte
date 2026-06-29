<script lang="ts">
  import { onMount } from 'svelte';
  import { X, UserPlus, Trash } from 'lucide-svelte';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/toast.js';

  // Per-app "who can see/manage this" modal. Lists every user with an
  // explicit grant + lets the owner add/remove logins. When the parent
  // passes `pendingVisibility`, save also flips the app's visibility mode
  // on apply — used by the "set to invited and pick the people" flow.

  type App = {
    id: string;
    name: string;
    visibility: 'private' | 'invited' | 'public';
    owner_login: string;
  };

  let {
    app,
    pendingVisibility,
    onClose
  }: {
    app: App;
    pendingVisibility: 'private' | 'invited' | 'public' | null;
    onClose: () => void;
  } = $props();

  type Grant = { user_login: string; granted_at: number; granted_by: string | null };

  let grants: Grant[] = $state([]);
  let newLogin = $state('');
  let busy = $state(false);

  async function load() {
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(app.id)}/grants`);
      if (r.ok) grants = (await r.json()).grants ?? [];
    } catch {
      /* */
    }
  }
  onMount(load);

  async function addGrant() {
    const login = newLogin.trim();
    if (!login) return;
    busy = true;
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(app.id)}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_login: login })
      });
      if (!r.ok) {
        toast.error('Grant failed', await r.text());
        return;
      }
      newLogin = '';
      await load();
    } finally {
      busy = false;
    }
  }

  async function removeGrant(login: string) {
    try {
      const r = await fetch(
        `/api/apps/${encodeURIComponent(app.id)}/grants/${encodeURIComponent(login)}`,
        { method: 'DELETE' }
      );
      if (r.ok) await load();
      else toast.error('Revoke failed', await r.text());
    } catch (e) {
      toast.error('Revoke failed', e instanceof Error ? e.message : String(e));
    }
  }

  async function commitPendingVisibility() {
    if (!pendingVisibility || pendingVisibility === app.visibility) return;
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(app.id)}/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: pendingVisibility })
      });
      if (!r.ok) toast.error('Visibility change failed', await r.text());
      else await invalidateAll();
    } catch {
      /* */
    }
  }

  async function close() {
    await commitPendingVisibility();
    onClose();
  }
</script>

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="g-title">
    <header>
      <h2 id="g-title">Access for {app.name}</h2>
      <button class="b-btn icon tiny" onclick={close} title="Close">
        <X size={12} />
      </button>
    </header>
    <div class="body">
      <p class="hint">
        Owner: <strong>{app.owner_login}</strong> · Current visibility:
        <strong>{pendingVisibility ?? app.visibility}</strong>
      </p>

      <form
        class="add"
        onsubmit={(e) => {
          e.preventDefault();
          void addGrant();
        }}
      >
        <input
          class="b-input"
          type="text"
          placeholder="user login (e.g. nguyentuansi or me@example.com)"
          bind:value={newLogin}
          disabled={busy}
        />
        <button class="b-btn primary" type="submit" disabled={busy || !newLogin.trim()}>
          <UserPlus size={13} /> Grant
        </button>
      </form>

      <ul class="grants">
        {#each grants as g (g.user_login)}
          <li>
            <span class="login">{g.user_login}</span>
            <button class="b-btn icon tiny" onclick={() => removeGrant(g.user_login)} title="Revoke">
              <Trash size={11} />
            </button>
          </li>
        {/each}
        {#if grants.length === 0}
          <li class="empty">No one else has been granted access yet.</li>
        {/if}
      </ul>
    </div>
    <footer>
      <button class="b-btn primary" onclick={close}>Done</button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .modal {
    width: 460px;
    max-width: 90vw;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--b-border);
  }
  header h2 {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
  }
  .body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hint {
    margin: 0;
    color: var(--b-text-2);
    font-size: 12px;
  }
  .add {
    display: flex;
    gap: 6px;
  }
  .add input {
    flex: 1;
  }
  ul.grants {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--b-border);
    border-radius: 6px;
    background: var(--b-surface-2);
    max-height: 220px;
    overflow: auto;
  }
  ul.grants li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    font-size: 12.5px;
    border-bottom: 1px solid var(--b-border);
  }
  ul.grants li:last-child {
    border-bottom: 0;
  }
  ul.grants li.empty {
    color: var(--b-text-3);
    justify-content: center;
    font-style: italic;
  }
  .login {
    font-family: var(--b-mono);
    font-size: 12px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--b-border);
    background: var(--b-surface-2);
  }
</style>
