#!/usr/bin/env node
/** Entry point for the zcode-trae-connect CLI. */
import { main } from '../src/cli.js'

main().catch(error => {
  console.error(`zcode-trae-connect: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
