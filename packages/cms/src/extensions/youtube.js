import { Node } from '@tiptap/core';

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return m?.[1] || null;
}

export const YouTube = Node.create({
  name: 'youtube',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      videoId: { default: null },
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute('src'),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'iframe',
        getAttrs(el) {
          const src = el.getAttribute('src') || '';
          const id = extractVideoId(src);
          return id ? { videoId: id, src } : false;
        },
      },
      {
        tag: 'div[data-youtube-id]',
        getAttrs(el) {
          const id = el.getAttribute('data-youtube-id');
          return id ? { videoId: id } : false;
        },
      },
    ];
  },

  renderHTML({ node }) {
    const id = node.attrs.videoId;
    return ['div', { class: 'mimsy-youtube-wrap', 'data-youtube-id': id }, [
      'iframe', {
        src: `https://www.youtube.com/embed/${id}`,
        width: '100%',
        height: '400',
        frameborder: '0',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
        allowfullscreen: 'true',
        style: 'border:0;border-radius:0.5em;',
      },
    ]];
  },

  // Serialize as HTML block in markdown (preserved by CommonMark)
  renderMarkdown(node) {
    const id = node.attrs?.videoId;
    if (!id) return '';
    return `<iframe src="https://www.youtube.com/embed/${id}" width="100%" height="400" frameborder="0" allowfullscreen></iframe>\n`;
  },

  addCommands() {
    return {
      setYouTube: (url) => ({ chain }) => {
        const videoId = extractVideoId(url);
        if (!videoId) return false;
        return chain().insertContent({ type: 'youtube', attrs: { videoId } }).run();
      },
    };
  },
});
