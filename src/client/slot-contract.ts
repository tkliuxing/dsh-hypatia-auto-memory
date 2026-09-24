/**
 * Type-only slot contract: this plugin contributes one settings card, and the
 * card's seat depends on the harness that renders it (see `plugin-card-seat.ts`).
 *
 * - `plugins.bundle.config` is declared by `@deepseek-ai/dsh-client-ui-plugin-manager`,
 *   the sidebar Plugins page dsh ≥ 0.1.7 ships: the keyed seat, keyed by this
 *   bundle's package name, that the page renders on the bundle's own page.
 * - `settings.plugins.tab` is declared by `@deepseek-ai/dsh-client-ui-settings-plugins`,
 *   the Settings section's list seat, which is all a deployment without that
 *   page has.
 *
 * Those packages declare the slot keys; we merge their types so
 * `ctx.slots.register` type-checks, plus our own locale namespace so TypeScript
 * knows what the card consumes.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { AutoMemoryLocaleKey } from './locales'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Settings card copy for dsh-hypatia-auto-memory. */
    'hypatia-auto-memory': AutoMemoryLocaleKey
  }
}
