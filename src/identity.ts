/**
 * Single package identity for xrkh-better-sidebar.
 * Name / version come from package.json — do not hardcode a semver here.
 */
import packageJson from '../package.json' with { type: 'json' }

export const PACKAGE_ID = packageJson.name as 'xrkh-better-sidebar'

/** Settings / UI badge display name. */
export const PACKAGE_DISPLAY_NAME = packageJson.name

/** Semver from package.json (settings badge + service.version). */
export const PACKAGE_VERSION: string = packageJson.version

/** Log / Error tag: `[xrkh-better-sidebar] …` */
export function packageTag(message: string): string {
  return `[${PACKAGE_ID}] ${message}`
}
