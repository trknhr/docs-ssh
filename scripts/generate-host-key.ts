/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified for docs-ssh project scaffolding.
 */

import { generateHostKeyPem, getHostKeyFingerprint } from '../src/host-key.js'

const pem = generateHostKeyPem()

process.stdout.write(pem)
console.error(`SHA256:${getHostKeyFingerprint(pem)}`)
