#!/usr/bin/env node
/**
 * Refresh the verbatim skill copies from the repository root.
 *
 * `hypatia-memory` is deliberately NOT synced: this plugin ships its own
 * variant, in which the agent retrieves and the plugin writes. Only the copies
 * the plugin carries on behalf of the retired `dsh-hypatia` are refreshed.
 *
 * Usage: npm run sync-skills
 */

import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COPIES = ['hypatia', 'hypatia-dream']

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const canonical = join(dirname(packageRoot), 'skills')

if (existsSync(canonical) === false) {
  console.error(`canonical skills directory not found: ${canonical}`)
  console.error('run this from a checkout of the hypatia repository')
  process.exit(1)
}

for (const skill of COPIES) {
  const from = join(canonical, skill)
  if (existsSync(from) === false) {
    console.error(`missing upstream skill: ${from}`)
    process.exit(1)
  }
  cpSync(from, join(packageRoot, 'skills', skill), { recursive: true })
  console.log(`synced ${skill}`)
}
