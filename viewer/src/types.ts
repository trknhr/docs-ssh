export type ViewerFileKind = 'binary' | 'image' | 'markdown' | 'text'

export interface RootSummary {
  aliases: string[]
  label: string
  mountPath: string
  type: 'home' | 'project'
}

export interface ViewerOidcState {
  enabled: boolean
  issuer?: string
  provider?: string
  signupAvailable?: boolean
}

export interface ViewerSessionUser {
  email?: string
  expiresAt: number
  issuer: string
  login: string
  provider: string
  role?: 'owner' | 'admin' | 'member'
  subject: string
  tenant?: string
  userDisplayName: string
  userId: string
}

export interface ViewerSessionResponse {
  oidc: ViewerOidcState
  session: ViewerSessionUser | null
}

export interface ViewerProject {
  archivedAt: string | null
  createdAt: string
  displayName: string
  slug: string
}

export interface ViewerProjectListResponse {
  projects: ViewerProject[]
}

export interface ViewerProjectMutationResponse {
  project: ViewerProject
}

export type ViewerApiTokenCreateScope = 'read' | 'write' | 'ssh-session'
export type ViewerApiTokenScope = 'bootstrap:read' | 'project:read' | 'project:write' | 'sources:read' | 'ssh-session:create'

export interface ViewerApiToken {
  createdAt: string
  expiresAt: string | null
  id: string
  label: string | null
  lastUsedAt: string | null
  project: string
  revokedAt: string | null
  scopes: ViewerApiTokenScope[]
  token?: string
}

export interface ViewerApiTokenListResponse {
  tokens: ViewerApiToken[]
}

export interface ViewerApiTokenMutationResponse {
  token: ViewerApiToken
  tokens?: ViewerApiToken[]
}

export interface ViewerUserIdentity {
  email?: string | null
  issuer: string
  provider: string
  subject: string
}

export interface ViewerUser {
  createdAt: string
  displayName: string
  identities: ViewerUserIdentity[]
  login: string
  role: 'owner' | 'admin' | 'member'
}

export interface ViewerUserListResponse {
  users: ViewerUser[]
}

export interface ViewerUserMutationResponse {
  user: ViewerUser
  users: ViewerUser[]
}

export interface TreeNodeData {
  children?: TreeNodeData[]
  id: string
  kind: 'directory' | 'file'
  name: string
  path: string
  previewKind?: ViewerFileKind
}

export interface TreeResponse {
  docsName: string
  mounts: RootSummary[]
  tree: TreeNodeData[]
  truncated: boolean
}

export interface FilePayload {
  aliases: string[]
  content?: string
  error?: string
  kind: ViewerFileKind
  mountPath: string
  name: string
  path: string
  rawUrl: string
  size: number
}

export interface FileResponse {
  ok: boolean
  payload: FilePayload
  status: number
}
