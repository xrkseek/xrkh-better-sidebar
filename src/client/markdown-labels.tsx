/**
 * Copy-button chrome for shared `MarkdownText`: XRKH uses a flat
 * `codeLabels` prop (`copyLabel` / `copiedLabel`). Thread the plugin
 * dictionary pair through every render site (re-evaluated per render).
 */
import type { ComponentProps } from 'react'
import { MarkdownText } from '@xrkseek/client-ui-primitives'

/** The flat copy-button pair the plugin threads through its own props (e.g.
 *  MermaidMarkdownProps.codeLabels — the chunk contract stays put). */
export interface MarkdownCopyLabels {
  copyLabel: string
  copiedLabel: string
}

/** MarkdownText props carrying the fence copy labels. */
export function markdownTextProps(text: string, labels: MarkdownCopyLabels): ComponentProps<typeof MarkdownText> {
  return {
    text,
    codeLabels: { copyLabel: labels.copyLabel, copiedLabel: labels.copiedLabel },
  }
}
