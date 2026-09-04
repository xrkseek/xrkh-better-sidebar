/**
 * Build-time ambient stubs for unpublished / renamed XRKH workspace packages
 * that `@xrkseek/xrk-host-apiproxy/api` pulls in via client-connection types.
 * Runtime never loads these; they only keep `tsc -p tsconfig.build.json` green
 * when the plugin is built against the harness monorepo.
 */
declare module '@xrkseek/xrk-jobs/brand' {
  export type JobId = string & { readonly [brand]: unique symbol }
  declare const brand: unique symbol
}

declare module '@xrkseek/xrk-attachment' {
  export type AttachmentIdType = string
  export type ImageMediaType = string
  export type ImageAttachmentLimits = {
    maxCount?: number
    maxBytes?: number
  }
  export type ImageAttachmentRef = {
    id: AttachmentIdType
    mediaType?: ImageMediaType
  }
}

declare module '@xrkseek/xrk-session-projection/types' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface SessionProjectionMap {}
}
