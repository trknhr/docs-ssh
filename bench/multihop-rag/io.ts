import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function getString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function parsePositiveIntegerFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value)) throw new Error(`--${name} must be a positive integer`)

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

export function getCliArgs(): string[] {
  const args = process.argv.slice(2)
  return args[0] === '--' ? args.slice(1) : args
}

export async function readJsonArray(path: string): Promise<unknown[]> {
  const content = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(content)
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON array`)
  }
  return parsed
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Invalid JSONL line ${index + 1} in ${path}: ${message}`)
      }
    })
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}
