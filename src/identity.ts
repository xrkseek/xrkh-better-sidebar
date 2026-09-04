/**
 * Single package identity for xrkh-better-sidebar.
 * Keep in lockstep with package.json `name`.
 */
export const PACKAGE_ID = "xrkh-better-sidebar" as const;

/** Settings / UI badge display name. */
export const PACKAGE_DISPLAY_NAME = "xrkh-better-sidebar" as const;

/** Log / Error tag: `[xrkh-better-sidebar] …` */
export function packageTag(message: string): string {
  return `[${PACKAGE_ID}] ${message}`;
}
