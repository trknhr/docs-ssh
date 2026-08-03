import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fetchRagbenchRows } from './hf-dataset.js'

const MAX_FETCH_LENGTH = 100

function parseNonNegativeInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) {
    throw new Error(`--${name} must be a non-negative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`--${name} must be a non-negative integer`)
  }
  return parsed
}

const args = process.argv.slice(2)
const { values } = parseArgs({
  args: args[0] === '--' ? args.slice(1) : args,
  options: {
    config: { type: 'string', default: 'emanual' },
    split: { type: 'string', default: 'test' },
    limit: { type: 'string', default: '50' },
    offset: { type: 'string', default: '0' },
    output: { type: 'string', default: '.bench/ragbench/cases.jsonl' },
  },
})

const config = values.config ?? 'emanual'
const split = values.split ?? 'test'
const limit = parseNonNegativeInteger('limit', values.limit)
const offset = parseNonNegativeInteger('offset', values.offset)
const output = resolve(values.output ?? '.bench/ragbench/cases.jsonl')

const cases: Awaited<ReturnType<typeof fetchRagbenchRows>> = []
let fetched = 0
while (fetched < limit) {
  const length = Math.min(MAX_FETCH_LENGTH, limit - fetched)
  const rows = await fetchRagbenchRows({
    config,
    split,
    offset: offset + fetched,
    length,
  })
  cases.push(...rows)
  fetched += rows.length
  if (rows.length < length) break
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, cases.map((entry) => JSON.stringify(entry)).join('\n') + '\n')

console.log(JSON.stringify({
  cases: cases.length,
  config,
  offset,
  output,
  split,
}, null, 2))
