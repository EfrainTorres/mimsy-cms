<script>
  /** client:visible island test: frontmatter-driven content that hydrates late */
  let { quote, author } = $props();
</script>

<blockquote class="bg-stone-50 border-l-4 border-blue-500 rounded-r-lg p-6">
  <p class="text-stone-700 italic leading-relaxed">"{quote}"</p>
  <footer class="mt-3 text-sm font-medium text-stone-500">&mdash; {author}</footer>
</blockquote>
