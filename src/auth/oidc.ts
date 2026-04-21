import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { IncomingMessage } from 'node:http'
import {
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  createRandomStateToken,
  sanitizeViewerReturnTo,
  type PendingOidcLogin,
} from './web-session.js'

const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000

export interface OidcAuthConfig {
  clientId: string
  clientSecret?: string
  issuer: string
  provider: string
  scope: string
}

export interface OidcIdentityClaims {
  email?: string
  issuer: string
  subject: string
}

interface OidcMetadata {
  authorization_endpoint: string
  issuer: string
  jwks_uri: string
  token_endpoint: string
}

interface OidcTokenResponse {
  access_token?: string
  id_token?: string
  token_type?: string
}

function getRequestProtocol(request: IncomingMessage): string {
  const forwardedProto = request.headers['x-forwarded-proto']
  if (typeof forwardedProto === 'string') {
    const value = forwardedProto.split(',')[0]?.trim()
    if (value) return value
  }

  return 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http'
}

export function getViewerOrigin(request: IncomingMessage, publicOrigin?: string): string {
  if (publicOrigin) return publicOrigin.replace(/\/+$/u, '')

  const forwardedHost = request.headers['x-forwarded-host']
  const hostHeader = typeof forwardedHost === 'string' ? forwardedHost.split(',')[0]?.trim() : request.headers.host
  if (!hostHeader) {
    throw new Error('Could not determine viewer origin from the request.')
  }

  return `${getRequestProtocol(request)}://${hostHeader}`
}

export function createPendingOidcLogin(returnTo: string): PendingOidcLogin {
  return {
    codeVerifier: createPkceCodeVerifier(),
    expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
    nonce: createRandomStateToken(),
    returnTo: sanitizeViewerReturnTo(returnTo),
    state: createRandomStateToken(),
  }
}

export class OidcClient {
  #config: OidcAuthConfig
  #metadataPromise: Promise<OidcMetadata> | null = null
  #jwks: ReturnType<typeof createRemoteJWKSet> | null = null

  constructor(config: OidcAuthConfig) {
    this.#config = config
  }

  async #getMetadata(): Promise<OidcMetadata> {
    if (!this.#metadataPromise) {
      this.#metadataPromise = fetch(
        new URL('/.well-known/openid-configuration', this.#config.issuer).toString(),
      )
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`OIDC discovery failed: ${response.status}`)
          }

          const payload = (await response.json()) as Partial<OidcMetadata>
          if (
            !payload.authorization_endpoint
            || !payload.issuer
            || !payload.jwks_uri
            || !payload.token_endpoint
          ) {
            throw new Error('OIDC discovery response was missing required endpoints.')
          }

          return {
            authorization_endpoint: payload.authorization_endpoint,
            issuer: payload.issuer,
            jwks_uri: payload.jwks_uri,
            token_endpoint: payload.token_endpoint,
          }
        })
        .catch((error) => {
          this.#metadataPromise = null
          throw error
        })
    }

    return this.#metadataPromise
  }

  async buildAuthorizationRedirectUrl(args: {
    pendingLogin: PendingOidcLogin
    redirectUri: string
  }): Promise<string> {
    const metadata = await this.#getMetadata()
    const authorizationUrl = new URL(metadata.authorization_endpoint)
    authorizationUrl.searchParams.set('client_id', this.#config.clientId)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('redirect_uri', args.redirectUri)
    authorizationUrl.searchParams.set('scope', this.#config.scope)
    authorizationUrl.searchParams.set('state', args.pendingLogin.state)
    authorizationUrl.searchParams.set('nonce', args.pendingLogin.nonce)
    authorizationUrl.searchParams.set(
      'code_challenge',
      createPkceCodeChallenge(args.pendingLogin.codeVerifier),
    )
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    return authorizationUrl.toString()
  }

  async exchangeCodeForIdentity(args: {
    code: string
    nonce: string
    codeVerifier: string
    redirectUri: string
  }): Promise<OidcIdentityClaims> {
    const metadata = await this.#getMetadata()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (this.#config.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64')}`
    }

    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        code: args.code,
        code_verifier: args.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: args.redirectUri,
      }),
    })

    if (!response.ok) {
      throw new Error(`OIDC token exchange failed: ${response.status}`)
    }

    const payload = (await response.json()) as OidcTokenResponse
    if (!payload.id_token) {
      throw new Error('OIDC token response did not include an ID token.')
    }

    this.#jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri))
    const verified = await jwtVerify(payload.id_token, this.#jwks, {
      audience: this.#config.clientId,
      issuer: metadata.issuer,
    })

    if (typeof verified.payload.sub !== 'string' || verified.payload.sub.length === 0) {
      throw new Error('OIDC ID token did not include a valid subject.')
    }
    if (verified.payload.nonce !== args.nonce) {
      throw new Error('OIDC ID token nonce did not match the login request.')
    }

    return {
      email: typeof verified.payload.email === 'string' ? verified.payload.email : undefined,
      issuer: metadata.issuer,
      subject: verified.payload.sub,
    }
  }
}
