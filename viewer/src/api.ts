import type {
  FileResponse,
  TreeResponse,
  ViewerSessionResponse,
  ViewerSshKeyListResponse,
  ViewerSshKeyMutationResponse,
} from './types'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
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

export async function getSession() {
  return fetchJson<ViewerSessionResponse>('/api/auth/session')
}

export async function getSshKeys() {
  return fetchJson<ViewerSshKeyListResponse>('/api/auth/ssh-keys')
}

export async function addSshKey(input: {
  name?: string
  publicKey: string
}) {
  return fetchJson<ViewerSshKeyMutationResponse>('/api/auth/ssh-keys', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}
