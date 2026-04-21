import { resolve } from 'node:path'
import { resolveStatePaths, type StatePaths } from './sources/source-store.js'

export interface InstanceConfig {
  auth: {
    dbPath: string
    oidc: {
      clientId?: string
      clientSecret?: string
      enabled: boolean
      issuer?: string
      provider: string
      scope: string
    }
  }
  docsDir: string
  docsName: string
  statePaths: StatePaths
  workspaceDir: string
  ssh: {
    bindHost: string
    port: number
    connectHost: string
    connectPort: number
    hostKey?: string
    hostKeyPath: string
  }
  viewer: {
    bindHost: string
    port: number
    publicOrigin?: string
    staticDir: string
  }
  timeouts: {
    idleMs: number
    sessionMs: number
    execMs: number
  }
}

export interface LoadInstanceConfigOptions {
  authDbPath?: string
  authOidcClientId?: string
  authOidcClientSecret?: string
  authOidcIssuer?: string
  authOidcProvider?: string
  authOidcScope?: string
  docsDir?: string
  docsName?: string
  env?: NodeJS.ProcessEnv
  execTimeoutMs?: number
  idleTimeoutMs?: number
  registryPath?: string
  sessionTimeoutMs?: number
  sshBindHost?: string
  sshConnectHost?: string
  sshConnectPort?: number
  sshHostKey?: string
  sshHostKeyPath?: string
  sshPort?: number
  stateDir?: string
  viewerBindHost?: string
  viewerPublicOrigin?: string
  viewerPort?: number
  viewerStaticDir?: string
  workspaceDir?: string
}

function getStringValue(
  override: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  return override ?? envValue ?? fallback
}

function getIntegerValue(
  override: number | undefined,
  envValue: string | undefined,
  fallback: number,
  label: string,
): number {
  if (override !== undefined) return override
  if (envValue === undefined) return fallback

  const parsed = parseInt(envValue, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label}: ${envValue}`)
  }

  return parsed
}

export function loadInstanceConfig(opts: LoadInstanceConfigOptions = {}): InstanceConfig {
  const env = opts.env ?? process.env
  const statePaths = resolveStatePaths({
    stateDir: getStringValue(opts.stateDir, env.DOCS_SSH_STATE_DIR, './.docs-ssh'),
    registryPath: opts.registryPath ?? env.DOCS_SSH_REGISTRY_PATH,
  })

  return {
    auth: {
      dbPath: resolve(
        getStringValue(opts.authDbPath, env.DOCS_SSH_AUTH_DB_PATH, `${statePaths.stateDir}/auth.sqlite`),
      ),
      oidc: {
        clientId: opts.authOidcClientId ?? env.DOCS_SSH_OIDC_CLIENT_ID,
        clientSecret: opts.authOidcClientSecret ?? env.DOCS_SSH_OIDC_CLIENT_SECRET,
        enabled: Boolean(
          (opts.authOidcIssuer ?? env.DOCS_SSH_OIDC_ISSUER)
          && (opts.authOidcClientId ?? env.DOCS_SSH_OIDC_CLIENT_ID),
        ),
        issuer: opts.authOidcIssuer ?? env.DOCS_SSH_OIDC_ISSUER,
        provider: getStringValue(opts.authOidcProvider, env.DOCS_SSH_OIDC_PROVIDER, 'oidc'),
        scope: getStringValue(opts.authOidcScope, env.DOCS_SSH_OIDC_SCOPE, 'openid email profile'),
      },
    },
    docsDir: resolve(getStringValue(opts.docsDir, env.DOCS_DIR, './docs')),
    docsName: getStringValue(opts.docsName, env.DOCS_NAME, 'Documentation'),
    statePaths,
    workspaceDir: resolve(
      getStringValue(opts.workspaceDir, env.WORKSPACE_DIR, `${statePaths.stateDir}/workspace`),
    ),
    ssh: {
      bindHost: getStringValue(opts.sshBindHost, env.SSH_HOST, '127.0.0.1'),
      port: getIntegerValue(opts.sshPort, env.SSH_PORT ?? env.PORT, 2222, 'SSH_PORT'),
      connectHost: getStringValue(
        opts.sshConnectHost,
        env.SSH_CONNECT_HOST ?? env.SSH_HOST,
        '127.0.0.1',
      ),
      connectPort: getIntegerValue(
        opts.sshConnectPort,
        env.SSH_CONNECT_PORT ?? env.SSH_PORT ?? env.PORT,
        2222,
        'SSH_CONNECT_PORT',
      ),
      hostKey: opts.sshHostKey ?? env.SSH_HOST_KEY,
      hostKeyPath: resolve(
        getStringValue(opts.sshHostKeyPath, env.SSH_HOST_KEY_PATH, './ssh_host_key'),
      ),
    },
    viewer: {
      bindHost: getStringValue(opts.viewerBindHost, env.VIEWER_HOST, '127.0.0.1'),
      port: getIntegerValue(opts.viewerPort, env.VIEWER_PORT, 3000, 'VIEWER_PORT'),
      publicOrigin: opts.viewerPublicOrigin ?? env.VIEWER_PUBLIC_ORIGIN,
      staticDir: resolve(
        getStringValue(opts.viewerStaticDir, env.VIEWER_DIST_DIR, './viewer-dist'),
      ),
    },
    timeouts: {
      idleMs: getIntegerValue(opts.idleTimeoutMs, env.IDLE_TIMEOUT, 60_000, 'IDLE_TIMEOUT'),
      sessionMs: getIntegerValue(
        opts.sessionTimeoutMs,
        env.SESSION_TIMEOUT,
        600_000,
        'SESSION_TIMEOUT',
      ),
      execMs: getIntegerValue(opts.execTimeoutMs, env.EXEC_TIMEOUT, 10_000, 'EXEC_TIMEOUT'),
    },
  }
}
