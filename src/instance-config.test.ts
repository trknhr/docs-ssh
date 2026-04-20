import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadInstanceConfig } from './instance-config.js'

describe('loadInstanceConfig', () => {
  it('derives runtime paths from the shared state root by default', () => {
    const config = loadInstanceConfig({
      env: {
        DOCS_SSH_STATE_DIR: './tmp/state',
      },
    })

    expect(config.statePaths.stateDir).toBe(resolve('./tmp/state'))
    expect(config.statePaths.registryPath).toBe(resolve('./tmp/state/sources.json'))
    expect(config.statePaths.sourcesDir).toBe(resolve('./tmp/state/sources'))
    expect(config.auth.dbPath).toBe(resolve('./tmp/state/auth.sqlite'))
    expect(config.workspaceDir).toBe(resolve('./tmp/state/workspace'))
    expect(config.docsDir).toBe(resolve('./docs'))
    expect(config.viewer.staticDir).toBe(resolve('./viewer-dist'))
  })

  it('respects explicit overrides for bind and connect settings', () => {
    const config = loadInstanceConfig({
      docsDir: './custom-docs',
      docsName: 'Project Docs',
      execTimeoutMs: 15_000,
      idleTimeoutMs: 5_000,
      authDbPath: './runtime/auth.sqlite',
      registryPath: './runtime/registry.json',
      sessionTimeoutMs: 20_000,
      sshBindHost: '0.0.0.0',
      sshConnectHost: 'docs.internal',
      sshConnectPort: 2200,
      sshHostKeyPath: './runtime/host_key',
      sshPort: 2222,
      stateDir: './runtime/state',
      viewerBindHost: '0.0.0.0',
      viewerPort: 4000,
      viewerStaticDir: './runtime/viewer',
      workspaceDir: './runtime/workspace',
      env: {},
    })

    expect(config.docsDir).toBe(resolve('./custom-docs'))
    expect(config.docsName).toBe('Project Docs')
    expect(config.auth.dbPath).toBe(resolve('./runtime/auth.sqlite'))
    expect(config.statePaths.stateDir).toBe(resolve('./runtime/state'))
    expect(config.statePaths.registryPath).toBe(resolve('./runtime/registry.json'))
    expect(config.workspaceDir).toBe(resolve('./runtime/workspace'))
    expect(config.ssh).toMatchObject({
      bindHost: '0.0.0.0',
      port: 2222,
      connectHost: 'docs.internal',
      connectPort: 2200,
      hostKeyPath: resolve('./runtime/host_key'),
    })
    expect(config.viewer).toMatchObject({
      bindHost: '0.0.0.0',
      port: 4000,
      staticDir: resolve('./runtime/viewer'),
    })
    expect(config.timeouts).toEqual({
      idleMs: 5_000,
      sessionMs: 20_000,
      execMs: 15_000,
    })
  })
})
