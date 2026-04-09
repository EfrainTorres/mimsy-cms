import { Node, mergeAttributes } from '@tiptap/core';
import { tableEditing, goToNextCell, addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable } from '@tiptap/pm/tables';

export const Table = Node.create({
  name: 'table',
  group: 'block',
  content: 'tableRow+',
  tableRole: 'table',
  isolating: true,

  parseHTML() { return [{ tag: 'table' }]; },

  renderHTML({ HTMLAttributes }) {
    return ['table', mergeAttributes(HTMLAttributes), ['tbody', 0]];
  },

  // GFM table markdown: | H1 | H2 |\n|---|---|\n| c1 | c2 |
  parseMarkdown(token, helpers) {
    if (token.type !== 'table') return null;
    const rows = [];
    // Header row
    if (token.header?.length) {
      const headerCells = token.header.map(cell => ({
        type: 'tableHeader',
        content: [{ type: 'paragraph', content: helpers.parseInline ? helpers.parseInline(cell.tokens || []) : [{ type: 'text', text: cell.text || '' }] }],
      }));
      rows.push({ type: 'tableRow', content: headerCells });
    }
    // Body rows
    if (token.rows?.length) {
      for (const row of token.rows) {
        const cells = row.map(cell => ({
          type: 'tableCell',
          content: [{ type: 'paragraph', content: helpers.parseInline ? helpers.parseInline(cell.tokens || []) : [{ type: 'text', text: cell.text || '' }] }],
        }));
        rows.push({ type: 'tableRow', content: cells });
      }
    }
    return { type: 'table', content: rows };
  },

  markdownTokenName: 'table',

  renderMarkdown(node, helpers) {
    const rows = node.content || [];
    if (!rows.length) return '';

    const grid = rows.map(row =>
      (row.content || []).map(cell => {
        const para = cell.content?.[0];
        if (!para || !para.content) return '';
        // Use helpers.renderChildren to preserve inline marks (bold, italic, links)
        const text = helpers.renderChildren(para.content, '');
        return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
      })
    );

    const cols = Math.max(...grid.map(r => r.length));
    // Pad rows to equal column count
    for (const row of grid) { while (row.length < cols) row.push(''); }

    // Column widths
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.max(3, ...grid.map(r => r[c]?.length || 0))
    );

    const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
    const formatRow = (cells) => '| ' + cells.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
    const separator = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';

    const lines = [];
    lines.push(formatRow(grid[0]));
    lines.push(separator);
    for (let i = 1; i < grid.length; i++) lines.push(formatRow(grid[i]));
    return lines.join('\n') + '\n';
  },

  addCommands() {
    return {
      insertTable: ({ rows = 3, cols = 3 } = {}) => ({ editor, chain }) => {
        const headerCells = [];
        for (let c = 0; c < cols; c++) {
          headerCells.push({ type: 'tableHeader', content: [{ type: 'paragraph' }] });
        }
        const bodyRows = [];
        for (let r = 0; r < rows - 1; r++) {
          const cells = [];
          for (let c = 0; c < cols; c++) {
            cells.push({ type: 'tableCell', content: [{ type: 'paragraph' }] });
          }
          bodyRows.push({ type: 'tableRow', content: cells });
        }
        return chain().insertContent({
          type: 'table',
          content: [
            { type: 'tableRow', content: headerCells },
            ...bodyRows,
          ],
        }).run();
      },
      addRowAfter: () => ({ state, dispatch }) => addRowAfter(state, dispatch),
      addRowBefore: () => ({ state, dispatch }) => addRowBefore(state, dispatch),
      addColumnAfter: () => ({ state, dispatch }) => addColumnAfter(state, dispatch),
      addColumnBefore: () => ({ state, dispatch }) => addColumnBefore(state, dispatch),
      deleteRow: () => ({ state, dispatch }) => deleteRow(state, dispatch),
      deleteColumn: () => ({ state, dispatch }) => deleteColumn(state, dispatch),
      deleteTable: () => ({ state, dispatch }) => deleteTable(state, dispatch),
    };
  },

  addProseMirrorPlugins() {
    return [tableEditing()];
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => goToNextCell(1)(this.editor.view.state, this.editor.view.dispatch),
      'Shift-Tab': () => goToNextCell(-1)(this.editor.view.state, this.editor.view.dispatch),
    };
  },
});

export const TableRow = Node.create({
  name: 'tableRow',
  content: '(tableCell | tableHeader)+',
  tableRole: 'row',
  parseHTML() { return [{ tag: 'tr' }]; },
  renderHTML({ HTMLAttributes }) { return ['tr', mergeAttributes(HTMLAttributes), 0]; },
});

export const TableCell = Node.create({
  name: 'tableCell',
  content: 'block+',
  tableRole: 'cell',
  isolating: true,
  parseHTML() { return [{ tag: 'td' }]; },
  renderHTML({ HTMLAttributes }) { return ['td', mergeAttributes(HTMLAttributes), 0]; },
  addAttributes() {
    return {
      colspan: { default: 1 },
      rowspan: { default: 1 },
    };
  },
});

export const TableHeader = Node.create({
  name: 'tableHeader',
  content: 'block+',
  tableRole: 'header_cell',
  isolating: true,
  parseHTML() { return [{ tag: 'th' }]; },
  renderHTML({ HTMLAttributes }) { return ['th', mergeAttributes(HTMLAttributes), 0]; },
  addAttributes() {
    return {
      colspan: { default: 1 },
      rowspan: { default: 1 },
    };
  },
});
