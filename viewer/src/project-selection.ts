export interface SelectableProject {
  publicId: string
  slug: string
}

export function resolveProjectSelection<T extends SelectableProject>(
  projects: T[],
  routeProjectPublicId: string | null,
  selectedProjectSlug: string | null,
): T | null {
  const routeProject = routeProjectPublicId
    ? projects.find((project) => project.publicId === routeProjectPublicId)
    : null
  if (routeProject) return routeProject

  const selectedProject = selectedProjectSlug
    ? projects.find((project) => project.slug === selectedProjectSlug)
    : null
  return selectedProject ?? projects[0] ?? null
}
