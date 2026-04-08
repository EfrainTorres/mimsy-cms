export function toast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  window.dispatchEvent(new CustomEvent('mimsy:toast', { detail: { message, type } }));
}
