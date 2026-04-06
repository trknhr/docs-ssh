import type { FileResponse, TreeResponse } from './types'

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  const payload = (await response.json()) as T & { error?: string }

  if (!response.ok) {
    throw new Error('error' in payload && typeof payload.error === 'string' ? payload.error : 'Request failed.')
  }

  return payload
}

export async function getTree() {
  return fetchJson<TreeResponse>('/api/tree')
}

export async function getFile(path: string): Promise<FileResponse> {
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
  const payload = (await response.json()) as FileResponse['payload']

  return {
    ok: response.ok,
    payload,
    status: response.status,
  }
}
