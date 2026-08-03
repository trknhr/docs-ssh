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

export interface GeneratedSshKeyPair {
  private: string
  public: string
}

const SSH_KEY_GENERATION_ATTEMPTS = 8

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

// ssh2 can occasionally shorten Ed25519 public key material that starts with zero bytes.
// Validate the complete pair and retry instead of persisting an unusable CLI identity.
export function generateSshEd25519KeyPair(
  generateKeyPair: () => GeneratedSshKeyPair = () => sshUtils.generateKeyPairSync('ed25519'),
): GeneratedSshKeyPair {
  let lastError: unknown

  for (let attempt = 0; attempt < SSH_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    const keyPair = generateKeyPair()

    try {
      const publicKey = normalizeSshPublicKey(keyPair.public)
      if (publicKey.algorithm !== 'ssh-ed25519') {
        throw new Error(`Expected an Ed25519 public key, but generated ${publicKey.algorithm}.`)
      }

      const parsedPrivate = sshUtils.parseKey(keyPair.private)
      if (parsedPrivate instanceof Error) {
        throw new Error(`Invalid SSH private key: ${parsedPrivate.message}`)
      }

      const privateKey = Array.isArray(parsedPrivate) ? parsedPrivate[0] : parsedPrivate
      if (!privateKey?.isPrivateKey()) {
        throw new Error('Invalid SSH private key: no usable private key material found.')
      }
      if (privateKey.type !== 'ssh-ed25519') {
        throw new Error(`Expected an Ed25519 private key, but generated ${privateKey.type}.`)
      }
      if (!publicKey.parsedKey.getPublicSSH().equals(privateKey.getPublicSSH())) {
        throw new Error('Generated SSH public and private keys do not match.')
      }

      return {
        private: keyPair.private,
        public: publicKey.publicKey,
      }
    } catch (error) {
      lastError = error
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(
    `Failed to generate a valid Ed25519 SSH key pair after ${SSH_KEY_GENERATION_ATTEMPTS} attempts${detail}`,
  )
}
