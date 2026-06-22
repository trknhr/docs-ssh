import { useCallback, useDeferredValue, useEffect, useRef, useState, startTransition } from 'react'
import { Allotment } from 'allotment'
import DOMPurify from 'dompurify'
import { Renderer, marked } from 'marked'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import { archiveProject, createApiToken, createProject, createUser, getApiTokens, getFile, getProjects, getSession, getTree, getUsers, revokeApiToken, updateProject } from './api'
import type {
  FilePayload,
  RootSummary,
  TreeNodeData,
  ViewerApiToken,
  ViewerApiTokenCreateScope,
  ViewerApiTokenScope,
  ViewerOidcState,
  ViewerProject,
  ViewerSessionUser,
  ViewerUser,
} from './types'

const API_TOKEN_SCOPE_OPTIONS: Array<{ label: string; value: ViewerApiTokenCreateScope }> = [
  { label: 'read', value: 'read' },
  { label: 'write', value: 'write' },
  { label: 'ssh-session', value: 'ssh-session' },
]

const API_TOKEN_EXPIRATION_OPTIONS = [
  { label: '7 days', value: '7' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '1 year', value: '365' },
  { label: 'No expiration', value: '' },
]

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function getFileExtension(path: string) {
  const lastDotIndex = path.lastIndexOf('.')
  return lastDotIndex === -1 ? '' : path.slice(lastDotIndex).toLowerCase()
}

function isExternalHref(href: string) {
  return /^(https?:|mailto:|tel:)/i.test(href)
}

function normalizeVirtualPath(path: string) {
  const segments = path.split('/')
  const normalized: string[] = []

  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      normalized.pop()
      continue
    }
    normalized.push(segment)
  }

  return `/${normalized.join('/')}`
}

function resolveVirtualPath(basePath: string, targetPath: string) {
  if (targetPath.startsWith('/')) return normalizeVirtualPath(targetPath)

  const baseSegments = normalizeVirtualPath(basePath).split('/').slice(0, -1)
  return normalizeVirtualPath([...baseSegments, ...targetPath.split('/')].join('/'))
}

function splitHref(href: string) {
  const hashIndex = href.indexOf('#')
  if (hashIndex === -1) {
    return {
      fragment: '',
      path: href,
    }
  }

  return {
    fragment: href.slice(hashIndex),
    path: href.slice(0, hashIndex),
  }
}

function toRawUrl(path: string) {
  return `/api/raw?path=${encodeURIComponent(path)}`
}

function formatTokenDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'never'
}

function formatApiTokenScopes(scopes: ViewerApiTokenScope[]) {
  const labels: ViewerApiTokenCreateScope[] = []
  if (scopes.some((scope) => scope === 'bootstrap:read' || scope === 'project:read' || scope === 'sources:read')) {
    labels.push('read')
  }
  if (scopes.includes('project:write')) {
    labels.push('write')
  }
  if (scopes.includes('ssh-session:create')) {
    labels.push('ssh-session')
  }
  return labels.length > 0 ? labels.join(', ') : scopes.join(', ')
}

function createExpirationTimestamp(days: string) {
  if (!days) return undefined
  const parsedDays = Number.parseInt(days, 10)
  if (!Number.isFinite(parsedDays) || parsedDays <= 0) return undefined
  return new Date(Date.now() + parsedDays * 24 * 60 * 60 * 1000).toISOString()
}

function getCurrentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function findFirstFile(nodes: TreeNodeData[]): string | null {
  for (const node of nodes) {
    if (node.kind === 'file') return node.path
    if (node.children) {
      const nested = findFirstFile(node.children)
      if (nested) return nested
    }
  }
  return null
}

function containsPath(nodes: TreeNodeData[], path: string): boolean {
  for (const node of nodes) {
    if (node.kind === 'file' && node.path === path) return true
    if (node.children && containsPath(node.children, path)) return true
  }
  return false
}

function findMountForPath(mounts: RootSummary[], path: string | null): RootSummary | null {
  if (!path) return null

  return mounts
    .map((mount) => {
      const matchedPath = [mount.mountPath, ...mount.aliases]
        .filter((mountPath) => path === mountPath || path.startsWith(`${mountPath}/`))
        .sort((left, right) => right.length - left.length)[0]
      return matchedPath ? { matchedPath, mount } : null
    })
    .filter((match): match is { matchedPath: string, mount: RootSummary } => Boolean(match))
    .sort((left, right) => right.matchedPath.length - left.matchedPath.length)[0]
    ?.mount
    ?? null
}

function getShikiLanguage(path: string) {
  const extension = getFileExtension(path)

  switch (extension) {
    case '.css':
      return 'css'
    case '.csv':
      return 'csv'
    case '.env':
    case '.ini':
    case '.toml':
      return 'ini'
    case '.gql':
    case '.graphql':
      return 'graphql'
    case '.htm':
    case '.html':
      return 'html'
    case '.java':
      return 'java'
    case '.js':
    case '.cjs':
    case '.mjs':
      return 'javascript'
    case '.json':
      return 'json'
    case '.jsx':
      return 'jsx'
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.mdx':
      return 'mdx'
    case '.py':
      return 'python'
    case '.rb':
      return 'ruby'
    case '.scss':
      return 'scss'
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'bash'
    case '.sql':
      return 'sql'
    case '.svg':
      return 'xml'
    case '.ts':
    case '.cts':
    case '.mts':
      return 'typescript'
    case '.tsx':
      return 'tsx'
    case '.xml':
      return 'xml'
    case '.yaml':
    case '.yml':
      return 'yaml'
    default:
      return 'text'
  }
}

function readLocationState() {
  const url = new URL(window.location.href)
  return {
    path: url.searchParams.get('path'),
  }
}

function writeLocationState(path: string | null) {
  const url = new URL(window.location.href)

  if (path) {
    url.searchParams.set('path', path)
  } else {
    url.searchParams.delete('path')
  }

  window.history.replaceState(null, '', url)
}

function useElementSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null)
  const [size, setSize] = useState({ height: 0, width: 0 })
  const ref = useCallback((node: T | null) => {
    setElement(node)
  }, [])

  useEffect(() => {
    if (!element) return

    const updateSize = () => {
      const rect = element.getBoundingClientRect()
      setSize({
        height: rect.height,
        width: rect.width,
      })
    }

    const observer = new ResizeObserver((entries) => {
      const nextEntry = entries[0]
      if (!nextEntry) return

      setSize({
        height: nextEntry.contentRect.height,
        width: nextEntry.contentRect.width,
      })
    })

    observer.observe(element)
    updateSize()
    const frameId = window.requestAnimationFrame(updateSize)
    window.addEventListener('resize', updateSize)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', updateSize)
    }
  }, [element])

  return { ref, size }
}

function renderMarkdown(file: FilePayload) {
  const renderer = new Renderer()

  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens)
    if (!href) return label
    if (href.startsWith('#')) {
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`
    }

    if (isExternalHref(href)) {
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`
    }

    const { fragment, path } = splitHref(href)
    const resolvedPath = resolveVirtualPath(file.path, path)

    return `<a href="?path=${encodeURIComponent(resolvedPath)}${escapeHtml(fragment)}" data-doc-path="${escapeHtml(resolvedPath)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`
  }

  renderer.image = function ({ href, title, text }) {
    if (!href) return text
    const imageSource = isExternalHref(href)
      ? href
      : toRawUrl(resolveVirtualPath(file.path, href))

    return `<img src="${escapeHtml(imageSource)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy" />`
  }

  const rendered = marked.parse(file.content ?? '', {
    gfm: true,
    renderer,
  })

  return DOMPurify.sanitize(rendered as string)
}

function PreviewHeader(props: {
  file: FilePayload | null
  session: ViewerSessionUser | null
}) {
  if (!props.file) {
    return (
      <header className="preview-header">
        <div>
          <p className="eyebrow">Preview</p>
          <h2>{props.session ? 'Workspace' : 'No file selected'}</h2>
          {props.session ? (
            <p className="preview-path">Project access for {props.session.login}</p>
          ) : null}
        </div>
      </header>
    )
  }

  return (
    <header className="preview-header">
      <div>
        <p className="eyebrow">{props.file.mountPath}</p>
        <h2>{props.file.name}</h2>
        <p className="preview-path">{props.file.path}</p>
      </div>
      <div className="preview-meta">
        <span className="meta-pill">Read only</span>
        {props.file.aliases.map((alias) => (
          <span className="meta-pill meta-pill--muted" key={alias}>
            {alias}
          </span>
        ))}
        <a className="meta-link" href={props.file.rawUrl} target="_blank" rel="noreferrer">
          Open raw
        </a>
      </div>
    </header>
  )
}

function CopyBlock(props: {
  label: string
  value: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="copy-block">
      <div className="copy-block__header">
        <span>{props.label}</span>
        <button
          className="meta-link meta-button"
          disabled={!props.value}
          onClick={() => {
            void navigator.clipboard.writeText(props.value).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1400)
            })
          }}
          type="button"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="config-snippet">{props.value || 'Select a project'}</pre>
    </div>
  )
}

function StatusMessages(props: {
  error: string | null
  success: string | null
}) {
  return (
    <>
      {props.success ? (
        <p className="status-message status-message--success">{props.success}</p>
      ) : null}
      {props.error ? (
        <p className="status-message status-message--error">{props.error}</p>
      ) : null}
    </>
  )
}

function EmptyInline(props: {
  children: string
}) {
  return (
    <div className="preview-state preview-state--compact">
      <p>{props.children}</p>
    </div>
  )
}

type WorkspaceTab = 'access' | 'projects' | 'setup' | 'tokens' | 'users'

function AccountPanel(props: {
  apiTokenCreateError: string | null
  apiTokenCreateStatus: string | null
  apiTokenExpirationDays: string
  apiTokenLabel: string
  apiTokenPlaintext: string | null
  apiTokenRevokingId: string | null
  apiTokenScopes: ViewerApiTokenCreateScope[]
  apiTokenSubmitting: boolean
  apiTokens: ViewerApiToken[]
  apiTokensLoading: boolean
  canManageUsers: boolean
  onArchiveProject: () => void
  onApiTokenExpirationDaysChange: (value: string) => void
  onApiTokenLabelChange: (value: string) => void
  onApiTokenScopeChange: (scope: ViewerApiTokenCreateScope, checked: boolean) => void
  onCreateApiToken: () => void
  onCreateProject: () => void
  onCreateUser: () => void
  onProjectEditDisplayNameChange: (value: string) => void
  onProjectDisplayNameChange: (value: string) => void
  onProjectSlugChange: (value: string) => void
  onRevokeApiToken: (id: string) => void
  onSelectProject: (slug: string) => void
  onUpdateProject: () => void
  onUserDisplayNameChange: (value: string) => void
  onUserEmailChange: (value: string) => void
  onUserIssuerChange: (value: string) => void
  onUserLoginChange: (value: string) => void
  onUserProviderChange: (value: string) => void
  onUserRoleChange: (value: 'owner' | 'admin' | 'member') => void
  onUserSubjectChange: (value: string) => void
  projectCreateError: string | null
  projectCreateStatus: string | null
  projectDisplayName: string
  projectEditDisplayName: string
  projectEditSlug: string
  projectMutationError: string | null
  projectMutationStatus: string | null
  projectSlug: string
  projectArchiving: boolean
  projectSubmitting: boolean
  projectUpdating: boolean
  projects: ViewerProject[]
  projectsLoading: boolean
  selectedProject: string | null
  session: ViewerSessionUser
  userCreateError: string | null
  userCreateStatus: string | null
  userDisplayName: string
  userEmail: string
  userIssuer: string
  userLogin: string
  userProvider: string
  userRole: 'owner' | 'admin' | 'member'
  userSubject: string
  userSubmitting: boolean
  users: ViewerUser[]
  usersLoading: boolean
}) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('setup')
  const selectedProject = props.projects.find((project) => project.slug === props.selectedProject) ?? props.projects[0]
  const projectConfig = selectedProject
    ? [
        'server = "docs-ssh"',
        `project = "${selectedProject.slug}"`,
        '',
      ].join('\n')
    : ''
  const loginCommand = 'docs-ssh login --server docs-ssh'
  const activeTokenCount = props.apiTokens.filter((token) => !token.revokedAt).length
  const roleLabel = props.session.role ?? 'member'
  const workspaceTabs: Array<{ count?: string, id: WorkspaceTab, label: string }> = [
    { id: 'setup', label: 'Setup' },
    {
      count: props.projectsLoading ? '...' : String(props.projects.length),
      id: 'projects',
      label: 'Projects',
    },
    ...(props.canManageUsers && selectedProject
      ? [{
          count: props.apiTokensLoading ? '...' : String(activeTokenCount),
          id: 'tokens' as const,
          label: 'Tokens',
        }]
      : []),
    ...(props.canManageUsers
      ? [{
          count: props.usersLoading ? '...' : String(props.users.length),
          id: 'users' as const,
          label: 'Users',
        }]
      : [{ id: 'access' as const, label: 'Access' }]),
  ]
  const visibleActiveTab = workspaceTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : workspaceTabs[0]?.id ?? 'setup'

  return (
    <section className="account-dashboard docs-page">
      <nav className="docs-tabs" aria-label="Workspace sections" role="tablist">
        {workspaceTabs.map((tab) => (
          <button
            aria-controls={`workspace-panel-${tab.id}`}
            aria-selected={visibleActiveTab === tab.id}
            className={`docs-tab ${visibleActiveTab === tab.id ? 'selected' : ''}`}
            id={`workspace-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            tabIndex={visibleActiveTab === tab.id ? 0 : -1}
            type="button"
          >
            <span>{tab.label}</span>
            {tab.count ? <strong>{tab.count}</strong> : null}
          </button>
        ))}
      </nav>

      {visibleActiveTab === 'setup' ? (
        <section
          aria-labelledby="workspace-tab-setup"
          className="docs-section docs-section--setup"
          id="workspace-panel-setup"
          role="tabpanel"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Agent setup</p>
              <h3>Commands</h3>
            </div>
          </div>
          <div className="setup-strip">
            <CopyBlock label="Web session" value={loginCommand} />
            <CopyBlock label="Directory project" value={projectConfig} />
          </div>
        </section>
      ) : null}

      {visibleActiveTab === 'projects' ? (
        <section
          aria-labelledby="workspace-tab-projects"
          className="docs-section docs-section--projects"
          id="workspace-panel-projects"
          role="tabpanel"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Projects</p>
              <h3>Project switchboard</h3>
            </div>
          </div>

          <div className="project-section-grid">
            <div>
              {props.projectsLoading ? (
                <EmptyInline>Loading projects...</EmptyInline>
              ) : props.projects.length === 0 ? (
                <EmptyInline>No projects available.</EmptyInline>
              ) : (
                <div className="project-list">
                  {props.projects.map((project) => (
                    <button
                      aria-pressed={project.slug === selectedProject?.slug}
                      className={`project-item ${project.slug === selectedProject?.slug ? 'selected' : ''}`}
                      key={project.slug}
                      onClick={() => props.onSelectProject(project.slug)}
                      type="button"
                    >
                      <span>
                        <strong>{project.displayName}</strong>
                        <code>{project.slug}</code>
                      </span>
                      <span className="project-item__status">
                        {project.slug === selectedProject?.slug ? 'Current' : 'Open'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {selectedProject ? (
                <div className="project-editor">
                  <div className="form-grid">
                    <label className="field field--stacked">
                      <span>Selected slug</span>
                      <input
                        aria-readonly="true"
                        maxLength={120}
                        readOnly
                        type="text"
                        value={props.projectEditSlug}
                      />
                    </label>
                    <label className="field field--stacked">
                      <span>Selected display name</span>
                      <input
                        maxLength={160}
                        onChange={(event) => props.onProjectEditDisplayNameChange(event.target.value)}
                        type="text"
                        value={props.projectEditDisplayName}
                      />
                    </label>
                  </div>
                  <div className="account-form__footer account-form__footer--inline">
                    <button
                      className="action-button"
                      disabled={props.projectUpdating || props.projectArchiving}
                      onClick={props.onUpdateProject}
                      type="button"
                    >
                      {props.projectUpdating ? 'Saving project...' : 'Save project'}
                    </button>
                    <button
                      className="danger-button"
                      disabled={
                        props.projectUpdating
                        || props.projectArchiving
                        || selectedProject.slug === 'default'
                      }
                      onClick={props.onArchiveProject}
                      type="button"
                    >
                      {props.projectArchiving ? 'Archiving project...' : 'Archive project'}
                    </button>
                    <StatusMessages error={props.projectMutationError} success={props.projectMutationStatus} />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="create-panel">
              <div className="section-heading section-heading--compact">
                <div>
                  <p className="eyebrow">New project</p>
                  <h3>Create project</h3>
                </div>
              </div>
              <div className="account-form">
                <div className="form-grid">
                  <label className="field field--stacked">
                    <span>Slug</span>
                    <input
                      maxLength={120}
                      onChange={(event) => props.onProjectSlugChange(event.target.value)}
                      placeholder="product-docs"
                      type="text"
                      value={props.projectSlug}
                    />
                  </label>
                  <label className="field field--stacked">
                    <span>Display name</span>
                    <input
                      maxLength={160}
                      onChange={(event) => props.onProjectDisplayNameChange(event.target.value)}
                      placeholder="Product Docs"
                      type="text"
                      value={props.projectDisplayName}
                    />
                  </label>
                </div>
                <div className="account-form__footer">
                  <button
                    className="action-button"
                    disabled={props.projectSubmitting}
                    onClick={props.onCreateProject}
                    type="button"
                  >
                    {props.projectSubmitting ? 'Creating project...' : 'Create project'}
                  </button>
                  <StatusMessages error={props.projectCreateError} success={props.projectCreateStatus} />
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {visibleActiveTab === 'tokens' && props.canManageUsers && selectedProject ? (
        <section
          aria-labelledby="workspace-tab-tokens"
          className="docs-section docs-section--tokens"
          id="workspace-panel-tokens"
          role="tabpanel"
        >
          <div className="content-section-grid">
            <div className="section-heading">
              <div>
                <p className="eyebrow">API Tokens</p>
                <h3>{selectedProject.slug}</h3>
              </div>
              <span className="meta-pill">{activeTokenCount} active</span>
            </div>

            <div className="account-form content-section-form">
              <div className="form-grid">
                <label className="field field--stacked">
                  <span>Label</span>
                  <input
                    maxLength={120}
                    onChange={(event) => props.onApiTokenLabelChange(event.target.value)}
                    placeholder="agent token"
                    type="text"
                    value={props.apiTokenLabel}
                  />
                </label>
                <label className="field field--stacked">
                  <span>Expiration</span>
                  <select
                    onChange={(event) => props.onApiTokenExpirationDaysChange(event.target.value)}
                    value={props.apiTokenExpirationDays}
                  >
                    {API_TOKEN_EXPIRATION_OPTIONS.map((option) => (
                      <option key={option.value || 'none'} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="token-scope-grid">
                {API_TOKEN_SCOPE_OPTIONS.map((scope) => (
                  <label className="check-field" key={scope.value}>
                    <input
                      checked={props.apiTokenScopes.includes(scope.value)}
                      onChange={(event) => props.onApiTokenScopeChange(scope.value, event.target.checked)}
                      type="checkbox"
                    />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
              <div className="account-form__footer">
                <button
                  className="action-button"
                  disabled={props.apiTokenSubmitting}
                  onClick={props.onCreateApiToken}
                  type="button"
                >
                  {props.apiTokenSubmitting ? 'Creating token...' : 'Create token'}
                </button>
                <StatusMessages error={props.apiTokenCreateError} success={props.apiTokenCreateStatus} />
              </div>
            </div>
          </div>

          {props.apiTokenPlaintext ? (
            <CopyBlock label="New token" value={props.apiTokenPlaintext} />
          ) : null}

          {props.apiTokensLoading ? (
            <EmptyInline>Loading tokens...</EmptyInline>
          ) : props.apiTokens.length === 0 ? (
            <EmptyInline>No active API tokens for this project.</EmptyInline>
          ) : (
            <div className="token-list">
              {props.apiTokens.map((token) => (
                <div className="token-item" key={token.id}>
                  <div className="token-item__body">
                    <div className="token-item__header">
                      <strong>{token.label || 'API token'}</strong>
                      <span className="meta-pill meta-pill--muted">{token.project}</span>
                    </div>
                    <dl className="token-meta-grid">
                      <div>
                        <dt>Created</dt>
                        <dd>{formatTokenDate(token.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>{formatTokenDate(token.expiresAt)}</dd>
                      </div>
                      <div>
                        <dt>Last used</dt>
                        <dd>{formatTokenDate(token.lastUsedAt)}</dd>
                      </div>
                    </dl>
                    <code className="token-scopes">{formatApiTokenScopes(token.scopes)}</code>
                  </div>
                  <button
                    className="danger-button danger-button--small"
                    disabled={props.apiTokenRevokingId === token.id}
                    onClick={() => props.onRevokeApiToken(token.id)}
                    type="button"
                  >
                    {props.apiTokenRevokingId === token.id ? 'Revoking...' : 'Revoke'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {visibleActiveTab === 'users' && props.canManageUsers ? (
        <section
          aria-labelledby="workspace-tab-users"
          className="docs-section docs-section--users"
          id="workspace-panel-users"
          role="tabpanel"
        >
          <div className="content-section-grid">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Users</p>
                <h3>Web access</h3>
              </div>
              <span className="meta-pill">{props.usersLoading ? '...' : props.users.length} users</span>
            </div>

            <div className="create-panel">
              <div className="section-heading section-heading--compact">
                <div>
                  <p className="eyebrow">New user</p>
                  <h3>Add web user</h3>
                </div>
              </div>
              <div className="account-form">
                <div className="form-grid">
                  <label className="field field--stacked">
                    <span>Login</span>
                    <input
                      maxLength={120}
                      onChange={(event) => props.onUserLoginChange(event.target.value)}
                      placeholder="bob"
                      type="text"
                      value={props.userLogin}
                    />
                  </label>
                  <label className="field field--stacked">
                    <span>Display name</span>
                    <input
                      maxLength={160}
                      onChange={(event) => props.onUserDisplayNameChange(event.target.value)}
                      placeholder="Bob Member"
                      type="text"
                      value={props.userDisplayName}
                    />
                  </label>
                </div>
                <div className="form-grid">
                  <label className="field field--stacked">
                    <span>Provider</span>
                    <input
                      maxLength={80}
                      onChange={(event) => props.onUserProviderChange(event.target.value)}
                      placeholder="google"
                      type="text"
                      value={props.userProvider}
                    />
                  </label>
                  <label className="field field--stacked">
                    <span>Role</span>
                    <select
                      onChange={(event) => props.onUserRoleChange(event.target.value as 'owner' | 'admin' | 'member')}
                      value={props.userRole}
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                      {props.session.role === 'owner' ? <option value="owner">owner</option> : null}
                    </select>
                  </label>
                </div>
                <label className="field field--stacked">
                  <span>Issuer</span>
                  <input
                    maxLength={240}
                    onChange={(event) => props.onUserIssuerChange(event.target.value)}
                    placeholder="https://accounts.google.com"
                    type="text"
                    value={props.userIssuer}
                  />
                </label>
                <label className="field field--stacked">
                  <span>Subject</span>
                  <input
                    maxLength={240}
                    onChange={(event) => props.onUserSubjectChange(event.target.value)}
                    placeholder="Google subject"
                    type="text"
                    value={props.userSubject}
                  />
                </label>
                <label className="field field--stacked">
                  <span>Email</span>
                  <input
                    maxLength={240}
                    onChange={(event) => props.onUserEmailChange(event.target.value)}
                    placeholder="bob@example.com"
                    type="email"
                    value={props.userEmail}
                  />
                </label>
                <div className="account-form__footer">
                  <button
                    className="action-button"
                    disabled={props.userSubmitting}
                    onClick={props.onCreateUser}
                    type="button"
                  >
                    {props.userSubmitting ? 'Adding user...' : 'Add user'}
                  </button>
                  <StatusMessages error={props.userCreateError} success={props.userCreateStatus} />
                </div>
              </div>
            </div>
          </div>

          {props.usersLoading ? (
            <EmptyInline>Loading users...</EmptyInline>
          ) : (
            <div className="user-list">
              {props.users.map((user) => (
                <div className="user-item" key={user.login}>
                  <div>
                    <strong>{user.displayName}</strong>
                    <code>{user.login}</code>
                  </div>
                  <span className="meta-pill">{user.role}</span>
                  {user.identities.map((identity) => (
                    <span className="meta-pill meta-pill--muted" key={`${identity.provider}:${identity.issuer}:${identity.subject}`}>
                      {identity.provider}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {visibleActiveTab === 'access' && !props.canManageUsers ? (
        <section
          aria-labelledby="workspace-tab-access"
          className="docs-section docs-section--readonly"
          id="workspace-panel-access"
          role="tabpanel"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Access</p>
              <h3>{props.session.userDisplayName}</h3>
            </div>
            <span className="meta-pill">{roleLabel}</span>
          </div>
          <CopyBlock label="Directory project" value={projectConfig} />
        </section>
      ) : null}
    </section>
  )
}

function ExplorerNode(props: NodeRendererProps<TreeNodeData>) {
  const isDirectory = props.node.data.kind === 'directory'

  return (
    <div
      className={`explorer-node ${props.node.isSelected ? 'selected' : ''}`}
      ref={props.dragHandle}
      style={props.style}
    >
      <button
        aria-label={props.node.isOpen ? 'Collapse folder' : 'Expand folder'}
        className="explorer-node__toggle"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (isDirectory) props.node.toggle()
        }}
        type="button"
      >
        {isDirectory ? (props.node.isOpen ? '▾' : '▸') : '·'}
      </button>
      <span className={`explorer-node__icon ${isDirectory ? 'folder' : props.node.data.previewKind ?? 'file'}`} />
      <span className="explorer-node__label">{props.node.data.name}</span>
    </div>
  )
}

function PreviewPane(props: {
  file: FilePayload | null
  loading: boolean
  onNavigate: (path: string) => void
}) {
  const [codeHtml, setCodeHtml] = useState('')

  useEffect(() => {
    let cancelled = false

    if (!props.file || props.file.kind !== 'text') {
      setCodeHtml('')
      return
    }

    setCodeHtml('')

    import('shiki')
      .then(({ codeToHtml }) =>
        codeToHtml(props.file?.content ?? '', {
          lang: getShikiLanguage(props.file?.path ?? ''),
          theme: 'dark-plus',
        }),
      )
      .then((html) => {
        if (!cancelled) setCodeHtml(html)
      })
      .catch(() => {
        if (!cancelled) {
          setCodeHtml(
            `<pre class="plain-code-fallback"><code>${escapeHtml(props.file?.content ?? '')}</code></pre>`,
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [props.file])

  if (props.loading) {
    return (
      <div className="preview-state">
        <div className="preview-skeleton preview-skeleton--wide" />
        <div className="preview-skeleton" />
        <div className="preview-skeleton preview-skeleton--wide" />
      </div>
    )
  }

  if (!props.file) {
    return (
      <div className="preview-state">
        <h3>Select a file from the explorer</h3>
        <p>The preview follows the mounted project tree.</p>
      </div>
    )
  }

  if (props.file.error) {
    return (
      <div className="preview-state">
        <h3>Preview unavailable</h3>
        <p>{props.file.error}</p>
        <a className="meta-link" href={props.file.rawUrl} target="_blank" rel="noreferrer">
          Open raw file
        </a>
      </div>
    )
  }

  if (props.file.kind === 'image') {
    return (
      <div className="image-preview">
        <img alt={props.file.name} src={props.file.rawUrl} />
      </div>
    )
  }

  if (props.file.kind === 'markdown') {
    const html = renderMarkdown(props.file)

    return (
      <article
        className="markdown-preview"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(event) => {
          const target = event.target
          if (!(target instanceof HTMLElement)) return

          const anchor = target.closest('a[data-doc-path]')
          if (!(anchor instanceof HTMLAnchorElement)) return

          const nextPath = anchor.dataset.docPath
          if (!nextPath) return

          event.preventDefault()
          props.onNavigate(nextPath)
        }}
      />
    )
  }

  return (
    <div
      className="code-preview"
      dangerouslySetInnerHTML={{ __html: codeHtml || '<div class="preview-state"><p>Preparing syntax highlight...</p></div>' }}
    />
  )
}

function LoggedOutLanding(props: {
  oidc: ViewerOidcState
}) {
  const authReady = props.oidc.enabled
  const signupAvailable = Boolean(props.oidc.signupAvailable)

  return (
    <section className="logged-out-shell">
      {authReady ? (
        <>
          <p className="logged-out-copy">
            {signupAvailable
              ? 'This docs-ssh server has no owner yet. Continue with Google to create the first owner account.'
              : 'Sign in with a linked Google account.'}
          </p>
          <a
            className="hero-button"
            href={`/auth/login?returnTo=${encodeURIComponent(getCurrentReturnTo())}`}
          >
            Continue with Google
          </a>
        </>
      ) : (
        <span className="meta-pill meta-pill--muted">OIDC not configured</span>
      )}
    </section>
  )
}

export function App() {
  const initialLocation = readLocationState()
  const treeRef = useRef<TreeApi<TreeNodeData> | null>(null)
  const [oidc, setOidc] = useState<ViewerOidcState>({ enabled: false })
  const [session, setSession] = useState<ViewerSessionUser | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [mounts, setMounts] = useState<RootSummary[]>([])
  const [activePath, setActivePath] = useState<string | null>(initialLocation.path)
  const [tree, setTree] = useState<TreeNodeData[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeTruncated, setTreeTruncated] = useState(false)
  const [file, setFile] = useState<FilePayload | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [projects, setProjects] = useState<ViewerProject[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [selectedProject, setSelectedProject] = useState<string | null>(
    window.localStorage.getItem('docs-ssh:selected-project'),
  )
  const [projectSlug, setProjectSlug] = useState('')
  const [projectDisplayName, setProjectDisplayName] = useState('')
  const [projectEditSlug, setProjectEditSlug] = useState('')
  const [projectEditDisplayName, setProjectEditDisplayName] = useState('')
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null)
  const [projectCreateStatus, setProjectCreateStatus] = useState<string | null>(null)
  const [projectMutationError, setProjectMutationError] = useState<string | null>(null)
  const [projectMutationStatus, setProjectMutationStatus] = useState<string | null>(null)
  const [projectArchiving, setProjectArchiving] = useState(false)
  const [projectSubmitting, setProjectSubmitting] = useState(false)
  const [projectUpdating, setProjectUpdating] = useState(false)
  const [users, setUsers] = useState<ViewerUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [userLogin, setUserLogin] = useState('')
  const [userDisplayName, setUserDisplayName] = useState('')
  const [userProvider, setUserProvider] = useState('')
  const [userIssuer, setUserIssuer] = useState('')
  const [userSubject, setUserSubject] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'member'>('member')
  const [userCreateError, setUserCreateError] = useState<string | null>(null)
  const [userCreateStatus, setUserCreateStatus] = useState<string | null>(null)
  const [userSubmitting, setUserSubmitting] = useState(false)
  const [apiTokens, setApiTokens] = useState<ViewerApiToken[]>([])
  const [apiTokensLoading, setApiTokensLoading] = useState(false)
  const [apiTokenLabel, setApiTokenLabel] = useState('')
  const [apiTokenExpirationDays, setApiTokenExpirationDays] = useState('90')
  const [apiTokenScopes, setApiTokenScopes] = useState<ViewerApiTokenCreateScope[]>(['read', 'ssh-session'])
  const [apiTokenPlaintext, setApiTokenPlaintext] = useState<string | null>(null)
  const [apiTokenCreateError, setApiTokenCreateError] = useState<string | null>(null)
  const [apiTokenCreateStatus, setApiTokenCreateStatus] = useState<string | null>(null)
  const [apiTokenSubmitting, setApiTokenSubmitting] = useState(false)
  const [apiTokenRevokingId, setApiTokenRevokingId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const deferredSearchTerm = useDeferredValue(searchTerm)
  const explorerViewport = useElementSize<HTMLDivElement>()
  const activeMount = findMountForPath(mounts, activePath)
  const treeHeight = Math.max(1, explorerViewport.size.height)
  const canManageUsers = session?.role === 'owner' || session?.role === 'admin'
  const showSessionGate = sessionLoading && !session
  const showLoggedOutLanding = !session && !sessionLoading
  const showAccountPanel = Boolean(session) && !activePath

  useEffect(() => {
    let cancelled = false

    getSession()
      .then((payload) => {
        if (cancelled) return
        setOidc(payload.oidc)
        setSession(payload.session)
        setSessionLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setSessionLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (oidc.provider && !userProvider) setUserProvider(oidc.provider)
    if (oidc.issuer && !userIssuer) setUserIssuer(oidc.issuer)
  }, [oidc.issuer, oidc.provider, userIssuer, userProvider])

  useEffect(() => {
    let cancelled = false
    setTreeLoading(true)
    setTreeError(null)

    getTree(selectedProject ?? undefined)
      .then((payload) => {
        if (cancelled) return

        setMounts(payload.mounts)
        setTree(payload.tree)
        setTreeTruncated(payload.truncated)
        setTreeLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        setTreeError(error instanceof Error ? error.message : String(error))
        setTreeLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedProject])

  useEffect(() => {
    if (!session) {
      setProjects([])
      setProjectsLoading(false)
      return
    }

    let cancelled = false
    setProjectsLoading(true)

    getProjects()
      .then((payload) => {
        if (cancelled) return

        setProjects(payload.projects)
        const selectedIsAvailable = selectedProject
          ? payload.projects.some((project) => project.slug === selectedProject)
          : false
        if (!selectedIsAvailable && payload.projects[0]) {
          selectProject(payload.projects[0].slug)
        }
        setProjectsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setProjectsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [session, selectedProject])

  useEffect(() => {
    const project = selectedProject
      ? projects.find((entry) => entry.slug === selectedProject)
      : projects[0]
    setProjectEditSlug(project?.slug ?? '')
    setProjectEditDisplayName(project?.displayName ?? '')
  }, [projects, selectedProject])

  useEffect(() => {
    if (!session || !canManageUsers) {
      setUsers([])
      setUsersLoading(false)
      return
    }

    let cancelled = false
    setUsersLoading(true)

    getUsers()
      .then((payload) => {
        if (cancelled) return
        setUsers(payload.users)
        setUsersLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setUsersLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [canManageUsers, session])

  useEffect(() => {
    if (!session || !canManageUsers || !selectedProject) {
      setApiTokens([])
      setApiTokensLoading(false)
      setApiTokenPlaintext(null)
      return
    }

    let cancelled = false
    setApiTokensLoading(true)
    setApiTokenCreateError(null)

    getApiTokens(selectedProject)
      .then((payload) => {
        if (cancelled) return
        setApiTokens(payload.tokens)
        setApiTokensLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        setApiTokenCreateError(error instanceof Error ? error.message : String(error))
        setApiTokensLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [canManageUsers, selectedProject, session])

  useEffect(() => {
    const handlePopState = () => {
      const locationState = readLocationState()
      startTransition(() => {
        setActivePath(locationState.path)
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    writeLocationState(activePath)
  }, [activePath])

  useEffect(() => {
    if (!tree.length) return

    if (!activePath) return
    if (containsPath(tree, activePath)) return

    startTransition(() => setActivePath(null))
  }, [activePath, tree])

  useEffect(() => {
    if (!activePath) {
      setFile(null)
      return
    }

    let cancelled = false
    setFileLoading(true)

    getFile(activePath)
      .then((response) => {
        if (cancelled) return
        setFileLoading(false)
        setFile(response.payload)
      })
      .catch((error) => {
        if (cancelled) return
        setFileLoading(false)
        setFile({
          aliases: activeMount?.aliases ?? [],
          error: error instanceof Error ? error.message : String(error),
          kind: 'binary',
          mountPath: activeMount?.mountPath ?? '/',
          name: activePath.split('/').at(-1) ?? activePath,
          path: activePath,
          rawUrl: toRawUrl(activePath),
          size: 0,
        })
      })

    return () => {
      cancelled = true
    }
  }, [activeMount, activePath])

  useEffect(() => {
    if (!activePath || !treeRef.current) return
    treeRef.current.openParents(`file:${activePath}`)
    treeRef.current.scrollTo(`file:${activePath}`)
  }, [activePath, tree])

  const setSelectedProjectValue = (slug: string | null) => {
    setSelectedProject(slug)
    if (slug) {
      window.localStorage.setItem('docs-ssh:selected-project', slug)
    } else {
      window.localStorage.removeItem('docs-ssh:selected-project')
    }
    startTransition(() => setActivePath(null))
  }

  const selectProject = (slug: string) => {
    setSelectedProjectValue(slug)
  }

  const submitProject = async () => {
    const slug = projectSlug.trim()
    const displayName = projectDisplayName.trim()
    if (!slug) {
      setProjectCreateError('Enter a project slug first.')
      setProjectCreateStatus(null)
      return
    }

    setProjectSubmitting(true)
    setProjectCreateError(null)
    setProjectCreateStatus(null)

    try {
      const payload = await createProject({
        displayName: displayName || undefined,
        slug,
      })

      setProjects((current) => {
        const next = current.filter((entry) => entry.slug !== payload.project.slug)
        return [...next, payload.project].sort((left, right) => left.slug.localeCompare(right.slug))
      })
      setProjectSlug('')
      setProjectDisplayName('')
      setProjectCreateStatus(`Created ${payload.project.slug}`)
      selectProject(payload.project.slug)
    } catch (error) {
      setProjectCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectSubmitting(false)
    }
  }

  const getSelectedProject = () => (
    selectedProject
      ? projects.find((project) => project.slug === selectedProject)
      : projects[0]
  )

  const submitProjectUpdate = async () => {
    const project = getSelectedProject()
    const displayName = projectEditDisplayName.trim()
    if (!project) {
      setProjectMutationError('Select a project first.')
      setProjectMutationStatus(null)
      return
    }

    setProjectUpdating(true)
    setProjectMutationError(null)
    setProjectMutationStatus(null)

    try {
      const payload = await updateProject({
        displayName: displayName || undefined,
        slug: project.slug,
      })

      setProjects((current) => {
        const next = current.filter((entry) => entry.slug !== project.slug && entry.slug !== payload.project.slug)
        return [...next, payload.project].sort((left, right) => left.slug.localeCompare(right.slug))
      })
      setProjectMutationStatus(`Updated ${payload.project.slug}`)
      const oldMountPath = `/projects/${project.slug}`
      if (activePath === oldMountPath || activePath?.startsWith(`${oldMountPath}/`)) {
        startTransition(() => setActivePath(null))
      }
      selectProject(payload.project.slug)
    } catch (error) {
      setProjectMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectUpdating(false)
    }
  }

  const submitProjectArchive = async () => {
    const project = getSelectedProject()
    if (!project) {
      setProjectMutationError('Select a project first.')
      setProjectMutationStatus(null)
      return
    }
    if (project.slug === 'default') {
      setProjectMutationError('The default project cannot be archived.')
      setProjectMutationStatus(null)
      return
    }
    if (!window.confirm(`Archive project "${project.slug}"?`)) return

    setProjectArchiving(true)
    setProjectMutationError(null)
    setProjectMutationStatus(null)

    try {
      const payload = await archiveProject(project.slug)
      const nextProjects = projects.filter((entry) => entry.slug !== payload.project.slug)
      setProjects(nextProjects)
      setProjectMutationStatus(`Archived ${payload.project.slug}`)
      const archivedMountPath = `/projects/${project.slug}`
      if (activePath === archivedMountPath || activePath?.startsWith(`${archivedMountPath}/`)) {
        startTransition(() => setActivePath(null))
      }
      setSelectedProjectValue(nextProjects[0]?.slug ?? null)
    } catch (error) {
      setProjectMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setProjectArchiving(false)
    }
  }

  const submitUser = async () => {
    const login = userLogin.trim()
    const displayName = userDisplayName.trim()
    const provider = userProvider.trim()
    const issuer = userIssuer.trim()
    const subject = userSubject.trim()
    const email = userEmail.trim()
    if (!login) {
      setUserCreateError('Enter a user login first.')
      setUserCreateStatus(null)
      return
    }
    if (!issuer || !subject) {
      setUserCreateError('Enter the identity issuer and subject from the access request.')
      setUserCreateStatus(null)
      return
    }

    setUserSubmitting(true)
    setUserCreateError(null)
    setUserCreateStatus(null)

    try {
      const payload = await createUser({
        displayName: displayName || undefined,
        email: email || undefined,
        issuer,
        login,
        provider: provider || undefined,
        role: userRole,
        subject,
      })

      setUsers(payload.users)
      setUserLogin('')
      setUserDisplayName('')
      setUserSubject('')
      setUserEmail('')
      setUserRole('member')
      setUserCreateStatus(`Added ${payload.user.login}`)
    } catch (error) {
      setUserCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setUserSubmitting(false)
    }
  }

  const setApiTokenScope = (scope: ViewerApiTokenCreateScope, checked: boolean) => {
    setApiTokenScopes((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(scope)
        if (scope === 'write') next.add('read')
      } else {
        next.delete(scope)
        if (scope === 'read') next.delete('write')
      }
      return API_TOKEN_SCOPE_OPTIONS
        .map((option) => option.value)
        .filter((entry) => next.has(entry))
    })
    setApiTokenPlaintext(null)
  }

  const submitApiToken = async () => {
    const project = getSelectedProject()
    if (!project) {
      setApiTokenCreateError('Select a project first.')
      setApiTokenCreateStatus(null)
      return
    }
    if (apiTokenScopes.length === 0) {
      setApiTokenCreateError('Select at least one token scope.')
      setApiTokenCreateStatus(null)
      return
    }

    setApiTokenSubmitting(true)
    setApiTokenCreateError(null)
    setApiTokenCreateStatus(null)
    setApiTokenPlaintext(null)

    try {
      const payload = await createApiToken({
        expiresAt: createExpirationTimestamp(apiTokenExpirationDays),
        label: apiTokenLabel.trim() || undefined,
        project: project.slug,
        scopes: apiTokenScopes,
      })
      setApiTokens((current) => payload.tokens ?? [payload.token, ...current])
      setApiTokenLabel('')
      setApiTokenExpirationDays('90')
      setApiTokenPlaintext(payload.token.token ?? null)
      setApiTokenCreateStatus(`Created token for ${project.slug}`)
    } catch (error) {
      setApiTokenCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setApiTokenSubmitting(false)
    }
  }

  const revokeSelectedApiToken = async (id: string) => {
    if (!window.confirm('Revoke this API token?')) return

    setApiTokenRevokingId(id)
    setApiTokenCreateError(null)
    setApiTokenCreateStatus(null)
    setApiTokenPlaintext(null)

    try {
      await revokeApiToken(id)
      setApiTokens((current) => current.filter((token) => token.id !== id))
      setApiTokenCreateStatus('Revoked token')
    } catch (error) {
      setApiTokenCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setApiTokenRevokingId(null)
    }
  }

  const currentProject = selectedProject
    ? projects.find((project) => project.slug === selectedProject) ?? null
    : projects[0] ?? null
  const firstFilePath = findFirstFile(tree)
  const workspacePanel = session ? (
    <AccountPanel
      apiTokenCreateError={apiTokenCreateError}
      apiTokenCreateStatus={apiTokenCreateStatus}
      apiTokenExpirationDays={apiTokenExpirationDays}
      apiTokenLabel={apiTokenLabel}
      apiTokenPlaintext={apiTokenPlaintext}
      apiTokenRevokingId={apiTokenRevokingId}
      apiTokenScopes={apiTokenScopes}
      apiTokenSubmitting={apiTokenSubmitting}
      apiTokens={apiTokens}
      apiTokensLoading={apiTokensLoading}
      canManageUsers={canManageUsers}
      onArchiveProject={submitProjectArchive}
      onApiTokenExpirationDaysChange={(value) => {
        setApiTokenExpirationDays(value)
        setApiTokenPlaintext(null)
      }}
      onApiTokenLabelChange={setApiTokenLabel}
      onApiTokenScopeChange={setApiTokenScope}
      onCreateApiToken={submitApiToken}
      onCreateProject={submitProject}
      onCreateUser={submitUser}
      onProjectEditDisplayNameChange={setProjectEditDisplayName}
      onProjectDisplayNameChange={setProjectDisplayName}
      onProjectSlugChange={setProjectSlug}
      onRevokeApiToken={revokeSelectedApiToken}
      onSelectProject={selectProject}
      onUpdateProject={submitProjectUpdate}
      onUserDisplayNameChange={setUserDisplayName}
      onUserEmailChange={setUserEmail}
      onUserIssuerChange={setUserIssuer}
      onUserLoginChange={setUserLogin}
      onUserProviderChange={setUserProvider}
      onUserRoleChange={setUserRole}
      onUserSubjectChange={setUserSubject}
      projectCreateError={projectCreateError}
      projectCreateStatus={projectCreateStatus}
      projectDisplayName={projectDisplayName}
      projectEditDisplayName={projectEditDisplayName}
      projectEditSlug={projectEditSlug}
      projectMutationError={projectMutationError}
      projectMutationStatus={projectMutationStatus}
      projectSlug={projectSlug}
      projectArchiving={projectArchiving}
      projectSubmitting={projectSubmitting}
      projectUpdating={projectUpdating}
      projects={projects}
      projectsLoading={projectsLoading}
      selectedProject={selectedProject}
      session={session}
      userCreateError={userCreateError}
      userCreateStatus={userCreateStatus}
      userDisplayName={userDisplayName}
      userEmail={userEmail}
      userIssuer={userIssuer}
      userLogin={userLogin}
      userProvider={userProvider}
      userRole={userRole}
      userSubject={userSubject}
      userSubmitting={userSubmitting}
      users={users}
      usersLoading={usersLoading}
    />
  ) : null

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <p className="eyebrow">Viewer</p>
          <div className="topbar__brand-heading">
            <img className="topbar__brand-mark" src="/brand/docs-ssh-mark.svg" alt="" />
            <h1>DOCS-SSH</h1>
          </div>
          {currentProject ? (
            <p className="topbar__subtitle">
              <span>{currentProject.displayName}</span>
              <code>{currentProject.slug}</code>
            </p>
          ) : null}
        </div>
        {session ? (
          <div className="topbar__actions">
            <label className="project-switcher">
              <span>Project</span>
              <select
                disabled={projectsLoading || projects.length === 0}
                onChange={(event) => {
                  if (event.target.value) selectProject(event.target.value)
                }}
                value={currentProject?.slug ?? ''}
              >
                {projects.length === 0 ? (
                  <option value="">No projects</option>
                ) : null}
                {projects.map((project) => (
                  <option key={project.slug} value={project.slug}>
                    {project.displayName}
                  </option>
                ))}
              </select>
            </label>
            <div className="auth-panel">
              <div className="auth-panel__body">
                <button
                  className={`meta-link meta-button ${showAccountPanel ? 'selected' : ''}`}
                  onClick={() => startTransition(() => setActivePath(null))}
                  type="button"
                >
                  Workspace
                </button>
                <button
                  className={`meta-link meta-button ${activePath ? 'selected' : ''}`}
                  disabled={!activePath && !firstFilePath}
                  onClick={() => startTransition(() => setActivePath(activePath ?? firstFilePath))}
                  type="button"
                >
                  Files
                </button>
                <span className="meta-pill">
                  {session.userDisplayName} ({session.login})
                </span>
                <a
                  className="meta-link"
                  href={`/auth/logout?returnTo=${encodeURIComponent(getCurrentReturnTo())}`}
                >
                  Sign out
                </a>
              </div>
            </div>
          </div>
        ) : null}
      </header>

      <main className="workspace">
        {showSessionGate ? (
          <section className="session-gate" aria-label="Checking web session">
            <p className="eyebrow">Web Session</p>
            <div className="preview-skeleton preview-skeleton--wide" />
            <div className="preview-skeleton" />
          </section>
        ) : showLoggedOutLanding ? (
          <LoggedOutLanding
            oidc={oidc}
          />
        ) : (
          <Allotment className="workspace-split" defaultSizes={[28, 72]}>
            <Allotment.Pane minSize={260} preferredSize={320}>
              <section className="sidebar">
                <div className="sidebar__toolbar">
                  {currentProject ? (
                    <div className="sidebar__project">
                      <span>Project</span>
                      <strong>{currentProject.displayName}</strong>
                      <code>{currentProject.slug}</code>
                    </div>
                  ) : null}
                  <label className="field field--stacked">
                    <span>Filter files</span>
                    <input
                      onChange={(event) => setSearchTerm(event.target.value)}
                      placeholder="Search tree"
                      type="search"
                      value={searchTerm}
                    />
                  </label>
                  {activeMount ? (
                    <div className="mount-meta">
                      <span className="meta-pill">{activeMount.mountPath}</span>
                      {activeMount.aliases.map((alias) => (
                        <span className="meta-pill meta-pill--muted" key={alias}>
                          {alias}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="sidebar__tree" ref={explorerViewport.ref}>
                  {treeError ? (
                    <div className="preview-state preview-state--compact">
                      <h3>Explorer unavailable</h3>
                      <p>{treeError}</p>
                    </div>
                  ) : null}

                  {!treeError ? (
                    <Tree<TreeNodeData>
                      className="file-tree"
                      data={tree}
                      disableDrag
                      disableEdit
                      disableMultiSelection
                      height={treeHeight}
                      idAccessor="id"
                      onSelect={(nodes) => {
                        const nextNode = nodes.at(-1)
                        if (!nextNode || nextNode.data.kind !== 'file') return
                        startTransition(() => setActivePath(nextNode.data.path))
                      }}
                      openByDefault
                      overscanCount={12}
                      ref={treeRef}
                      rowHeight={28}
                      searchMatch={(node: NodeApi<TreeNodeData>, term: string) =>
                        node.data.path.toLocaleLowerCase().includes(term.toLocaleLowerCase())
                      }
                      searchTerm={deferredSearchTerm}
                      selection={activePath ? `file:${activePath}` : undefined}
                      width="100%"
                    >
                      {ExplorerNode}
                    </Tree>
                  ) : null}
                </div>

                {treeTruncated ? (
                  <div className="sidebar__notice">
                    Tree results were capped to keep the viewer responsive.
                  </div>
                ) : null}
              </section>
            </Allotment.Pane>

            <Allotment.Pane minSize={420}>
              <section className="preview-panel">
                <PreviewHeader file={file} session={session} />
                <div className="preview-body">
                  {showAccountPanel && workspacePanel ? (
                    workspacePanel
                  ) : (
                    <PreviewPane
                      file={file}
                      loading={fileLoading || treeLoading}
                      onNavigate={(path) => {
                        startTransition(() => {
                          setActivePath(path)
                        })
                      }}
                    />
                  )}
                </div>
              </section>
            </Allotment.Pane>
          </Allotment>
        )}
      </main>
    </div>
  )
}
