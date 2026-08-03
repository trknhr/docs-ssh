import ssh2 from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { generateSshEd25519KeyPair, normalizeSshPublicKey } from './ssh-key.js'

const { utils: sshUtils } = ssh2

describe('generateSshEd25519KeyPair', () => {
  it('retries when ssh2 generates a malformed public key', () => {
    const validKeyPair = generateSshEd25519KeyPair()
    const generateKeyPair = vi
      .fn()
      .mockReturnValueOnce({
        private: 'invalid private key',
        public: 'ssh-ed25519 AAAA',
      })
      .mockReturnValue(validKeyPair)

    const keyPair = generateSshEd25519KeyPair(generateKeyPair)

    expect(generateKeyPair).toHaveBeenCalledTimes(2)
    expect(keyPair).toEqual(validKeyPair)
    expect(normalizeSshPublicKey(keyPair.public).algorithm).toBe('ssh-ed25519')
    const parsedPrivateKey = sshUtils.parseKey(keyPair.private)
    if (parsedPrivateKey instanceof Error) throw parsedPrivateKey
    const privateKey = Array.isArray(parsedPrivateKey) ? parsedPrivateKey[0] : parsedPrivateKey
    expect(privateKey?.isPrivateKey()).toBe(true)
  })

  it('fails after retrying a bounded number of malformed keys', () => {
    const generateKeyPair = vi.fn(() => ({
      private: 'invalid private key',
      public: 'ssh-ed25519 AAAA',
    }))

    expect(() => generateSshEd25519KeyPair(generateKeyPair)).toThrow(
      'Failed to generate a valid Ed25519 SSH key pair after 8 attempts',
    )
    expect(generateKeyPair).toHaveBeenCalledTimes(8)
  })
})
