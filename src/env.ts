import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const DEFAULT_ENV_PATH = '.env'

let loadedDefaultEnvFile = false

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}

export function loadLocalEnvFile(path = DEFAULT_ENV_PATH): void {
  const isDefaultPath = path === DEFAULT_ENV_PATH
  if (isDefaultPath && loadedDefaultEnvFile) return

  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(path)
    } else {
      const parsed = parseEnv(readFileSync(path, 'utf8'))
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }

  if (isDefaultPath) loadedDefaultEnvFile = true
}
