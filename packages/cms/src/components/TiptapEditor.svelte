<script>
  import { onMount, onDestroy } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { Markdown } from '@tiptap/markdown';
  import Link from '@tiptap/extension-link';
  import Image from '@tiptap/extension-image';

  let { content = '', onchange = () => {} } = $props();

  let editorElement = $state();
  let editor = $state();
  let uploading = $state(false);
  let imageFileInput = $state();

  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/mimsy/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }
    const data = await res.json();
    return data.url;
  }

  async function handleImageUpload(file, insertPos) {
    if (!editor || !file.type.startsWith('image/')) return;
    uploading = true;
    const placeholderText = `Uploading ${file.name}...`;
    if (insertPos != null) {
      editor.chain().focus().insertContentAt(insertPos, { type: 'paragraph', content: [{ type: 'text', text: placeholderText }] }).run();
    } else {
      editor.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: placeholderText }] }).run();
    }
    try {
      const url = await uploadImage(file);
      const { doc } = editor.state;
      let placeholderPos = null;
      doc.descendants((node, pos) => {
        if (placeholderPos != null) return false;
        if (node.isText && node.text?.includes(placeholderText)) { placeholderPos = pos; return false; }
      });
      if (placeholderPos != null) {
        const resolved = doc.resolve(placeholderPos);
        const paragraphStart = resolved.before(resolved.depth);
        const paragraphEnd = resolved.after(resolved.depth);
        editor.chain().focus().deleteRange({ from: paragraphStart, to: paragraphEnd }).insertContentAt(paragraphStart, { type: 'image', attrs: { src: url, alt: '' } }).run();
      } else {
        editor.chain().focus().setImage({ src: url, alt: '' }).run();
      }
    } catch (err) {
      console.error('Image upload failed:', err);
      alert(`Image upload failed: ${err.message}`);
      const { doc } = editor.state;
      doc.descendants((node, pos) => {
        if (node.isText && node.text?.includes(placeholderText)) {
          const resolved = doc.resolve(pos);
          editor.chain().deleteRange({ from: resolved.before(resolved.depth), to: resolved.after(resolved.depth) }).run();
          return false;
        }
      });
    } finally {
      uploading = false;
    }
  }

  onMount(() => {
    editor = new Editor({
      element: editorElement,
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({ link: false }),
        Markdown,
        Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
        Image.configure({ inline: false, allowBase64: false }),
      ],
      content,
      contentType: 'markdown',
      editorProps: {
        handlePaste(view, event) {
          const items = event.clipboardData?.items;
          if (!items) return false;
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              event.preventDefault();
              const file = item.getAsFile();
              if (file) handleImageUpload(file);
              return true;
            }
          }
          return false;
        },
        handleDrop(view, event) {
          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return false;
          const imageFiles = [...files].filter((f) => f.type.startsWith('image/'));
          if (imageFiles.length === 0) return false;
          event.preventDefault();
          const coords = { left: event.clientX, top: event.clientY };
          const pos = view.posAtCoords(coords)?.pos;
          for (const file of imageFiles) handleImageUpload(file, pos);
          return true;
        },
      },
      onUpdate: ({ editor: e }) => { onchange(e.getMarkdown()); },
    });
  });

  onDestroy(() => { editor?.destroy(); });

  function toggleBold() { editor?.chain().focus().toggleBold().run(); }
  function toggleItalic() { editor?.chain().focus().toggleItalic().run(); }
  function toggleStrike() { editor?.chain().focus().toggleStrike().run(); }
  function toggleCode() { editor?.chain().focus().toggleCode().run(); }
  function toggleBlockquote() { editor?.chain().focus().toggleBlockquote().run(); }
  function toggleBulletList() { editor?.chain().focus().toggleBulletList().run(); }
  function toggleOrderedList() { editor?.chain().focus().toggleOrderedList().run(); }
  function toggleCodeBlock() { editor?.chain().focus().toggleCodeBlock().run(); }
  function setHorizontalRule() { editor?.chain().focus().setHorizontalRule().run(); }

  function setHeading(level) {
    if (level === 0) editor?.chain().focus().setParagraph().run();
    else editor?.chain().focus().toggleHeading({ level }).run();
  }

  function insertLink() {
    const url = prompt('Enter URL:');
    if (url) editor?.chain().focus().setLink({ href: url }).run();
  }
  function removeLink() { editor?.chain().focus().unsetLink().run(); }

  function triggerImagePicker() { imageFileInput?.click(); }
  function onImageFileSelected(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) handleImageUpload(file);
    }
    event.target.value = '';
  }

  export function getMarkdown() { return editor?.getMarkdown() ?? ''; }

  // Toolbar button helper
  function isActive(type, opts) { return editor?.isActive(type, opts) ?? false; }
</script>

<div class="mimsy-tiptap">
  <!-- Toolbar -->
  <div class="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border border-stone-200 rounded-t-lg bg-stone-50/80">
    <!-- Text type -->
    <select
      class="h-7 px-1.5 text-[11px] font-medium border-0 rounded bg-transparent text-stone-600 cursor-pointer hover:bg-stone-200/60 transition-colors outline-none"
      onchange={(e) => { setHeading(Number(e.target.value)); e.target.value = '0'; }}
    >
      <option value="0">Paragraph</option>
      <option value="1">Heading 1</option>
      <option value="2">Heading 2</option>
      <option value="3">Heading 3</option>
    </select>

    <span class="w-px h-4 bg-stone-200 mx-0.5"></span>

    <!-- Inline -->
    <button type="button" onclick={toggleBold}
      class="mimsy-toolbar-btn" class:active={isActive('bold')}
      title="Bold"><strong>B</strong></button>

    <button type="button" onclick={toggleItalic}
      class="mimsy-toolbar-btn" class:active={isActive('italic')}
      title="Italic"><em>I</em></button>

    <button type="button" onclick={toggleStrike}
      class="mimsy-toolbar-btn" class:active={isActive('strike')}
      title="Strikethrough"><s>S</s></button>

    <button type="button" onclick={toggleCode}
      class="mimsy-toolbar-btn font-mono text-[10px]" class:active={isActive('code')}
      title="Inline Code">&lt;/&gt;</button>

    <span class="w-px h-4 bg-stone-200 mx-0.5"></span>

    <!-- Block -->
    <button type="button" onclick={toggleBulletList}
      class="mimsy-toolbar-btn" class:active={isActive('bulletList')}
      title="Bullet List">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
    </button>

    <button type="button" onclick={toggleOrderedList}
      class="mimsy-toolbar-btn" class:active={isActive('orderedList')}
      title="Ordered List">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.242 5.992h12m-12 6.003h12m-12 5.999h12M4.117 7.495v-3.75H2.99m1.125 3.75H2.99m1.125 0H5.24m-1.92 2.577a1.125 1.125 0 1 1 1.591 1.59l-1.83 1.83h2.16" /></svg>
    </button>

    <button type="button" onclick={toggleBlockquote}
      class="mimsy-toolbar-btn" class:active={isActive('blockquote')}
      title="Blockquote">
      <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M4.583 17.321C3.553 16.227 3 15 3 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179Zm10 0C13.553 16.227 13 15 13 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179Z"/></svg>
    </button>

    <button type="button" onclick={toggleCodeBlock}
      class="mimsy-toolbar-btn font-mono text-[10px]" class:active={isActive('codeBlock')}
      title="Code Block">{'{}'}</button>

    <button type="button" onclick={setHorizontalRule}
      class="mimsy-toolbar-btn"
      title="Horizontal Rule">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M3.75 12h16.5" /></svg>
    </button>

    <span class="w-px h-4 bg-stone-200 mx-0.5"></span>

    <!-- Link -->
    {#if isActive('link')}
      <button type="button" onclick={removeLink}
        class="mimsy-toolbar-btn !text-red-600 !bg-red-50"
        title="Remove Link">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.181 8.68a4.503 4.503 0 0 1 1.903 6.405m-9.768-2.782L3.56 14.06a4.5 4.5 0 0 0 6.364 6.365l.742-.742M7.5 8.25l-.742.742a4.5 4.5 0 0 0-.872 5.166m11.289-5.408 1.756-1.756a4.5 4.5 0 0 0-6.365-6.365l-.742.742M6 6l12 12" /></svg>
      </button>
    {:else}
      <button type="button" onclick={insertLink}
        class="mimsy-toolbar-btn" title="Insert Link">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>
      </button>
    {/if}

    <!-- Image -->
    <button type="button" onclick={triggerImagePicker}
      class="mimsy-toolbar-btn" disabled={uploading}
      title="Insert Image">
      {#if uploading}
        <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
      {:else}
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
      {/if}
    </button>
    <input
      bind:this={imageFileInput}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
      class="hidden"
      onchange={onImageFileSelected}
    />
  </div>

  <!-- Editor content area -->
  <div
    bind:this={editorElement}
    class="mimsy-editor-content border border-t-0 border-stone-200 rounded-b-lg p-5 min-h-[20rem] bg-white focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-100 transition-all"
  ></div>
</div>

<style>
  /* Toolbar button base */
  .mimsy-toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: #78716c; /* stone-500 */
    transition: all 100ms ease;
    cursor: pointer;
    border: none;
    background: transparent;
  }
  .mimsy-toolbar-btn:hover {
    background: #e7e5e4; /* stone-200 */
    color: #44403c; /* stone-700 */
  }
  .mimsy-toolbar-btn.active,
  .mimsy-toolbar-btn:global(.active) {
    background: var(--mimsy-accent-light, #ede9fe);
    color: var(--mimsy-accent, #7c3aed);
  }
  .mimsy-toolbar-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Editor prose styles */
  :global(.mimsy-editor-content .ProseMirror) {
    outline: none;
    min-height: 18rem;
    font-family: var(--mimsy-font-sans, 'DM Sans', system-ui, sans-serif);
    font-size: 0.9375rem;
    color: #1c1917; /* stone-900 */
    line-height: 1.7;
  }
  :global(.mimsy-editor-content .ProseMirror > * + *) {
    margin-top: 0.75em;
  }
  :global(.mimsy-editor-content .ProseMirror h1) {
    font-family: var(--mimsy-font-serif, 'Instrument Serif', Georgia, serif);
    font-size: 1.875em;
    font-weight: 400;
    line-height: 1.2;
    color: #0c0a09; /* stone-950 */
  }
  :global(.mimsy-editor-content .ProseMirror h2) {
    font-family: var(--mimsy-font-serif, 'Instrument Serif', Georgia, serif);
    font-size: 1.375em;
    font-weight: 400;
    line-height: 1.3;
    color: #0c0a09;
  }
  :global(.mimsy-editor-content .ProseMirror h3) {
    font-size: 1.125em;
    font-weight: 600;
    line-height: 1.4;
    color: #1c1917;
  }
  :global(.mimsy-editor-content .ProseMirror p) {
    line-height: 1.7;
  }
  :global(.mimsy-editor-content .ProseMirror ul) {
    list-style: disc;
    padding-left: 1.5em;
  }
  :global(.mimsy-editor-content .ProseMirror ol) {
    list-style: decimal;
    padding-left: 1.5em;
  }
  :global(.mimsy-editor-content .ProseMirror li) {
    line-height: 1.7;
  }
  :global(.mimsy-editor-content .ProseMirror li > p) {
    margin-top: 0;
  }
  :global(.mimsy-editor-content .ProseMirror blockquote) {
    border-left: 2px solid #d6d3d1; /* stone-300 */
    padding-left: 1em;
    color: #78716c; /* stone-500 */
    font-style: italic;
  }
  :global(.mimsy-editor-content .ProseMirror code) {
    font-family: var(--mimsy-font-mono, 'DM Mono', ui-monospace, monospace);
    background: #f5f5f4;
    padding: 0.15em 0.35em;
    border-radius: 0.25em;
    font-size: 0.85em;
    color: var(--mimsy-accent, #7c3aed);
  }
  :global(.mimsy-editor-content .ProseMirror pre) {
    background: #1c1917; /* stone-900 */
    color: #e7e5e4; /* stone-200 */
    padding: 0.875em 1.125em;
    border-radius: 0.5em;
    overflow-x: auto;
    font-family: var(--mimsy-font-mono, 'DM Mono', ui-monospace, monospace);
    font-size: 0.8125em;
    line-height: 1.6;
  }
  :global(.mimsy-editor-content .ProseMirror pre code) {
    background: none;
    padding: 0;
    font-size: inherit;
    color: inherit;
  }
  :global(.mimsy-editor-content .ProseMirror hr) {
    border: none;
    border-top: 1px solid #e7e5e4; /* stone-200 */
    margin: 1.5em 0;
  }
  :global(.mimsy-editor-content .ProseMirror a) {
    color: var(--mimsy-accent, #7c3aed);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  :global(.mimsy-editor-content .ProseMirror a:hover) {
    color: var(--mimsy-accent-dark, #5b21b6);
  }
  :global(.mimsy-editor-content .ProseMirror img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.5em;
    margin: 0.5em 0;
  }
  :global(.mimsy-editor-content .ProseMirror img.ProseMirror-selectednode) {
    outline: 2px solid var(--mimsy-accent, #7c3aed);
    outline-offset: 3px;
  }
  /* Placeholder text for empty editor */
  :global(.mimsy-editor-content .ProseMirror p.is-editor-empty:first-child::before) {
    content: 'Start writing...';
    float: left;
    color: #a8a29e; /* stone-400 */
    pointer-events: none;
    height: 0;
  }
</style>
