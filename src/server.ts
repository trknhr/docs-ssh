/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to provide a local-first docs-ssh server with minimal dependencies.
 */

import { ensureHostKey, logHostKeyFingerprint } from './host-key.js'
import { loadInstanceConfig, type InstanceConfig } from './instance-config.js'
import { createSSHServer } from './ssh.js'
import { createViewerServer } from './viewer/server.js'

async function loadHostKey(config: InstanceConfig): Promise<Buffer> {
  if (config.ssh.hostKey) {
    const pem = config.ssh.hostKey
    logHostKeyFingerprint('SSH_HOST_KEY env var', pem)
    return Buffer.from(pem)
  }

  return ensureHostKey(config.ssh.hostKeyPath)
}

async function main(): Promise<void> {
  const instanceConfig = loadInstanceConfig()
  const hostKey = await loadHostKey(instanceConfig)

  const server = createSSHServer({
    authDbPath: instanceConfig.auth.dbPath,
    hostKey,
    host: instanceConfig.ssh.bindHost,
    port: instanceConfig.ssh.port,
    idleTimeout: instanceConfig.timeouts.idleMs,
    sessionTimeout: instanceConfig.timeouts.sessionMs,
    execTimeout: instanceConfig.timeouts.execMs,
    docsDir: instanceConfig.docsDir,
    docsName: instanceConfig.docsName,
    registryPath: instanceConfig.statePaths.registryPath,
    sshConnectHost: instanceConfig.ssh.connectHost,
    sshConnectPort: instanceConfig.ssh.connectPort,
    workspaceDir: instanceConfig.workspaceDir,
  })

  const viewer = createViewerServer({
    docsDir: instanceConfig.docsDir,
    docsName: instanceConfig.docsName,
    host: instanceConfig.viewer.bindHost,
    port: instanceConfig.viewer.port,
    registryPath: instanceConfig.statePaths.registryPath,
    staticDir: instanceConfig.viewer.staticDir,
    workspaceDir: instanceConfig.workspaceDir,
  })

  await Promise.all([server.listen(), viewer.listen()])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
