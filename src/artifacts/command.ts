import { basename, extname, posix } from 'node:path'
import { defineCommand, type ExecResult } from 'just-bash'
import type {
  ArtifactFormat,
  ArtifactVisibility,
  ArtifactWithVersions,
} from './store.js'

export interface ArtifactCommandService {
  getArtifact(publicId: string): ArtifactWithVersions | Promise<ArtifactWithVersions>
  listArtifacts(projectSlug: string): ArtifactWithVersions[] | Promise<ArtifactWithVersions[]>
  publishArtifact(input: {
    content: string
    format: ArtifactFormat
    projectSlug: string
    sourcePath: string
    title: string
    visibility?: ArtifactVisibility
  }): ArtifactWithVersions | Promise<ArtifactWithVersions>
  updateArtifactVisibility(
    publicId: string,
    visibility: ArtifactVisibility,
  ): ArtifactWithVersions | Promise<ArtifactWithVersions>
}

interface ParsedArtifactArgs {
  json: boolean
  positionals: string[]
  projectSlug?: string
  title?: string
  visibility?: ArtifactVisibility
}

function usage(): ExecResult {
  return {
    stdout: [
      'Usage: artifact publish PATH [--project SLUG] [--title TITLE] [--share private|project] [--json]',
      '       artifact list [--project SLUG] [--json]',
      '       artifact versions ID [--json]',
      '       artifact share ID private|project [--json]',
      '',
      'Publishes self-contained HTML from a project task artifact directory.',
      'A relative PATH is resolved below /projects/<project>/, while an absolute project path is used as-is.',
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  }
}

function errorResult(message: string, exitCode = 2): ExecResult {
  return {
    stdout: '',
    stderr: `artifact: ${message}\n`,
    exitCode,
  }
}

function parseVisibility(value: string): ArtifactVisibility | null {
  return value === 'private' || value === 'project' ? value : null
}

function parseArgs(args: string[]): ParsedArtifactArgs | string {
  const parsed: ParsedArtifactArgs = {
    json: false,
    positionals: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--project' || arg === '--title' || arg === '--share') {
      const value = args[index + 1]
      if (!value) return `${arg} requires a value`
      if (arg === '--project') parsed.projectSlug = value.trim()
      if (arg === '--title') parsed.title = value.trim()
      if (arg === '--share') {
        const visibility = parseVisibility(value)
        if (!visibility) return '--share must be private or project'
        parsed.visibility = visibility
      }
      index += 1
      continue
    }
    if (arg.startsWith('-')) return `unknown option: ${arg}`
    parsed.positionals.push(arg)
  }

  return parsed
}

function getArtifactUrl(viewerOrigin: string | undefined, publicId: string): string {
  const origin = viewerOrigin?.replace(/\/+$/u, '')
  return origin ? `${origin}/artifacts/${publicId}` : `/artifacts/${publicId}`
}

function toArtifactPayload(artifact: ArtifactWithVersions, viewerOrigin?: string) {
  return {
    createdAt: artifact.createdAt,
    format: artifact.format,
    latestVersion: artifact.latestVersion,
    project: artifact.projectSlug,
    publicId: artifact.publicId,
    sourcePath: artifact.sourcePath,
    title: artifact.title,
    updatedAt: artifact.updatedAt,
    url: getArtifactUrl(viewerOrigin, artifact.publicId),
    versions: artifact.versions,
    visibility: artifact.visibility,
  }
}

function formatArtifact(artifact: ArtifactWithVersions, viewerOrigin?: string): string {
  return [
    `${artifact.title} (${artifact.publicId})`,
    `  URL: ${getArtifactUrl(viewerOrigin, artifact.publicId)}`,
    `  Project: ${artifact.projectSlug}`,
    `  Version: ${artifact.latestVersion}`,
    `  Visibility: ${artifact.visibility}`,
    `  Source: ${artifact.sourcePath}`,
  ].join('\n')
}

function resolvePublishPath(
  rawPath: string,
  projectSlug: string,
): { format: ArtifactFormat, path: string, projectSlug: string } | string {
  const normalizedProject = projectSlug.trim()
  if (!normalizedProject || normalizedProject.includes('/')) return 'invalid project slug'

  const virtualPath = rawPath.startsWith('/')
    ? posix.normalize(rawPath)
    : posix.resolve(`/projects/${normalizedProject}`, rawPath)
  const match = /^\/projects\/([^/]+)\/tasks\/[^/]+\/artifacts\/.+\.(html?)$/iu.exec(virtualPath)
  if (!match) {
    return 'publish path must be an .html or .htm file below /projects/<project>/tasks/<task>/artifacts/'
  }
  if (match[1] !== normalizedProject) {
    return `path belongs to project "${match[1]}", not "${normalizedProject}"`
  }

  return {
    format: 'html',
    path: virtualPath,
    projectSlug: normalizedProject,
  }
}

export function createArtifactCommand(opts: {
  defaultProjectSlug: string
  service?: ArtifactCommandService
  viewerOrigin?: string
}) {
  return defineCommand('artifact', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) return usage()
    if (!opts.service) return errorResult('artifact publishing is not configured on this server', 1)

    const subcommand = args[0]
    const parsed = parseArgs(args.slice(1))
    if (typeof parsed === 'string') return errorResult(parsed)

    try {
      if (subcommand === 'publish') {
        const rawPath = parsed.positionals[0]
        if (!rawPath) return errorResult('publish requires a path')
        if (parsed.positionals.length > 1) return errorResult('publish accepts one path')

        const absoluteProjectSlug = rawPath.startsWith('/')
          ? /^\/projects\/([^/]+)(?:\/|$)/u.exec(posix.normalize(rawPath))?.[1]
          : undefined
        const resolved = resolvePublishPath(
          rawPath,
          parsed.projectSlug ?? absoluteProjectSlug ?? opts.defaultProjectSlug,
        )
        if (typeof resolved === 'string') return errorResult(resolved)

        const content = await ctx.fs.readFile(resolved.path, 'utf8')
        const artifact = await opts.service.publishArtifact({
          content,
          format: resolved.format,
          projectSlug: resolved.projectSlug,
          sourcePath: resolved.path,
          title: parsed.title || basename(resolved.path, extname(resolved.path)),
          visibility: parsed.visibility,
        })

        if (parsed.json) {
          return {
            stdout: `${JSON.stringify({ artifact: toArtifactPayload(artifact, opts.viewerOrigin) }, null, 2)}\n`,
            stderr: '',
            exitCode: 0,
          }
        }

        return {
          stdout: `Published artifact v${artifact.latestVersion}\n${formatArtifact(artifact, opts.viewerOrigin)}\n`,
          stderr: '',
          exitCode: 0,
        }
      }

      if (subcommand === 'list') {
        if (parsed.positionals.length > 0) return errorResult('list does not accept positional arguments')
        const artifacts = await opts.service.listArtifacts(parsed.projectSlug ?? opts.defaultProjectSlug)
        if (parsed.json) {
          return {
            stdout: `${JSON.stringify({
              artifacts: artifacts.map((artifact) => toArtifactPayload(artifact, opts.viewerOrigin)),
            }, null, 2)}\n`,
            stderr: '',
            exitCode: 0,
          }
        }
        return {
          stdout: artifacts.length > 0
            ? `${artifacts.map((artifact) => formatArtifact(artifact, opts.viewerOrigin)).join('\n\n')}\n`
            : 'No artifacts found.\n',
          stderr: '',
          exitCode: 0,
        }
      }

      if (subcommand === 'versions') {
        const publicId = parsed.positionals[0]
        if (!publicId) return errorResult('versions requires an artifact id')
        if (parsed.positionals.length > 1) return errorResult('versions accepts one artifact id')
        const artifact = await opts.service.getArtifact(publicId)
        if (parsed.json) {
          return {
            stdout: `${JSON.stringify({ artifact: toArtifactPayload(artifact, opts.viewerOrigin) }, null, 2)}\n`,
            stderr: '',
            exitCode: 0,
          }
        }
        return {
          stdout: [
            formatArtifact(artifact, opts.viewerOrigin),
            '',
            ...artifact.versions.map((version) =>
              `  v${version.version}  ${version.createdAt}  ${version.sizeBytes} bytes  ${version.contentHash.slice(0, 12)}`),
            '',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }
      }

      if (subcommand === 'share') {
        const publicId = parsed.positionals[0]
        const rawVisibility = parsed.positionals[1]
        if (!publicId || !rawVisibility) {
          return errorResult('share requires an artifact id and private or project')
        }
        if (parsed.positionals.length > 2) return errorResult('share accepts an artifact id and visibility')
        const visibility = parseVisibility(rawVisibility)
        if (!visibility) return errorResult('share visibility must be private or project')

        const artifact = await opts.service.updateArtifactVisibility(publicId, visibility)
        if (parsed.json) {
          return {
            stdout: `${JSON.stringify({ artifact: toArtifactPayload(artifact, opts.viewerOrigin) }, null, 2)}\n`,
            stderr: '',
            exitCode: 0,
          }
        }
        return {
          stdout: `Artifact visibility set to ${artifact.visibility}.\n${formatArtifact(artifact, opts.viewerOrigin)}\n`,
          stderr: '',
          exitCode: 0,
        }
      }

      return errorResult(`unknown subcommand: ${subcommand}`)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), 1)
    }
  })
}
