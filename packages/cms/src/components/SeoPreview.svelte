<script>
  let { title = '', description = '', slug = '', collection = '', basePath = '' } = $props();

  let open = $state(false);

  const TITLE_LIMIT = 60;
  const DESC_LIMIT = 160;

  function truncate(text, max) {
    if (!text) return '';
    return text.length <= max ? text : text.slice(0, max) + '...';
  }

  function charClass(length, limit) {
    if (length === 0) return 'text-stone-300';
    if (length <= limit * 0.8) return 'text-emerald-600';
    if (length <= limit) return 'text-amber-600';
    return 'text-red-600';
  }
</script>

<div class="mimsy-card mt-5 overflow-hidden">
  <button
    type="button"
    onclick={() => { open = !open; }}
    class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-stone-50/80 transition-colors"
  >
    <span class="mimsy-section-title mb-0">SEO Preview</span>
    <svg
      class="w-4 h-4 text-stone-400 transition-transform duration-200 {open ? 'rotate-180' : ''}"
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
  </button>

  {#if open}
    <div class="px-5 pb-5 space-y-6 border-t border-stone-100 pt-4">

      <!-- Character counts -->
      <div class="flex flex-wrap gap-x-6 gap-y-1">
        <span class="text-[11px] text-stone-500">
          Title <span class={charClass(title.length, TITLE_LIMIT)}>{title.length}/{TITLE_LIMIT}</span>
        </span>
        <span class="text-[11px] text-stone-500">
          Description <span class={charClass(description.length, DESC_LIMIT)}>{description.length}/{DESC_LIMIT}</span>
        </span>
      </div>

      <!-- Google Preview -->
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 mb-2">Search Result</p>
        <div class="border border-stone-200/80 rounded-lg p-4 bg-white max-w-xl" style="font-family: Arial, sans-serif;">
          <div class="text-xs text-stone-500 mb-0.5">yourdomain.com &rsaquo; {collection} &rsaquo; {slug || 'untitled'}</div>
          <div class="text-lg leading-snug mb-1 cursor-pointer" style="color: #1a0dab;">{truncate(title, TITLE_LIMIT) || 'Page Title'}</div>
          <div class="text-sm leading-relaxed" style="color: #4d5156;">{truncate(description, DESC_LIMIT) || 'Add a description to improve search visibility.'}</div>
        </div>
      </div>

      <!-- Social Card Preview -->
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 mb-2">Social Card</p>
        <div class="border border-stone-200/80 rounded-xl overflow-hidden max-w-sm bg-white">
          <div class="bg-stone-100 h-36 flex items-center justify-center">
            <svg class="w-10 h-10 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          </div>
          <div class="p-3 border-t border-stone-100">
            <div class="text-[10px] text-stone-400 uppercase tracking-wide mb-0.5">yourdomain.com</div>
            <div class="text-sm font-medium text-stone-900 leading-snug mb-0.5">{truncate(title, 70) || 'Page Title'}</div>
            <div class="text-xs text-stone-500 leading-relaxed line-clamp-2">{truncate(description, 200) || 'No description provided.'}</div>
          </div>
        </div>
      </div>

    </div>
  {/if}
</div>
