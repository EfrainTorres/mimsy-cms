<script>
  import { onDestroy, untrack } from 'svelte';

  let {
    collection,
    slug,
    isDataCollection = false,
    open = $bindable(false),
    onrestore,  // (frontmatter, body) => void
    revision = 0,  // incremented by parent on each successful save
  } = $props();

  // Plain var (not $state) — tracks which revision was last fetched.
  // -1 ensures the first open always fetches.
  let fetchedRevision = -1;

  // State
  let versions = $state([]);
  let loading = $state(false);
  let hasMore = $state(false);
  let noGit = $state(false);

  let selectedVersion = $state(null);
  let diff = $state(null);
  let diffLoading = $state(false);
  let diffError = $state('');

  // Group consecutive saves by same author within 5 minutes
  let groupedVersions = $derived(groupVersions(versions));

  function groupVersions(vs) {
    if (!vs.length) return [];
    const groups = [];
    let group = [vs[0]];
    for (let i = 1; i < vs.length; i++) {
      const prev = vs[i - 1];
      const curr = vs[i];
      // Prefer email or GitHub login as stable identity — display names can collide.
      const identity = (a) => a.email || a.login || a.name;
      const sameAuthor = identity(prev.author) === identity(curr.author);
      const withinWindow = new Date(prev.date) - new Date(curr.date) < 5 * 60 * 1000;
      if (sameAuthor && withinWindow) {
        group.push(curr);
      } else {
        groups.push(group);
        group = [curr];
      }
    }
    groups.push(group);
    return groups;
  }

  function relativeTime(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60_000) return 'Just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDate(dateStr) {
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  // Fetch only when: drawer opens for the first time, OR revision changed since last fetch.
  // revision increments on every successful save in the parent — the only time history changes.
  // untrack() prevents $effect from tracking reactive reads inside loadHistory().
  $effect(() => {
    if (open) {
      untrack(() => {
        if (revision !== fetchedRevision) {
          const bust = fetchedRevision >= 0; // bust on save, not on first open
          fetchedRevision = revision;
          loadHistory(bust);
        }
      });
    } else {
      // Reset diff view when closing
      selectedVersion = null;
      diff = null;
      diffError = '';
    }
  });

  async function loadHistory(bust = false) {
    if (loading) return; // prevent parallel fetches on rapid open/close
    loading = true;
    try {
      const params = new URLSearchParams({ collection, slug });
      if (isDataCollection) params.set('data', '1');
      if (bust) params.set('bust', '1');
      const res = await fetch(`/api/mimsy/history?${params}`);
      if (!res.ok) throw new Error('Failed to load history');
      const data = await res.json();
      versions = data.versions ?? [];
      hasMore = data.hasMore ?? false;
      noGit = data.noGit ?? false;
    } catch {
      versions = [];
      noGit = false;
    } finally {
      loading = false;
    }
  }

  async function selectVersion(version) {
    selectedVersion = version;
    diff = null;
    diffError = '';
    diffLoading = true;

    try {
      const params = new URLSearchParams({ collection, slug, sha: version.sha });
      if (version.parentSha) params.set('prevSha', version.parentSha);
      const res = await fetch(`/api/mimsy/history/diff?${params}`);
      if (!res.ok) throw new Error('Failed to load diff');
      diff = await res.json();
    } catch {
      diffError = 'Could not load this version.';
    } finally {
      diffLoading = false;
    }
  }

  function restore() {
    if (!diff) return;
    onrestore(diff.frontmatter, diff.body, selectedVersion.date);
    open = false;
  }

  function close() {
    open = false;
  }

  // Close on Escape
  function handleKeydown(e) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown, true);
  }
  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeydown, true);
    }
  });
</script>

<!-- Backdrop -->
<div
  class="mimsy-history-backdrop"
  class:mimsy-history-open={open}
  onclick={close}
  aria-hidden="true"
></div>

<!-- Drawer -->
<div class="mimsy-history-drawer" class:mimsy-history-open={open} role="dialog" aria-label="Version history">
  <!-- Header -->
  <div class="mimsy-preview-header">
    {#if selectedVersion}
      <button
        onclick={() => { selectedVersion = null; diff = null; diffError = ''; }}
        class="flex items-center gap-1.5 text-xs text-stone-500 hover:text-stone-700 transition-colors font-medium"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 19.5 8.25 12l7.5-7.5"/>
        </svg>
        Version history
      </button>
    {:else}
      <span class="mimsy-section-title" style="margin-bottom:0">Version History</span>
    {/if}
    <button onclick={close} class="mimsy-toast-close" title="Close">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/>
      </svg>
    </button>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto">
    {#if selectedVersion}
      <!-- Diff view -->
      <div class="p-4">
        <div class="mb-4">
          <p class="text-xs font-semibold text-stone-700">{formatDate(selectedVersion.date)}</p>
          <p class="text-xs text-stone-400 mt-0.5">by {selectedVersion.author.name}</p>
        </div>

        {#if diffLoading}
          <div class="flex items-center gap-2 py-8 justify-center">
            <div class="w-4 h-4 border-2 border-stone-200 border-t-stone-400 rounded-full animate-spin"></div>
            <span class="text-xs text-stone-400">Loading changes…</span>
          </div>
        {:else if diffError}
          <p class="text-xs text-red-500 py-4">{diffError}</p>
        {:else if diff}
          <!-- Frontmatter changes -->
          {#if diff.frontmatterChanges.length === 0 && !diff.bodyChanged}
            <p class="text-xs text-stone-400 italic py-2">No changes detected (first version or identical content).</p>
          {:else}
            <div class="space-y-2 mb-4">
              {#each diff.frontmatterChanges as change}
                <div class="rounded-lg overflow-hidden border border-stone-100 text-xs font-mono">
                  <div class="px-2.5 py-1 bg-stone-50 text-stone-500 text-[11px] font-sans font-medium border-b border-stone-100">
                    {change.key}
                  </div>
                  {#if change.type === 'added'}
                    <div class="px-2.5 py-1.5 bg-emerald-50 text-emerald-800 leading-relaxed">
                      + {change.after || '(empty)'}
                    </div>
                  {:else if change.type === 'removed'}
                    <div class="px-2.5 py-1.5 bg-red-50 text-red-800 leading-relaxed line-through opacity-70">
                      - {change.before || '(empty)'}
                    </div>
                  {:else}
                    <div class="px-2.5 py-1.5 bg-red-50 text-red-800 leading-relaxed line-through opacity-60">
                      - {change.before}
                    </div>
                    <div class="px-2.5 py-1.5 bg-emerald-50 text-emerald-800 leading-relaxed">
                      + {change.after}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>

            {#if diff.bodyChanged && !isDataCollection}
              <div class="rounded-lg overflow-hidden border border-stone-100 text-xs mb-4">
                <div class="px-2.5 py-1 bg-stone-50 text-stone-500 text-[11px] font-medium border-b border-stone-100">
                  body
                </div>
                {#if diff.bodyBefore}
                  <div class="px-2.5 py-1.5 bg-red-50 text-red-800 font-mono leading-relaxed line-through opacity-60">
                    - {diff.bodyBefore}{diff.bodyBefore.length >= 300 ? '…' : ''}
                  </div>
                {/if}
                {#if diff.bodyAfter}
                  <div class="px-2.5 py-1.5 bg-emerald-50 text-emerald-800 font-mono leading-relaxed">
                    + {diff.bodyAfter}{diff.bodyAfter.length >= 300 ? '…' : ''}
                  </div>
                {/if}
              </div>
            {/if}
          {/if}

          <!-- Restore button -->
          <button
            onclick={restore}
            class="mimsy-btn-primary w-full justify-center"
            style="display:flex"
          >
            Restore this version
          </button>
          <p class="text-[11px] text-stone-400 text-center mt-2 leading-relaxed">
            Loads content into the editor — not saved until you press Save.
          </p>
        {/if}
      </div>
    {:else}
      <!-- Version list -->
      {#if loading}
        <div class="flex items-center gap-2 py-12 justify-center">
          <div class="w-4 h-4 border-2 border-stone-200 border-t-stone-400 rounded-full animate-spin"></div>
          <span class="text-xs text-stone-400">Loading history…</span>
        </div>
      {:else if noGit}
        <div class="p-6 text-center">
          <svg class="w-8 h-8 mx-auto mb-3 text-stone-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
          </svg>
          <p class="text-xs font-medium text-stone-500">No git repository found</p>
          <p class="text-[11px] text-stone-400 mt-1 leading-relaxed">
            Initialize a git repository to enable version history.
          </p>
        </div>
      {:else if versions.length === 0}
        <div class="p-6 text-center">
          <p class="text-xs font-medium text-stone-500">No version history yet</p>
          <p class="text-[11px] text-stone-400 mt-1 leading-relaxed">
            History is tracked via git commits. Changes appear here after each commit.
          </p>
        </div>
      {:else}
        <div class="divide-y divide-stone-50">
          {#each groupedVersions as group, gi}
            {@const latest = group[0]}
            {@const count = group.length}
            <div class="px-4 py-3 hover:bg-stone-50/70 transition-colors">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    {#if latest.author.avatar}
                      <img src={latest.author.avatar} alt={latest.author.name} class="w-4 h-4 rounded-full flex-shrink-0">
                    {/if}
                    <span class="text-xs font-medium text-stone-700 truncate">
                      {latest.isCurrent && gi === 0 ? 'Current version' : relativeTime(latest.date)}
                    </span>
                  </div>
                  <p class="text-[11px] text-stone-400 mt-0.5">
                    {latest.isCurrent && gi === 0 ? `Last saved ${relativeTime(latest.date)}` : formatDate(latest.date)} · {latest.author.name}
                  </p>
                </div>
                <div class="flex gap-1.5 flex-shrink-0">
                  <button
                    onclick={() => selectVersion(latest)}
                    class="text-[11px] text-violet-600 hover:text-violet-700 font-medium transition-colors"
                    disabled={latest.isCurrent && gi === 0}
                  >
                    {latest.isCurrent && gi === 0 ? 'Current' : 'View'}
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if hasMore}
          <div class="p-4 text-center">
            <p class="text-[11px] text-stone-400">Showing 30 most recent versions.</p>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</div>
