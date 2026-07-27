import type {
  ViewerArtifactResponse,
  ViewerArtifactVisibility,
  FileResponse,
  TreeResponse,
  ViewerApiTokenCreateScope,
  ViewerApiTokenListResponse,
  ViewerApiTokenMutationResponse,
  ViewerProjectListResponse,
  ViewerProjectMutationResponse,
  ViewerSessionResponse,
  ViewerTenantInvitationResponse,
  ViewerUserListResponse,
  ViewerUserMutationResponse,
  ViewerWorkspaceAccessRequestListResponse,
  ViewerWorkspaceAccessRequestMutationResponse,
} from './types'

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload = (await response.json()) as T & { error?: string }

  if (!response.ok) {
    throw new Error('error' in payload && typeof payload.error === 'string' ? payload.error : 'Request failed.')
  }

  return payload
}

function getProjectSearch(project?: { publicId: string; workspacePublicId: string }) {
  if (!project) return ''
  const search = new URLSearchParams({
    projectId: project.publicId,
    workspaceId: project.workspacePublicId,
  })
  return `?${search.toString()}`
}

export async function getTree(project?: { publicId: string; workspacePublicId: string }) {
  return fetchJson<TreeResponse>(`/api/tree${getProjectSearch(project)}`)
}

export async function getFile(
  path: string,
  project?: { publicId: string; workspacePublicId: string },
): Promise<FileResponse> {
  const search = new URLSearchParams({ path })
  if (project) {
    search.set('projectId', project.publicId)
    search.set('workspaceId', project.workspacePublicId)
  }
  const response = await fetch(`/api/file?${search.toString()}`)
  const payload = (await response.json()) as FileResponse['payload']

  if (project && payload.rawUrl) {
    const rawSearch = new URLSearchParams(payload.rawUrl.split('?', 2)[1] ?? '')
    rawSearch.set('projectId', project.publicId)
    rawSearch.set('workspaceId', project.workspacePublicId)
    payload.rawUrl = `/api/raw?${rawSearch.toString()}`
  }

  return {
    ok: response.ok,
    payload,
    status: response.status,
  }
}

export async function getSession() {
  return fetchJson<ViewerSessionResponse>('/api/auth/session')
}

export async function getArtifact(publicId: string) {
  return fetchJson<ViewerArtifactResponse>(`/api/artifacts/${encodeURIComponent(publicId)}`)
}

export async function updateArtifactVisibility(
  publicId: string,
  visibility: ViewerArtifactVisibility,
) {
  return fetchJson<ViewerArtifactResponse>(`/api/artifacts/${encodeURIComponent(publicId)}`, {
    body: JSON.stringify({ visibility }),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PATCH',
  })
}

export async function createWorkspaceAccessRequest(input: {
  intendedUse?: string
  workspaceName: string
}) {
  return fetchJson<ViewerWorkspaceAccessRequestMutationResponse>('/api/onboarding/request', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}

export async function getWorkspaceAccessRequests() {
  return fetchJson<ViewerWorkspaceAccessRequestListResponse>('/api/operator/workspace-requests')
}

export async function reviewWorkspaceAccessRequest(input: {
  decision: 'approved' | 'rejected'
  publicId: string
  reviewNote?: string
}) {
  return fetchJson<ViewerWorkspaceAccessRequestMutationResponse>('/api/operator/workspace-requests', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PATCH',
  })
}

export async function createTenantInvitation(input: {
  email: string
  role: 'owner' | 'admin' | 'member'
}) {
  return fetchJson<ViewerTenantInvitationResponse>('/api/invitations', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}

export async function getTenantInvitation(token: string) {
  return fetchJson<ViewerTenantInvitationResponse>(`/api/invitations/accept?token=${encodeURIComponent(token)}`)
}

export async function acceptTenantInvitation(token: string) {
  return fetchJson<ViewerTenantInvitationResponse>(`/api/invitations/accept?token=${encodeURIComponent(token)}`, {
    method: 'POST',
  })
}

export async function getProjects(workspacePublicId?: string) {
  const suffix = workspacePublicId ? `?workspaceId=${encodeURIComponent(workspacePublicId)}` : ''
  return fetchJson<ViewerProjectListResponse>(`/api/projects${suffix}`)
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

export async function getApiTokens(project: string) {
  return fetchJson<ViewerApiTokenListResponse>(`/api/tokens?project=${encodeURIComponent(project)}`)
}

export async function createApiToken(input: {
  expiresAt?: string
  label?: string
  project: string
  scopes?: ViewerApiTokenCreateScope[]
}) {
  return fetchJson<ViewerApiTokenMutationResponse>('/api/tokens', {
    body: JSON.stringify(input),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}

export async function revokeApiToken(id: string) {
  return fetchJson<ViewerApiTokenMutationResponse>(`/api/tokens?id=${encodeURIComponent(id)}`, {
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
