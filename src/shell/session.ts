/**
 * Derived from supabase-community/supabase-ssh under Apache-2.0.
 * Modified only for docs-ssh packaging.
 */

import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Bash } from 'just-bash'
import type { CommandCompleteFn } from './completion.js'
import { type CompletionEngine, createCompletionEngine } from './completion.js'

export type { CommandCompleteFn } from './completion.js'

type CompletionResult = [string[], string]

export interface ShellSessionOptions {
  bash: Bash
  input: Readable
  output: Writable
  terminal: boolean
  prompt: (cwd: string) => string
  banner?: string
  complete?: CommandCompleteFn
  onExit?: () => void
  beforeExec?: (command: string) => boolean | undefined
  afterExec?: (info: {
    command: string
    exitCode: number
    stdoutBytes: number
    stderrBytes: number
    timedOut: boolean
    durationMs: number
  }) => void
  execTimeout?: number
}

export class ShellSession {
  #rl: Interface
  #cwd: string
  #bash: Bash
  #completion: CompletionEngine
  #promptFn: (cwd: string) => string
  #onExit?: () => void
  #beforeExec?: (command: string) => boolean | undefined
  #afterExec?: ShellSessionOptions['afterExec']
  #output: Writable
  #execTimeout?: number

  constructor(opts: ShellSessionOptions) {
    this.#bash = opts.bash
    this.#cwd = opts.bash.getCwd()
    this.#promptFn = opts.prompt
    this.#completion = createCompletionEngine(opts.bash, opts.complete)
    this.#onExit = opts.onExit
    this.#beforeExec = opts.beforeExec
    this.#afterExec = opts.afterExec
    this.#output = opts.output
    this.#execTimeout = opts.execTimeout

    this.#rl = createInterface({
      input: opts.input,
      output: opts.output,
      prompt: opts.prompt(this.#cwd),
      terminal: opts.terminal,
      completer: (line: string, callback: (error: null, result: CompletionResult) => void) => {
        this.#completion
          .complete(line, this.#cwd)
          .then((result) => callback(null, result))
          .catch(() => callback(null, [[], line]))
      },
    })

    this.#rl.on('line', (line) => this.#handleLine(line))
    this.#rl.on('close', () => this.#onExit?.())
    this.#rl.on('SIGINT', () => {
      this.#output.write('^C\r\n')
      this.#rl.prompt()
    })

    if (opts.banner) opts.output.write(opts.banner)

    this.#rl.prompt()
  }

  async #handleLine(line: string) {
    const command = line.trim()

    if (this.#beforeExec) {
      const result = this.#beforeExec(command)
      if (result === false) return
    }

    if (command) {
      const start = performance.now()
      try {
        const signal = this.#execTimeout ? AbortSignal.timeout(this.#execTimeout) : undefined
        const result = await this.#bash.exec(command, { cwd: this.#cwd, signal })
        if (result.stdout) this.#output.write(result.stdout.replace(/\n/g, '\r\n'))
        if (result.stderr) this.#output.write(result.stderr.replace(/\n/g, '\r\n'))
        if (result.env.PWD) this.#cwd = result.env.PWD
        this.#afterExec?.({
          command,
          exitCode: result.exitCode ?? 0,
          stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
          stderrBytes: Buffer.byteLength(result.stderr ?? ''),
          timedOut: false,
          durationMs: performance.now() - start,
        })
      } catch (error) {
        this.#afterExec?.({
          command,
          exitCode: 1,
          stdoutBytes: 0,
          stderrBytes: 0,
          timedOut: error instanceof Error && error.name === 'TimeoutError',
          durationMs: performance.now() - start,
        })
        this.#output.write(`Error: ${error instanceof Error ? error.message : String(error)}\r\n`)
      }
    }

    this.#rl.setPrompt(this.#promptFn(this.#cwd))
    this.#rl.prompt()
  }

  close() {
    this.#rl.close()
  }
}

export function createShellSession(opts: ShellSessionOptions) {
  return new ShellSession(opts)
}
