/**
 * Staged form model behind the hypatia-auto-memory settings card.
 *
 * A port of the shared form behind the official DSH plugin cards
 * (`@deepseek-ai/dsh-client-ui-settings-plugins/src/client/card-form.ts`),
 * adapted to what this plugin needs and an out-of-tree bundle can carry:
 *
 * - every field addresses a PATH inside the namespace section, because the
 *   `hypatia-auto-memory` schema is nested (`consolidation.models`,
 *   `recall.preloadRulesTaboos`); the Host applies path ops recursively;
 * - boolean fields exist alongside text and number fields;
 * - one save issues ONE atomic `scope.mutate(ops)`, so related model-route
 *   selections are admitted or refused as one unit;
 * - the card stages what the user types and writes only on save; a field is
 *   "overridden" when the user layer CARRIES it (presence, not value), and a
 *   reset stages a clear back to the composition layer;
 * - the Host is the only authority on whether a write landed: the outcome is
 *   read back from the user layer, and drafts a save did not land stay put.
 *
 * Zero runtime imports, so the model is unit-tested under `node:test`
 * without a bundler (see `test/client-card-form.test.mjs`). Only erasable
 * TypeScript syntax is used for the same reason.
 */

/** JSON-shaped value a field may write into the settings document. */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike }

/** One path-addressed edit as `SettingsScope.mutate` accepts it. */
export type PathOp =
  | { op: 'set'; path: string[]; value: JsonLike }
  | { op: 'unset'; path: string[] }

/** The slice of the client settings scope this form reads and writes. */
export interface FormScope {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PathOp[]): Promise<void>
}

/** The slice of a settings-scope snapshot the form reads. */
export interface FormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: unknown
  base: unknown
  user: unknown
  writable: boolean
}

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite =
  | { kind: 'set'; value: JsonLike }
  | { kind: 'clear' }

/** Control family a field renders as. */
export type FieldKind = 'text' | 'number' | 'boolean'

/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /** Field name the card addresses this control by. */
  field: string
  /** Path from the section root to the stored value. */
  path: readonly string[]
  /** Control family. */
  kind: FieldKind
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: unknown) => string
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as a card's control renders it. */
export interface CardFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Form state every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid (or the whole form is), which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/** The write actions every plugin card's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  edit: (field: string, text: string) => void
  /** Stage the opposite of a boolean field's effective value. */
  toggle: (field: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** Options narrowing what the form as a whole accepts. */
export interface CardFormOptions {
  /**
   * A form-wide constraint over the EFFECTIVE values a save would leave
   * (`read(field)`), for rules that span fields. Returning true marks the
   * form invalid and blocks the save; the card renders the reason.
   */
  violates?: (read: (field: string) => unknown) => boolean
}

interface StagedEdit {
  text: string
  clear: boolean
}

interface PlannedWrite {
  field: string
  /** The op a save issues; undefined when the draft is not a value the field accepts. */
  op: PathOp | undefined
}

/** Read `path` under `root` when every step is an own property of a plain object. */
export function readPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const step of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, step)) return undefined
    current = current[step]
  }
  return current
}

/** Whether every step of `path` is an own property under `root`. */
export function hasPath(root: unknown, path: readonly string[]): boolean {
  let current: unknown = root
  for (const step of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, step)) return false
    current = current[step]
  }
  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - field name the card addresses this control by.
 * @param path - path from the section root.
 * @returns the field's conversion spec.
 */
export function textField(field: string, path: readonly string[]): CardFieldSpec {
  return {
    field,
    path,
    kind: 'text',
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A number field. An empty draft clears the field; a draft that is not a
 * finite number, or violates the declared bounds, blocks the save.
 * @param field - field name the card addresses this control by.
 * @param path - path from the section root.
 * @param bounds - `integer` requires a whole number; `min` is inclusive.
 * @returns the field's conversion spec.
 */
export function numberField(
  field: string,
  path: readonly string[],
  bounds: { integer?: boolean; min?: number } = {},
): CardFieldSpec {
  return {
    field,
    path,
    kind: 'number',
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return undefined
      if (bounds.integer === true && !Number.isInteger(parsed)) return undefined
      if (bounds.min !== undefined && parsed < bounds.min) return undefined
      return { kind: 'set', value: parsed }
    },
  }
}

/**
 * A boolean field rendered as a switch. Its draft text is `true`/`false`;
 * an empty draft clears the field.
 * @param field - field name the card addresses this control by.
 * @param path - path from the section root.
 * @returns the field's conversion spec.
 */
export function booleanField(field: string, path: readonly string[]): CardFieldSpec {
  return {
    field,
    path,
    kind: 'boolean',
    format: value => value === true ? 'true' : value === false ? 'false' : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/**
 * Stages one card's edits over one settings namespace and writes them on save.
 *
 * The form publishes through plain listeners; the controller that owns it
 * projects the form into a snapshot store the renderer binds as a selector
 * hook. Both the scope and the local drafts change underneath, so every
 * projection is rebuilt from the two together.
 */
export class CardForm {
  private readonly scope: FormScope
  private readonly specs: Map<string, CardFieldSpec>
  private readonly violates: ((read: (field: string) => unknown) => boolean) | undefined
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param specs - the section fields this card edits.
   * @param options - form-wide constraints.
   */
  constructor(scope: FormScope, specs: readonly CardFieldSpec[], options: CardFormOptions = {}) {
    this.scope = scope
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    this.violates = options.violates
    scope.subscribe(() => { this.publish() })
  }

  /**
   * Observe every change to what the form would render.
   * @param listener - invoked after each scope change or staged edit.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the card-level state: what the Host serves, and what a save would do.
   * @returns the form state every card shares.
   */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.op === undefined) || this.violated(),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * Read one control's state.
   * @param field - field name of a section field.
   * @returns the draft text, whether a save would leave an override, and whether it is invalid.
   */
  field(field: string): CardFieldState {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(spec)), overridden: this.stored(spec), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /**
   * The value a save would leave in force for one field: the staged write
   * when it parses, the composition value behind a staged clear, or the
   * section value when nothing is staged.
   * @param field - field name of a section field.
   * @returns the effective value, or undefined while the draft is invalid.
   */
  effective(field: string): unknown {
    const spec = this.spec(field)
    const staged = this.staged.get(field)
    if (staged === undefined) return this.sectionValue(spec)
    if (staged.clear) return this.baseValue(spec)
    const write = spec.parse(staged.text)
    if (write === undefined) return undefined
    return write.kind === 'clear' ? this.baseValue(spec) : write.value
  }

  /**
   * Build the edit, toggle, reset, save, and discard actions bound to this form.
   * @returns the actions a card's slot entry injects.
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      toggle: (field) => {
        this.stage(field, { text: this.effective(field) === true ? 'false' : 'true', clear: false })
      },
      resetField: (field) => {
        const spec = this.spec(field)
        this.stage(field, { text: spec.format(this.baseValue(spec)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged edit in one atomic mutation, then re-seed from what
   * the Host accepted.
   *
   * The Host is the only authority on whether the values were accepted — its
   * validators own the constraints no schema can express — so the outcome is
   * read back from the user layer rather than predicted here. A save that
   * did not land keeps its drafts, so the user can correct them instead of
   * retyping.
   * @returns settlement after the write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || plan.some(item => item.op === undefined) || this.violated()) return
    const ops = plan.flatMap(item => item.op === undefined ? [] : [item.op])
    this.saving = true
    this.failed = false
    this.publish()
    let landed = false
    try {
      await this.scope.mutate(ops)
      landed = ops.every(op => this.landed(op))
    } catch {
      // A transport failure reads the same as a refused write: nothing landed.
      landed = false
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /**
   * Every staged edit a save would write. An entry whose draft is not a value
   * its field accepts carries no op: the form is still dirty, and the save
   * refuses rather than dropping the edit.
   * @returns the planned writes, in the order the fields were staged.
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      const path = [...spec.path]
      if (staged.clear) {
        if (this.stored(spec)) plan.push({ field, op: { op: 'unset', path } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(spec))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, op: undefined })
      else if (write.kind === 'clear') {
        if (this.stored(spec)) plan.push({ field, op: { op: 'unset', path } })
      } else plan.push({ field, op: { op: 'set', path, value: write.value } })
    }
    return plan
  }

  private landed(op: PathOp): boolean {
    const user = this.scope.getSnapshot().user
    if (op.op === 'unset') return !hasPath(user, op.path)
    return hasPath(user, op.path) && sameJson(readPath(user, op.path), op.value)
  }

  private violated(): boolean {
    if (this.violates === undefined) return false
    return this.violates(field => this.effective(field))
  }

  private stage(field: string, edit: StagedEdit): void {
    this.spec(field)
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    // Every call site names a field this card declared; a missing one is a
    // wiring mistake that must not degrade into a silently inert control.
    if (spec === undefined) throw new Error(`hypatia-auto-memory card has no field ${field}`)
    return spec
  }

  private sectionValue(spec: CardFieldSpec): unknown {
    return readPath(this.scope.getSnapshot().value, spec.path)
  }

  private baseValue(spec: CardFieldSpec): unknown {
    return readPath(this.scope.getSnapshot().base, spec.path)
  }

  private stored(spec: CardFieldSpec): boolean {
    return hasPath(this.scope.getSnapshot().user, spec.path)
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
