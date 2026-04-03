/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to provide a local-first docs-ssh server with minimal dependencies.
 */

import { resolve } from 'node:path'
import { ensureHostKey, logHostKeyFingerprint } from './host-key.js'
import { createSSHServer } from './ssh.js'
import { getStatePaths } from './sources/source-store.js'

const SSH_PORT = parseInt(process.env.SSH_PORT ?? process.env.PORT ?? '2222', 10)
const SSH_HOST = process.env.SSH_HOST ?? '127.0.0.1'
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT ?? '60000', 10)
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT ?? '600000', 10)
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT ?? '10000', 10)
const DOCS_DIR = resolve(process.env.DOCS_DIR ?? './docs')
const DOCS_NAME = process.env.DOCS_NAME ?? 'Documentation'
const SSH_HOST_KEY_PATH = resolve(process.env.SSH_HOST_KEY_PATH ?? './ssh_host_key')
const STATE_PATHS = getStatePaths()

async function loadHostKey(): Promise<Buffer> {
  if (process.env.SSH_HOST_KEY) {
    const pem = process.env.SSH_HOST_KEY
    logHostKeyFingerprint('SSH_HOST_KEY env var', pem)
    return Buffer.from(pem)
  }

  return ensureHostKey(SSH_HOST_KEY_PATH)
}

async function main() {
  const hostKey = await loadHostKey()

  const server = createSSHServer({
    hostKey,
    host: SSH_HOST,
    port: SSH_PORT,
    idleTimeout: IDLE_TIMEOUT,
    sessionTimeout: SESSION_TIMEOUT,
    execTimeout: EXEC_TIMEOUT,
    docsDir: DOCS_DIR,
    docsName: DOCS_NAME,
    registryPath: STATE_PATHS.registryPath,
  })

  await server.listen()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
