#!/usr/bin/env node
/**
 * Publish the bundle when its exact version is not on npm yet.
 *
 * Every component ships inside this package (subpath rows), so there is exactly
 * one registry entry to publish. Re-running is safe: the version is skipped when
 * the registry already has it, which also lets a partially failed CI run continue.
 *
 * Usage: pnpm release [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const root = process.cwd()
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let published = false
try {
  execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe' })
  published = true
} catch {
  published = false
}

if (published) {
  console.log(`skip      ${name}@${version} (already on npm)`)
} else if (dryRun) {
  console.log(`would pub ${name}@${version}`)
} else {
  console.log(`publish   ${name}@${version}`)
  const args = ['publish', '--access', 'public', '--no-git-checks']
  if (process.env.CI) args.push('--provenance')
  execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' })
}
