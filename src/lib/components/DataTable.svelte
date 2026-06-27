<script lang="ts" generics="T extends Record<string, any>">
	// Vendored from @berth/ui v0.1.0's DataTable.svelte (MIT, attribution
	// in LICENSE-THIRD-PARTY.md). The library is migrating to a TanStack-
	// backed Layer 3 DataTable; we hold a self-contained copy here until
	// that lands so the dashboard keeps working through the transition.
	import type { Snippet } from 'svelte';
	import { cn } from './_cn.js';

	type SortDir = 'asc' | 'desc' | null;

	type Column<T> = {
		key: keyof T & string;
		label: string;
		sortable?: boolean;
		align?: 'left' | 'right' | 'center';
		width?: string;
		/** Optional CSS class applied to every cell in this column — used
		 *  by the consumer to attach width/typography overrides. */
		class?: string;
		render?: Snippet<[T]>;
	};

	let {
		rows,
		columns,
		pageSize = 10,
		filterable = true,
		filterPlaceholder = 'Filter rows…',
		class: className = '',
		emptyMessage = 'No rows.',
		rowClass,
	}: {
		rows: T[];
		columns: Column<T>[];
		pageSize?: number;
		filterable?: boolean;
		filterPlaceholder?: string;
		class?: string;
		emptyMessage?: string;
		/** Per-row class hook. Lets the consumer mark sub-app rows,
		 *  collapsed-folder rows, dim/inactive rows, etc. without needing
		 *  to fork the table. Without this, every consumer-supplied class
		 *  on the rows is silently lost. */
		rowClass?: (row: T, index: number) => string;
	} = $props();

	let filter = $state('');
	let sortKey = $state<string | null>(null);
	let sortDir = $state<SortDir>(null);
	let page = $state(1);

	const filtered = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return rows;
		return rows.filter((r) =>
			columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)),
		);
	});

	const sorted = $derived.by(() => {
		if (!sortKey || !sortDir) return filtered;
		const dir = sortDir === 'asc' ? 1 : -1;
		return [...filtered].sort((a, b) => {
			const av = a[sortKey as keyof T];
			const bv = b[sortKey as keyof T];
			if (av === bv) return 0;
			if (av === null || av === undefined) return 1;
			if (bv === null || bv === undefined) return -1;
			return av < bv ? -dir : dir;
		});
	});

	const pageCount = $derived(Math.max(1, Math.ceil(sorted.length / pageSize)));
	const visible = $derived(sorted.slice((page - 1) * pageSize, page * pageSize));

	$effect(() => { if (page > pageCount) page = 1; });

	function cycleSort(key: string) {
		if (sortKey !== key) { sortKey = key; sortDir = 'asc'; return; }
		if (sortDir === 'asc') sortDir = 'desc';
		else if (sortDir === 'desc') { sortKey = null; sortDir = null; }
		else sortDir = 'asc';
	}
</script>

<div class={cn('w-full', className)}>
	{#if filterable}
		<div class="mb-3 max-w-sm">
			<div class="relative">
				<input
					type="search"
					bind:value={filter}
					placeholder={filterPlaceholder}
					class="w-full h-9 rounded-ui-md border border-ui-input bg-transparent pl-9 pr-3 text-sm text-ui-foreground placeholder-ui-muted-foreground shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ui-ring/40 focus-visible:border-ui-ring"
				/>
				<span class="absolute left-3 top-1/2 -translate-y-1/2 text-ui-muted-foreground text-sm">🔍</span>
			</div>
		</div>
	{/if}

	<div class="rounded-ui-lg border border-ui-border overflow-x-auto">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b border-ui-border bg-ui-muted">
					{#each columns as col}
						<th
							class={cn(
								'h-10 px-3 text-xs uppercase tracking-wide font-medium text-ui-muted-foreground',
								col.align === 'right' && 'text-right',
								col.align === 'center' && 'text-center',
								col.align !== 'right' && col.align !== 'center' && 'text-left',
							)}
							style={col.width ? `width: ${col.width}` : undefined}
						>
							{#if col.sortable}
								<button
									type="button"
									onclick={() => cycleSort(col.key)}
									class="inline-flex items-center gap-1 hover:text-ui-foreground transition-colors"
								>
									{col.label}
									<span class="text-[8px] opacity-70">
										{#if sortKey === col.key && sortDir === 'asc'}▲
										{:else if sortKey === col.key && sortDir === 'desc'}▼
										{:else}⇅{/if}
									</span>
								</button>
							{:else}
								{col.label}
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each visible as row, i}
					<tr
						class={cn(
							'border-b border-ui-border last:border-b-0 hover:bg-ui-accent/30 transition-colors',
							rowClass?.(row, i),
						)}
					>
						{#each columns as col}
							<td
								class={cn(
									'h-12 px-3 text-ui-foreground/90',
									col.align === 'right' && 'text-right',
									col.align === 'center' && 'text-center',
									col.class,
								)}
							>
								{#if col.render}{@render col.render(row)}{:else}{row[col.key]}{/if}
							</td>
						{/each}
					</tr>
				{/each}
				{#if visible.length === 0}
					<tr>
						<td colspan={columns.length} class="px-3 py-8 text-center text-ui-muted-foreground text-sm">
							{emptyMessage}
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</div>

	{#if pageCount > 1}
		<div class="flex items-center justify-between mt-3 text-xs text-ui-muted-foreground">
			<span>
				Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} of {sorted.length}
			</span>
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => (page = Math.max(1, page - 1))}
					disabled={page <= 1}
					class="h-8 px-3 rounded-ui-md border border-ui-border text-ui-foreground hover:bg-ui-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
				>‹ Prev</button>
				<span class="px-3 text-ui-foreground tabular-nums">{page} / {pageCount}</span>
				<button
					type="button"
					onclick={() => (page = Math.min(pageCount, page + 1))}
					disabled={page >= pageCount}
					class="h-8 px-3 rounded-ui-md border border-ui-border text-ui-foreground hover:bg-ui-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
				>Next ›</button>
			</div>
		</div>
	{/if}
</div>
