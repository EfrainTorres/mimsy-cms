<script>
  import FieldRenderer from './FieldRenderer.svelte';
  import { formatLabel } from '../utils/format-label.js';

  let {
    title = '',
    description = '',
    slug = '',
    collection = '',
    basePath = '',
    seoFields = [],
    frontmatter = {},
    onFieldChange = null,
    referenceOptions = {},
  } = $props();

  let open = $state(false);
  let faviconOk = $state(true);
  let ogImageOk = $state(true);

  const TITLE_LIMIT = 60;
  const DESC_LIMIT = 160;

  let hasSeoFields = $derived(seoFields.length > 0);

  // Smart reading: prefer explicit SEO fields, fall back to content title/description
  let effectiveTitle = $derived(
    frontmatter.metaTitle || frontmatter.seoTitle || frontmatter.ogTitle ||
    frontmatter.meta_title || frontmatter.seo_title || frontmatter.og_title ||
    (frontmatter.seo && typeof frontmatter.seo === 'object' ? frontmatter.seo.title : '') ||
    title
  );

  let effectiveDescription = $derived(
    frontmatter.metaDescription || frontmatter.seoDescription || frontmatter.ogDescription ||
    frontmatter.meta_description || frontmatter.seo_description || frontmatter.og_description ||
    (frontmatter.seo && typeof frontmatter.seo === 'object' ? frontmatter.seo.description : '') ||
    description
  );

  let effectiveImage = $derived(
    frontmatter.ogImage || frontmatter.socialImage ||
    frontmatter.og_image || frontmatter.social_image ||
    (frontmatter.seo && typeof frontmatter.seo === 'object' ? frontmatter.seo.image : '') ||
    ''
  );

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
    <span class="mimsy-section-title mb-0">SEO</span>
    <svg
      class="w-4 h-4 text-stone-400 transition-transform duration-200 {open ? 'rotate-180' : ''}"
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    ><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
  </button>

  {#if open}
    <div class="px-5 pb-5 border-t border-stone-100 pt-4">

      <!-- SEO Fields (if detected) -->
      {#if hasSeoFields && onFieldChange}
        <div class="space-y-3 mb-5">
          {#each seoFields as sf}
            <div>
              <label class="mimsy-label" for={`seo-${sf.key}`}>
                {formatLabel(sf.key)}
                {#if sf.fieldDef && !sf.fieldDef.required}
                  <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
                {/if}
              </label>
              <FieldRenderer
                fieldDef={sf.fieldDef ?? { name: sf.key, type: sf.fieldType || 'string', required: false }}
                value={frontmatter[sf.key]}
                onchange={(v) => onFieldChange(sf.key, v)}
                {referenceOptions}
                fieldId={`seo-${sf.key}`}
              />
            </div>
          {/each}
        </div>
      {/if}

      <!-- Preview section -->
      <div class="space-y-6">
        <!-- Character counts -->
        <div class="flex flex-wrap gap-x-6 gap-y-1">
          <span class="text-[11px] text-stone-500">
            Title <span class={charClass(effectiveTitle.length, TITLE_LIMIT)}>{effectiveTitle.length}/{TITLE_LIMIT}</span>
          </span>
          <span class="text-[11px] text-stone-500">
            Description <span class={charClass(effectiveDescription.length, DESC_LIMIT)}>{effectiveDescription.length}/{DESC_LIMIT}</span>
          </span>
        </div>

        <!-- Google Search Result Preview -->
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 mb-2">Google</p>
          <div class="max-w-[600px] bg-white border border-stone-200/60 rounded-lg p-4" style="font-family: Arial, sans-serif;">
            <!-- Favicon + site name + URL breadcrumb -->
            <div class="flex items-center gap-3 mb-[3px]">
              <div class="w-[26px] h-[26px] rounded-full bg-stone-100 flex items-center justify-center shrink-0 overflow-hidden">
                {#if faviconOk}
                  <img src="/favicon.svg" alt="" class="w-[18px] h-[18px] object-contain" onerror={() => { faviconOk = false; }} />
                {:else}
                  <svg class="w-3.5 h-3.5 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.73-3.56" /></svg>
                {/if}
              </div>
              <div class="min-w-0">
                <div style="font-size: 14px; line-height: 20px; color: #202124;">yourdomain.com</div>
                <div style="font-size: 12px; line-height: 18px; color: #4d5156;" class="truncate">https://yourdomain.com &rsaquo; {collection} &rsaquo; {slug || 'untitled'}</div>
              </div>
            </div>
            <!-- Title -->
            <div style="font-size: 20px; line-height: 26px; color: #1a0dab; font-weight: 400; cursor: pointer; margin-bottom: 3px;">
              {truncate(effectiveTitle, TITLE_LIMIT) || 'Page Title'}
            </div>
            <!-- Description snippet -->
            <div style="font-size: 14px; line-height: 22px; color: #474747;">
              {truncate(effectiveDescription, DESC_LIMIT) || 'Add a description to improve search visibility.'}
            </div>
          </div>
        </div>

        <!-- Social Card Preview (Open Graph / Twitter) -->
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 mb-2">Social</p>
          <div class="overflow-hidden max-w-[506px] bg-white" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; border: 1px solid #dadce0; border-radius: 12px;">
            <div class="bg-stone-100 flex items-center justify-center overflow-hidden" style="aspect-ratio: 1.91 / 1;">
              {#if effectiveImage && ogImageOk}
                <img
                  src={effectiveImage}
                  alt=""
                  class="w-full h-full object-cover"
                  onerror={() => { ogImageOk = false; }}
                />
              {:else}
                <svg class="w-12 h-12 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                </svg>
              {/if}
            </div>
            <div style="padding: 10px 12px 12px; border-top: 1px solid #dadce0;">
              <div style="font-size: 12px; line-height: 16px; color: #70757a; text-transform: uppercase; letter-spacing: 0.02em;">yourdomain.com</div>
              <div style="font-size: 15px; line-height: 20px; font-weight: 600; color: #1d1d1f; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{truncate(effectiveTitle, 70) || 'Page Title'}</div>
              <div style="font-size: 13px; line-height: 18px; color: #70757a; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">{truncate(effectiveDescription, 200) || 'No description provided.'}</div>
            </div>
          </div>
        </div>
      </div>

    </div>
  {/if}
</div>
