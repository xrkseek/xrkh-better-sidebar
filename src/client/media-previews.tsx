/**
 * Lightweight media / tabular previews registered beside the built-in
 * image/pdf/markdown viewers. Office stays on a dedicated viewer card that
 * reuses {@link BinaryDownload} until a heavy renderer is reintroduced.
 */
import type { ReactNode } from 'react'
import type { FileViewerProps } from './service.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Split one CSV/TSV text into rows (RFC4180-ish enough for settings/preview). */
export function parseDelimited(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

/** CSV / TSV table preview (first ~200 rows). */
export function CsvPreview(props: FileViewerProps): ReactNode {
  const text = props.content ?? ''
  const delimiter = props.path.toLowerCase().endsWith('.tsv') ? '\t' : ','
  const rows = parseDelimited(text, delimiter).slice(0, 200)
  if (rows.length === 0) {
    return (
      <div className={css.editorBinary}>
        <span className={css.editorBinaryNotice}>{t('editorEmptyHint')}</span>
      </div>
    )
  }
  const [header, ...body] = rows
  return (
    <div className={css.editorCsvWrap}>
      <table className={css.editorCsv}>
        <thead>
          <tr>{(header ?? []).map((cell, i) => <th key={i}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {(header ?? r).map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** HTML5 audio preview via the media route. */
export function AudioPreview(props: FileViewerProps): ReactNode {
  const url = props.mediaUrl
  if (!url) return null
  return (
    <div className={css.editorMediaWrap}>
      <audio className={css.editorAudio} controls src={url} preload="metadata">
        {props.title}
      </audio>
    </div>
  )
}

/** HTML5 video preview via the media route. */
export function VideoPreview(props: FileViewerProps): ReactNode {
  const url = props.mediaUrl
  if (!url) return null
  return (
    <div className={css.editorMediaWrap}>
      <video className={css.editorVideo} controls src={url} preload="metadata">
        {props.title}
      </video>
    </div>
  )
}
