export interface GitRepoPreset {
  name: string
  repoUrl: string
  subdir?: string
  description: string
}

export const GIT_REPO_PRESETS: Record<string, GitRepoPreset> = {
  github: {
    name: 'github',
    repoUrl: 'https://github.com/github/docs.git',
    subdir: 'content',
    description: 'GitHub Docs repository content.',
  },
  supabase: {
    name: 'supabase',
    repoUrl: 'https://github.com/supabase/supabase.git',
    subdir: 'apps/docs/content',
    description: 'Supabase docs content inside the main monorepo.',
  },
  neon: {
    name: 'neon',
    repoUrl: 'https://github.com/neondatabase/website.git',
    subdir: 'content',
    description: 'Neon docs content from the website repository.',
  },
  cloudflare: {
    name: 'cloudflare',
    repoUrl: 'https://github.com/cloudflare/cloudflare-docs.git',
    description: 'Cloudflare docs repository root.',
  },
}

export function getGitRepoPreset(name: string): GitRepoPreset | null {
  return GIT_REPO_PRESETS[name] ?? null
}
