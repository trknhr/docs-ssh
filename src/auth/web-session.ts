import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const PENDING_COOKIE_NAME = 'docs_ssh_oidc'
const SESSION_COOKIE_NAME = 'docs_ssh_session'

export interface PendingOidcLogin {
  codeVerifier: string
  expiresAt: number
  nonce: string
  returnTo: string
  state: string
}

export interface ViewerSession {
  email?: string
  expiresAt: number
  issuer: string
  login: string
  provider: string
  subject: string
  userDisplayName: string
  userId: string
}

interface CookieAttributes {
  httpOnly?: boolean
  maxAge?: number
  path?: string
  sameSite?: 'Lax' | 'Strict' | 'None'
  secure?: boolean
}

interface CookieCodecPayload {
  kind: string
}

function serializeCookie(name: string, value: string, attributes: CookieAttributes = {}): string {
  const segments = [`${name}=${value}`]
  segments.push(`Path=${attributes.path ?? '/'}`)
  if (attributes.maxAge !== undefined) segments.push(`Max-Age=${Math.max(0, Math.floor(attributes.maxAge))}`)
  if (attributes.httpOnly !== false) segments.push('HttpOnly')
  if (attributes.sameSite) segments.push(`SameSite=${attributes.sameSite}`)
  if (attributes.secure) segments.push('Secure')
  return segments.join('; ')
}

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function signValue(secret: Buffer, scope: string, encodedPayload: string): string {
  return createHmac('sha256', secret).update(`${scope}.${encodedPayload}`).digest('base64url')
}

function createSignedCookie<T extends CookieCodecPayload>(secret: Buffer, scope: string, payload: T): string {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload))
  return `${encodedPayload}.${signValue(secret, scope, encodedPayload)}`
}

function readSignedCookie<T extends CookieCodecPayload>(
  secret: Buffer,
  scope: string,
  cookieValue: string | undefined,
): T | null {
  if (!cookieValue) return null

  const separatorIndex = cookieValue.lastIndexOf('.')
  if (separatorIndex === -1) return null

  const encodedPayload = cookieValue.slice(0, separatorIndex)
  const encodedSignature = cookieValue.slice(separatorIndex + 1)
  const expectedSignature = signValue(secret, scope, encodedPayload)

  const signatureBuffer = Buffer.from(encodedSignature)
  const expectedBuffer = Buffer.from(expectedSignature)
  if (
    signatureBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    return JSON.parse(decodeBase64Url(encodedPayload).toString('utf8')) as T
  } catch {
    return null
  }
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {}

  const cookies: Record<string, string> = {}
  for (const entry of header.split(';')) {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex === -1) continue

    const key = entry.slice(0, separatorIndex).trim()
    const value = entry.slice(separatorIndex + 1).trim()
    if (!key) continue
    cookies[key] = value
  }

  return cookies
}

function isExpired(timestampMs: number): boolean {
  return Date.now() >= timestampMs
}

export function deriveViewerSessionSecret(seed: Buffer | string): Buffer {
  return createHash('sha256').update(seed).update('docs-ssh.viewer-session').digest()
}

export function createPkceCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function createPkceCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

export function createRandomStateToken(): string {
  return randomBytes(24).toString('base64url')
}

export function clearPendingOidcCookie(secure: boolean): string {
  return serializeCookie(PENDING_COOKIE_NAME, '', {
    maxAge: 0,
    path: '/',
    sameSite: 'Lax',
    secure,
  })
}

export function clearViewerSessionCookie(secure: boolean): string {
  return serializeCookie(SESSION_COOKIE_NAME, '', {
    maxAge: 0,
    path: '/',
    sameSite: 'Lax',
    secure,
  })
}

export function getRequestCookies(request: IncomingMessage): Record<string, string> {
  return parseCookieHeader(request.headers.cookie)
}

export function getViewerSessionCookieName(): string {
  return SESSION_COOKIE_NAME
}

export function getPendingOidcCookieName(): string {
  return PENDING_COOKIE_NAME
}

export function isSecureViewerRequest(request: IncomingMessage, publicOrigin?: string): boolean {
  if (publicOrigin) {
    return new URL(publicOrigin).protocol === 'https:'
  }

  const forwardedProto = request.headers['x-forwarded-proto']
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0]?.trim() === 'https'
  }

  return 'encrypted' in request.socket && Boolean(request.socket.encrypted)
}

export function readPendingOidcLogin(
  secret: Buffer,
  request: IncomingMessage,
): PendingOidcLogin | null {
  const payload = readSignedCookie<(PendingOidcLogin & CookieCodecPayload)>(
    secret,
    PENDING_COOKIE_NAME,
    getRequestCookies(request)[PENDING_COOKIE_NAME],
  )
  if (!payload || payload.kind !== 'pending') return null
  if (isExpired(payload.expiresAt)) return null

  return {
    codeVerifier: payload.codeVerifier,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
    returnTo: payload.returnTo,
    state: payload.state,
  }
}

export function readViewerSession(secret: Buffer, request: IncomingMessage): ViewerSession | null {
  const payload = readSignedCookie<(ViewerSession & CookieCodecPayload)>(
    secret,
    SESSION_COOKIE_NAME,
    getRequestCookies(request)[SESSION_COOKIE_NAME],
  )
  if (!payload || payload.kind !== 'session') return null
  if (isExpired(payload.expiresAt)) return null

  return {
    email: payload.email,
    expiresAt: payload.expiresAt,
    issuer: payload.issuer,
    login: payload.login,
    provider: payload.provider,
    subject: payload.subject,
    userDisplayName: payload.userDisplayName,
    userId: payload.userId,
  }
}

export function sanitizeViewerReturnTo(input: string | null | undefined): string {
  if (!input) return '/'
  if (!input.startsWith('/')) return '/'
  if (input.startsWith('//')) return '/'
  return input
}

export function writePendingOidcCookie(
  secret: Buffer,
  payload: PendingOidcLogin,
  secure: boolean,
): string {
  return serializeCookie(
    PENDING_COOKIE_NAME,
    createSignedCookie(secret, PENDING_COOKIE_NAME, {
      ...payload,
      kind: 'pending',
    }),
    {
      maxAge: Math.max(0, Math.ceil((payload.expiresAt - Date.now()) / 1000)),
      path: '/',
      sameSite: 'Lax',
      secure,
    },
  )
}

export function writeViewerSessionCookie(
  secret: Buffer,
  payload: ViewerSession,
  secure: boolean,
): string {
  return serializeCookie(
    SESSION_COOKIE_NAME,
    createSignedCookie(secret, SESSION_COOKIE_NAME, {
      ...payload,
      kind: 'session',
    }),
    {
      maxAge: Math.max(0, Math.ceil((payload.expiresAt - Date.now()) / 1000)),
      path: '/',
      sameSite: 'Lax',
      secure,
    },
  )
}
