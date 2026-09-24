/**
 * Browser half of dsh-hypatia-auto-memory: contributes a settings tab inside
 * Settings → Plugins, keyed by the `hypatia-auto-memory` namespace, and a
 * per-session Memory tab beside the conversation's Chat and Trajectory tabs.
 *
 * The Host plugin already registers the schema and namespace; this half only
 * renders the form and routes edits through `ctx.configForms`. The Memory tab
 * reads the Host's read-only status namespace (see `src/memory-status.js`).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
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
import { fetchMemory, fetchShelves } from './memory-client'
import type { LoadShelfInventory } from './shelves'
import { en, NS, zh } from './locales'

const APPLY_CLAIM = '__dshHypatiaAutoMemoryApplied'

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
 * Required client services: slots, locale, the Host model catalog, and the
 * settings domain's shared configuration forms (the 0.1.7 successor of the
 * removed `settingsScope` service). Each Remote namespace is its own service,
 * so `remote.session` must be declared here or reading it throws.
 */
export const inject = ['slots', 'configForms', 'locale', 'remote', 'remote.session']

/** Mount the browser half. */
export function apply(ctx: Context): void {
  if (!claimApply()) return

  // Resolve through ctx.get with an explicit type rather than ctx.configForms:
  // the settings package's cordis Context merge only applies when its types
  // resolve to the same cordis module identity, which is not guaranteed for an
  // npm-installed plugin (symlinked workspace checkouts diverge).
  const configForms = ctx.get('configForms') as ConfigForms
  const form = configForms.get<ConfigShape>(NS)

  // Resolve through ctx.get with an explicit type rather than ctx.locale: the
  // locale package's cordis Context merge only applies when its types resolve
  // to the same cordis module identity, which is not guaranteed for an
  // npm-installed plugin (symlinked workspace checkouts diverge).
  const locale = ctx.get('locale') as unknown as LocaleRuntime
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-hypatia-auto-memory: locale dictionaries')
  // Bound before either registration below: the plugins tab label and the
  // Memory tab label both read through it so they follow the active locale
  // without re-registration, exactly as ui-trajectory's does.
  const t = locale.bind(NS)

  const loadModelCatalog: LoadConsolidationModelCatalog = async () => {
    const response = await ctx.remote.session.modelCatalog()
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return {
      groups: response.value.groups,
      partial: response.value.failures.length > 0,
    }
  }
  // The shelf listing comes from the Host's own route family: the 0.1.7
  // settings document only projects plugin Config forms, so the read-only
  // inventory namespace this used to ride can no longer be published.
  const loadShelfInventory: LoadShelfInventory = fetchShelves
  const renderCard = (props: PropsLocale<typeof NS>) => createElement(SettingsCard, {
    scope: form,
    loadModelCatalog,
    loadShelfInventory,
    ...props,
  })
  // The tab exists only while the Host serves our namespace; whileServed owns
  // the watch and hands us a disposer for the live registration.
  const unregister = ctx.effect(() => configForms.whileServed([NS], () =>
    ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register(
        { name: 'settings.plugins.tab', id: NS, label: () => t('title'), locale: NS },
        renderCard,
      ),
    ),
  ), 'dsh-hypatia-auto-memory: plugins settings tab')

  // The Memory tab's data: one same-origin request to the route family this
  // plugin's Host half registers (see `src/memory-api.js`) — the same family
  // the shelf listing above rides — parameterized by the session the tab is
  // bound to.
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
