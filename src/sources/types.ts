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

export interface SourceStore {
  registry: SourceRegistry
  defaultSource?: SourceSpec
  homeMountPath: '/home'
  projectMountPath: string
  projectSlug: string
  projectsMountPath: '/projects'
  sharedMountPath: '/shared'
  tmpMountPath: '/tmp'
  homeRootPath: string
  projectRootPath: string
  sharedRootPath: string
  tenantRootPath: string
  workspaceRootPath: string
}
