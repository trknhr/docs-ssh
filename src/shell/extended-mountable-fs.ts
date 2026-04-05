/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified only for docs-ssh packaging.
 */

import { posix } from 'node:path'
import { type InitialFiles, InMemoryFs, MountableFs, type MountableFsOptions } from 'just-bash'

interface ExtendedMountableFsOptions extends Omit<MountableFsOptions, 'base'> {
  readOnly?: boolean
  initialFiles?: InitialFiles | undefined
  readOnlyPaths?: string[]
  writablePaths?: string[]
}

export class ExtendedMountableFs extends MountableFs {
  #base: InMemoryFs
  #readOnly: boolean
  #readOnlyPaths: string[]
  #writablePaths: string[]
  #readFiles: Set<string> = new Set()
  #readDirs: Set<string> = new Set()
  #observing = false

  constructor(opts?: ExtendedMountableFsOptions) {
    const { readOnly, initialFiles, readOnlyPaths, writablePaths, ...rest } = opts ?? {}
    const base = new InMemoryFs(initialFiles)
    super({ ...rest, base })
    this.#base = base
    this.#readOnly = readOnly ?? false
    this.#readOnlyPaths = (readOnlyPaths ?? []).map((path) => posix.normalize(path))
    this.#writablePaths = (writablePaths ?? []).map((path) => posix.normalize(path))
  }

  startObservingReads(): void {
    this.#readFiles.clear()
    this.#readDirs.clear()
    this.#observing = true
  }

  stopObservingReads(): { files: string[]; dirs: string[] } {
    this.#observing = false
    const result = { files: [...this.#readFiles], dirs: [...this.#readDirs] }
    this.#readFiles.clear()
    this.#readDirs.clear()
    return result
  }

  override async readFile(
    path: string,
    ...args: Parameters<MountableFs['readFile']> extends [string, ...infer Rest] ? Rest : never
  ) {
    if (this.#observing) this.#readFiles.add(path)
    return super.readFile(path, ...args)
  }

  override async readdir(path: string) {
    if (this.#observing) this.#readDirs.add(path)
    return super.readdir(path)
  }

  mkdirSync(path: string, options?: { recursive?: boolean }) {
    this.#assertWritable(path, `mkdir '${path}'`)
    return this.#base.mkdirSync(path, options)
  }

  writeFileSync(path: string, content: string | Uint8Array) {
    this.#assertWritable(path, `write '${path}'`)
    return this.#base.writeFileSync(path, content)
  }

  #isReadOnlyPath(path: string): boolean {
    const normalizedPath = posix.normalize(path)
    return this.#readOnlyPaths.some(
      (readOnlyPath) =>
        normalizedPath === readOnlyPath || normalizedPath.startsWith(`${readOnlyPath}/`),
    )
  }

  #isWritablePath(path: string): boolean {
    if (this.#writablePaths.length === 0) return true

    const normalizedPath = posix.normalize(path)
    return this.#writablePaths.some(
      (writablePath) =>
        normalizedPath === writablePath || normalizedPath.startsWith(`${writablePath}/`),
    )
  }

  #assertWritable(path: string, operation: string): void {
    if (this.#readOnly || this.#isReadOnlyPath(path) || !this.#isWritablePath(path)) {
      throw new Error(`EROFS: read-only file system, ${operation}`)
    }
  }

  override async writeFile(
    path: string,
    ...args: Parameters<MountableFs['writeFile']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `write '${path}'`)
    return super.writeFile(path, ...args)
  }

  override async appendFile(
    path: string,
    ...args: Parameters<MountableFs['appendFile']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `append '${path}'`)
    return super.appendFile(path, ...args)
  }

  override async mkdir(
    path: string,
    ...args: Parameters<MountableFs['mkdir']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `mkdir '${path}'`)
    return super.mkdir(path, ...args)
  }

  override async rm(
    path: string,
    ...args: Parameters<MountableFs['rm']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `rm '${path}'`)
    return super.rm(path, ...args)
  }

  override async chmod(
    path: string,
    ...args: Parameters<MountableFs['chmod']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `chmod '${path}'`)
    return super.chmod(path, ...args)
  }

  override async symlink(...args: Parameters<MountableFs['symlink']>) {
    this.#assertWritable(args[1], `symlink '${args[1]}'`)
    return super.symlink(...args)
  }

  override async link(...args: Parameters<MountableFs['link']>) {
    this.#assertWritable(args[1], `link '${args[1]}'`)
    return super.link(...args)
  }

  override async cp(
    source: string,
    path: string,
    ...args: Parameters<MountableFs['cp']> extends [string, string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `cp '${path}'`)
    return super.cp(source, path, ...args)
  }

  override async mv(...args: Parameters<MountableFs['mv']>) {
    this.#assertWritable(args[1], `mv '${args[1]}'`)
    return super.mv(...args)
  }

  override async utimes(
    path: string,
    ...args: Parameters<MountableFs['utimes']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(path, `utimes '${path}'`)
    return super.utimes(path, ...args)
  }
}
