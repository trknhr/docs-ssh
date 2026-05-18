import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const CONFIG_FILE_NAME = '.docs-ssh.toml'
const TOML_STRING_PATTERN = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/

export interface DocsSshProjectConfig {
  path: string
  project?: string
  server?: string
  viewerOrigin?: string
}

function parseProjectConfig(content: string, path: string): DocsSshProjectConfig {
  const config: DocsSshProjectConfig = { path }

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = TOML_STRING_PATTERN.exec(line)
    if (!match) continue

    const key = match[1]
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (key === 'project') config.project = value
    if (key === 'server') config.server = value
    if (key === 'viewer' || key === 'viewer_origin') config.viewerOrigin = value
  }

  return config
}

export async function findProjectConfig(startDir = process.cwd()): Promise<DocsSshProjectConfig | null> {
  let currentDir = resolve(startDir)

  while (true) {
    const configPath = resolve(currentDir, CONFIG_FILE_NAME)
    try {
      return parseProjectConfig(await readFile(configPath, 'utf8'), configPath)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return null
    currentDir = parentDir
  }
}
