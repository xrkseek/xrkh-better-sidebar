/**
 * Shared vocabulary of the recommended plugin catalogs.
 */

/** Browse more XRKH / sidebar-related plugins on GitHub. */
export const PLUGIN_TOPIC_URL = 'https://github.com/topics/xrkh-better-sidebar'

/** One curated plugin entry (name / url / description / install script). */
export interface PluginEntry {
  /** Unique id (the npm package name). */
  id: string
  /** Short display name. */
  name: string
  /** GitHub repository URL. */
  url: string
  /** One-line description (i18n friendly: string or () => string). */
  description: string | (() => string)
  /** Optional catalog group heading (i18n friendly). */
  category?: string | (() => string)
  /** Shell command pre-filled into the install terminal. */
  install: string
}
