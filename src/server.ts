/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to provide a local-first docs-ssh server with minimal dependencies.
 */

import { loadLocalEnvFile } from './env.js'
import { ensureHostKey, logHostKeyFingerprint } from './host-key.js'
import { loadInstanceConfig, type InstanceConfig } from './instance-config.js'
import { createSSHServer } from './ssh.js'
import { createViewerServer } from './viewer/server.js'

loadLocalEnvFile()

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
    authDbPath: instanceConfig.auth.dbPath,
    docsDir: instanceConfig.docsDir,
    docsName: instanceConfig.docsName,
    host: instanceConfig.viewer.bindHost,
    oidc: instanceConfig.auth.oidc.enabled && instanceConfig.auth.oidc.issuer && instanceConfig.auth.oidc.clientId
      ? {
          clientId: instanceConfig.auth.oidc.clientId,
          clientSecret: instanceConfig.auth.oidc.clientSecret,
          issuer: instanceConfig.auth.oidc.issuer,
          provider: instanceConfig.auth.oidc.provider,
          scope: instanceConfig.auth.oidc.scope,
        }
      : undefined,
    port: instanceConfig.viewer.port,
    publicOrigin: instanceConfig.viewer.publicOrigin,
    registryPath: instanceConfig.statePaths.registryPath,
    sessionSecret: hostKey,
    staticDir: instanceConfig.viewer.staticDir,
    workspaceDir: instanceConfig.workspaceDir,
  })

  await Promise.all([server.listen(), viewer.listen()])
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
