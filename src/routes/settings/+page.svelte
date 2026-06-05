<script lang="ts">
  import type { PageData } from './$types.js';
  let { data }: { data: PageData } = $props();
</script>

<h1>Settings</h1>

<section>
  <h2>Database</h2>
  <p class="b-mono b-mute2">{data.dbPath}</p>
</section>

<section>
  <h2>Users</h2>
  <p class="b-muted">First visitor becomes admin; everyone else is a viewer until promoted.</p>
  <table>
    <thead>
      <tr><th>Login</th><th>Role</th><th>Last seen</th></tr>
    </thead>
    <tbody>
      {#each data.users as u (u.login)}
        <tr>
          <td class="b-mono">{u.login}</td>
          <td>{u.role}</td>
          <td class="b-mono b-mute2">{u.last_seen?.toLocaleString() ?? '—'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</section>

<style>
  h1 { font-size: 22px; font-weight: 600; margin: 6px 0 8px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--b-text-3); font-weight: 600; }
  section { margin-top: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--b-border); }
  th { color: var(--b-text-2); font-weight: 500; font-size: 11px; text-transform: uppercase; }
</style>
