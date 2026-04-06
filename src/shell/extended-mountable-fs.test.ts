import { describe, expect, it } from 'vitest'
import { ExtendedMountableFs } from './extended-mountable-fs.js'

describe('ExtendedMountableFs', () => {
  it('records file and directory reads while observation is enabled', async () => {
    const fs = new ExtendedMountableFs({
      initialFiles: {
        '/notes.txt': 'hello',
        '/docs/readme.md': '# Docs\n',
      },
    })

    fs.startObservingReads()
    await expect(fs.readFile('/notes.txt', 'utf8')).resolves.toBe('hello')
    await expect(fs.readdir('/docs')).resolves.toEqual(['readme.md'])
    expect(fs.stopObservingReads()).toEqual({
      files: ['/notes.txt'],
      dirs: ['/docs'],
    })
    expect(fs.stopObservingReads()).toEqual({
      files: [],
      dirs: [],
    })
  })

  it('allows writes only inside configured writable paths', async () => {
    const fs = new ExtendedMountableFs({
      writablePaths: ['/tmp', '/workspace/tasks'],
      readOnlyPaths: ['/workspace/README.md'],
    })

    await fs.mkdir('/tmp', { recursive: true })
    await fs.writeFile('/tmp/output.txt', 'ok')
    await expect(fs.readFile('/tmp/output.txt', 'utf8')).resolves.toBe('ok')

    await fs.mkdir('/workspace/tasks/example', { recursive: true })
    await fs.writeFile('/workspace/tasks/example/notes.md', 'note')
    await expect(fs.readFile('/workspace/tasks/example/notes.md', 'utf8')).resolves.toBe('note')

    await expect(fs.writeFile('/workspace/README.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/workspace/README.md'",
    )
    await expect(fs.writeFile('/docs/guide.md', 'blocked')).rejects.toThrow(
      "EROFS: read-only file system, write '/docs/guide.md'",
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
