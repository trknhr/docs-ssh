import { describe, expect, it } from 'vitest'
import { GIT_REPO_PRESETS, getGitRepoPreset } from './presets.js'

describe('git repo presets', () => {
  it('returns known presets by name', () => {
    expect(getGitRepoPreset('github')).toEqual({
      name: 'github',
      repoUrl: 'https://github.com/github/docs.git',
      subdir: 'content',
      description: 'GitHub Docs repository content.',
    })
    expect(getGitRepoPreset('cloudflare')).toEqual({
      name: 'cloudflare',
      repoUrl: 'https://github.com/cloudflare/cloudflare-docs.git',
      description: 'Cloudflare docs repository root.',
    })
  })

  it('returns null for unknown presets', () => {
    expect(getGitRepoPreset('unknown')).toBeNull()
  })

  it('keeps preset metadata internally consistent', () => {
    expect(Object.keys(GIT_REPO_PRESETS)).toEqual(
      expect.arrayContaining(['github', 'supabase', 'neon', 'cloudflare']),
    )

    for (const [key, preset] of Object.entries(GIT_REPO_PRESETS)) {
      expect(preset.name).toBe(key)
      expect(preset.repoUrl).toMatch(/^https:\/\/github\.com\/.+\.git$/u)
      expect(preset.description.length).toBeGreaterThan(0)
    }
  })
})
