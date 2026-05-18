import { describe, expect, it } from 'vitest'
import { inferViewerOrigin } from './cli-login-config.js'

describe('inferViewerOrigin', () => {
  it('uses localhost for local development aliases', () => {
    expect(inferViewerOrigin('docs-ssh-local')).toBe('http://localhost:3000')
    expect(inferViewerOrigin('localhost')).toBe('http://localhost:3000')
    expect(inferViewerOrigin('127.0.0.1')).toBe('http://localhost:3000')
  })

  it('uses the server host for non-local aliases', () => {
    expect(inferViewerOrigin('docs.example.com')).toBe('http://docs.example.com:3000')
  })
})
