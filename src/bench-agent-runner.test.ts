import { describe, expect, it } from 'vitest'
import {
  extractJsonObject,
  makeDocsSshPrompt,
  makeVectorPrompt,
  parseAgentAnswer,
  parseCodexEventMetrics,
} from '../bench/ragbench/retrieval/agent-runner.js'

describe('RAGBench agent runner response parsing', () => {
  it('parses raw JSON answers', () => {
    expect(parseAgentAnswer('{"candidates":[{"documentId":"a","reason":"matches the query","confidence":0.9}]}')).toEqual({
      candidates: [
        {
          confidence: 0.9,
          documentId: 'a',
          reason: 'matches the query',
        },
      ],
    })
  })

  it('extracts JSON from fenced final messages', () => {
    expect(extractJsonObject('```json\n{"candidates":[]}\n```')).toEqual({ candidates: [] })
  })

  it('extracts the first complete JSON object from surrounding text', () => {
    expect(extractJsonObject('final:\n{"candidates":[{"documentId":"doc","reason":"ok"}]}\nthanks')).toEqual({
      candidates: [
        {
          documentId: 'doc',
          reason: 'ok',
        },
      ],
    })
  })

  it('rejects malformed candidate shape', () => {
    expect(() => parseAgentAnswer('{"candidates":[{"documentId":1}]}')).toThrow(
      'Codex candidate 0.documentId must be a string',
    )
  })

  it('counts Codex JSONL turns and tool calls', () => {
    expect(parseCodexEventMetrics([
      '{"type":"thread.started"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"type":"command_execution"}}',
      '{"type":"item.started","item":{"type":"mcp_tool_call"}}',
      '{"type":"item.started","item":{"type":"agent_message"}}',
      '{"type":"turn.completed"}',
    ].join('\n'))).toEqual({
      toolCallCount: 2,
      turnCount: 1,
    })
  })

  it('prompts docs-ssh agents to batch remote commands through one remote exec', () => {
    const prompt = makeDocsSshPrompt({
      caseId: 'case-1',
      documents: [
        { id: '0', text: 'first document' },
        { id: '1', text: 'second document' },
      ],
      maxToolCalls: 8,
      question: 'Which document explains setup?',
      remoteRoot: '/projects/ragbench/tasks/cases',
      topK: 5,
    })

    expect(prompt).toContain('Prefer the remote batch helper')
    expect(prompt).toContain('RAGBENCH_REMOTE_COMMAND')
    expect(prompt).toContain('Recommended one-call batch command:')
    expect(prompt).toContain("printf '%s\\n'")
    expect(prompt).toContain('| sh -lc "\\$RAGBENCH_REMOTE_COMMAND batch"')
    expect(prompt).toContain('/projects/ragbench/tasks/cases/case-1/documents/doc-0.md')
    expect(prompt).toContain('/projects/ragbench/tasks/cases/case-1/documents/doc-1.md')
  })

  it('prompts vector agents to read multiple candidates in one command', () => {
    const prompt = makeVectorPrompt({
      caseId: 'case-1',
      casesPath: '/tmp/cases.jsonl',
      maxToolCalls: 8,
      question: 'Which document explains setup?',
      searchTopK: 8,
      toolPath: '/tmp/vector-agent-tool.ts',
      topK: 5,
    })

    expect(prompt).toContain('Prefer one search, then read multiple top candidates with read-many')
    expect(prompt).toContain('read-many')
    expect(prompt).toContain('--document-ids')
    expect(prompt).toContain('<commaSeparatedDocumentIds>')
  })
})
