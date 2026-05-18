import { useCallback, useDeferredValue, useEffect, useRef, useState, startTransition } from 'react'
import { Allotment } from 'allotment'
import DOMPurify from 'dompurify'
import { Renderer, marked } from 'marked'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import { createProject, getFile, getProjects, getSession, getTree } from './api'
import type {
  FilePayload,
  RootSummary,
  TreeNodeData,
  ViewerOidcState,
  ViewerProject,
  ViewerSessionUser,
} from './types'

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
          <h2>{props.session ? 'Account' : 'No file selected'}</h2>
          {props.session ? (
            <p className="preview-path">SSH access for {props.session.login}</p>
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

function AccountPanel(props: {
  onCreateProject: () => void
  onProjectDisplayNameChange: (value: string) => void
  onProjectSlugChange: (value: string) => void
  onSelectProject: (slug: string) => void
  projectCreateError: string | null
  projectCreateStatus: string | null
  projectDisplayName: string
  projectSlug: string
  projectSubmitting: boolean
  projects: ViewerProject[]
  projectsLoading: boolean
  selectedProject: string | null
  session: ViewerSessionUser
}) {
  const selectedProject = props.projects.find((project) => project.slug === props.selectedProject) ?? props.projects[0]
  const [configCopied, setConfigCopied] = useState(false)
  const projectConfig = selectedProject
    ? [
        'server = "docs-ssh"',
        `project = "${selectedProject.slug}"`,
        '',
      ].join('\n')
    : ''

  return (
    <section className="account-dashboard">
      <div className="account-banner">
        <div>
          <p className="eyebrow">Agent Access</p>
          <h3>Prepare project config for {props.session.login}</h3>
          <p>
            Create or select the project that local agents should use from this work directory.
          </p>
        </div>
        <div className="account-banner__meta">
          <span className="meta-pill">{props.session.userDisplayName}</span>
          <span className="meta-pill meta-pill--muted">
            {selectedProject ? `project: ${selectedProject.slug}` : 'select a project'}
          </span>
        </div>
      </div>

      <div className="account-grid">
        <article className="account-card">
          <p className="eyebrow">Projects</p>
          <h3>Create or select a project</h3>
          <div className="account-form">
            <label className="field field--stacked">
              <span>Slug</span>
              <input
                maxLength={120}
                onChange={(event) => props.onProjectSlugChange(event.target.value)}
                placeholder="slack-ai-assistant-agentcore-migration"
                type="text"
                value={props.projectSlug}
              />
            </label>
            <label className="field field--stacked">
              <span>Display name</span>
              <input
                maxLength={160}
                onChange={(event) => props.onProjectDisplayNameChange(event.target.value)}
                placeholder="Slack AI assistant AgentCore migration"
                type="text"
                value={props.projectDisplayName}
              />
            </label>
            <div className="account-form__footer">
              <button
                className="action-button"
                disabled={props.projectSubmitting}
                onClick={props.onCreateProject}
                type="button"
              >
                {props.projectSubmitting ? 'Creating project...' : 'Create project'}
              </button>
              {props.projectCreateStatus ? (
                <p className="status-message status-message--success">{props.projectCreateStatus}</p>
              ) : null}
              {props.projectCreateError ? (
                <p className="status-message status-message--error">{props.projectCreateError}</p>
              ) : null}
            </div>
          </div>
          {props.projectsLoading ? (
            <div className="preview-state preview-state--compact">
              <p>Loading projects...</p>
            </div>
          ) : props.projects.length === 0 ? (
            <div className="preview-state preview-state--compact">
              <p>No projects available.</p>
            </div>
          ) : (
            <div className="project-list">
              {props.projects.map((project) => (
                <button
                  className={`project-item ${project.slug === selectedProject?.slug ? 'selected' : ''}`}
                  key={project.slug}
                  onClick={() => props.onSelectProject(project.slug)}
                  type="button"
                >
                  <strong>{project.displayName}</strong>
                  <code>{project.slug}</code>
                </button>
              ))}
            </div>
          )}
        </article>

        <article className="account-card">
          <p className="eyebrow">Agent Config</p>
          <h3>Use the selected project from this directory</h3>
          {selectedProject ? (
            <>
              <div className="config-snippet-wrap">
                <pre className="config-snippet">{projectConfig}</pre>
                <button
                  className="meta-link meta-button config-copy-button"
                  onClick={() => {
                    void navigator.clipboard.writeText(projectConfig).then(() => {
                      setConfigCopied(true)
                      window.setTimeout(() => setConfigCopied(false), 1400)
                    })
                  }}
                  type="button"
                >
                  {configCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p>
                Store this as
                {' '}
                <code>.docs-ssh.toml</code>
                {' '}
                in the local work directory. The server still verifies project membership before issuing an SSH session.
              </p>
            </>
          ) : (
            <div className="preview-state preview-state--compact">
              <p>Select or create a project to generate config.</p>
            </div>
          )}
        </article>
      </div>
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
        <p>The preview follows the mounted tree at /docs and /workspace.</p>
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

  return (
    <section className="logged-out-shell">
      {authReady ? (
        <a
          className="hero-button"
          href={`/auth/login?returnTo=${encodeURIComponent(getCurrentReturnTo())}`}
        >
          Sign in with Google
        </a>
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
  const [projectCreateError, setProjectCreateError] = useState<string | null>(null)
  const [projectCreateStatus, setProjectCreateStatus] = useState<string | null>(null)
  const [projectSubmitting, setProjectSubmitting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const deferredSearchTerm = useDeferredValue(searchTerm)
  const explorerViewport = useElementSize<HTMLDivElement>()
  const activeMount = findMountForPath(mounts, activePath)
  const treeHeight = Math.max(1, explorerViewport.size.height)
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

  const selectProject = (slug: string) => {
    setSelectedProject(slug)
    window.localStorage.setItem('docs-ssh:selected-project', slug)
    startTransition(() => setActivePath(null))
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Viewer</p>
          <h1>DOCS-SSH</h1>
        </div>
        {session ? (
          <div className="topbar__actions">
            <div className="auth-panel">
              <div className="auth-panel__body">
                <button
                  className="meta-link meta-button"
                  onClick={() => startTransition(() => setActivePath(null))}
                  type="button"
                >
                  Account
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
                    <div className="source-meta">
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
                  {showAccountPanel ? (
                    <AccountPanel
                      onCreateProject={submitProject}
                      onProjectDisplayNameChange={setProjectDisplayName}
                      onProjectSlugChange={setProjectSlug}
                      onSelectProject={selectProject}
                      projectCreateError={projectCreateError}
                      projectCreateStatus={projectCreateStatus}
                      projectDisplayName={projectDisplayName}
                      projectSlug={projectSlug}
                      projectSubmitting={projectSubmitting}
                      projects={projects}
                      projectsLoading={projectsLoading}
                      selectedProject={selectedProject}
                      session={session}
                    />
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
