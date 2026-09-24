/**
 * Type-only slot contract: this plugin contributes one tab inside
 * `settings.plugins.tab`, keyed by its settings namespace.
 *
 * The slot itself is declared by `@deepseek-ai/dsh-client-ui-settings`
 * (the settings domain base, which also provides `ctx.configForms`); we only
 * need the locale namespace merge so TypeScript knows what the card consumes.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoMemoryLocaleKey } from './locales'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Settings card copy for dsh-hypatia-auto-memory. */
    'hypatia-auto-memory': AutoMemoryLocaleKey
  }
}
