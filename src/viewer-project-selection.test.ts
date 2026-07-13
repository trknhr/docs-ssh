import { describe, expect, it } from 'vitest'
import { resolveProjectSelection } from '../viewer/src/project-selection.js'

const projects = [
  { publicId: 'project-default', slug: 'default' },
  { publicId: 'project-docs', slug: 'docs-ssh' },
]

describe('resolveProjectSelection', () => {
  it('prefers the project addressed by the canonical route', () => {
    expect(resolveProjectSelection(projects, 'project-docs', 'default')).toEqual(projects[1])
  })

  it('keeps an available local selection when the route has no project', () => {
    expect(resolveProjectSelection(projects, null, 'docs-ssh')).toEqual(projects[1])
  })

  it('falls back to the first project when neither selection is available', () => {
    expect(resolveProjectSelection(projects, 'missing', 'archived')).toEqual(projects[0])
  })

  it('returns null for an empty workspace', () => {
    expect(resolveProjectSelection([], null, null)).toBeNull()
  })
})
