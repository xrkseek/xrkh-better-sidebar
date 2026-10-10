/**
 * Recommended FILE-PREVIEWER plugins catalog (Side card → add preview plugin).
 */
import type { PluginEntry } from './plugins-shared.ts'
import { t } from './locales.ts'

export const builtinViewerPlugins: readonly PluginEntry[] = [
  {
    id: 'xrkh-better-sidebar-plugin-office',
    name: 'Office preview',
    url: 'https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office',
    description: () => t('pluginOfficeDesc'),
    install: 'xrkh plugin add xrkh-better-sidebar-plugin-office@0.1.0',
  },
]
