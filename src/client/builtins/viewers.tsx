/**
 * Built-in file viewer descriptors: image / pdf / markdown / html / office /
 * csv / audio / video / code / binary-download. Office OOXML and legacy OLE
 * share the download pane for now (heavy Univer / docx-preview stacks stay
 * out of the core bundle); CSV/audio/video are native light previews.
 *
 * The heavy viewers (CodeMirror-backed markdown/html/code) render through
 * {@link lazyChunkComponent} wrappers — libraries load on first open.
 *
 * Every viewer carries declarative settings-surface fields (`title`, `icon`)
 * so the Side card settings page can render the enable/disable inventory.
 */
import { IconCodeOutline16, IconDownloadOutline16 } from '@xrkseek/client-ui-primitives'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import { PdfView } from '../PdfView.tsx'
import { BinaryDownload } from '../binary-download.tsx'
import {
  AudioPreview,
  CsvPreview,
  VideoPreview,
} from '../media-previews.tsx'
import {
  IconImageOutline16,
  IconMarkdownOutline16,
  IconPdfOutline16,
  IconHtmlOutline16,
} from '../icons.tsx'
import type { ComponentType } from 'react'
import type { FileViewerDescriptor, FileViewerProps } from '../service.ts'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

/**
 * Lazy wrapper over the chunk-resident viewer component. The `pick`
 * function is module-level (stable identity — the wrapper effect depends
 * on it); the cast bridges the chunk exports record to the descriptor prop
 * shape (the view reads only its own subset of FileViewerProps).
 */
const LazyTextEditor = lazyChunkComponent<FileViewerProps>('editor', (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined)

/** Built-in file viewer descriptors (office + media + tabular included). */
export function builtinViewers(): readonly FileViewerDescriptor[] {
  return [
    {
      id: 'image',
      title: () => t('viewerImage'),
      icon: (size: number) => <IconImageOutline16 size={size} />,
      exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
      fetchStrategy: 'mediaUrl',
      component: ({ mediaUrl: url, title }) => (
        <div className={css.editorImageWrap}>
          <img className={css.editorImage} src={url} alt={title} />
        </div>
      ),
    },
    {
      id: 'pdf',
      title: () => t('viewerPdf'),
      icon: (size: number) => <IconPdfOutline16 size={size} />,
      exts: ['pdf'],
      fetchStrategy: 'mediaUrl',
      component: ({ scope, path, title }) => (
        <PdfView scope={scope} path={path} title={title} />
      ),
    },
    {
      id: 'markdown',
      title: () => t('viewerMarkdown'),
      icon: (size: number) => <IconMarkdownOutline16 size={size} />,
      exts: ['md', 'markdown'],
      fetchStrategy: 'fsRead',
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'html',
      title: () => t('viewerHtml'),
      icon: (size: number) => <IconHtmlOutline16 size={size} />,
      exts: ['html', 'htm'],
      fetchStrategy: 'fsRead',
      settings: {
        toggles: [{
          key: 'htmlViewerNoSandbox',
          title: () => t('settingsHtmlSandboxTitle'),
          desc: () => t('settingsHtmlSandboxDesc'),
        }, {
          key: 'htmlViewerDefaultUnsafe',
          title: () => t('settingsHtmlDefaultUnsafeTitle'),
          desc: () => t('settingsHtmlDefaultUnsafeDesc'),
        }],
      },
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'office',
      title: () => t('viewerOffice'),
      icon: (size: number) => <IconDownloadOutline16 size={size} />,
      exts: ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf'],
      priority: 10,
      fetchStrategy: 'binary-download',
      component: ({ scope, path }) => <BinaryDownload scope={scope} path={path} />,
    },
    {
      id: 'csv',
      title: () => t('viewerCsv'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      exts: ['csv', 'tsv'],
      priority: 20,
      fetchStrategy: 'fsRead',
      component: (props) => <CsvPreview {...props} />,
    },
    {
      id: 'audio',
      title: () => t('viewerAudio'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      exts: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
      priority: 20,
      fetchStrategy: 'mediaUrl',
      component: (props) => <AudioPreview {...props} />,
    },
    {
      id: 'video',
      title: () => t('viewerVideo'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      exts: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
      priority: 20,
      fetchStrategy: 'mediaUrl',
      component: (props) => <VideoPreview {...props} />,
    },
    {
      id: 'code',
      title: () => t('viewerCode'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      exts: [],
      priority: -100,
      fetchStrategy: 'fsRead',
      component: (props) => <LazyTextEditor {...props} />,
    },
    {
      id: 'binary-download',
      title: () => t('viewerBinary'),
      icon: (size: number) => <IconDownloadOutline16 size={size} />,
      exts: ['zip', 'rar', '7z', 'gz', 'tar', 'exe', 'dll', 'wasm'],
      priority: -50,
      fetchStrategy: 'binary-download',
      // NUL probe: a file whose head bytes contain a NUL is binary — claimed
      // before the catch-all code viewer on the head re-match.
      detect: (_path, head) => head.includes(0),
      component: ({ scope, path }) => <BinaryDownload scope={scope} path={path} />,
    },
  ]
}
