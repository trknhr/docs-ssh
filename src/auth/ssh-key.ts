import { createHash } from 'node:crypto'
import ssh2, { type ParsedKey } from 'ssh2'

const { utils: sshUtils } = ssh2

export interface PresentedSshPublicKey {
  algo: string
  data: Buffer
}

export interface NormalizedSshPublicKey {
  algorithm: string
  fingerprint: string
  parsedKey: ParsedKey
  publicKey: string
}

function createPublicKeyInput(publicKey: Buffer | PresentedSshPublicKey | string): string {
  if (typeof publicKey === 'string') return publicKey.trim()
  if (Buffer.isBuffer(publicKey)) return publicKey.toString('utf8').trim()
  return `${publicKey.algo} ${publicKey.data.toString('base64')}`
}

export function normalizeSshPublicKey(
  publicKey: Buffer | PresentedSshPublicKey | string,
): NormalizedSshPublicKey {
  const parsed = sshUtils.parseKey(createPublicKeyInput(publicKey))
  if (parsed instanceof Error) {
    throw new Error(`Invalid SSH public key: ${parsed.message}`)
  }

  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key) {
    throw new Error('Invalid SSH public key: no usable key material found.')
  }
  if (key.isPrivateKey()) {
    throw new Error('Expected an SSH public key, but a private key was provided.')
  }

  const normalizedValue = key.getPublicSSH()
  const normalized = Buffer.isBuffer(normalizedValue)
    ? `${key.type} ${normalizedValue.toString('base64')}`
    : String(normalizedValue).trim()
  const [algorithm, encodedKey] = normalized.split(/\s+/, 3)
  if (!algorithm || !encodedKey) {
    throw new Error('Invalid SSH public key: could not normalize key data.')
  }

  const fingerprint =
    'SHA256:' +
    createHash('sha256')
      .update(Buffer.from(encodedKey, 'base64'))
      .digest('base64')
      .replace(/=+$/g, '')

  return {
    algorithm,
    fingerprint,
    parsedKey: key,
    publicKey: normalized,
  }
}
