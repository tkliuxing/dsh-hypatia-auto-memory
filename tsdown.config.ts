/**
 * Build the browser half as the factory artifact DSH's client module loader
 * consumes. CSS Modules compile and inject when that factory executes.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'

const PACKAGE_NAME = 'dsh-hypatia-auto-memory'
const NODE_ENV = process.env['NODE_ENV'] ?? 'production'
const CSS_VIRTUAL_PREFIX = '\0dsh-hypatia-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Modules the DSH web shell seeds into the browser module table. */
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
])

function styleInjectionModule(fileId: string, css: string, classMap: Readonly<Record<string, string>>): string {
  const tagId = `${PACKAGE_NAME}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_NAME)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

export default {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2023',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !specifier.startsWith('node:') && !CLIENT_EXTERNALS.has(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: [
        NODE_ENV === 'development' ? 'development' : 'production',
        'browser', 'import', 'module', 'default',
      ],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
  },
  plugins: [{
    name: 'dsh-hypatia-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const fileId = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + fileId + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // Sort before building the map: lightningcss hands `exports` back in an
      // order that varies between runs, and `JSON.stringify` preserves insertion
      // order, so an unsorted map made every build emit a differently ordered
      // bundle — identical in meaning, different in bytes. That is churn in
      // `lib/client.js` on every `npm run build`, and `prepublishOnly` runs one,
      // so every release carried a spurious diff. Sorting the locals is enough:
      // nothing reads this object by position.
      const classMap: Record<string, string> = {}
      const locals = Object.entries(cssExports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      for (const [local, exported] of locals) classMap[local] = exported.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
