/**
 * Browser half of dsh-hypatia-auto-memory: contributes a settings card under
 * Settings → Plugins, keyed by the `hypatia-auto-memory` namespace.
 *
 * The Host plugin already registers the schema and namespace; this half only
 * renders the form and routes edits through `ctx.settingsScope`.
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
import { createElement } from 'react'
import { SettingsCard } from './SettingsCard'
import type { ConfigShape } from './SettingsCard'
import type { LoadConsolidationModelCatalog } from './consolidation-models'
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

  ctx.effect(() => () => {
    unregister()
    releaseApply()
  })
}
