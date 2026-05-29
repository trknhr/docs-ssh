import type {
  FileResponse,
  TreeResponse,
  ViewerProjectListResponse,
  ViewerProjectMutationResponse,
  ViewerSessionResponse,
  ViewerUserListResponse,
  ViewerUserMutationResponse,
} from './types'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload = (await response.json()) as T & { error?: string }

  if (!response.ok) {
    throw new Error('error' in payload && typeof payload.error === 'string' ? payload.error : 'Request failed.')
  }

  return payload
}

export async function getTree(project?: string) {
  const suffix = project ? `?project=${encodeURIComponent(project)}` : ''
  return fetchJson<TreeResponse>(`/api/tree${suffix}`)
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

export async function getProjects() {
  return fetchJson<ViewerProjectListResponse>('/api/projects')
}

export async function createProject(input: {
  displayName?: string
  slug: string
}) {
  return fetchJson<ViewerProjectMutationResponse>('/api/projects', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}

export async function updateProject(input: {
  displayName?: string
  slug: string
}) {
  return fetchJson<ViewerProjectMutationResponse>('/api/projects', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PATCH',
  })
}

export async function archiveProject(slug: string) {
  return fetchJson<ViewerProjectMutationResponse>(`/api/projects?slug=${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}

export async function getUsers() {
  return fetchJson<ViewerUserListResponse>('/api/users')
}

export async function createUser(input: {
  displayName?: string
  email?: string
  issuer: string
  login: string
  provider?: string
  role: 'owner' | 'admin' | 'member'
  subject: string
}) {
  return fetchJson<ViewerUserMutationResponse>('/api/users', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}
