/**
 * Browser half of dsh-hypatia-auto-memory: contributes a settings card under
 * Settings → Plugins, keyed by the `hypatia-auto-memory` namespace, and a
 * per-session Memory tab beside the conversation's Chat and Trajectory tabs.
 *
 * The Host plugin already registers the schema and namespace; this half only
 * renders the form and routes edits through `ctx.settingsScope`. The Memory tab
 * reads the Host's read-only status namespace (see `src/memory-status.js`).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: the 'conversation.view' SlotMap row is declared by the conversation
// shell, so the registration below only type-checks with its merge in the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createElement } from 'react'
import { SettingsCard } from './SettingsCard'
import type { ConfigShape } from './SettingsCard'
import type { LoadConsolidationModelCatalog } from './consolidation-models'
import { MemoryView } from './MemoryView'
import { fetchMemory } from './memory-client'
import { readShelfInventory, type LoadShelfInventory } from './shelves'
import { en, NS, zh } from './locales'

const APPLY_CLAIM = '__dshHypatiaAutoMemoryApplied'

/**
 * The one settings-controller method this card calls. The remotes assembly
 * mounts the `settings` namespace at runtime, but its declaration merge lives
 * in `@deepseek-ai/dsh-api-settings-controller`, which this bundle does not
 * depend on for one method.
 */
interface SettingsDescribeRemote {
  describe(): Promise<RemoteResult<{ namespaces: readonly unknown[] }>>
}

function claimApply(): boolean {
  const scope = globalThis as Record<string, unknown>
  if (scope[APPLY_CLAIM] === true) return false
  scope[APPLY_CLAIM] = true
  return true
}

function releaseApply(): void {
  delete (globalThis as Record<string, unknown>)[APPLY_CLAIM]
}

/**
 * Required client services: settings, locale, slots, the Host model catalog,
 * and the settings descriptor. Each Remote namespace is its own service, so
 * `remote.settings` must be declared here or reading it throws.
 */
export const inject = ['slots', 'settingsScope', 'locale', 'remote', 'remote.session', 'remote.settings']

/** Mount the browser half. */
export function apply(ctx: Context): void {
  if (!claimApply()) return

  const settingsScope = ctx.get('settingsScope') as SettingsScopeBinder
  const scope = settingsScope.bind<ConfigShape>({ namespace: NS })

  // Resolve through ctx.get with an explicit type rather than ctx.locale: the
  // locale package's cordis Context merge only applies when its types resolve
  // to the same cordis module identity, which is not guaranteed for an
  // npm-installed plugin (symlinked workspace checkouts diverge).
  const locale = ctx.get('locale') as unknown as LocaleRuntime
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-hypatia-auto-memory: locale dictionaries')

  const loadModelCatalog: LoadConsolidationModelCatalog = async () => {
    const response = await ctx.remote.session.modelCatalog()
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return {
      groups: response.value.groups,
      partial: response.value.failures.length > 0,
    }
  }
  // The Host re-publishes `hypatia list` as a settings namespace no card
  // claims; the descriptor is the only wire path a plugin's Host half has.
  // Read directly rather than through the shared describe mirror: the mirror
  // re-reads only on document commits, and a re-registration is not one.
  const loadShelfInventory: LoadShelfInventory = async () => {
    const settings = (ctx.remote as unknown as { settings: SettingsDescribeRemote }).settings
    const response = await settings.describe()
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    const inventory = readShelfInventory(response.value.namespaces)
    if (inventory === undefined) throw new Error('the Host publishes no shelf listing')
    return inventory
  }
  const renderCard = (props: PropsLocale<typeof NS>) => createElement(SettingsCard, {
    scope,
    loadModelCatalog,
    loadShelfInventory,
    ...props,
  })
  const unregister = ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      { name: 'settings.plugin.item', key: NS, locale: NS },
      renderCard,
    ),
  )

  // The Memory tab's data: one same-origin request to the route this plugin's
  // Host half registers (see `src/memory-api.js`), parameterized by the session
  // the tab is bound to — which is why it is a route and not the settings
  // descriptor read the shelf listing uses.
  // The tab label reads through a bound translate so it follows the active
  // locale without re-registration, exactly as ui-trajectory's does.
  const t = locale.bind(NS)
  const unregisterMemoryView = ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'memory',
        // After Chat (0) and Trajectory (10).
        order: 20,
        locale: NS,
        label: () => t('viewMemory'),
        inject: () => ({ fetch: fetchMemory }),
      },
      MemoryView,
    ),
  )

  ctx.effect(() => () => {
    unregister()
    unregisterMemoryView()
    releaseApply()
  })
}
