declare module 'markdown-it-footnote' {
  import MarkdownIt from 'markdown-it';
  const plugin: (parser: InstanceType<typeof MarkdownIt>) => void;
  export default plugin;
}

declare module 'markdown-it-katex' {
  import MarkdownIt from 'markdown-it';
  const plugin: (parser: InstanceType<typeof MarkdownIt>, options: { throwOnError: boolean; trust: boolean }) => void;
  export default plugin;
}
