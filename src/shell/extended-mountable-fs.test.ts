import { describe, expect, it } from 'vitest'
import { ExtendedMountableFs } from './extended-mountable-fs.js'

describe('ExtendedMountableFs', () => {
  it('records file and directory reads while observation is enabled', async () => {
    const fs = new ExtendedMountableFs({
      initialFiles: {
        '/notes.txt': 'hello',
        '/project/docs/readme.md': '# Docs\n',
      },
    })

    fs.startObservingReads()
    await expect(fs.readFile('/notes.txt', 'utf8')).resolves.toBe('hello')
    await expect(fs.readdir('/project/docs')).resolves.toEqual(['readme.md'])
    expect(fs.stopObservingReads()).toEqual({
      files: ['/notes.txt'],
      dirs: ['/project/docs'],
    })
    expect(fs.stopObservingReads()).toEqual({
      files: [],
      dirs: [],
    })
  })

  it('allows writes only inside configured writable paths', async () => {
    const fs = new ExtendedMountableFs({
      writablePaths: ['/tmp', '/project/tasks'],
      readOnlyPaths: ['/project/README.md', '/project/docs'],
    })

    await fs.mkdir('/tmp', { recursive: true })
    await fs.writeFile('/tmp/output.txt', 'ok')
    await expect(fs.readFile('/tmp/output.txt', 'utf8')).resolves.toBe('ok')

    await fs.mkdir('/project/tasks/example', { recursive: true })
    await fs.writeFile('/project/tasks/example/notes.md', 'note')
    await expect(fs.readFile('/project/tasks/example/notes.md', 'utf8')).resolves.toBe('note')

    await expect(fs.writeFile('/project/README.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/project/README.md'",
    )
    await expect(fs.writeFile('/project/docs/guide.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/project/docs/guide.md'",
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
