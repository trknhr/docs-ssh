import { useDeferredValue, useEffect, useRef, useState, startTransition } from 'react'
import { Allotment } from 'allotment'
import DOMPurify from 'dompurify'
import { Renderer, marked } from 'marked'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import { addSshKey, getFile, getSession, getSshKeys, getTree } from './api'
import type {
  FilePayload,
  RootSummary,
  TreeNodeData,
  ViewerOidcState,
  ViewerSessionUser,
  ViewerSshKey,
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

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.valueOf())) return timestamp
  return date.toLocaleString()
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
    .filter((mount) => path === mount.mountPath || path.startsWith(`${mount.mountPath}/`))
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0]
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
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ height: 0, width: 0 })

  useEffect(() => {
    if (!ref.current) return

    const observer = new ResizeObserver((entries) => {
      const nextEntry = entries[0]
      if (!nextEntry) return

      setSize({
        height: nextEntry.contentRect.height,
        width: nextEntry.contentRect.width,
      })
    })

    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])

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
  onNameChange: (value: string) => void
  onPublicKeyChange: (value: string) => void
  onSubmit: () => void
  session: ViewerSessionUser
  sshKeyError: string | null
  sshKeyName: string
  sshKeyPublicKey: string
  sshKeyStatus: string | null
  sshKeys: ViewerSshKey[]
  sshKeysLoading: boolean
  sshKeySubmitting: boolean
}) {
  return (
    <section className="account-dashboard">
      <div className="account-banner">
        <div>
          <p className="eyebrow">SSH Access</p>
          <h3>Register a public key for {props.session.login}</h3>
          <p>
            Paste the contents of your public key file such as
            {' '}
            <code>~/.ssh/id_ed25519.pub</code>
            {' '}
            or
            {' '}
            <code>~/.ssh/id_rsa.pub</code>
            .
          </p>
        </div>
        <div className="account-banner__meta">
          <span className="meta-pill">{props.session.userDisplayName}</span>
          <span className="meta-pill meta-pill--muted">{props.sshKeys.length} linked key{props.sshKeys.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="account-grid">
        <article className="account-card">
          <p className="eyebrow">Add Key</p>
          <h3>Paste a new public key</h3>
          <div className="account-form">
            <label className="field field--stacked">
              <span>Label</span>
              <input
                maxLength={120}
                onChange={(event) => props.onNameChange(event.target.value)}
                placeholder="Laptop, workstation, CI runner"
                type="text"
                value={props.sshKeyName}
              />
            </label>
            <label className="field field--stacked">
              <span>Public key</span>
              <textarea
                onChange={(event) => props.onPublicKeyChange(event.target.value)}
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
                rows={6}
                value={props.sshKeyPublicKey}
              />
            </label>
            <div className="account-form__footer">
              <button
                className="action-button"
                disabled={props.sshKeySubmitting}
                onClick={props.onSubmit}
                type="button"
              >
                {props.sshKeySubmitting ? 'Saving key…' : 'Add SSH key'}
              </button>
              {props.sshKeyStatus ? (
                <p className="status-message status-message--success">{props.sshKeyStatus}</p>
              ) : null}
              {props.sshKeyError ? (
                <p className="status-message status-message--error">{props.sshKeyError}</p>
              ) : null}
            </div>
          </div>
        </article>

        <article className="account-card">
          <p className="eyebrow">Registered Keys</p>
          <h3>Current public keys</h3>
          {props.sshKeysLoading ? (
            <div className="preview-state preview-state--compact">
              <p>Loading registered keys…</p>
            </div>
          ) : props.sshKeys.length === 0 ? (
            <div className="preview-state preview-state--compact">
              <p>No SSH public keys linked yet.</p>
            </div>
          ) : (
            <div className="ssh-key-list">
              {props.sshKeys.map((sshKey) => (
                <div className="ssh-key-item" key={sshKey.fingerprint}>
                  <div className="ssh-key-item__header">
                    <strong>{sshKey.name?.trim() || 'Unnamed key'}</strong>
                    <span className="meta-pill meta-pill--muted">{sshKey.algorithm}</span>
                  </div>
                  <code>{sshKey.fingerprint}</code>
                  <p>Added {formatTimestamp(sshKey.createdAt)}</p>
                </div>
              ))}
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
  docsName: string
  mounts: RootSummary[]
  oidc: ViewerOidcState
  sessionLoading: boolean
}) {
  const authReady = props.oidc.enabled
  const primaryLabel = props.sessionLoading
    ? 'Checking session…'
    : authReady
      ? 'Sign in with Google'
      : 'OIDC not configured'

  return (
    <section className="logged-out-shell">
      <div className="logged-out-hero">
        <div className="logged-out-hero__copy">
          <p className="eyebrow">Viewer Access</p>
          <h2>Signed out</h2>
          <p className="logged-out-hero__lede">
            This viewer is set up for web identity sign-in. Sign in first to enter {props.docsName}
            {' '}
            and attach your browser session to a known account.
          </p>
          <div className="logged-out-hero__actions">
            {authReady ? (
              <a
                className="hero-button"
                href={`/auth/login?returnTo=${encodeURIComponent(getCurrentReturnTo())}`}
              >
                {primaryLabel}
              </a>
            ) : (
              <span className="meta-pill meta-pill--muted">{primaryLabel}</span>
            )}
            {props.oidc.provider ? (
              <span className="meta-pill">
                Provider
                {' '}
                {props.oidc.provider}
              </span>
            ) : null}
          </div>
        </div>

        <div className="logged-out-status">
          <p className="eyebrow">Session State</p>
          <div className="logged-out-status__card">
            <strong>{props.sessionLoading ? 'Checking current session' : 'No active web session'}</strong>
            <p>
              {props.sessionLoading
                ? 'The viewer is verifying your session cookies before deciding whether to open the explorer.'
                : 'The explorer is intentionally hidden until sign-in succeeds.'}
            </p>
          </div>
          <div className="logged-out-status__card">
            <strong>What sign-in unlocks</strong>
            <p>Authenticated web session, linked identity resolution, and the future browser-side SSH key flow.</p>
          </div>
        </div>
      </div>

      <div className="logged-out-grid">
        <article className="logged-out-card">
          <p className="eyebrow">Mounted Paths</p>
          <h3>What will open after sign-in</h3>
          <div className="logged-out-card__pills">
            {props.mounts.length > 0 ? props.mounts.map((mount) => (
              <span className="meta-pill meta-pill--muted" key={mount.mountPath}>
                {mount.mountPath}
              </span>
            )) : <span className="meta-pill meta-pill--muted">Loading mounts…</span>}
          </div>
          <p>The authenticated view opens the docs tree and workspace explorer inside the same browser session.</p>
        </article>

        <article className="logged-out-card">
          <p className="eyebrow">Flow</p>
          <h3>What happens next</h3>
          <ol className="logged-out-steps">
            <li>Redirect to the configured OIDC provider.</li>
            <li>Verify the ID token and resolve your linked identity.</li>
            <li>Return here with a signed session cookie.</li>
          </ol>
        </article>
      </div>
    </section>
  )
}

export function App() {
  const initialLocation = readLocationState()
  const treeRef = useRef<TreeApi<TreeNodeData> | null>(null)
  const [docsName, setDocsName] = useState('Documentation')
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
  const [sshKeys, setSshKeys] = useState<ViewerSshKey[]>([])
  const [sshKeysLoading, setSshKeysLoading] = useState(false)
  const [sshKeyName, setSshKeyName] = useState('')
  const [sshKeyPublicKey, setSshKeyPublicKey] = useState('')
  const [sshKeyError, setSshKeyError] = useState<string | null>(null)
  const [sshKeyStatus, setSshKeyStatus] = useState<string | null>(null)
  const [sshKeySubmitting, setSshKeySubmitting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const deferredSearchTerm = useDeferredValue(searchTerm)
  const explorerViewport = useElementSize<HTMLDivElement>()
  const activeMount = findMountForPath(mounts, activePath)
  const treeHeight = explorerViewport.size.height > 0 ? explorerViewport.size.height : 480
  const showLoggedOutLanding = !session
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

    getTree()
      .then((payload) => {
        if (cancelled) return

        setDocsName(payload.docsName)
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
  }, [])

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

  useEffect(() => {
    if (!session) {
      setSshKeys([])
      setSshKeysLoading(false)
      setSshKeyError(null)
      setSshKeyStatus(null)
      return
    }

    let cancelled = false
    setSshKeysLoading(true)
    setSshKeyError(null)

    getSshKeys()
      .then((payload) => {
        if (cancelled) return
        setSshKeys(payload.keys)
        setSshKeysLoading(false)
      })
      .catch((error) => {
        if (cancelled) return
        setSshKeyError(error instanceof Error ? error.message : String(error))
        setSshKeysLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [session?.userId])

  const submitSshKey = async () => {
    const publicKey = sshKeyPublicKey.trim()
    const name = sshKeyName.trim()
    if (!publicKey) {
      setSshKeyError('Paste an SSH public key first.')
      setSshKeyStatus(null)
      return
    }

    setSshKeySubmitting(true)
    setSshKeyError(null)
    setSshKeyStatus(null)

    try {
      const payload = await addSshKey({
        name: name || undefined,
        publicKey,
      })

      setSshKeys((current) => {
        const next = current.filter((entry) => entry.fingerprint !== payload.key.fingerprint)
        return [payload.key, ...next]
      })
      setSshKeyPublicKey('')
      setSshKeyName('')
      setSshKeyStatus(`Saved ${payload.key.fingerprint}`)
    } catch (error) {
      setSshKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      setSshKeySubmitting(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">docs-ssh viewer</p>
          <h1>{docsName}</h1>
        </div>
        <div className="topbar__actions">
          <div className="auth-panel">
            <p className="eyebrow">Web Session</p>
            {sessionLoading ? (
              <span className="meta-pill meta-pill--muted">Checking session…</span>
            ) : session ? (
              <div className="auth-panel__body">
                <button
                  className="meta-link meta-button"
                  onClick={() => startTransition(() => setActivePath(null))}
                  type="button"
                >
                  SSH keys
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
            ) : oidc.enabled ? (
              <div className="auth-panel__body">
                <span className="meta-pill meta-pill--muted">
                  OIDC ready{oidc.provider ? ` · ${oidc.provider}` : ''}
                </span>
                <a
                  className="meta-link"
                  href={`/auth/login?returnTo=${encodeURIComponent(getCurrentReturnTo())}`}
                >
                  Sign in
                </a>
              </div>
            ) : (
              <span className="meta-pill meta-pill--muted">OIDC not configured</span>
            )}
          </div>
          {!showLoggedOutLanding ? mounts.map((mount) => (
            <span className="meta-pill meta-pill--muted" key={mount.mountPath}>
              {mount.mountPath}
            </span>
          )) : null}
        </div>
      </header>

      <main className="workspace">
        {showLoggedOutLanding ? (
          <LoggedOutLanding
            docsName={docsName}
            mounts={mounts}
            oidc={oidc}
            sessionLoading={sessionLoading}
          />
        ) : (
          <Allotment defaultSizes={[28, 72]}>
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
                      onNameChange={setSshKeyName}
                      onPublicKeyChange={setSshKeyPublicKey}
                      onSubmit={submitSshKey}
                      session={session}
                      sshKeyError={sshKeyError}
                      sshKeyName={sshKeyName}
                      sshKeyPublicKey={sshKeyPublicKey}
                      sshKeys={sshKeys}
                      sshKeysLoading={sshKeysLoading}
                      sshKeyStatus={sshKeyStatus}
                      sshKeySubmitting={sshKeySubmitting}
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
