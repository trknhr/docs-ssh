import { useDeferredValue, useEffect, useRef, useState, startTransition } from 'react'
import { Allotment } from 'allotment'
import DOMPurify from 'dompurify'
import { Renderer, marked } from 'marked'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import { getFile, getTree } from './api'
import type { FilePayload, RootSummary, TreeNodeData } from './types'

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

function PreviewHeader(props: { file: FilePayload | null }) {
  if (!props.file) {
    return (
      <header className="preview-header">
        <div>
          <p className="eyebrow">Preview</p>
          <h2>No file selected</h2>
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

export function App() {
  const initialLocation = readLocationState()
  const treeRef = useRef<TreeApi<TreeNodeData> | null>(null)
  const [docsName, setDocsName] = useState('Documentation')
  const [mounts, setMounts] = useState<RootSummary[]>([])
  const [activePath, setActivePath] = useState<string | null>(initialLocation.path)
  const [tree, setTree] = useState<TreeNodeData[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeTruncated, setTreeTruncated] = useState(false)
  const [file, setFile] = useState<FilePayload | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const deferredSearchTerm = useDeferredValue(searchTerm)
  const explorerViewport = useElementSize<HTMLDivElement>()
  const activeMount = findMountForPath(mounts, activePath)
  const treeHeight = explorerViewport.size.height > 0 ? explorerViewport.size.height : 480

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">docs-ssh viewer</p>
          <h1>{docsName}</h1>
        </div>
        <div className="topbar__actions">
          {mounts.map((mount) => (
            <span className="meta-pill meta-pill--muted" key={mount.mountPath}>
              {mount.mountPath}
            </span>
          ))}
        </div>
      </header>

      <main className="workspace">
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
              <PreviewHeader file={file} />
              <div className="preview-body">
                <PreviewPane
                  file={file}
                  loading={fileLoading || treeLoading}
                  onNavigate={(path) => {
                    startTransition(() => {
                      setActivePath(path)
                    })
                  }}
                />
              </div>
            </section>
          </Allotment.Pane>
        </Allotment>
      </main>
    </div>
  )
}
