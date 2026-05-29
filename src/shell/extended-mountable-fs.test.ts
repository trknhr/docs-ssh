import { describe, expect, it } from 'vitest'
import { ExtendedMountableFs } from './extended-mountable-fs.js'

describe('ExtendedMountableFs', () => {
  it('records file and directory reads while observation is enabled', async () => {
    const fs = new ExtendedMountableFs({
      initialFiles: {
        '/notes.txt': 'hello',
        '/projects/default/tasks/example/notes.md': '# Notes\n',
      },
    })

    fs.startObservingReads()
    await expect(fs.readFile('/notes.txt', 'utf8')).resolves.toBe('hello')
    await expect(fs.readdir('/projects/default/tasks/example')).resolves.toEqual(['notes.md'])
    expect(fs.stopObservingReads()).toEqual({
      files: ['/notes.txt'],
      dirs: ['/projects/default/tasks/example'],
    })
    expect(fs.stopObservingReads()).toEqual({
      files: [],
      dirs: [],
    })
  })

  it('allows writes only inside configured writable paths', async () => {
    const fs = new ExtendedMountableFs({
      writablePaths: ['/tmp', '/projects/default/tasks'],
      readOnlyPaths: ['/projects/default/README.md', '/projects/default/reference'],
    })

    await fs.mkdir('/tmp', { recursive: true })
    await fs.writeFile('/tmp/output.txt', 'ok')
    await expect(fs.readFile('/tmp/output.txt', 'utf8')).resolves.toBe('ok')

    await fs.mkdir('/projects/default/tasks/example', { recursive: true })
    await fs.writeFile('/projects/default/tasks/example/notes.md', 'note')
    await expect(fs.readFile('/projects/default/tasks/example/notes.md', 'utf8')).resolves.toBe('note')

    await expect(fs.writeFile('/projects/default/README.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/projects/default/README.md'",
    )
    await expect(fs.writeFile('/projects/default/reference/guide.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/projects/default/reference/guide.md'",
    )
  })

  it('rejects all writes when the filesystem is globally read-only', async () => {
    const fs = new ExtendedMountableFs({
      readOnly: true,
      initialFiles: {
        '/existing.txt': 'hello',
      },
    })

    await expect(fs.readFile('/existing.txt', 'utf8')).resolves.toBe('hello')
    await expect(fs.writeFile('/existing.txt', 'updated')).rejects.toThrow(
      "EROFS: read-only file system, write '/existing.txt'",
    )
    expect(() => fs.writeFileSync('/sync.txt', 'blocked')).toThrow(
      "EROFS: read-only file system, write '/sync.txt'",
    )
  })
})
