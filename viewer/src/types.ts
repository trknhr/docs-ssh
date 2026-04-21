export type ViewerFileKind = 'binary' | 'image' | 'markdown' | 'text'

export interface RootSummary {
  aliases: string[]
  label: string
  mountPath: string
  type: 'docs' | 'source' | 'workspace'
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

export interface ViewerSshKey {
  algorithm: string
  createdAt: string
  fingerprint: string
  name: string | null
}

export interface ViewerSshKeyListResponse {
  keys: ViewerSshKey[]
}

export interface ViewerSshKeyMutationResponse {
  key: ViewerSshKey
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
