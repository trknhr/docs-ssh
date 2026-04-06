export type ViewerFileKind = 'binary' | 'image' | 'markdown' | 'text'

export interface RootSummary {
  aliases: string[]
  label: string
  mountPath: string
  type: 'docs' | 'source' | 'workspace'
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
