export type ViewerFileKind = 'binary' | 'image' | 'markdown' | 'text'

export interface RootSummary {
  aliases: string[]
  label: string
  mountPath: string
  type: 'home' | 'project' | 'project-docs' | 'source'
}

export interface ViewerOidcState {
  enabled: boolean
  issuer?: string
  provider?: string
}

export interface ViewerSessionUser {
  email?: string
  expiresAt: number
  issuer: string
  login: string
  provider: string
  subject: string
  userDisplayName: string
  userId: string
}

export interface ViewerSessionResponse {
  oidc: ViewerOidcState
  session: ViewerSessionUser | null
}

export interface ViewerProject {
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
