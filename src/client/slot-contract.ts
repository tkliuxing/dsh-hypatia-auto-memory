/**
 * Type-only slot contract: this plugin contributes one card under
 * `settings.plugin.item`, keyed by its settings namespace.
 *
 * The slot itself is declared by `@deepseek-ai/dsh-client-ui-settings-plugins`;
 * we only need the type merges so TypeScript knows what `ctx.slots.register`
 * expects here and what locale namespace the card consumes.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoMemoryLocaleKey } from './locales'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Settings card copy for dsh-hypatia-auto-memory. */
    'hypatia-auto-memory': AutoMemoryLocaleKey
  }
}
