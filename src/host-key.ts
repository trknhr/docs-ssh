/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified to support first-run local host-key generation in docs-ssh.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function getHostKeyFingerprint(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64')
}

export function generateHostKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
}

export async function writeHostKey(path: string, pem: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, pem, { mode: 0o600 })
}

export async function ensureHostKey(path: string): Promise<Buffer> {
  try {
    const pem = await readFile(path)
    console.log(`Loaded host key from ${path} (SHA256:${getHostKeyFingerprint(pem)})`)
    return pem
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }

    const pem = generateHostKeyPem()
    await writeHostKey(path, pem)
    console.log(`Generated host key at ${path} (SHA256:${getHostKeyFingerprint(pem)})`)
    return Buffer.from(pem)
  }
}

export function logHostKeyFingerprint(source: string, pem: string | Buffer): void {
  console.log(`Loaded host key from ${source} (SHA256:${getHostKeyFingerprint(pem)})`)
}
