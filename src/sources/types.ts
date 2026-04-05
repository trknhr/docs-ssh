export type SourceType = 'local-folder' | 'git-repo'

export interface SourceSpec {
  name: string
  type: SourceType
  rootPath: string
  managed: boolean
  createdAt: string
  repoUrl?: string
  ref?: string
  subdir?: string
}

export interface SourceRegistry {
  version: 1
  defaultSourceName: string
  sources: SourceSpec[]
}

export interface SourceMount {
  sourceName: string
  mountPoint: string
  rootPath: string
}

export interface SourceStore {
  registry: SourceRegistry
  mounts: SourceMount[]
  defaultSource?: SourceSpec
  workspaceMountPath: '/workspace'
  scratchMountPath: '/scratch'
  workspaceRootPath: string
}
