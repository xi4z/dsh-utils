#!/usr/bin/env node
/**
 * Publish the whole release train: every component package first, then the
 * bundle that depends on them.
 *
 * The bundle is patch-only: it mounts the six component packages and declares
 * them as exact-version dependencies, so a consumer installs one spec and pnpm
 * resolves the components from the registry. That only works when every package
 * of the train is published at the shared version, which is why this script
 * checks that all versions agree before publishing anything.
 *
 * Re-running is safe: a package version already on the registry is skipped,
 * which also lets a partially failed CI run continue.
 *
 * Usage: pnpm release [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const root = process.cwd()

/** Dependency order: every component before the bundle that mounts it. */
const COMPONENTS = ['approval-policy', 'notify', 'utils-agents', 'ui']

function read(dir) {
  return { dir, ...JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
}

const bundle = read(root)
const components = COMPONENTS.map((name) => read(join(root, 'packages', name)))

const mismatched = [bundle, ...components].filter((pkg) => pkg.version !== bundle.version)
if (mismatched.length > 0) {
  console.error('every package of the train must share the bundle version ' + bundle.version + ':')
  for (const pkg of mismatched) console.error('  ' + pkg.name + '@' + pkg.version)
  process.exit(1)
}

for (const pkg of [...components, bundle]) {
  let published = false
  try {
    execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { stdio: 'pipe' })
    published = true
  } catch {
    published = false
  }

  if (published) {
    console.log(`skip      ${pkg.name}@${pkg.version} (already on npm)`)
  } else if (dryRun) {
    console.log(`would pub ${pkg.name}@${pkg.version}`)
  } else {
    console.log(`publish   ${pkg.name}@${pkg.version}`)
    const args = ['publish', '--access', 'public', '--no-git-checks']
    if (process.env.CI) args.push('--provenance')
    execFileSync('pnpm', args, { cwd: pkg.dir, stdio: 'inherit' })
  }
}
