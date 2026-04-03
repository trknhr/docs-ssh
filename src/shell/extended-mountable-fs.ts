/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified only for docs-ssh packaging.
 */

import { type InitialFiles, InMemoryFs, MountableFs, type MountableFsOptions } from 'just-bash'

interface ExtendedMountableFsOptions extends Omit<MountableFsOptions, 'base'> {
  readOnly?: boolean
  initialFiles?: InitialFiles | undefined
}

export class ExtendedMountableFs extends MountableFs {
  #base: InMemoryFs
  #readOnly: boolean
  #readFiles: Set<string> = new Set()
  #readDirs: Set<string> = new Set()
  #observing = false

  constructor(opts?: ExtendedMountableFsOptions) {
    const { readOnly, initialFiles, ...rest } = opts ?? {}
    const base = new InMemoryFs(initialFiles)
    super({ ...rest, base })
    this.#base = base
    this.#readOnly = readOnly ?? false
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
    return this.#base.mkdirSync(path, options)
  }

  writeFileSync(path: string, content: string | Uint8Array) {
    return this.#base.writeFileSync(path, content)
  }

  #assertWritable(operation: string): void {
    if (this.#readOnly) throw new Error(`EROFS: read-only file system, ${operation}`)
  }

  override async writeFile(
    path: string,
    ...args: Parameters<MountableFs['writeFile']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`write '${path}'`)
    return super.writeFile(path, ...args)
  }

  override async appendFile(
    path: string,
    ...args: Parameters<MountableFs['appendFile']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`append '${path}'`)
    return super.appendFile(path, ...args)
  }

  override async mkdir(
    path: string,
    ...args: Parameters<MountableFs['mkdir']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`mkdir '${path}'`)
    return super.mkdir(path, ...args)
  }

  override async rm(
    path: string,
    ...args: Parameters<MountableFs['rm']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`rm '${path}'`)
    return super.rm(path, ...args)
  }

  override async chmod(
    path: string,
    ...args: Parameters<MountableFs['chmod']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`chmod '${path}'`)
    return super.chmod(path, ...args)
  }

  override async symlink(...args: Parameters<MountableFs['symlink']>) {
    this.#assertWritable(`symlink '${args[1]}'`)
    return super.symlink(...args)
  }

  override async link(...args: Parameters<MountableFs['link']>) {
    this.#assertWritable(`link '${args[1]}'`)
    return super.link(...args)
  }

  override async cp(
    source: string,
    path: string,
    ...args: Parameters<MountableFs['cp']> extends [string, string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`cp '${path}'`)
    return super.cp(source, path, ...args)
  }

  override async mv(...args: Parameters<MountableFs['mv']>) {
    this.#assertWritable(`mv '${args[1]}'`)
    return super.mv(...args)
  }

  override async utimes(
    path: string,
    ...args: Parameters<MountableFs['utimes']> extends [string, ...infer Rest] ? Rest : never
  ) {
    this.#assertWritable(`utimes '${path}'`)
    return super.utimes(path, ...args)
  }
}
