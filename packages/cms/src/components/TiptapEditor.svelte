<script>
  import { onMount, onDestroy } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { Markdown } from '@tiptap/markdown';
  import Link from '@tiptap/extension-link';
  import Image from '@tiptap/extension-image';
  import { isInTable } from '@tiptap/pm/tables';
  import { Table, TableRow, TableCell, TableHeader } from '../extensions/table.js';
  import { YouTube } from '../extensions/youtube.js';
  import { toast } from '../utils/toast.js';

  let { content = '', onchange = () => {} } = $props();

  let wrapperElement = $state();
  let editorElement = $state();
  let editor = $state();
  let editorVersion = $state(0);
  let uploading = $state(false);
  let imageFileInput = $state();

  // Image dropdown
  let showImageMenu = $state(false);

  // Link popover
  let linkPopoverOpen = $state(false);
  let linkUrl = $state('');
  let linkNewTab = $state(false);
  let linkInputEl = $state();

  // Image alt popover
  let selectedImageAttrs = $state(null); // { src, alt, pos }
  let imageAltValue = $state('');
  let imagePopoverStyle = $state('');

  // Slash commands
  let slashOpen = $state(false);
  let slashQuery = $state('');
  let slashIndex = $state(0);
  let slashCoords = $state({ top: 0, left: 0 });

  // YouTube URL prompt (shown after selecting YouTube from slash)
  let youtubePromptOpen = $state(false);
  let youtubeUrl = $state('');
  let youtubeInputEl = $state();

  // Table context detection
  let inTable = $state(false);

  // --- Slash command items ---
  const SLASH_ICONS = {
    h1: '<b>H1</b>', h2: '<b>H2</b>', h3: '<b>H3</b>',
    bullet: '<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" fill="currentColor"/><path stroke-width="2" d="M11 12h10"/></svg>',
    ordered: '<b>1.</b>',
    quote: '<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M4.583 17.321C3.553 16.227 3 15 3 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179Z"/></svg>',
    code: '<b>&lt;/&gt;</b>',
    hr: '<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" d="M4 12h16"/></svg>',
    table: '<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-width="2"/><path stroke-width="2" d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    image: '<svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159M3.75 21h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Z"/></svg>',
    youtube: '<svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814ZM9.545 15.568V8.432L15.818 12l-6.273 3.568Z"/></svg>',
  };

  const SLASH_ITEMS = [
    { id: 'h1',      label: 'Heading 1',      desc: 'Large heading',    keys: 'heading title h1',         action: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: 'h2',      label: 'Heading 2',      desc: 'Medium heading',   keys: 'heading subtitle h2',      action: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: 'h3',      label: 'Heading 3',      desc: 'Small heading',    keys: 'heading h3',               action: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: 'bullet',  label: 'Bullet List',    desc: 'Unordered list',   keys: 'bullet unordered list ul',  action: (e) => e.chain().focus().toggleBulletList().run() },
    { id: 'ordered', label: 'Numbered List',  desc: 'Ordered list',     keys: 'numbered ordered list ol',  action: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: 'quote',   label: 'Blockquote',     desc: 'Quote block',      keys: 'quote blockquote',          action: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: 'code',    label: 'Code Block',     desc: 'Code snippet',     keys: 'code block pre snippet',    action: (e) => e.chain().focus().toggleCodeBlock().run() },
    { id: 'hr',      label: 'Divider',        desc: 'Horizontal line',  keys: 'divider horizontal rule line separator', action: (e) => e.chain().focus().setHorizontalRule().run() },
    { id: 'table',   label: 'Table',          desc: '3x3 table',        keys: 'table grid',                action: (e) => e.chain().focus().insertTable().run() },
    { id: 'image',   label: 'Image',          desc: 'From library',     keys: 'image photo picture',       action: null },
    { id: 'youtube', label: 'YouTube',        desc: 'Embed video',      keys: 'youtube video embed',       action: null },
  ];

  function getFilteredSlashItems() {
    if (!slashQuery) return SLASH_ITEMS;
    const q = slashQuery.toLowerCase();
    return SLASH_ITEMS.filter(i => i.label.toLowerCase().includes(q) || i.keys.includes(q));
  }

  // --- Image upload ---
  async function uploadImage(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/mimsy/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }
    return (await res.json()).url;
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
      toast(`Image upload failed: ${err.message}`, 'error');
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

  // --- Editor lifecycle ---
  onMount(() => {
    editor = new Editor({
      element: editorElement,
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({ link: false }),
        Markdown,
        Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
        Image.configure({ inline: false, allowBase64: false }),
        Table, TableRow, TableCell, TableHeader,
        YouTube,
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
        handleKeyDown(view, event) {
          // Slash menu keyboard nav
          if (slashOpen) {
            const items = getFilteredSlashItems();
            if (items.length === 0) { slashOpen = false; return false; }
            if (event.key === 'ArrowDown') { event.preventDefault(); slashIndex = (slashIndex + 1) % items.length; return true; }
            if (event.key === 'ArrowUp') { event.preventDefault(); slashIndex = (slashIndex - 1 + items.length) % items.length; return true; }
            if (event.key === 'Enter') { event.preventDefault(); if (items[slashIndex]) executeSlashCommand(items[slashIndex]); return true; }
            if (event.key === 'Escape') { event.preventDefault(); slashOpen = false; return true; }
          }
          // Ctrl+K for link
          if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
            event.preventDefault();
            openLinkPopover();
            return true;
          }
          return false;
        },
      },
      onTransaction: ({ editor: e }) => {
        editorVersion++;
        updateSlashState(e);
        updateImageSelection(e);
        inTable = isInTable(e.state);
      },
      onUpdate: ({ editor: e }) => { onchange(e.getMarkdown()); },
    });
  });

  onDestroy(() => { editor?.destroy(); });

  // --- Slash command state ---
  function updateSlashState(e) {
    const { selection } = e.state;
    // Only in text selections (not node selections)
    if (selection.node) { if (slashOpen) slashOpen = false; return; }
    const resolved = selection.$from;
    if (resolved.parent.type.name !== 'paragraph') { if (slashOpen) slashOpen = false; return; }
    const textBefore = resolved.parent.textContent.slice(0, resolved.parentOffset);
    if (textBefore.startsWith('/') && !textBefore.includes(' ')) {
      const query = textBefore.slice(1).toLowerCase();
      if (!slashOpen || slashQuery !== query) slashIndex = 0;
      slashQuery = query;
      slashOpen = true;
      // Position at the slash character
      const coords = e.view.coordsAtPos(resolved.start());
      if (wrapperElement) {
        const rect = wrapperElement.getBoundingClientRect();
        slashCoords = { top: coords.bottom - rect.top + 4, left: coords.left - rect.left };
      }
    } else if (slashOpen) {
      slashOpen = false;
    }
  }

  function deleteSlashText() {
    if (!editor) return;
    const resolved = editor.state.selection.$from;
    const start = resolved.start();
    const end = resolved.pos;
    editor.chain().focus().deleteRange({ from: start, to: end }).run();
  }

  function executeSlashCommand(cmd) {
    slashOpen = false;
    deleteSlashText();
    if (cmd.id === 'image') {
      insertFromLibrary();
      return;
    }
    if (cmd.id === 'youtube') {
      youtubePromptOpen = true;
      youtubeUrl = '';
      requestAnimationFrame(() => youtubeInputEl?.focus());
      return;
    }
    cmd.action(editor);
  }

  function embedYouTube() {
    const url = youtubeUrl.trim();
    youtubePromptOpen = false;
    if (!url || !editor) return;
    const ok = editor.commands.setYouTube(url);
    if (!ok) toast('Invalid YouTube URL', 'error');
  }

  // --- Image selection state ---
  function updateImageSelection(e) {
    const { selection } = e.state;
    if (selection.node?.type.name === 'image') {
      const { src, alt } = selection.node.attrs;
      selectedImageAttrs = { src, alt: alt || '', pos: selection.from };
      imageAltValue = alt || '';
      // Calculate position relative to wrapper
      requestAnimationFrame(() => {
        if (!wrapperElement || !editor) return;
        const dom = editor.view.nodeDOM(selection.from);
        if (!dom) return;
        const imgEl = dom.nodeType === 1 && dom.tagName === 'IMG' ? dom : dom.querySelector?.('img');
        if (!imgEl) return;
        const wrapRect = wrapperElement.getBoundingClientRect();
        const imgRect = imgEl.getBoundingClientRect();
        imagePopoverStyle = `top:${imgRect.bottom - wrapRect.top + 6}px;left:${imgRect.left - wrapRect.left}px;width:${Math.min(Math.max(imgRect.width, 200), 360)}px;`;
      });
    } else if (selectedImageAttrs) {
      selectedImageAttrs = null;
    }
  }

  function applyImageAlt(silent = false) {
    if (!editor || selectedImageAttrs == null) return;
    if (imageAltValue === (selectedImageAttrs.alt || '')) return; // no change
    editor.chain().focus().updateAttributes('image', { alt: imageAltValue }).run();
    if (!silent) toast('Alt text updated', 'success');
  }

  // --- Link popover ---
  function openLinkPopover() {
    if (!editor) return;
    // Pre-fill from existing link
    const attrs = editor.getAttributes('link');
    linkUrl = attrs.href || '';
    linkNewTab = attrs.target === '_blank';
    linkPopoverOpen = true;
    requestAnimationFrame(() => linkInputEl?.focus());
  }

  function applyLink() {
    if (!editor) return;
    const url = linkUrl.trim();
    if (!url) { removeLink(); return; }
    const attrs = { href: url };
    if (linkNewTab) attrs.target = '_blank';
    else attrs.target = null;
    editor.chain().focus().setLink(attrs).run();
    linkPopoverOpen = false;
  }

  function removeLink() {
    editor?.chain().focus().unsetLink().run();
    linkPopoverOpen = false;
  }

  // --- Toolbar helpers ---
  function isActive(type, opts) {
    void editorVersion;
    return editor?.isActive(type, opts) ?? false;
  }

  function canUndo() { void editorVersion; return editor?.can().undo() ?? false; }
  function canRedo() { void editorVersion; return editor?.can().redo() ?? false; }

  function blockTypeValue() {
    void editorVersion;
    if (!editor) return '0';
    for (let i = 1; i <= 3; i++) { if (editor.isActive('heading', { level: i })) return String(i); }
    return '0';
  }

  function setHeading(level) {
    if (level === 0) editor?.chain().focus().setParagraph().run();
    else editor?.chain().focus().toggleHeading({ level }).run();
  }

  // --- Image picker ---
  function insertFromLibrary() {
    showImageMenu = false;
    window.dispatchEvent(new CustomEvent('mimsy:media:open', {
      detail: {
        showAlt: true,
        callback: (url, alt) => {
          if (editor) editor.chain().focus().setImage({ src: url, alt: alt || '' }).run();
        }
      }
    }));
  }

  function onImageFileSelected(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) handleImageUpload(file);
    }
    event.target.value = '';
  }

  export function getMarkdown() { return editor?.getMarkdown() ?? ''; }
</script>

<div class="mimsy-tiptap" bind:this={wrapperElement}>
  <!-- Toolbar -->
  <div class="mimsy-toolbar">
    <!-- Undo/Redo -->
    <button type="button" onclick={() => editor?.chain().focus().undo().run()}
      class="mimsy-toolbar-btn" disabled={!canUndo()} title="Undo (Ctrl+Z)">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().redo().run()}
      class="mimsy-toolbar-btn" disabled={!canRedo()} title="Redo (Ctrl+Shift+Z)">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" /></svg>
    </button>

    <span class="mimsy-toolbar-sep"></span>

    <!-- Block type dropdown (reflects current state) -->
    <select
      class="h-7 px-1.5 text-[11px] font-medium border-0 rounded bg-transparent text-stone-600 cursor-pointer hover:bg-stone-200/60 transition-colors outline-none"
      onchange={(e) => setHeading(Number(e.target.value))}
    >
      <option value="0" selected={blockTypeValue() === '0'}>Paragraph</option>
      <option value="1" selected={blockTypeValue() === '1'}>Heading 1</option>
      <option value="2" selected={blockTypeValue() === '2'}>Heading 2</option>
      <option value="3" selected={blockTypeValue() === '3'}>Heading 3</option>
    </select>

    <span class="mimsy-toolbar-sep"></span>

    <!-- Inline formatting -->
    <button type="button" onclick={() => editor?.chain().focus().toggleBold().run()}
      class="mimsy-toolbar-btn" class:active={isActive('bold')} title="Bold">
      <strong>B</strong>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().toggleItalic().run()}
      class="mimsy-toolbar-btn" class:active={isActive('italic')} title="Italic">
      <em>I</em>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().toggleStrike().run()}
      class="mimsy-toolbar-btn" class:active={isActive('strike')} title="Strikethrough">
      <s>S</s>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().toggleCode().run()}
      class="mimsy-toolbar-btn font-mono text-[10px]" class:active={isActive('code')} title="Inline Code">
      &lt;/&gt;
    </button>

    <span class="mimsy-toolbar-sep"></span>

    <!-- Block elements -->
    <button type="button" onclick={() => editor?.chain().focus().toggleBulletList().run()}
      class="mimsy-toolbar-btn" class:active={isActive('bulletList')} title="Bullet List">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().toggleOrderedList().run()}
      class="mimsy-toolbar-btn" class:active={isActive('orderedList')} title="Ordered List">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.242 5.992h12m-12 6.003h12m-12 5.999h12M4.117 7.495v-3.75H2.99m1.125 3.75H2.99m1.125 0H5.24m-1.92 2.577a1.125 1.125 0 1 1 1.591 1.59l-1.83 1.83h2.16" /></svg>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().toggleBlockquote().run()}
      class="mimsy-toolbar-btn" class:active={isActive('blockquote')} title="Blockquote">
      <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M4.583 17.321C3.553 16.227 3 15 3 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179Zm10 0C13.553 16.227 13 15 13 13.011c0-3.5 2.457-6.637 6.03-8.188l.893 1.378c-3.335 1.804-3.987 4.145-4.247 5.621.537-.278 1.24-.375 1.929-.311 1.804.167 3.226 1.648 3.226 3.489a3.5 3.5 0 0 1-3.5 3.5c-1.073 0-2.099-.49-2.748-1.179Z"/></svg>
    </button>
    <button type="button" onclick={() => editor?.chain().focus().toggleCodeBlock().run()}
      class="mimsy-toolbar-btn font-mono text-[10px]" class:active={isActive('codeBlock')} title="Code Block">
      {'{}'}
    </button>
    <button type="button" onclick={() => editor?.chain().focus().setHorizontalRule().run()}
      class="mimsy-toolbar-btn" title="Horizontal Rule">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M3.75 12h16.5" /></svg>
    </button>

    <span class="mimsy-toolbar-sep"></span>

    <!-- Link (popover instead of prompt) -->
    <div class="relative">
      <button type="button" onclick={openLinkPopover}
        class="mimsy-toolbar-btn" class:active={isActive('link')} title="Link (Ctrl+K)">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" /></svg>
      </button>
      {#if linkPopoverOpen}
        <div style="position:fixed;inset:0;z-index:49;" onclick={() => linkPopoverOpen = false} role="presentation" aria-hidden="true"></div>
        <div class="mimsy-popover" style="z-index:50;">
          <input
            bind:this={linkInputEl}
            type="url"
            class="mimsy-input text-xs"
            value={linkUrl}
            oninput={(e) => linkUrl = e.target.value}
            placeholder="https://example.com"
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') { e.preventDefault(); linkPopoverOpen = false; editor?.chain().focus().run(); } }}
          />
          <label class="mimsy-popover-check">
            <input type="checkbox" checked={linkNewTab} onchange={(e) => linkNewTab = e.target.checked} />
            <span>Open in new tab</span>
          </label>
          <div class="flex items-center gap-1.5 mt-1.5">
            <button type="button" onclick={applyLink} class="mimsy-popover-apply">Apply</button>
            {#if isActive('link')}
              <button type="button" onclick={removeLink} class="mimsy-popover-remove">Unlink</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <!-- Image (with click-outside) -->
    <div class="relative">
      <button type="button" onclick={() => showImageMenu = !showImageMenu}
        class="mimsy-toolbar-btn" class:active={showImageMenu} disabled={uploading} title="Insert Image">
        {#if uploading}
          <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
        {:else}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
        {/if}
      </button>
      {#if showImageMenu}
        <div style="position:fixed;inset:0;z-index:49;" onclick={() => showImageMenu = false} role="presentation" aria-hidden="true"></div>
        <div class="mimsy-dropdown" style="z-index:50;">
          <button type="button" onclick={() => { showImageMenu = false; imageFileInput?.click(); }}
            class="mimsy-dropdown-item">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
            Upload file
          </button>
          <button type="button" onclick={insertFromLibrary}
            class="mimsy-dropdown-item">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
            From library
          </button>
        </div>
      {/if}
    </div>
    <input
      bind:this={imageFileInput}
      type="file"
      accept="image/*"
      class="hidden"
      onchange={onImageFileSelected}
    />

    <!-- Table controls (shown when cursor is in a table) -->
    {#if inTable}
      <span class="mimsy-toolbar-sep"></span>
      <button type="button" onclick={() => editor?.chain().focus().addRowAfter().run()}
        class="mimsy-toolbar-btn" title="Add row below">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m7.5-7.5h-15" /></svg>
      </button>
      <button type="button" onclick={() => editor?.chain().focus().addColumnAfter().run()}
        class="mimsy-toolbar-btn" title="Add column right">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
      </button>
      <button type="button" onclick={() => editor?.chain().focus().deleteRow().run()}
        class="mimsy-toolbar-btn !text-red-500" title="Delete row">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14" /></svg>
      </button>
      <button type="button" onclick={() => editor?.chain().focus().deleteColumn().run()}
        class="mimsy-toolbar-btn !text-red-500" title="Delete column">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
      <button type="button" onclick={() => editor?.chain().focus().deleteTable().run()}
        class="mimsy-toolbar-btn !text-red-500" title="Delete table">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
      </button>
    {/if}
  </div>

  <!-- Editor content area -->
  <div
    bind:this={editorElement}
    class="mimsy-editor-content border border-t-0 border-stone-200 rounded-b-lg p-5 min-h-[20rem] bg-white focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-100 transition-all"
  ></div>

  <!-- Image alt text popover (positioned over selected image) -->
  {#if selectedImageAttrs}
    <div style="position:fixed;inset:0;z-index:49;" onclick={() => { applyImageAlt(true); selectedImageAttrs = null; }} role="presentation" aria-hidden="true"></div>
    <div class="mimsy-image-popover" style="position:absolute;{imagePopoverStyle}z-index:50;">
      <div class="flex items-center gap-1.5">
        <svg class="w-3 h-3 text-stone-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.862-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
        <input
          type="text"
          class="mimsy-input text-xs flex-1"
          value={imageAltValue}
          oninput={(e) => imageAltValue = e.target.value}
          placeholder="Describe this image..."
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyImageAlt(); selectedImageAttrs = null; editor?.chain().focus().run(); } if (e.key === 'Escape') { e.preventDefault(); selectedImageAttrs = null; editor?.chain().focus().run(); } }}
        />
      </div>
    </div>
  {/if}

  <!-- Slash command menu -->
  {#if slashOpen && getFilteredSlashItems().length > 0}
    <div style="position:fixed;inset:0;z-index:49;" onclick={() => slashOpen = false} role="presentation" aria-hidden="true"></div>
    <div class="mimsy-slash-menu" style="position:absolute;top:{slashCoords.top}px;left:{slashCoords.left}px;z-index:50;">
      {#each getFilteredSlashItems() as cmd, i}
        <button type="button"
          class="mimsy-slash-item" class:active={i === slashIndex}
          onclick={() => executeSlashCommand(cmd)}
          onmouseenter={() => slashIndex = i}
        >
          <span class="mimsy-slash-icon">{@html SLASH_ICONS[cmd.id] || ''}</span>
          <span class="mimsy-slash-text">
            <span class="mimsy-slash-label">{cmd.label}</span>
            <span class="mimsy-slash-desc">{cmd.desc}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- YouTube URL prompt -->
  {#if youtubePromptOpen}
    <div style="position:fixed;inset:0;z-index:49;" onclick={() => youtubePromptOpen = false} role="presentation" aria-hidden="true"></div>
    <div class="mimsy-popover" style="position:absolute;top:{slashCoords.top}px;left:{slashCoords.left}px;z-index:50;width:320px;">
      <span class="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-1 block">YouTube URL</span>
      <input
        bind:this={youtubeInputEl}
        type="url"
        class="mimsy-input text-xs"
        value={youtubeUrl}
        oninput={(e) => youtubeUrl = e.target.value}
        placeholder="https://youtube.com/watch?v=..."
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); embedYouTube(); } if (e.key === 'Escape') { e.preventDefault(); youtubePromptOpen = false; editor?.chain().focus().run(); } }}
      />
      <button type="button" onclick={embedYouTube} class="mimsy-popover-apply mt-2">Embed</button>
    </div>
  {/if}
</div>

<style>
  /* Wrapper — positioning context for absolute popovers */
  .mimsy-tiptap { position: relative; }

  /* Toolbar */
  .mimsy-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid #e7e5e4;
    border-radius: 0.5rem 0.5rem 0 0;
    background: rgba(250, 250, 249, 0.8);
  }
  .mimsy-toolbar-sep {
    width: 1px;
    height: 1rem;
    background: #e7e5e4;
    margin: 0 2px;
  }
  .mimsy-toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: #78716c;
    transition: all 100ms ease;
    cursor: pointer;
    border: none;
    background: transparent;
  }
  .mimsy-toolbar-btn:hover:not(:disabled) {
    background: #e7e5e4;
    color: #44403c;
  }
  .mimsy-toolbar-btn.active,
  .mimsy-toolbar-btn:global(.active) {
    background: var(--mimsy-accent-light, #ede9fe);
    color: var(--mimsy-accent, #7c3aed);
  }
  .mimsy-toolbar-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  /* Popover (link, youtube) */
  .mimsy-popover {
    position: absolute;
    left: 0;
    top: calc(100% + 4px);
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    padding: 0.5rem;
    min-width: 240px;
  }
  .mimsy-popover-check {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.375rem;
    font-size: 0.6875rem;
    color: #78716c;
    cursor: pointer;
  }
  .mimsy-popover-check input[type="checkbox"] {
    accent-color: var(--mimsy-accent, #7c3aed);
    width: 0.875rem;
    height: 0.875rem;
  }
  .mimsy-popover-apply {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.25rem 0.625rem;
    background: var(--mimsy-accent, #7c3aed);
    color: #fff;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: background 100ms;
  }
  .mimsy-popover-apply:hover { background: var(--mimsy-accent-dark, #5b21b6); }
  .mimsy-popover-remove {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.25rem 0.625rem;
    background: transparent;
    color: #dc2626;
    border: 1px solid #fecaca;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: background 100ms;
  }
  .mimsy-popover-remove:hover { background: #fef2f2; }

  /* Dropdown menu (image picker) */
  .mimsy-dropdown {
    position: absolute;
    left: 0;
    top: calc(100% + 4px);
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    padding: 0.25rem 0;
    min-width: 140px;
  }
  .mimsy-dropdown-item {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    color: #44403c;
    border: none;
    background: none;
    cursor: pointer;
    transition: background 80ms;
  }
  .mimsy-dropdown-item:hover { background: #fafaf9; }

  /* Image alt popover */
  .mimsy-image-popover {
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    padding: 0.375rem 0.5rem;
  }

  /* Slash command menu */
  .mimsy-slash-menu {
    background: #fff;
    border: 1px solid #e7e5e4;
    border-radius: 0.5rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    padding: 0.25rem;
    min-width: 200px;
    max-height: 320px;
    overflow-y: auto;
  }
  .mimsy-slash-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border: none;
    background: transparent;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: background 60ms;
    text-align: left;
  }
  .mimsy-slash-item:hover, .mimsy-slash-item.active {
    background: var(--mimsy-accent-light, #ede9fe);
  }
  .mimsy-slash-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.375rem;
    background: #f5f5f4;
    border: 1px solid #e7e5e4;
    font-size: 0.6875rem;
    font-weight: 600;
    color: #57534e;
    flex-shrink: 0;
  }
  .mimsy-slash-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .mimsy-slash-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: #1c1917;
    line-height: 1.2;
  }
  .mimsy-slash-desc {
    font-size: 0.6875rem;
    color: #a8a29e;
    line-height: 1.2;
  }

  /* Editor prose styles */
  :global(.mimsy-editor-content .ProseMirror) {
    outline: none;
    min-height: 18rem;
    font-family: var(--mimsy-font-sans, 'DM Sans', system-ui, sans-serif);
    font-size: 0.9375rem;
    color: #1c1917;
    line-height: 1.7;
  }
  :global(.mimsy-editor-content .ProseMirror > * + *) { margin-top: 0.75em; }
  :global(.mimsy-editor-content .ProseMirror h1) {
    font-family: var(--mimsy-font-serif, 'Instrument Serif', Georgia, serif);
    font-size: 1.875em; font-weight: 400; line-height: 1.2; color: #0c0a09;
  }
  :global(.mimsy-editor-content .ProseMirror h2) {
    font-family: var(--mimsy-font-serif, 'Instrument Serif', Georgia, serif);
    font-size: 1.375em; font-weight: 400; line-height: 1.3; color: #0c0a09;
  }
  :global(.mimsy-editor-content .ProseMirror h3) {
    font-size: 1.125em; font-weight: 600; line-height: 1.4; color: #1c1917;
  }
  :global(.mimsy-editor-content .ProseMirror p) { line-height: 1.7; }
  :global(.mimsy-editor-content .ProseMirror ul) { list-style: disc; padding-left: 1.5em; }
  :global(.mimsy-editor-content .ProseMirror ol) { list-style: decimal; padding-left: 1.5em; }
  :global(.mimsy-editor-content .ProseMirror li) { line-height: 1.7; }
  :global(.mimsy-editor-content .ProseMirror li > p) { margin-top: 0; }
  :global(.mimsy-editor-content .ProseMirror blockquote) {
    border-left: 2px solid #d6d3d1; padding-left: 1em; color: #78716c; font-style: italic;
  }
  :global(.mimsy-editor-content .ProseMirror code) {
    font-family: var(--mimsy-font-mono, 'DM Mono', ui-monospace, monospace);
    background: #f5f5f4; padding: 0.15em 0.35em; border-radius: 0.25em;
    font-size: 0.85em; color: var(--mimsy-accent, #7c3aed);
  }
  :global(.mimsy-editor-content .ProseMirror pre) {
    background: #1c1917; color: #e7e5e4; padding: 0.875em 1.125em;
    border-radius: 0.5em; overflow-x: auto;
    font-family: var(--mimsy-font-mono, 'DM Mono', ui-monospace, monospace);
    font-size: 0.8125em; line-height: 1.6;
  }
  :global(.mimsy-editor-content .ProseMirror pre code) {
    background: none; padding: 0; font-size: inherit; color: inherit;
  }
  :global(.mimsy-editor-content .ProseMirror hr) { border: none; border-top: 1px solid #e7e5e4; margin: 1.5em 0; }
  :global(.mimsy-editor-content .ProseMirror a) {
    color: var(--mimsy-accent, #7c3aed); text-decoration: underline;
    text-underline-offset: 2px; cursor: pointer;
  }
  :global(.mimsy-editor-content .ProseMirror a:hover) { color: var(--mimsy-accent-dark, #5b21b6); }
  :global(.mimsy-editor-content .ProseMirror img) {
    max-width: 100%; height: auto; border-radius: 0.5em; margin: 0.5em 0;
  }
  :global(.mimsy-editor-content .ProseMirror img.ProseMirror-selectednode) {
    outline: 2px solid var(--mimsy-accent, #7c3aed); outline-offset: 3px;
  }
  /* Placeholder */
  :global(.mimsy-editor-content .ProseMirror p.is-editor-empty:first-child::before) {
    content: 'Start writing... (type / for commands)';
    float: left; color: #a8a29e; pointer-events: none; height: 0;
  }

  /* Table styles */
  :global(.mimsy-editor-content .ProseMirror table) {
    border-collapse: collapse; width: 100%; margin: 0.75em 0;
    font-size: 0.875em;
  }
  :global(.mimsy-editor-content .ProseMirror th),
  :global(.mimsy-editor-content .ProseMirror td) {
    border: 1px solid #d6d3d1; padding: 0.5em 0.75em; text-align: left; vertical-align: top;
    min-width: 60px;
  }
  :global(.mimsy-editor-content .ProseMirror th) {
    background: #fafaf9; font-weight: 600; color: #44403c;
  }
  :global(.mimsy-editor-content .ProseMirror td) { background: #fff; }
  :global(.mimsy-editor-content .ProseMirror .selectedCell) {
    background: var(--mimsy-accent-light, #ede9fe) !important;
  }
  :global(.mimsy-editor-content .ProseMirror th p),
  :global(.mimsy-editor-content .ProseMirror td p) {
    margin: 0;
  }

  /* YouTube embed */
  :global(.mimsy-editor-content .ProseMirror .mimsy-youtube-wrap) {
    margin: 0.75em 0; border-radius: 0.5em; overflow: hidden;
    aspect-ratio: 16/9; position: relative; background: #1c1917;
  }
  :global(.mimsy-editor-content .ProseMirror .mimsy-youtube-wrap iframe) {
    position: absolute; inset: 0; width: 100%; height: 100%;
  }
  :global(.mimsy-editor-content .ProseMirror .mimsy-youtube-wrap.ProseMirror-selectednode) {
    outline: 2px solid var(--mimsy-accent, #7c3aed); outline-offset: 3px;
  }
</style>
